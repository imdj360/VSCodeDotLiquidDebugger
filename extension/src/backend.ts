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

export interface FilterCall {
    name: string;
    input: string;
    arg?: string;
    output: string;
}

export interface StepRecord {
    line: number;
    outputEnd: number;
    stepType: string;
    condition?: string;
    variables: Record<string, string>;
    filterCalls?: FilterCall[];
}

export interface RenderResult {
    success: boolean;
    output: string;
    variables: TraceVariable[];
    lineMappings: LineMapping[];
    steps: StepRecord[];
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
    private _disposing  = false;
    private _disposed   = false;
    private readonly _output: vscode.OutputChannel;

    private readonly backendDir:  string;
    private readonly rendererDll: string;
    private readonly projectDir:  string;

    constructor(private context: vscode.ExtensionContext) {
        this.backendDir  = path.join(context.extensionPath, 'backend');
        this.rendererDll = path.join(this.backendDir, 'renderer', 'DotLiquidRenderer.dll');
        this.projectDir  = path.join(this.backendDir, 'DotLiquidRenderer');
        this._output     = vscode.window.createOutputChannel('DotLiquid Debugger');
    }

    async render(request: RenderRequest): Promise<RenderResult> {
        if (this._disposed) {
            return this.errResult('Renderer backend has been disposed.');
        }

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
            try {
                proc.stdin!.write(JSON.stringify(wire) + '\n', (err) => {
                    if (err) {
                        const r = this._pending.get(id);
                        if (r) {
                            this._pending.delete(id);
                            r(this.errResult(`Write to renderer failed: ${err.message}`));
                        }
                    }
                });
            } catch (err: unknown) {
                this._pending.delete(id);
                resolve(this.errResult(`Write to renderer failed: ${(err as Error).message}`));
            }
        });
    }

    private async ensureProcess(): Promise<cp.ChildProcess | null> {
        if (this._disposed) { return null; }
        if (this._proc) { return this._proc; }

        if (!fs.existsSync(this.rendererDll)) {
            const built = await this.buildRenderer();
            if (!built) { return null; }
        }

        const dotnet = this.dotnetExe();
        const proc   = cp.spawn(dotnet, [this.rendererDll], { env: process.env });
        this._disposing = false;

        proc.stdout!.on('data', (data: Buffer) => {
            this._lineBuffer += data.toString();
            const lines = this._lineBuffer.split('\n');
            this._lineBuffer = lines.pop() ?? '';
            for (const ln of lines) {
                if (!ln.trim()) { continue; }
                let wire: WireResult | undefined;
                try {
                    wire = JSON.parse(ln) as WireResult;
                } catch {
                    // Malformed line — extract the id via regex so we can fail
                    // the specific request rather than leaving it hung forever.
                    const idMatch = ln.match(/"id"\s*:\s*(\d+)/);
                    if (idMatch) {
                        const id      = parseInt(idMatch[1], 10);
                        const resolve = this._pending.get(id);
                        if (resolve) {
                            this._pending.delete(id);
                            resolve(this.errResult('Renderer returned malformed output.'));
                        }
                    }
                    continue;
                }
                const resolve = this._pending.get(wire.id);
                if (resolve) {
                    this._pending.delete(wire.id);
                    resolve(wire);
                }
            }
        });

        // Drain stderr into the output channel so pipe buffer never fills
        proc.stderr!.on('data', (data: Buffer) => {
            this._output.append(data.toString());
        });

        proc.on('exit', () => {
            const wasDisposing = this._disposing;
            this._disposing = false;
            if (!wasDisposing) {
                this._rejectAll('Renderer process exited unexpectedly. It will respawn on next render.');
            }
            this._proc = null;
        });

        proc.on('error', (err) => {
            this._rejectAll(`Failed to start renderer: ${err.message}`);
            this._proc = null;
        });

        // A broken pipe or premature close on stdin must reject in-flight requests
        // rather than leaving them hung.  This fires if the child dies between
        // ensureProcess() returning and the write completing.
        proc.stdin!.on('error', () => {
            // The 'exit' handler will also fire and call _rejectAll; this is
            // a no-op if _pending is already empty, so duplicate calls are safe.
            this._rejectAll('Renderer stdin closed unexpectedly.');
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
        this._output.appendLine('[DotLiquid] Building renderer…');

        return vscode.window.withProgress(
            {
                location:    vscode.ProgressLocation.Notification,
                title:       'DotLiquid Debugger: Building renderer (first run, ~10s)…',
                cancellable: false
            },
            () => new Promise<boolean>((resolve) => {
                let buildOutput = '';
                const proc = cp.spawn(
                    dotnet,
                    ['build', '-c', 'Release', '-o', outDir],
                    { cwd: this.projectDir, env: process.env }
                );
                proc.stdout!.on('data', (d: Buffer) => {
                    const text = d.toString();
                    this._output.append(text);
                    buildOutput += text;
                });
                proc.stderr!.on('data', (d: Buffer) => {
                    const text = d.toString();
                    this._output.append(text);
                    buildOutput += text;
                });
                proc.on('close', (code) => {
                    if (code !== 0) {
                        const tail = buildOutput.trim().split('\n').slice(-5).join('\n');
                        void vscode.window.showErrorMessage(
                            `DotLiquid Debugger: renderer build failed.\n${tail}\n\nFull output: DotLiquid Debugger output channel.`,
                            'Show Output'
                        ).then(action => { if (action === 'Show Output') { this._output.show(); } });
                    }
                    resolve(code === 0);
                });
                proc.on('error', (err) => {
                    this._output.appendLine(`[DotLiquid] Build process error: ${err.message}`);
                    resolve(false);
                });
            })
        );
    }

    private async checkDotnet(executable: string): Promise<boolean> {
        return new Promise((resolve) => {
            const proc = cp.spawn(executable, ['--version']);
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
            lineMappings: [], steps: [], errors: [{ message }], renderTimeMs: 0
        };
    }

    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;

        const proc = this._proc;
        this._proc = null;

        if (proc) {
            this._disposing = true;
            this._rejectAll('Renderer process stopped.');
            proc.kill();
        } else {
            this._rejectAll('Renderer process stopped.');
        }
        this._output.dispose();
    }
}
