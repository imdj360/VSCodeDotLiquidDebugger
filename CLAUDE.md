# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All scripts run from the `extension/` directory.

```bash
# Build TypeScript
npm run compile

# Run all tests (compiles first, then runs both test files)
npm test

# Build the .NET renderer (required before renderer.test.mjs can pass)
npm run build-renderer

# Package the VSIX
npm run package

# Watch mode for TypeScript
npm run watch
```

Run a single test file:
```bash
cd extension
node --test test/renderer.test.mjs        # requires DotLiquidRenderer.dll
node --test test/backend.integration.test.mjs  # unit tests, no DLL needed
```

## Architecture

This is a VS Code extension that provides live preview/debugging for DotLiquid templates targeting Azure Logic Apps Standard (DotLiquid 2.0.361).

**Two-process design:**

1. **TypeScript extension host** (`extension/src/`) — VS Code extension, WebView panel, auto-refresh
2. **Persistent .NET 8 renderer** (`extension/backend/DotLiquidRenderer/`) — stays alive, renders templates via NDJSON over stdin/stdout

**NDJSON wire protocol:**
- One JSON request per line → one JSON response per line
- Every request/response carries an `id` field; `backend.ts` uses `Map<number, resolver>` to pair out-of-order responses
- camelCase on both sides (Newtonsoft.Json `CamelCasePropertyNamesContractResolver`)

**Backend lifecycle (`extension/src/backend.ts`):**
- `LiquidBackend` spawns the DLL on first `render()` call; subsequent calls reuse the same process
- `on('exit')` handler rejects all in-flight requests and nulls `_proc`; next `render()` respawns
- Renderer stderr is piped to the `DotLiquid Debugger` OutputChannel (never silently swallowed)
- `buildRenderer()` runs `dotnet build` on first use if `backend/renderer/DotLiquidRenderer.dll` is missing; build failure shows a toast with last-5-lines + "Show Output" action

**Key invariant:** `TraceTag.Records` in Program.cs is a static list. This is safe only because the NDJSON loop is single-threaded. Do not parallelize the renderer loop.

**Auto-refresh scoping (`extension/src/previewPanel.ts`):**
- `isTrackedFile(fileName)` gates auto-refresh to the panel's specific `.liquid` file and its paired `.liquid.json` input — not all `.liquid` files in the workspace

**Input JSON handling (Program.cs):**
- Uses `JToken.Parse` (not `JObject.Parse`) — accepts both object and array roots
- Array root without `wrapContent=true` is exposed as `items` in the template context

**VSIX packaging:**
- Backend source must stay inside `extension/` for `vsce package` to include it
- Source: `extension/backend/DotLiquidRenderer/`
- Compiled output: `extension/backend/renderer/` (gitignored; built on first use or by `npm run build-renderer`)
- `extension/.vscodeignore` excludes `bin/`, `obj/`, and `renderer/` build artifacts

**Requires:** .NET 8 SDK (no fallback — hard error with clear message if missing). Configured via `dotliquid.dotnetPath` setting (default: `dotnet`).
