import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export interface RenderRequest {
    template: string;
    inputJson: string;
    wrapContent: boolean;
}

export interface TraceVariable {
    name: string;
    value: string;
    line: number;
}

export interface LineMapping {
    templateLine: number;
    outputStart: number;
    outputEnd: number;
    outputText: string;
}

export interface RenderResult {
    success: boolean;
    output: string;
    variables: TraceVariable[];
    lineMappings: LineMapping[];
    errors: RenderError[];
    renderTimeMs: number;
}

export interface RenderError {
    message: string;
    line?: number;
    column?: number;
}

export class LiquidBackend {
    private backendScriptPath: string;

    constructor(private context: vscode.ExtensionContext) {
        this.backendScriptPath = path.join(context.extensionPath, 'backend', 'renderer.csx');
    }

    async render(request: RenderRequest): Promise<RenderResult> {
        const cfg = vscode.workspace.getConfiguration('dotliquid');
        const dotnetScript = cfg.get<string>('dotnetScriptPath', 'dotnet-script');

        const available = await this.checkDotnetScript(dotnetScript);
        if (!available) {
            return {
                success: false,
                output: '',
                variables: [],
                lineMappings: [],
                errors: [{
                    message: 'dotnet-script not found.\nInstall: dotnet tool install -g dotnet-script\nThen reload VS Code.'
                }],
                renderTimeMs: 0
            };
        }

        // All instrumentation is handled in renderer.csx — pass raw template
        const payload = JSON.stringify({
            template: request.template,
            inputJson: request.inputJson,
            wrapContent: request.wrapContent
        });

        return new Promise((resolve) => {
            const start = Date.now();
            let stdout = '';
            let stderr = '';

            const proc = cp.spawn(dotnetScript, [this.backendScriptPath], {
                env: process.env
            });

            proc.stdin.write(payload);
            proc.stdin.end();

            proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                const renderTimeMs = Date.now() - start;

                if (code !== 0) {
                    resolve({
                        success: false,
                        output: '',
                        variables: [],
                        lineMappings: [],
                        errors: [{ message: stderr || `Process exited with code ${code}` }],
                        renderTimeMs
                    });
                    return;
                }

                try {
                    const result = JSON.parse(stdout) as RenderResult;
                    result.renderTimeMs = renderTimeMs;
                    resolve(result);
                } catch (e) {
                    resolve({
                        success: false,
                        output: stdout,
                        variables: [],
                        lineMappings: [],
                        errors: [{ message: `Failed to parse backend response: ${e}` }],
                        renderTimeMs
                    });
                }
            });

            proc.on('error', (err) => {
                resolve({
                    success: false,
                    output: '',
                    variables: [],
                    lineMappings: [],
                    errors: [{ message: `Failed to start backend: ${err.message}` }],
                    renderTimeMs: Date.now() - start
                });
            });
        });
    }

    private async checkDotnetScript(executable: string): Promise<boolean> {
        return new Promise((resolve) => {
            const proc = cp.spawn(executable, ['--version'], { shell: true });
            proc.on('close', (code) => resolve(code === 0));
            proc.on('error', () => resolve(false));
        });
    }

    dispose() {
        // Each render is a short-lived process — nothing persistent to clean up
    }
}
