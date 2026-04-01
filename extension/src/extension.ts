import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LiquidBackend } from './backend';
import { PreviewPanel } from './previewPanel';

let backend: LiquidBackend | undefined;
let previewPanel: PreviewPanel | undefined;

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

        fs.writeFileSync(inputPath, JSON.stringify(sample, null, 2));
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

    context.subscriptions.push(openPreview, runTemplate, createInput, onSave, onTextChange);
}

export function deactivate() {
    backend?.dispose();
}
