import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

export interface RenderError {
    message: string;
    line?: number;
    column?: number;
}

export interface RenderResult {
    success: boolean;
    output: string;
    variables: TraceVariable[];
    lineMappings: LineMapping[];
    errors: RenderError[];
    renderTimeMs: number;
}

// Internal wire types include the id field used to pair requests/responses
interface WireRequest extends RenderRequest { id: number; }
interface WireResult  extends RenderResult  { id: number; }

export class LiquidBackend {
    private _proc: cp.ChildProcess | null = null;
    private _lineBuffer = '';
    private _pending    = new Map<number, (result: RenderResult) => void>();
    private _nextId     = 1;

    private readonly backendDir:  string;
    private readonly rendererDll: string;
    private readonly projectDir:  string;

    constructor(private context: vscode.ExtensionContext) {
        this.backendDir  = path.join(context.extensionPath, 'backend');
        this.rendererDll = path.join(this.backendDir, 'renderer', 'DotLiquidRenderer.dll');
        this.projectDir  = path.join(this.backendDir, 'DotLiquidRenderer');
    }

    async render(request: RenderRequest): Promise<RenderResult> {
        const proc = await this.ensureProcess();
        if (!proc) {
            return this.errResult(
                'Renderer process could not be started. See the Errors panel for details.'
            );
        }

        const id: number = this._nextId++;
        const wire: WireRequest = { id, ...request };

        return new Promise<RenderResult>((resolve) => {
            this._pending.set(id, resolve);
            proc.stdin!.write(JSON.stringify(wire) + '\n');
        });
    }

    private async ensureProcess(): Promise<cp.ChildProcess | null> {
        if (this._proc) { return this._proc; }

        if (!fs.existsSync(this.rendererDll)) {
            const built = await this.buildRenderer();
            if (!built) { return null; }
        }

        const dotnet = this.dotnetExe();
        const proc   = cp.spawn(dotnet, [this.rendererDll], { env: process.env });

        proc.stdout!.on('data', (data: Buffer) => {
            this._lineBuffer += data.toString();
            const lines = this._lineBuffer.split('\n');
            this._lineBuffer = lines.pop() ?? '';
            for (const ln of lines) {
                if (!ln.trim()) { continue; }
                try {
                    const wire    = JSON.parse(ln) as WireResult;
                    const resolve = this._pending.get(wire.id);
                    if (resolve) {
                        this._pending.delete(wire.id);
                        resolve(wire);
                    }
                } catch { /* malformed line — ignore */ }
            }
        });

        // Drain stderr so the pipe buffer never fills and blocks the process
        proc.stderr!.on('data', () => { /* intentionally empty */ });

        proc.on('exit', () => {
            this._rejectAll('Renderer process exited unexpectedly. It will respawn on next render.');
            this._proc = null;
        });

        proc.on('error', (err) => {
            this._rejectAll(`Failed to start renderer: ${err.message}`);
            this._proc = null;
        });

        this._proc = proc;
        return proc;
    }

    private async buildRenderer(): Promise<boolean> {
        const dotnet    = this.dotnetExe();
        const available = await this.checkDotnet(dotnet);

        if (!available) {
            void vscode.window.showErrorMessage(
                'DotLiquid Debugger requires the .NET 8 SDK.\n' +
                'Install from https://dotnet.microsoft.com/download/dotnet/8.0 ' +
                'then reload VS Code (Developer: Reload Window).'
            );
            return false;
        }

        const outDir = path.join(this.backendDir, 'renderer');

        return vscode.window.withProgress(
            {
                location:    vscode.ProgressLocation.Notification,
                title:       'DotLiquid Debugger: Building renderer (first run, ~10s)…',
                cancellable: false
            },
            () => new Promise<boolean>((resolve) => {
                const proc = cp.spawn(
                    dotnet,
                    ['build', '-c', 'Release', '-o', outDir],
                    { cwd: this.projectDir, env: process.env }
                );
                proc.on('close', (code) => resolve(code === 0));
                proc.on('error', ()     => resolve(false));
            })
        );
    }

    private async checkDotnet(executable: string): Promise<boolean> {
        return new Promise((resolve) => {
            const proc = cp.spawn(executable, ['--version'], { shell: true });
            proc.on('close', (code) => resolve(code === 0));
            proc.on('error', ()     => resolve(false));
        });
    }

    private dotnetExe(): string {
        return vscode.workspace.getConfiguration('dotliquid').get<string>('dotnetPath', 'dotnet');
    }

    private _rejectAll(message: string): void {
        for (const [, resolve] of this._pending) {
            resolve(this.errResult(message));
        }
        this._pending.clear();
    }

    private errResult(message: string): RenderResult {
        return {
            success: false, output: '', variables: [],
            lineMappings: [], errors: [{ message }], renderTimeMs: 0
        };
    }

    dispose(): void {
        this._proc?.kill();
        this._proc = null;
    }
}
