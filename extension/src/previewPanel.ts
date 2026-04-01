import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LiquidBackend, RenderResult } from './backend';

export class PreviewPanel {
    public static currentPanel: PreviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private liquidUri: vscode.Uri;
    private decorationType: vscode.TextEditorDecorationType;

    private constructor(
        private context: vscode.ExtensionContext,
        private backend: LiquidBackend,
        liquidUri: vscode.Uri
    ) {
        this.liquidUri = liquidUri;

        this.panel = vscode.window.createWebviewPanel(
            'dotliquidPreview',
            `DotLiquid: ${path.basename(liquidUri.fsPath)}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media')
                ]
            }
        );

        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            borderRadius: '2px',
            isWholeLine: true
        });

        this.panel.webview.html = this.loadWebviewHtml();

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'run':
                        await this.run();
                        break;
                    case 'highlightLine':
                        this.highlightTemplateLine(message.line as number);
                        break;
                    case 'openInputFile':
                        await this.openInputFile();
                        break;
                    case 'copyOutput':
                        await vscode.env.clipboard.writeText(message.text as string);
                        vscode.window.showInformationMessage('Output copied to clipboard.');
                        break;
                }
            },
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Auto-run after webview has loaded
        setTimeout(() => this.run(), 200);
    }

    public static createOrShow(
        context: vscode.ExtensionContext,
        backend: LiquidBackend,
        liquidUri: vscode.Uri
    ): PreviewPanel {
        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            PreviewPanel.currentPanel.liquidUri = liquidUri;
            PreviewPanel.currentPanel.panel.title =
                `DotLiquid: ${path.basename(liquidUri.fsPath)}`;
            setTimeout(() => PreviewPanel.currentPanel?.run(), 100);
            return PreviewPanel.currentPanel;
        }

        PreviewPanel.currentPanel = new PreviewPanel(context, backend, liquidUri);
        return PreviewPanel.currentPanel;
    }

    /** Returns true if fileName is either the tracked .liquid template or its paired .liquid.json input. */
    public isTrackedFile(fileName: string): boolean {
        const liquidPath = this.liquidUri.fsPath;
        const inputPath  = liquidPath.replace(/\.liquid$/, '.liquid.json');
        return fileName === liquidPath || fileName === inputPath;
    }

    public async run(): Promise<void> {
        const liquidPath = this.liquidUri.fsPath;

        // Read template — prefer open editor (unsaved changes) over disk
        let templateText: string;
        try {
            const openDoc = vscode.workspace.textDocuments.find(
                d => d.fileName === liquidPath
            );
            templateText = openDoc
                ? openDoc.getText()
                : fs.readFileSync(liquidPath, 'utf8');
        } catch {
            this.postResult(this.makeError(`Cannot read template: ${liquidPath}`), {
                inputFileExists: false,
                inputFileName: '',
                templateFileName: path.basename(liquidPath),
                wrapContent: true
            });
            return;
        }

        // Paired input file: <name>.liquid.json
        const inputPath = liquidPath.replace(/\.liquid$/, '.liquid.json');
        let inputJson = '{}';
        let inputFileExists = false;

        if (fs.existsSync(inputPath)) {
            inputFileExists = true;
            try {
                const openDoc = vscode.workspace.textDocuments.find(
                    d => d.fileName === inputPath
                );
                inputJson = openDoc
                    ? openDoc.getText()
                    : fs.readFileSync(inputPath, 'utf8');
            } catch {
                this.postResult(this.makeError(`Cannot read input file: ${inputPath}`), {
                    inputFileExists: false,
                    inputFileName: path.basename(inputPath),
                    templateFileName: path.basename(liquidPath),
                    wrapContent: true
                });
                return;
            }
        }

        const cfg = vscode.workspace.getConfiguration('dotliquid');
        const wrapContent = cfg.get<boolean>('wrapContentObject', true);

        this.panel.webview.postMessage({ command: 'loading' });

        const result = await this.backend.render({
            template: templateText,
            inputJson,
            wrapContent
        });

        this.postResult(result, {
            inputFileExists,
            inputFileName: path.basename(inputPath),
            templateFileName: path.basename(liquidPath),
            wrapContent
        });
    }

    private postResult(
        result: RenderResult,
        meta: {
            inputFileExists: boolean;
            inputFileName: string;
            templateFileName: string;
            wrapContent: boolean;
        }
    ): void {
        this.panel.webview.postMessage({
            command: 'result',
            result,
            ...meta
        });
    }

    private highlightTemplateLine(line: number): void {
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.fileName === this.liquidUri.fsPath
        );
        if (!editor || line < 1) { return; }

        const lineIndex = line - 1;
        if (lineIndex >= editor.document.lineCount) { return; }

        const range = editor.document.lineAt(lineIndex).range;
        editor.setDecorations(this.decorationType, [range]);
        editor.revealRange(
            range,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );

        // Clear highlight after 2s
        setTimeout(() => editor.setDecorations(this.decorationType, []), 2000);
    }

    private async openInputFile(): Promise<void> {
        const inputPath = this.liquidUri.fsPath.replace(/\.liquid$/, '.liquid.json');
        if (!fs.existsSync(inputPath)) {
            await vscode.commands.executeCommand('dotliquid.createInputFile');
        } else {
            const doc = await vscode.workspace.openTextDocument(inputPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
    }

    private makeError(message: string): RenderResult {
        return {
            success: false,
            output: '',
            variables: [],
            lineMappings: [],
            errors: [{ message }],
            renderTimeMs: 0
        };
    }

    private loadWebviewHtml(): string {
        const htmlPath = path.join(
            this.context.extensionPath, 'media', 'preview.html'
        );
        return fs.readFileSync(htmlPath, 'utf8');
    }

    public dispose(): void {
        PreviewPanel.currentPanel = undefined;
        this.decorationType.dispose();
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
