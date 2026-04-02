import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LiquidBackend } from './backend';
import { PreviewPanel } from './previewPanel';

let backend: LiquidBackend | undefined;
let previewPanel: PreviewPanel | undefined;

class DotLiquidDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{
            type: 'dotliquid',
            request: 'launch',
            name: 'DotLiquid: ${fileBasenameNoExtension}',
            template: '${file}'
        }];
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined> {
        const wsFolder = folder?.uri.fsPath
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ?? '';

        // Resolve template path
        let templatePath = (config.template as string | undefined) ?? '${file}';
        templatePath = templatePath
            .replace('${file}', vscode.window.activeTextEditor?.document.fileName ?? '')
            .replace('${workspaceFolder}', wsFolder);

        if (!templatePath || !templatePath.endsWith('.liquid') || !fs.existsSync(templatePath)) {
            vscode.window.showErrorMessage('DotLiquid: "template" must point to an existing .liquid file.');
            return undefined;
        }

        // Resolve input path — auto-detect, then file picker
        let inputPath = (config.input as string | undefined)?.replace('${workspaceFolder}', wsFolder);
        if (!inputPath) {
            const autoInput = templatePath.replace(/\.liquid$/, '.liquid.json');
            if (fs.existsSync(autoInput)) {
                inputPath = autoInput;
            } else {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'JSON Files': ['json'] },
                    title: `Select input JSON for ${path.basename(templatePath)}`
                });
                inputPath = picked?.[0]?.fsPath;
            }
        }

        // Open template in editor then open/reuse preview panel
        const doc = await vscode.workspace.openTextDocument(templatePath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        previewPanel = PreviewPanel.createOrShow(this.context, backend!, vscode.Uri.file(templatePath));

        // Return undefined — cancels the debug session (no real adapter needed)
        return undefined;
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('DotLiquid Debugger activating...');

    backend = new LiquidBackend(context);

    // Command: Open Preview Panel
    const openPreview = vscode.commands.registerCommand('dotliquid.openPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.liquid')) {
            vscode.window.showWarningMessage('Open a .liquid file first.');
            return;
        }
        previewPanel = PreviewPanel.createOrShow(context, backend!, editor.document.uri);
    });

    // Command: Run Template (F5)
    const runTemplate = vscode.commands.registerCommand('dotliquid.runTemplate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.liquid')) {
            vscode.window.showWarningMessage('Open a .liquid file first.');
            return;
        }
        if (!previewPanel) {
            previewPanel = PreviewPanel.createOrShow(context, backend!, editor.document.uri);
        }
        if (!previewPanel) { return; } // panel creation failed (e.g. missing media/preview.html)
        await previewPanel.run();
    });

    // Command: Create paired input JSON
    const createInput = vscode.commands.registerCommand('dotliquid.createInputFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const liquidPath = editor.document.fileName;
        const inputPath = liquidPath.replace(/\.liquid$/, '.liquid.json');

        if (fs.existsSync(inputPath)) {
            vscode.window.showInformationMessage(`Input file already exists: ${path.basename(inputPath)}`);
            vscode.workspace.openTextDocument(inputPath).then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside));
            return;
        }

        const sample = {
            "field1": "value1",
            "field2": "value2",
            "items": [
                { "name": "Item 1", "qty": 1 },
                { "name": "Item 2", "qty": 2 }
            ]
        };

        try {
            fs.writeFileSync(inputPath, JSON.stringify(sample, null, 2));
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `DotLiquid Debugger: could not create input file — ${(err as Error).message}`
            );
            return;
        }
        const doc = await vscode.workspace.openTextDocument(inputPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(`Created ${path.basename(inputPath)} — edit this as your template input.`);
    });

    // Auto-refresh on document save — only for the panel's tracked template/input pair
    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const cfg = vscode.workspace.getConfiguration('dotliquid');
        if (!cfg.get<boolean>('autoRefresh', true)) return;
        if (!previewPanel) return;

        if (previewPanel.isTrackedFile(doc.fileName)) {
            await previewPanel.run();
        }
    });

    // Auto-refresh on text change (debounced) — only for the panel's tracked template/input pair
    let debounceTimer: NodeJS.Timeout | undefined;
    const onTextChange = vscode.workspace.onDidChangeTextDocument((event) => {
        const cfg = vscode.workspace.getConfiguration('dotliquid');
        if (!cfg.get<boolean>('autoRefresh', true)) return;
        if (!previewPanel) return;

        if (previewPanel.isTrackedFile(event.document.fileName)) {
            const delay = cfg.get<number>('refreshDebounceMs', 500);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                if (previewPanel) await previewPanel.run();
            }, delay);
        }
    });

    const debugProvider = vscode.debug.registerDebugConfigurationProvider(
        'dotliquid',
        new DotLiquidDebugConfigurationProvider(context)
    );

    context.subscriptions.push(
        openPreview, runTemplate, createInput, onSave, onTextChange, debugProvider,
        { dispose: () => { if (debounceTimer) { clearTimeout(debounceTimer); } } }
    );
}

export function deactivate() {
    backend?.dispose();
}
