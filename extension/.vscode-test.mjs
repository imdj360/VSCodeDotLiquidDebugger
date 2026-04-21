import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    files: 'out/test/integration/**/*.test.js',
    extensionDevelopmentPath: __dirname,
    workspaceFolder: path.resolve(__dirname, '../docs'),
    // Disable all user-installed extensions — only our dev extension loads.
    // Prevents Copilot / C# DevKit from overwhelming the extension host.
    launchArgs: ['--disable-extensions'],
    mocha: { timeout: 30000 }
});
