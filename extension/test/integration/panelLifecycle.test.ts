// Integration tests for PreviewPanel lifecycle and inputUri handling.
// Compiled to CJS (tsconfig.test.json) and run inside a real VS Code instance
// via @vscode/test-electron.
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';

// Resolve compiled output relative to this file's location in out/test/integration/
const EXT_OUT = path.resolve(__dirname, '../..');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const getPreviewPanel  = () => require(path.join(EXT_OUT, 'previewPanel')).PreviewPanel;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getExtExports    = () => require(path.join(EXT_OUT, 'extension'));

suite('Panel lifecycle', () => {
    let liquidUri: vscode.Uri;
    let pairedInputUri: vscode.Uri;
    let otherInputUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension('danieljonathan.dotliquid-template-debugger');
        await ext?.activate();

        const files = await vscode.workspace.findFiles('person-transform.liquid', undefined, 1);
        assert.ok(files.length > 0, 'workspace must contain person-transform.liquid');
        liquidUri      = files[0];
        pairedInputUri = vscode.Uri.file(liquidUri.fsPath.replace('.liquid', '.liquid.json'));
        otherInputUri  = vscode.Uri.file(
            path.join(path.dirname(liquidUri.fsPath), 'invoice-flat.liquid.json')
        );

        const doc = await vscode.workspace.openTextDocument(liquidUri);
        await vscode.window.showTextDocument(doc);
    });

    suiteTeardown(() => {
        getPreviewPanel().currentPanel?.dispose();
    });

    setup(() => {
        getPreviewPanel().currentPanel?.dispose();
    });

    // -------------------------------------------------------------------------
    // Bug: panel could not be reopened after closing — stale module-level ref
    // -------------------------------------------------------------------------
    test('panel is created on first openPreview', async () => {
        await vscode.commands.executeCommand('dotliquid.openPreview');
        assert.ok(getPreviewPanel().currentPanel, 'panel should be open after command');
    });

    test('panel reopens cleanly after being closed', async () => {
        await vscode.commands.executeCommand('dotliquid.openPreview');
        const panel1 = getPreviewPanel().currentPanel;
        assert.ok(panel1, 'panel should open on first command');

        panel1.dispose();
        assert.strictEqual(getPreviewPanel().currentPanel, undefined,
            'currentPanel must be cleared on dispose');

        // This was a silent no-op before the fix
        await vscode.commands.executeCommand('dotliquid.openPreview');
        const panel2 = getPreviewPanel().currentPanel;

        assert.ok(panel2, 'panel should reopen after close');
        assert.notStrictEqual(panel1, panel2, 'should be a new instance, not the disposed one');
    });

    // -------------------------------------------------------------------------
    // Bug: file picker result was discarded — inputUri never forwarded to panel
    // -------------------------------------------------------------------------
    test('explicit inputUri is stored and used for file tracking', () => {
        const PreviewPanel = getPreviewPanel();
        const { extensionContext, extensionBackend } = getExtExports();

        assert.ok(extensionContext,  'extensionContext must be set after activation');
        assert.ok(extensionBackend, 'extensionBackend must be set after activation');

        const panel = PreviewPanel.createOrShow(
            extensionContext, extensionBackend, liquidUri, otherInputUri
        );
        assert.ok(panel, 'panel should be created');

        assert.ok(panel.isTrackedFile(otherInputUri.fsPath),
            'should track the explicit inputUri');
        assert.ok(panel.isTrackedFile(liquidUri.fsPath),
            'should always track the template itself');
        assert.ok(!panel.isTrackedFile(pairedInputUri.fsPath),
            'should NOT fall back to .liquid.json convention when inputUri is explicit');
    });
});
