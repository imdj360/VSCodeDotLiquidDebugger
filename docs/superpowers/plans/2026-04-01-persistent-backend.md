# Persistent .NET Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-render `dotnet-script` spawning with a single long-lived `DotLiquidRenderer.dll` process that communicates via NDJSON over stdin/stdout, reducing render latency from ~300ms to ~5ms after first use.

**Architecture:** A .NET 8 console app reads newline-delimited JSON requests from stdin and writes responses to stdout, staying alive for the VS Code session. `backend.ts` spawns it once on first render, buffers stdout into lines, and pairs responses to callers using a numeric `id`. If the process crashes, an `on('exit')` handler nulls the reference so the next render triggers a clean respawn.

**Tech Stack:** .NET 8, DotLiquid 2.0.361, Newtonsoft.Json 13.0.3, TypeScript, VS Code Extension API

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/DotLiquidRenderer/DotLiquidRenderer.csproj` | Create | .NET project definition |
| `backend/DotLiquidRenderer/Program.cs` | Create | NDJSON loop + all render logic (replaces renderer.csx) |
| `backend/renderer/` | Generated (gitignored) | Compiled output from `dotnet build` |
| `extension/src/backend.ts` | Rewrite | Persistent process management, build bootstrap, NDJSON client |
| `extension/package.json` | Modify | Replace `dotnetScriptPath` setting with `dotnetPath` |
| `extension/media/preview.html` | Modify | Pretty-print toggle button + JS logic |
| `backend/renderer.csx` | Delete | Superseded by Program.cs |
| `.gitignore` | Modify | Add `backend/renderer/` |

---

## Task 1: .NET Project Scaffold

**Files:**
- Create: `backend/DotLiquidRenderer/DotLiquidRenderer.csproj`
- Create: `backend/DotLiquidRenderer/Program.cs` (minimal stub)

- [ ] **Step 1: Create the project file**

Create `backend/DotLiquidRenderer/DotLiquidRenderer.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="DotLiquid" Version="2.0.361" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Create a minimal Program.cs stub**

Create `backend/DotLiquidRenderer/Program.cs`:

```csharp
// Stub — replaced in Task 2
Console.WriteLine("DotLiquidRenderer ready");
```

- [ ] **Step 3: Verify the project builds**

Run from the repo root:
```bash
dotnet build backend/DotLiquidRenderer/DotLiquidRenderer.csproj -c Release
```

Expected output contains:
```
Build succeeded.
    0 Warning(s)
    0 Error(s)
```

- [ ] **Step 4: Commit scaffold**

```bash
git add backend/DotLiquidRenderer/
git commit -m "feat: add DotLiquidRenderer .NET project scaffold"
```

---

## Task 2: Full NDJSON Render Loop in Program.cs

**Files:**
- Modify: `backend/DotLiquidRenderer/Program.cs`

- [ ] **Step 1: Write the full Program.cs**

Replace `backend/DotLiquidRenderer/Program.cs` entirely:

```csharp
// Program.cs — DotLiquid renderer, NDJSON stdin/stdout loop
// Protocol: one JSON request per line → one JSON response per line
// Run: dotnet DotLiquidRenderer.dll (stays alive, reads until EOF)

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using DotLiquid;
using DotLiquid.NamingConventions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// ── One-time DotLiquid setup ──────────────────────────────────────────────────
Template.NamingConvention = new CSharpNamingConvention();
Template.RegisterTag<TraceTag>("__trace__");

// ── NDJSON loop ───────────────────────────────────────────────────────────────
string? line;
while ((line = Console.ReadLine()) != null) {
    if (string.IsNullOrWhiteSpace(line)) continue;
    var res = new RenderResult();
    var sw  = System.Diagnostics.Stopwatch.StartNew();
    try {
        var req = JsonConvert.DeserializeObject<RenderRequest>(line)
            ?? throw new Exception("Invalid request JSON");
        res.Id = req.Id;
        Render(req, res);
    } catch (Exception ex) {
        res.Errors.Add(new RenderError { Message = $"Backend error: {ex.Message}" });
    }
    sw.Stop();
    res.RenderTimeMs = (int)sw.ElapsedMilliseconds;
    Console.WriteLine(JsonConvert.SerializeObject(res));
}

// ── Render ────────────────────────────────────────────────────────────────────
static void Render(RenderRequest req, RenderResult res) {
    JObject inputObj;
    try {
        inputObj = JObject.Parse(req.InputJson);
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Input JSON is invalid: {ex.Message}", Line = el, Column = ec });
        return;
    }

    var dataDict = req.WrapContent
        ? new Dictionary<string, object> { ["content"] = JTokenToObject(inputObj) }
        : (Dictionary<string, object>)JTokenToObject(inputObj);
    var dataHash = Hash.FromDictionary(dataDict);

    var (assignLines, instrumented) = InstrumentTemplate(req.Template);

    Template template;
    try {
        template = Template.Parse(instrumented);
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Parse error: {ex.Message}", Line = el, Column = ec });
        return;
    }

    TraceTag.Records.Clear();
    string rawOutput;
    try {
        rawOutput = template.Render(new RenderParameters(CultureInfo.InvariantCulture) {
            LocalVariables    = dataHash,
            ErrorsOutputMode  = ErrorsOutputMode.Rethrow
        });
    } catch (Exception ex) {
        var (el, ec) = ParsePosition(ex.Message);
        res.Errors.Add(new RenderError { Message = $"Render error: {ex.Message}", Line = el, Column = ec });
        return;
    }

    if (template.Errors?.Count > 0) {
        foreach (var err in template.Errors) {
            var (el, ec) = ParsePosition(err.Message);
            res.Errors.Add(new RenderError { Message = err.Message, Line = el, Column = ec });
        }
    }

    // Variables — InstanceAssigns for post-render values, TraceTag for loop-scope
    var variables = new List<TraceVariable>();
    var seenVars  = new HashSet<string>();

    foreach (var kv in template.InstanceAssigns) {
        if (seenVars.Contains(kv.Key)) continue;
        seenVars.Add(kv.Key);
        assignLines.TryGetValue(kv.Key, out int varLine);
        variables.Add(new TraceVariable { Name = kv.Key, Value = FormatValue(kv.Value), Line = varLine });
    }
    foreach (var rec in TraceTag.Records) {
        foreach (var kv in rec.Scope) {
            if (seenVars.Contains(kv.Key)) continue;
            if (kv.Key.StartsWith("__") || kv.Key == "forloop") continue;
            seenVars.Add(kv.Key);
            variables.Add(new TraceVariable { Name = kv.Key, Value = FormatValue(kv.Value), Line = rec.Line });
        }
    }
    variables.Sort((a, b) => a.Line.CompareTo(b.Line));

    res.Success      = true;
    res.Output       = rawOutput;
    res.Variables    = variables;
    res.LineMappings = BuildLineMappings(req.Template, rawOutput);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
static (Dictionary<string, int> assignLines, string instrumented) InstrumentTemplate(string template) {
    var assignLines = new Dictionary<string, int>();
    var outLines    = new List<string>();
    var lines       = template.Split('\n');
    var assignPat   = new Regex(@"\{%-?\s*assign\s+(\w+)\s*=");
    var capturePat  = new Regex(@"\{%-?\s*capture\s+(\w+)\s*-?%\}");

    for (int i = 0; i < lines.Length; i++) {
        var ln = lines[i];
        outLines.Add(ln);
        var am = assignPat.Match(ln);
        if (am.Success) {
            var name = am.Groups[1].Value;
            assignLines[name] = i + 1;
            outLines.Add($"{{%- __trace__ {i + 1} -%}}");
        }
        var cm = capturePat.Match(ln);
        if (cm.Success) { assignLines[cm.Groups[1].Value] = i + 1; }
    }
    return (assignLines, string.Join('\n', outLines));
}

static List<LineMapping> BuildLineMappings(string templateText, string output) {
    var mappings   = new List<LineMapping>();
    var lines      = templateText.Split('\n');
    var searchFrom = 0;
    var tagLine    = new Regex(@"^\{%-?\s*(if|else|elsif|endif|for|endfor|assign|capture" +
                                @"|endcapture|comment|endcomment|unless|endunless|case|when" +
                                @"|endcase|break|continue|__trace__)\b");
    var tagSplit   = new Regex(@"\{[{%]-?.*?-?[%}]\}");

    for (int i = 0; i < lines.Length; i++) {
        var stripped = lines[i].Trim();
        if (string.IsNullOrWhiteSpace(stripped) || tagLine.IsMatch(stripped)) continue;
        var parts   = tagSplit.Split(stripped);
        var longest = parts.Select(p => p.Trim()).OrderByDescending(p => p.Length).FirstOrDefault() ?? "";
        if (longest.Length < 2) continue;
        var idx = output.IndexOf(longest, searchFrom, StringComparison.Ordinal);
        if (idx < 0) idx = output.IndexOf(longest, StringComparison.Ordinal);
        if (idx < 0) continue;
        var end = output.IndexOf('\n', idx + longest.Length);
        if (end < 0) end = output.Length;
        mappings.Add(new LineMapping { TemplateLine = i + 1, OutputStart = idx, OutputEnd = end, OutputText = output[idx..end] });
        searchFrom = Math.Min(end, output.Length);
    }
    return mappings;
}

static string FormatValue(object? v) {
    if (v is null)                             return "null";
    if (v is string s)                         return s;
    if (v is IEnumerable<object> list)         return $"[{string.Join(", ", list.Take(5).Select(FormatValue))}]";
    if (v is IDictionary<string, object> dict) return $"{{{string.Join(", ", dict.Take(3).Select(kv => $"{kv.Key}: {FormatValue(kv.Value)}"))}}}";
    return v.ToString() ?? "";
}

static object JTokenToObject(JToken token) => token.Type switch {
    JTokenType.Object  => ((JObject)token).Properties().ToDictionary(p => p.Name, p => JTokenToObject(p.Value)),
    JTokenType.Array   => ((JArray)token).Select(JTokenToObject).ToList<object>(),
    JTokenType.Integer => token.Value<long>(),
    JTokenType.Float   => token.Value<double>(),
    JTokenType.Boolean => (object)token.Value<bool>(),
    JTokenType.Null    => (object)"",
    _                  => (object)(token.Value<string>() ?? "")
};

static (int? line, int? col) ParsePosition(string msg) {
    var m = Regex.Match(msg, @"[Ll]ine[:\s]+(\d+)(?:[,\s]+[Cc]ol(?:umn)?[:\s]+(\d+))?");
    if (!m.Success) return (null, null);
    return (int.Parse(m.Groups[1].Value), m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : null);
}

// ── Types ─────────────────────────────────────────────────────────────────────
class RenderRequest {
    public int    Id          { get; set; }
    public string Template    { get; set; } = "";
    public string InputJson   { get; set; } = "{}";
    public bool   WrapContent { get; set; } = true;
}

class RenderResult {
    public int                 Id           { get; set; }
    public bool                Success      { get; set; }
    public string              Output       { get; set; } = "";
    public List<TraceVariable> Variables    { get; set; } = new();
    public List<LineMapping>   LineMappings { get; set; } = new();
    public List<RenderError>   Errors       { get; set; } = new();
    public int                 RenderTimeMs { get; set; }
}

class TraceVariable {
    public string Name  { get; set; } = "";
    public string Value { get; set; } = "";
    public int    Line  { get; set; }
}

class LineMapping {
    public int    TemplateLine { get; set; }
    public int    OutputStart  { get; set; }
    public int    OutputEnd    { get; set; }
    public string OutputText   { get; set; } = "";
}

class RenderError {
    public string Message { get; set; } = "";
    public int?   Line    { get; set; }
    public int?   Column  { get; set; }
}

class TraceRecord {
    public int                        Line  { get; set; }
    public Dictionary<string, object> Scope { get; set; } = new();
}

class TraceTag : Tag {
    public static List<TraceRecord> Records { get; } = new();

    private int _line;

    public override void Initialize(string tagName, string markup, List<string> tokens) {
        base.Initialize(tagName, markup, tokens);
        int.TryParse(markup.Trim(), out _line);
    }

    public override void Render(Context context, TextWriter result) {
        var snap = new Dictionary<string, object>();
        foreach (var scope in context.Scopes) {
            foreach (var kv in scope) {
                if (!snap.ContainsKey(kv.Key)) snap[kv.Key] = kv.Value;
            }
        }
        Records.Add(new TraceRecord { Line = _line, Scope = snap });
    }
}
```

- [ ] **Step 2: Build the project**

```bash
dotnet build backend/DotLiquidRenderer/DotLiquidRenderer.csproj -c Release -o backend/renderer
```

Expected: `Build succeeded.`

- [ ] **Step 3: Test a single render request**

```bash
echo '{"id":1,"template":"Hello {{ content.name | Upcase }}","inputJson":"{\"name\":\"Alice\"}","wrapContent":true}' \
  | dotnet backend/renderer/DotLiquidRenderer.dll
```

Expected output (single JSON line, then process exits on EOF):
```json
{"id":1,"success":true,"output":"Hello ALICE","variables":[],"lineMappings":[{"templateLine":1,"outputStart":0,"outputEnd":11,"outputText":"Hello ALICE"}],"errors":[],"renderTimeMs":...}
```

- [ ] **Step 4: Test with the sample orders template**

```bash
echo "{\"id\":2,\"template\":$(cat docs/orders.liquid | jq -Rs .),\"inputJson\":$(cat docs/orders.liquid.json | jq -Rs .),\"wrapContent\":true}" \
  | dotnet backend/renderer/DotLiquidRenderer.dll
```

Expected: JSON line with `"success":true` and `"variables"` containing `customerName`, `orderCount`, `totalItems`.

- [ ] **Step 5: Commit**

```bash
git add backend/DotLiquidRenderer/Program.cs
git commit -m "feat: implement NDJSON render loop in DotLiquidRenderer"
```

---

## Task 3: Input JSON Validation

> **Note:** The `Render()` method already has a `try/catch` around `JObject.Parse(req.InputJson)`. This task verifies it returns a structured error (with line/col) rather than a generic exception, and confirms the process keeps running after a bad request.

**Files:**
- Test only: `backend/DotLiquidRenderer/Program.cs` (no code change needed — validation is already in `Render()` from Task 2)

- [ ] **Step 1: Test malformed input JSON returns structured error**

```bash
echo '{"id":3,"template":"Hello {{ content.name }}","inputJson":"{bad json","wrapContent":true}' \
  | dotnet backend/renderer/DotLiquidRenderer.dll
```

Expected: JSON line with `"success":false` and `errors[0].message` starting with `"Input JSON is invalid:"`.

- [ ] **Step 2: Confirm the process keeps running after an error**

Pipe two requests — the second after a bad first:

```bash
printf '{"id":4,"template":"{{ content.x }}","inputJson":"{bad","wrapContent":true}\n{"id":5,"template":"Hello {{ content.name }}","inputJson":"{\"name\":\"Bob\"}","wrapContent":true}\n' \
  | dotnet backend/renderer/DotLiquidRenderer.dll
```

Expected: two JSON lines — first with `"success":false`, second with `"success":true,"output":"Hello Bob"`. The process does not crash between them.

- [ ] **Step 3: Commit**

```bash
git add backend/DotLiquidRenderer/Program.cs
git commit -m "test: verify input JSON validation and process resilience"
```

---

## Task 4: Rewrite backend.ts — Persistent Process + Build Bootstrap

**Files:**
- Rewrite: `extension/src/backend.ts`

- [ ] **Step 1: Replace backend.ts with the persistent-process implementation**

Replace `extension/src/backend.ts` entirely:

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd extension && npm run compile 2>&1
```

Expected: no errors. `out/` directory updated.

- [ ] **Step 3: Commit**

```bash
git add extension/src/backend.ts
git commit -m "feat: persistent DotLiquidRenderer process with NDJSON and auto-respawn"
```

---

## Task 5: Update package.json Setting

**Files:**
- Modify: `extension/package.json`

The old `dotliquid.dotnetScriptPath` setting pointed to the `dotnet-script` tool. The new `dotliquid.dotnetPath` points to the `dotnet` executable itself.

- [ ] **Step 1: Replace the setting in package.json**

In `extension/package.json`, find the `configuration.properties` block and replace:

```json
"dotliquid.dotnetScriptPath": {
  "type": "string",
  "default": "dotnet-script",
  "description": "Path to dotnet-script executable (install: dotnet tool install -g dotnet-script)"
},
```

with:

```json
"dotliquid.dotnetPath": {
  "type": "string",
  "default": "dotnet",
  "description": "Path to the .NET executable. Defaults to 'dotnet' (assumes it is on PATH)."
},
```

- [ ] **Step 2: Verify package.json is valid JSON**

```bash
node -e "require('./extension/package.json'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add extension/package.json
git commit -m "feat: replace dotnetScriptPath setting with dotnetPath"
```

---

## Task 6: Pretty-Print Toggle in preview.html

**Files:**
- Modify: `extension/media/preview.html`

- [ ] **Step 1: Add the Pretty button to the output panel header**

In `extension/media/preview.html`, find this block:

```html
    <div class="panel-header">
      <span>Output</span>
      <span class="badge" id="wrap-badge" title="Logic Apps wraps input in { content: ... }">content.*</span>
    </div>
```

Replace it with:

```html
    <div class="panel-header">
      <span>Output</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="badge" id="wrap-badge" title="Logic Apps wraps input in { content: ... }">content.*</span>
        <button class="secondary" id="prettify-btn" onclick="togglePretty()"
                style="display:none;padding:2px 7px;font-size:11px"
                title="Toggle JSON pretty-print">&#8644; Pretty</button>
      </div>
    </div>
```

- [ ] **Step 2: Add pretty-print state variables at the top of the script block**

In the `<script>` block, directly after:

```javascript
  let activeChunk = null;
```

Add:

```javascript
  var _rawOutput   = '';
  var _lastMappings = [];
  var _parsedJson  = null;
  var _isPretty    = false;
```

- [ ] **Step 3: Reset pretty-print state on loading**

In the `window.addEventListener('message', ...)` handler, find:

```javascript
    if (msg.command === 'loading') {
      setStatus('loading', 'Rendering...');
      document.getElementById('output-area').innerHTML = '<span style="color:var(--fg-dim)">Rendering...</span>';
    }
```

Replace with:

```javascript
    if (msg.command === 'loading') {
      _isPretty = false;
      _parsedJson = null;
      document.getElementById('prettify-btn').style.display = 'none';
      setStatus('loading', 'Rendering...');
      document.getElementById('output-area').innerHTML = '<span style="color:var(--fg-dim)">Rendering...</span>';
    }
```

- [ ] **Step 4: Populate pretty-print state after a successful render**

In `handleResult`, find:

```javascript
    setStatus('ok', result.renderTimeMs + 'ms');
    document.getElementById('output-area').classList.remove('error-state');
    renderErrors([]);
    renderOutput(result.output, result.lineMappings || []);
    renderVariables(result.variables || []);
    renderMappings(result.lineMappings || []);
```

Replace with:

```javascript
    setStatus('ok', result.renderTimeMs + 'ms');
    document.getElementById('output-area').classList.remove('error-state');
    renderErrors([]);

    _rawOutput    = result.output;
    _lastMappings = result.lineMappings || [];
    _isPretty     = false;

    var btn = document.getElementById('prettify-btn');
    try {
      _parsedJson = JSON.parse(result.output);
      btn.style.display  = '';
      btn.textContent    = '\u21C4 Pretty';
    } catch (_) {
      _parsedJson        = null;
      btn.style.display  = 'none';
    }

    renderOutput(result.output, result.lineMappings || []);
    renderVariables(result.variables || []);
    renderMappings(result.lineMappings || []);
```

- [ ] **Step 5: Hide the button on error**

In `handleResult`, find:

```javascript
    if (!result.success) {
      setStatus('error', 'Error');
      renderErrors(result.errors);
      document.getElementById('output-area').textContent = '';
      document.getElementById('output-area').classList.add('error-state');
      renderVariables([]);
      renderMappings([]);
      return;
    }
```

Replace with:

```javascript
    if (!result.success) {
      setStatus('error', 'Error');
      renderErrors(result.errors);
      document.getElementById('output-area').textContent = '';
      document.getElementById('output-area').classList.add('error-state');
      document.getElementById('prettify-btn').style.display = 'none';
      _parsedJson = null;
      _isPretty   = false;
      renderVariables([]);
      renderMappings([]);
      return;
    }
```

- [ ] **Step 6: Add the togglePretty function**

In the script block, after `window.openInputFile = function() { ... };` add:

```javascript
  window.togglePretty = function() {
    if (!_parsedJson) { return; }
    _isPretty = !_isPretty;
    var btn  = document.getElementById('prettify-btn');
    btn.textContent = _isPretty ? '\u21C4 Raw' : '\u21C4 Pretty';
    var area = document.getElementById('output-area');
    if (_isPretty) {
      area.textContent = JSON.stringify(_parsedJson, null, 2);
    } else {
      renderOutput(_rawOutput, _lastMappings);
    }
  };
```

- [ ] **Step 7: Manual verification**

Open `docs/orders.liquid` in VS Code, run the extension in the Extension Development Host (`F5` from the extension folder), open the preview panel (`Ctrl+Shift+L`). After render:
- The "⇄ Pretty" button should appear in the output panel header (orders output is valid JSON)
- Clicking "⇄ Pretty" should pretty-print the output; button label changes to "⇄ Raw"
- Clicking "⇄ Raw" restores the original output with line-click highlights intact
- Click a line in the output — template editor should highlight that line

- [ ] **Step 8: Commit**

```bash
git add extension/media/preview.html
git commit -m "feat: pretty-print toggle for JSON output"
```

---

## Task 7: Housekeeping

**Files:**
- Delete: `backend/renderer.csx`
- Modify: `.gitignore`

- [ ] **Step 1: Delete renderer.csx**

```bash
git rm backend/renderer.csx
```

- [ ] **Step 2: Add compiled output to .gitignore**

Open `.gitignore` and add to the end:

```
backend/renderer/
```

- [ ] **Step 3: Compile the extension one final time**

```bash
cd extension && npm run compile 2>&1
```

Expected: no errors.

- [ ] **Step 4: Final commit**

```bash
git add .gitignore
git commit -m "chore: remove renderer.csx, gitignore compiled backend output"
```

---

## Self-Review Notes

**Spec coverage check:**

| Spec requirement | Covered by |
|-----------------|-----------|
| Persistent process, NDJSON loop | Task 2 (Program.cs), Task 4 (backend.ts) |
| `id` field on request/response | Task 2 (RenderRequest/RenderResult), Task 4 (WireRequest/WireResult) |
| `on('exit')` → null `_proc` → auto-respawn | Task 4 (`proc.on('exit', ...)`) |
| Build bootstrap: check SDK, show progress, clear error UX | Task 4 (`buildRenderer()`) |
| Error message says ".NET 8 SDK" | Task 4 (`showErrorMessage` text) |
| Input JSON validation — structured error with line/col | Task 2 (catch JsonException in Render()), Task 3 (verified) |
| Pretty-print toggle — frontend only, disabled when not JSON | Task 6 |
| Delete renderer.csx | Task 7 |
| `.gitignore` update | Task 7 |
| Update `dotnetScriptPath` → `dotnetPath` in package.json | Task 5 |

**Type consistency check:**

- `WireRequest` extends `RenderRequest` + `id: number` — used in Task 4 only
- `WireResult` extends `RenderResult` + `id: number` — used in Task 4 only
- `RenderResult` interface (public, no `id`) — unchanged from current; previewPanel.ts unaffected
- `TraceTag.Records` (static `List<TraceRecord>`) — created in Task 2, cleared in `Render()` before each render
- `dotnetExe()` in backend.ts reads `dotliquid.dotnetPath` — matches the key set in Task 5

**No placeholders found.**
