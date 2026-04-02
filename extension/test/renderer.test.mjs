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

function runRendererRawLine(rawLine) {
    return new Promise((resolve, reject) => {
        const proc = spawn(DOTNET, [RENDERER]);
        let buffer = '';
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('Renderer timed out waiting for raw-line response'));
        }, 10_000);

        proc.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const ln of lines) {
                if (!ln.trim()) { continue; }
                clearTimeout(timer);
                proc.kill();
                resolve(JSON.parse(ln));
                return;
            }
        });

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.stdin.write(rawLine + '\n');
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

test('capture variables appear in the variables list with their source line', async () => {
    const [res] = await runRenderer([{
        id: 9,
        template:  '{% capture greeting %}hello{% endcapture %}\n{{ greeting }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const v = res.variables.find(v => v.name === 'greeting');
    assert.ok(v, 'expected "greeting" variable');
    assert.equal(v.value, 'hello');
    assert.equal(v.line, 1);

    const captureAssignStep = res.steps.find(s => s.line === 1 && s.stepType === 'assign');
    assert.equal(captureAssignStep, undefined, 'capture should not synthesize an assign filter step');
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

test('root array input with wrapContent=true exposes array as content', async () => {
    const [res] = await runRenderer([{
        id: 61,
        template:  '{% for item in content %}{{ item.name }} {% endfor %}',
        inputJson: '[{"name":"Alice"},{"name":"Bob"}]',
        wrapContent: true
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

test('malformed wire request still returns the extracted id when present', async () => {
    const res = await runRendererRawLine('{"id":77,"template":');

    assert.equal(res.id, 77);
    assert.equal(res.success, false);
    assert.ok(res.errors.length > 0);
    assert.match(res.errors[0].message, /Backend error:/);
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

test('step records include structural metadata for control-flow checkpoints', async () => {
    const [res] = await runRenderer([{
        id: 62,
        template:  '{% for item in content.items %}\n{% if item.show %}{{ item.name }}{% endif %}\n{% endfor %}',
        inputJson: '{"items":[{"name":"A","show":true},{"name":"B","show":false}]}',
        wrapContent: true
    }]);

    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.steps));

    const forStep = res.steps.find(s => s.stepType === 'for');
    const ifStep = res.steps.find(s => s.stepType === 'if');

    assert.ok(forStep, 'expected a for step');
    assert.equal(forStep.line, 1);
    assert.equal(forStep.condition, 'item in content.items');
    assert.ok(typeof forStep.outputEnd === 'number');

    assert.ok(ifStep, 'expected an if step');
    assert.equal(ifStep.line, 2);
    assert.equal(ifStep.condition, 'item.show');
    assert.ok(typeof ifStep.outputEnd === 'number');
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

// ── Filter call tracing tests ─────────────────────────────────────────────────

test('assign step with a math filter includes filterCalls', async () => {
    const [res] = await runRenderer([{
        id: 20,
        template:  '{% assign total = 10 | Times: 5 %}{{ total }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step,                          'expected an assign step');
    assert.ok(Array.isArray(step.filterCalls), 'filterCalls must be an array');
    assert.equal(step.filterCalls.length, 1, 'one filter call for | Times:');
    const fc = step.filterCalls[0];
    assert.equal(fc.name,   'Times');
    assert.equal(fc.input,  '10');
    assert.equal(fc.arg,    '5');
    assert.equal(fc.output, '50');
});

test('chained math filters appear in order with intermediate values', async () => {
    const [res] = await runRenderer([{
        id: 21,
        template:  '{% assign result = 100 | Times: 5 | DividedBy: 10 | Round: 0 %}{{ result }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step);
    assert.equal(step.filterCalls.length, 3, 'three chained filters');

    assert.equal(step.filterCalls[0].name,   'Times');
    assert.equal(step.filterCalls[0].input,  '100');
    assert.equal(step.filterCalls[0].output, '500');    // 100 × 5

    assert.equal(step.filterCalls[1].name,   'DividedBy');
    assert.equal(step.filterCalls[1].input,  '500');    // previous output threads as next input
    assert.equal(step.filterCalls[1].output, '50');     // 500 ÷ 10

    assert.equal(step.filterCalls[2].name,   'Round');
    assert.equal(step.filterCalls[2].input,  '50');     // previous output threads as next input
    assert.equal(step.filterCalls[2].output, '50');     // already a whole number
});

test('string filter Upcase is captured in filterCalls', async () => {
    const [res] = await runRenderer([{
        id: 22,
        template:  '{% assign loud = "hello" | Upcase %}{{ loud }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0, 'expected filter calls');
    const fc = step.filterCalls[0];
    assert.equal(fc.name,   'Upcase');
    assert.equal(fc.input,  'hello');
    assert.equal(fc.output, 'HELLO');
});

test('assign step without filters has empty filterCalls array', async () => {
    const [res] = await runRenderer([{
        id: 23,
        template:  '{% assign greeting = "hi" %}{{ greeting }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step);
    assert.ok(Array.isArray(step.filterCalls),   'filterCalls must always be an array');
    assert.equal(step.filterCalls.length, 0,     'no filters means empty array, not undefined');
});

test('filter parser does not split pipes inside quoted string literals', async () => {
    const [res] = await runRenderer([{
        id: 24,
        template:  '{% assign x = "a|b" | Upcase %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), 'A|B');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step);
    assert.equal(step.filterCalls.length, 1, 'expected exactly one real filter call');
    assert.equal(step.filterCalls[0].name, 'Upcase');
    assert.equal(step.filterCalls[0].input, 'a|b');
    assert.equal(step.filterCalls[0].output, 'A|B');
});

test('Replace with two args replays replacement output correctly', async () => {
    const [res] = await runRenderer([{
        id: 25,
        template:  '{% assign x = "abc" | Replace: "a", "z" %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), 'zbc');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0);
    const fc = step.filterCalls[0];
    assert.equal(fc.name, 'Replace');
    assert.equal(fc.arg, 'a');      // UI contract keeps first arg display
    assert.equal(fc.output, 'zbc'); // replay should match rendered result
});

test('Truncate replay uses DotLiquid three-dot omission', async () => {
    const [res] = await runRenderer([{
        id: 26,
        template:  '{% assign x = "abcdef" | Truncate: 3 %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), '...');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0);
    const fc = step.filterCalls[0];
    assert.equal(fc.name, 'Truncate');
    assert.equal(fc.output, '...');
});

test('Size on numeric input replays as 0', async () => {
    const [res] = await runRenderer([{
        id: 27,
        template:  '{% assign x = 42 | Size %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), '0');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0);
    const fc = step.filterCalls[0];
    assert.equal(fc.name, 'Size');
    assert.equal(fc.input, '42');
    assert.equal(fc.output, '0');
});

test('Size on string input replays as string length', async () => {
    const [res] = await runRenderer([{
        id: 31,
        template:  '{% assign x = "hello" | Size %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), '5');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0);
    const fc = step.filterCalls[0];
    assert.equal(fc.name, 'Size');
    assert.equal(fc.input, 'hello');
    assert.equal(fc.output, '5');
});

test('mixed-case sort replay matches rendered joined order', async () => {
    const [res] = await runRenderer([{
        id: 28,
        template:  '{% assign x = content.arr | Sort | Join: "," %}{{ x }}',
        inputJson: '{"arr":["Banana","apple"]}',
        wrapContent: true
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), 'apple,Banana');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step);
    assert.equal(step.filterCalls.length, 2);
    assert.equal(step.filterCalls[0].name, 'Sort');
    assert.equal(step.filterCalls[1].name, 'Join');
    assert.equal(step.filterCalls[1].input, step.filterCalls[0].output);
    assert.equal(step.filterCalls[1].output, 'apple,Banana');
});

test('Split | Join chain keeps enumerable values threaded between filters', async () => {
    const [res] = await runRenderer([{
        id: 29,
        template:  '{% assign x = "b,a" | Split: "," | Join: "|" %}{{ x }}',
        inputJson: '{}',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), 'b|a');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step);
    assert.equal(step.filterCalls.length, 2);
    assert.equal(step.filterCalls[0].name, 'Split');
    assert.equal(step.filterCalls[1].name, 'Join');
    assert.equal(step.filterCalls[1].input, step.filterCalls[0].output);
    assert.equal(step.filterCalls[1].arg, '|');
    assert.equal(step.filterCalls[1].output, 'b|a');
});

test('indexed path in assign replay resolves array element before filter', async () => {
    const [res] = await runRenderer([{
        id: 30,
        template:  '{% assign v = items[0].n | Times: 2 %}{{ v }}',
        inputJson: '[{"n":4}]',
        wrapContent: false
    }]);

    assert.equal(res.success, true);
    assert.equal(res.output.trim(), '8');

    const step = res.steps.find(s => s.stepType === 'assign');
    assert.ok(step?.filterCalls?.length > 0);
    const fc = step.filterCalls[0];
    assert.equal(fc.name, 'Times');
    assert.equal(fc.input, '4');
    assert.equal(fc.arg, '2');
    assert.equal(fc.output, '8');
});
