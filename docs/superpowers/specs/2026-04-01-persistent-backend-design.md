# Persistent .NET Backend + Feature Additions

**Date:** 2026-04-01  
**Status:** Approved  
**Scope:** v0.1 — persistent process, auto-respawn, input JSON validation, pretty-print toggle

---

## Problem

Every render spawns a new `dotnet-script renderer.csx` process:

- CLR load + NuGet resolve + JIT compile: ~300ms cold, ~50ms warm
- Actual DotLiquid render: <5ms
- With 500ms debounce: ~800ms total latency cold, ~550ms warm

For live-preview debugging, this is unusable. The 5ms render is buried under 300ms of process overhead.

---

## Solution

Replace the per-render `dotnet-script` spawn with a single long-lived `DotLiquidRenderer.dll` process that stays alive for the VS Code session. All renders go over its stdin/stdout as newline-delimited JSON.

Cold-start cost: paid **once** on first render (or extension activate). All subsequent renders: ~5–10ms.

---

## Architecture

### Protocol

Newline-delimited JSON (NDJSON) over stdin/stdout. Each request and response is a single line terminated by `\n`.

**Request:**
```json
{"id": 1, "template": "...", "inputJson": "{}", "wrapContent": true}
```

**Response:**
```json
{"id": 1, "success": true, "output": "...", "variables": [], "lineMappings": [], "errors": [], "renderTimeMs": 5}
```

The `id` field pairs responses to requests. Responses are emitted in the order requests are processed (the loop is single-threaded), but the `id` guards against any future parallelism.

### Process lifecycle (`backend.ts`)

```
LiquidBackend
  _proc: ChildProcess | null
  _pendingResolve: ((result) => void) | null

render(request):
  1. ensureProcess()        ← spawns if _proc is null
  2. write request line to _proc.stdin
  3. await response line from _proc.stdout
  4. resolve Promise<RenderResult>

ensureProcess():
  - if _proc !== null, return
  - check renderer/DotLiquidRenderer.dll exists
    - if not: runBuildOnce()
  - spawn: dotnet renderer/DotLiquidRenderer.dll
  - _proc.on('exit', () => { _proc = null })   ← crash-detection / auto-respawn
  - _proc.on('error', ...)

dispose():
  - _proc?.kill()
  - _proc = null
```

**Crash detection:** The `on('exit')` handler nulls `_proc`. The next `render()` call hits `ensureProcess()`, detects `_proc === null`, and spawns a fresh process. No silent failures.

### Build bootstrap

On first use (when `renderer/DotLiquidRenderer.dll` is missing):

1. Check `dotnet --version` — if not found, post error to webview (see Error UX below)
2. Post `{ command: 'building' }` to webview — webview shows "Building renderer (first run)…"
3. Run: `dotnet build DotLiquidRenderer/DotLiquidRenderer.csproj -c Release -o renderer`
4. If exit code ≠ 0, post build error to webview
5. On success, proceed to spawn

Build runs once. Subsequent sessions skip to spawn.

**Error UX (SDK not found):**
```
⚠ .NET 8 SDK required

DotLiquid Debugger uses a compiled .NET backend for fast renders.

Install: https://dotnet.microsoft.com/download/dotnet/8.0
Then run: dotnet tool restore (in the extension directory)

After installing, reload VS Code (Developer: Reload Window).
```

No fallback to `dotnet-script`. One code path.

---

## .NET Project Structure

```
backend/
  DotLiquidRenderer/
    DotLiquidRenderer.csproj      ← net8.0, DotLiquid 2.0.361, Newtonsoft.Json 13
    Program.cs                    ← NDJSON loop, all render logic
  renderer/                       ← compiled output (gitignored)
    DotLiquidRenderer.dll
    DotLiquidRenderer.runtimeconfig.json
    (+ dep files)
```

`renderer.csx` is **deleted**. All render logic lives in `Program.cs`.

**`DotLiquidRenderer.csproj`:**
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="DotLiquid" Version="2.0.361" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

**`Program.cs` structure:**
```csharp
// One-time setup
Template.NamingConvention = new CSharpNamingConvention();
Template.RegisterTag<TraceTag>("__trace__");

// NDJSON loop
string? line;
while ((line = Console.ReadLine()) != null) {
    var req = JsonConvert.DeserializeObject<RenderRequest>(line);
    var res = Render(req);
    Console.WriteLine(JsonConvert.SerializeObject(res));
}
```

All types (`RenderRequest`, `RenderResult`, `TraceVariable`, `LineMapping`, `RenderError`, `TraceTag`) and all helpers (`InstrumentTemplate`, `BuildLineMappings`, `FormatValue`, `JTokenToObject`, `ParsePosition`) move from `renderer.csx` into `Program.cs` unchanged.

**`.gitignore` addition:**
```
backend/renderer/
```

---

## New Features

### Input JSON validation

Currently a malformed input JSON reaches `JObject.Parse()` in the backend and throws a C# exception with a generic message. Instead, validate before rendering:

In `Program.cs`, before calling `JObject.Parse(request.InputJson)`:
```csharp
if (!IsValidJson(request.InputJson, out string jsonError)) {
    result.Errors.Add(new RenderError {
        Message = $"Input JSON is invalid: {jsonError}",
        // Line/col parsed from Newtonsoft parse exception message
    });
    return result;
}
```

Returns a structured `RenderError` with `line`/`column` pointing into the JSON file. The webview already renders these errors in the Errors panel with a click-to-jump line number.

### Pretty-print toggle

Pure frontend change in `preview.html`.

- Add a "⇄ Pretty" button in the output panel header (next to the existing Copy button), initially disabled
- After each successful render, attempt `JSON.parse(output)`:
  - If valid JSON: enable the button, store the parsed object
  - If not valid JSON: disable and hide the button
- Toggle click: switch between `output` (raw) and `JSON.stringify(parsed, null, 2)` (pretty)
- State resets on each new render result

No backend changes. No new message types.

---

## What Does Not Change

- `extension.ts` — command registration, auto-refresh debounce, all unchanged
- `previewPanel.ts` — `run()` method, `postResult()`, `highlightTemplateLine()`, all unchanged
- The render logic itself — `InstrumentTemplate`, `BuildLineMappings`, `TraceTag`, variable extraction — all move verbatim from `renderer.csx` to `Program.cs`
- The `RenderResult` shape — no breaking changes to the JSON contract
- The existing Variables and Line Map panels in the webview

---

## Deferred (v0.2)

- **Filter chain inspection** — requires walking the DotLiquid parsed AST (`Variable.Filters`) rather than regex-parsing template text. Deferred to avoid the ~20% mis-parse rate from naive regex on quoted filter arguments.

---

## Files Changed

| File | Action |
|------|--------|
| `backend/renderer.csx` | **Deleted** |
| `backend/DotLiquidRenderer/DotLiquidRenderer.csproj` | **New** |
| `backend/DotLiquidRenderer/Program.cs` | **New** |
| `extension/src/backend.ts` | **Rewritten** — persistent process, NDJSON, build bootstrap |
| `extension/media/preview.html` | **Modified** — pretty-print toggle button + logic, building state |
| `.gitignore` | **Modified** — add `backend/renderer/` |
