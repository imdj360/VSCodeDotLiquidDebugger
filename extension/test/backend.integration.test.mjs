import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import Module from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, '..');
const BACKEND_JS = resolve(EXT_ROOT, 'out/backend.js');
const require = Module.createRequire(import.meta.url);

function nextTick() {
    return new Promise(resolve => setImmediate(resolve));
}

class FakeChildProcess extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.writes = [];
        const stdinEmitter = new EventEmitter();
        this.stdin = Object.assign(stdinEmitter, {
            write: (chunk, cb) => {
                this.writes.push(chunk.toString());
                if (cb) { cb(null); }
                return true;
            }
        });
    }

    kill() {
        this.emit('exit', 0, 'SIGTERM');
    }
}

class AsyncKillChildProcess extends FakeChildProcess {
    kill() {
        queueMicrotask(() => this.emit('exit', 0, 'SIGTERM'));
    }
}

function makeVscodeMock(overrides = {}) {
    const output = {
        chunks: [],
        showCalls: 0,
        disposeCalls: 0,
        append(text) { this.chunks.push(String(text)); },
        appendLine(text) { this.chunks.push(`${String(text)}\n`); },
        show() { this.showCalls += 1; },
        dispose() { this.disposeCalls += 1; }
    };

    const showErrorMessageCalls = [];

    const vscode = {
        window: {
            createOutputChannel: () => output,
            withProgress: async (_opts, task) => task(),
            showErrorMessage: async (message, ...actions) => {
                showErrorMessageCalls.push({ message, actions });
                return undefined;
            }
        },
        workspace: {
            getConfiguration: () => ({
                get: (_name, def) => def
            })
        },
        ProgressLocation: {
            Notification: 15
        }
    };

    if (overrides.window) {
        Object.assign(vscode.window, overrides.window);
    }
    if (overrides.workspace) {
        Object.assign(vscode.workspace, overrides.workspace);
    }

    return { vscode, output, showErrorMessageCalls };
}

function loadBackendWithMocks({ cpMock, fsMock, vscodeMock }) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'child_process') {
            return cpMock;
        }
        if (request === 'fs') {
            return fsMock;
        }
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[BACKEND_JS];
        return require(BACKEND_JS);
    } finally {
        Module._load = originalLoad;
    }
}

function okResponse(id, outputText) {
    return {
        id,
        success: true,
        output: outputText,
        variables: [],
        lineMappings: [],
        errors: [],
        renderTimeMs: 1
    };
}

test('LiquidBackend pairs concurrent requests by id even with out-of-order responses', async () => {
    const proc = new FakeChildProcess();
    const cpMock = { spawn: () => proc };
    const fsMock = { existsSync: () => true };
    const { vscode } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const p1 = backend.render({ template: 'A', inputJson: '{}', wrapContent: false });
    const p2 = backend.render({ template: 'B', inputJson: '{}', wrapContent: false });
    await nextTick();

    assert.equal(proc.writes.length, 2, 'expected two NDJSON writes');

    const req1 = JSON.parse(proc.writes[0]);
    const req2 = JSON.parse(proc.writes[1]);
    assert.equal(req1.id, 1);
    assert.equal(req2.id, 2);

    const secondLine = `${JSON.stringify(okResponse(2, 'second'))}\n`;
    const firstLine = `${JSON.stringify(okResponse(1, 'first'))}\n`;
    proc.stdout.emit('data', Buffer.from(secondLine.slice(0, 12)));
    proc.stdout.emit('data', Buffer.from(secondLine.slice(12)));
    proc.stdout.emit('data', Buffer.from(firstLine));

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.output, 'first');
    assert.equal(r2.output, 'second');

    backend.dispose();
});

test('LiquidBackend buffers partial response lines across stdout chunks', async () => {
    const proc = new FakeChildProcess();
    const cpMock = { spawn: () => proc };
    const fsMock = { existsSync: () => true };
    const { vscode } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const pending = backend.render({ template: 'A', inputJson: '{}', wrapContent: false });
    await nextTick();

    const line = `${JSON.stringify(okResponse(1, 'fragmented'))}\n`;
    proc.stdout.emit('data', Buffer.from(line.slice(0, 18)));
    await nextTick();
    proc.stdout.emit('data', Buffer.from(line.slice(18)));

    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.output, 'fragmented');

    backend.dispose();
});

test('LiquidBackend rejects in-flight request on renderer exit and respawns on next render', async () => {
    const proc1 = new FakeChildProcess();
    const proc2 = new FakeChildProcess();
    let spawnCalls = 0;

    const cpMock = {
        spawn: () => {
            spawnCalls += 1;
            return spawnCalls === 1 ? proc1 : proc2;
        }
    };
    const fsMock = { existsSync: () => true };
    const { vscode } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const first = backend.render({ template: 'x', inputJson: '{}', wrapContent: false });
    await nextTick();
    proc1.emit('exit', 1, null);

    const firstResult = await first;
    assert.equal(firstResult.success, false);
    assert.match(firstResult.errors[0].message, /exited unexpectedly/i);

    const second = backend.render({ template: 'y', inputJson: '{}', wrapContent: false });
    await nextTick();
    proc2.stdout.emit('data', Buffer.from(`${JSON.stringify(okResponse(2, 'after-respawn'))}\n`));

    const secondResult = await second;
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.output, 'after-respawn');
    assert.equal(spawnCalls, 2, 'expected respawn for second render');

    backend.dispose();
});

test('dispose() while request is in-flight resolves request and disposes output channel', async () => {
    const proc = new FakeChildProcess();
    const cpMock = { spawn: () => proc };
    const fsMock = { existsSync: () => true };
    const { vscode, output } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const pending = backend.render({ template: 'z', inputJson: '{}', wrapContent: false });
    await nextTick();
    backend.dispose();

    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.errors[0].message, /stopped/i);
    assert.equal(output.disposeCalls, 1);
});

test('dispose() with async kill rejects pending request once and clears cleanly', async () => {
    const proc = new AsyncKillChildProcess();
    const cpMock = { spawn: () => proc };
    const fsMock = { existsSync: () => true };
    const { vscode, output } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const pending = backend.render({ template: 'z', inputJson: '{}', wrapContent: false });
    await nextTick();
    backend.dispose();

    const result = await pending;
    await nextTick();

    assert.equal(result.success, false);
    assert.match(result.errors[0].message, /stopped/i);
    assert.equal(output.disposeCalls, 1);
});

test('build failure with "Show Output" action opens the output channel', async () => {
    const versionProc = new FakeChildProcess();
    const buildProc = new FakeChildProcess();

    const cpMock = {
        spawn: (_exe, args) => {
            if (args[0] === '--version') {
                queueMicrotask(() => versionProc.emit('close', 0));
                return versionProc;
            }
            if (args[0] === 'build') {
                queueMicrotask(() => {
                    buildProc.stdout.emit('data', Buffer.from('MSBuild line\n'));
                    buildProc.stderr.emit('data', Buffer.from('error A\nerror B\n'));
                    buildProc.emit('close', 1);
                });
                return buildProc;
            }
            throw new Error(`unexpected spawn args: ${args.join(' ')}`);
        }
    };

    const fsMock = { existsSync: () => false };
    const { vscode, output, showErrorMessageCalls } = makeVscodeMock({
        window: {
            showErrorMessage: async (message, ...actions) => {
                showErrorMessageCalls.push({ message, actions });
                return 'Show Output';
            }
        }
    });

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const built = await backend.buildRenderer();
    await nextTick();

    assert.equal(built, false);
    assert.equal(showErrorMessageCalls.length, 1);
    assert.equal(showErrorMessageCalls[0].actions[0], 'Show Output');
    assert.match(showErrorMessageCalls[0].message, /renderer build failed/i);
    assert.ok(output.chunks.join('').includes('error A'));
    assert.equal(output.showCalls, 1, 'expected output channel to be shown');

    backend.dispose();
});

test('checkDotnet failure surfaces .NET SDK guidance and skips build', async () => {
    const versionProc = new FakeChildProcess();
    let buildSpawned = false;

    const cpMock = {
        spawn: (_exe, args) => {
            if (args[0] === '--version') {
                queueMicrotask(() => versionProc.emit('close', 1));
                return versionProc;
            }
            if (args[0] === 'build') {
                buildSpawned = true;
            }
            throw new Error(`unexpected spawn args: ${args.join(' ')}`);
        }
    };
    const fsMock = { existsSync: () => false };
    const { vscode, showErrorMessageCalls } = makeVscodeMock();

    const { LiquidBackend } = loadBackendWithMocks({ cpMock, fsMock, vscodeMock: vscode });
    const backend = new LiquidBackend({ extensionPath: '/fake-ext' });

    const built = await backend.buildRenderer();

    assert.equal(built, false);
    assert.equal(buildSpawned, false);
    assert.equal(showErrorMessageCalls.length, 1);
    assert.match(showErrorMessageCalls[0].message, /\.NET 8 SDK/i);

    backend.dispose();
});

test('vsce package listing includes backend runtime entrypoints', () => {
    const res = spawnSync('npx', ['@vscode/vsce', 'ls'], {
        cwd: EXT_ROOT,
        encoding: 'utf8'
    });

    assert.equal(res.status, 0, `vsce ls failed:\n${res.stderr || res.stdout}`);

    const files = new Set(
        res.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
    );

    assert.ok(files.has('out/backend.js'));
    assert.ok(files.has('backend/DotLiquidRenderer/DotLiquidRenderer.csproj'));
    assert.ok(files.has('backend/DotLiquidRenderer/Program.cs'));

    // Packaging may include prebuilt renderer binaries, or rely on first-run build.
    // At least one boot path must be present.
    const hasPrebuiltRenderer = files.has('backend/renderer/DotLiquidRenderer.dll');
    const hasBuildInputs = files.has('backend/DotLiquidRenderer/DotLiquidRenderer.csproj')
        && files.has('backend/DotLiquidRenderer/Program.cs');
    assert.ok(
        hasPrebuiltRenderer || hasBuildInputs,
        'package must include either prebuilt renderer binaries or backend build inputs'
    );
});
