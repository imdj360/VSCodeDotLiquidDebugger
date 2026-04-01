/**
 * Regression tests for the DotLiquidRenderer subprocess.
 *
 * These are plain Node tests (node:test) — no VS Code runtime required.
 * They cover two concerns:
 *
 *   1. Renderer NDJSON protocol  — spawn DotLiquidRenderer.dll, send requests,
 *      assert responses.  This is the subprocess behaviour that backend.ts depends on.
 *
 *   2. Build failure subprocess  — run `dotnet build` against a bad project path,
 *      capture exit code and stderr.  This validates the plumbing that feeds the
 *      "Show Output" toast in buildRenderer() without needing the VS Code extension host.
 *
 * Run:  npm test
 * Pre:  backend/renderer/DotLiquidRenderer.dll must exist (built by `npm run build-renderer`)
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn }  from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const RENDERER    = resolve(__dirname, '../backend/renderer/DotLiquidRenderer.dll');
const DOTNET      = 'dotnet';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Send one or more NDJSON requests to a fresh renderer process and collect
 * the same number of NDJSON responses.  The process is killed after all
 * responses arrive or after a 10-second timeout.
 */
function runRenderer(requests) {
    return new Promise((resolve, reject) => {
        const proc     = spawn(DOTNET, [RENDERER]);
        let   buffer   = '';
        const results  = [];
        const timer    = setTimeout(() => {
            proc.kill();
            reject(new Error(`Renderer timed out waiting for ${requests.length} response(s)`));
        }, 10_000);

        proc.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const ln of lines) {
                if (!ln.trim()) { continue; }
                results.push(JSON.parse(ln));
                if (results.length === requests.length) {
                    clearTimeout(timer);
                    proc.kill();
                    resolve(results);
                }
            }
        });

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });

        for (const req of requests) {
            proc.stdin.write(JSON.stringify(req) + '\n');
        }
    });
}

/**
 * Spawn `dotnet build` against the given project directory and capture
 * exit code, stdout, and stderr.  Mirrors what buildRenderer() does in
 * backend.ts (minus the vscode.window calls).
 */
function runDotnetBuild(projectDir, outDir) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const proc = spawn(DOTNET, ['build', '-c', 'Release', '-o', outDir], { cwd: projectDir });
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close',  (code) => resolve({ code, stdout, stderr }));
        proc.on('error',  (err)  => resolve({ code: -1, stdout, stderr: err.message }));
    });
}

// ── Pre-flight ────────────────────────────────────────────────────────────────

before(() => {
    if (!existsSync(RENDERER)) {
        throw new Error(
            `Renderer not found at ${RENDERER}.\n` +
            `Run 'npm run build-renderer' first.`
        );
    }
});

// ── Renderer NDJSON protocol tests ────────────────────────────────────────────

test('happy path — simple template renders correctly', async () => {
    const [res] = await runRenderer([{
        id: 1,
        template:  'Hello {{ content.name | Upcase }}',
        inputJson: '{"name":"Alice"}',
        wrapContent: true
    }]);

    assert.equal(res.id,      1);
    assert.equal(res.success, true);
    assert.equal(res.output,  'Hello ALICE');
    assert.equal(res.errors.length, 0);
});

test('response echoes request id', async () => {
    const [res] = await runRenderer([{
        id: 42,
        template:  '{{ content.x }}',
        inputJson: '{"x":"ok"}',
        wrapContent: true
    }]);

    assert.equal(res.id, 42);
});

test('malformed input JSON — structured error, not a crash', async () => {
    const [res] = await runRenderer([{
        id: 2,
        template:  'Hello {{ content.name }}',
        inputJson: '{bad json',
        wrapContent: true
    }]);

    assert.equal(res.success, false);
    assert.ok(res.errors.length > 0, 'expected at least one error');
    assert.match(res.errors[0].message, /Input JSON is invalid:/);
});

test('process survives a bad request and handles the next one', async () => {
    const [bad, good] = await runRenderer([
        { id: 3, template: '{{ content.x }}', inputJson: '{bad',        wrapContent: true  },
        { id: 4, template: 'Hello {{ content.name }}', inputJson: '{"name":"Bob"}', wrapContent: true  }
    ]);

    assert.equal(bad.id,       3);
    assert.equal(bad.success,  false);

    assert.equal(good.id,      4);
    assert.equal(good.success, true);
    assert.equal(good.output,  'Hello Bob');
});

test('assign variables are captured with line numbers', async () => {
    const [res] = await runRenderer([{
        id: 5,
        template:  '{% assign greeting = "hi" %}\n{{ greeting }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const v = res.variables.find(v => v.name === 'greeting');
    assert.ok(v,              'expected "greeting" variable');
    assert.equal(v.value,     'hi');
    assert.equal(v.line,      1);
});

test('root array input with wrapContent=false exposes items', async () => {
    const [res] = await runRenderer([{
        id: 6,
        template:  '{% for item in items %}{{ item.name }} {% endfor %}',
        inputJson: '[{"name":"Alice"},{"name":"Bob"}]',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), 'Alice Bob');
});

test('parse error returns structured error with message', async () => {
    const [res] = await runRenderer([{
        id: 7,
        template:  '{% if unclosed',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, false);
    assert.ok(res.errors.length > 0);
    assert.match(res.errors[0].message, /[Pp]arse/);
});

test('lineMappings map output text back to template lines', async () => {
    const [res] = await runRenderer([{
        id: 8,
        template:  'line one\nline two',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.ok(res.lineMappings.length > 0, 'expected at least one line mapping');
    const m = res.lineMappings[0];
    assert.ok(typeof m.templateLine === 'number');
    assert.ok(typeof m.outputStart  === 'number');
    assert.ok(typeof m.outputEnd    === 'number');
    assert.ok(typeof m.outputText   === 'string');
});

// ── Build failure subprocess tests ───────────────────────────────────────────

test('build against nonexistent project dir — exit code != 0, stderr non-empty', async () => {
    const result = await runDotnetBuild('/tmp/does-not-exist-dotliquid-test', '/tmp/out-dotliquid-test');

    assert.notEqual(result.code, 0,
        `expected non-zero exit code, got ${result.code}`);

    const combined = result.stdout + result.stderr;
    assert.ok(combined.trim().length > 0,
        'expected diagnostic output from failed build');
});

test('build failure output contains diagnosable text (not silently empty)', async () => {
    const result = await runDotnetBuild('/tmp/does-not-exist-dotliquid-test', '/tmp/out-dotliquid-test');

    // The key property the Show Output toast depends on: there is *something*
    // in stderr/stdout to show the user.  An empty string here would mean the
    // toast body is blank and useless.
    const combined = (result.stdout + result.stderr).trim();
    const tail     = combined.split('\n').slice(-5).join('\n');

    assert.ok(tail.length > 0,
        'last-5-lines tail used in toast must not be empty on build failure');
});
