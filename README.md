# DotLiquid Debugger for VS Code

Live preview, variable inspection, and line mapping for **DotLiquid templates** — targeting
**Azure Logic Apps Standard** (DotLiquid 2.0.361).

---

## Features

| Feature | Details |
|---------|---------|
| **Live preview** | Side-by-side output panel, refreshes on save (or on every keystroke with debounce) |
| **Variable panel** | Shows all `{% assign %}` / `{% capture %}` variables with their resolved values |
| **Line mapping** | Click any output region → jumps to the template line that produced it |
| **Error highlighting** | Parse and render errors with line/column, clickable to jump |
| **Logic Apps mode** | Automatically wraps input in `{ "content": ... }` to match Logic Apps Standard runtime |
| **Exact engine** | Uses DotLiquid 2.0.361 NuGet — same version as Logic Apps Standard |

---

## Prerequisites

### 1. .NET SDK (6.0+)

```bash
# Check if installed
dotnet --version

# Install from https://dotnet.microsoft.com/download
```

### 2. dotnet-script

```bash
dotnet tool install -g dotnet-script

# Verify
dotnet-script --version
```

> On first run, `dotnet-script` downloads the DotLiquid NuGet package automatically.
> Subsequent renders use the cached package.

---

## Setup

### Option A — Install from VSIX (recommended)

1. Download `dotliquid-debugger-0.1.0.vsix`
2. In VS Code: `Extensions` → `...` → `Install from VSIX...`

### Option B — Build from source

```bash
cd extension
npm install
npm run compile
# To package: npx vsce package
```

---

## Usage

### Basic workflow

1. Open a `.liquid` file
2. Press **Ctrl+Shift+L** or click the preview icon in the editor toolbar
3. The preview panel opens beside the editor

### Input JSON

The extension looks for a paired input file named `<template>.liquid.json` in the same folder.

```
orders.liquid        ← your template
orders.liquid.json   ← your input data
```

If no input file exists, a banner appears in the preview. Click it (or right-click in the editor →
**DotLiquid: Create Input JSON File**) to create a sample file.

The input JSON is automatically wrapped in `{ "content": ... }` before rendering — matching
exactly what Logic Apps Standard does at runtime. Your template accesses fields via `content.*`.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Shift+L` | Open/focus preview panel |
| `F5` | Re-run template |

### Line mapping

Click any region in the output panel to highlight the corresponding template line in the editor.
The **Line Map** sidebar shows all mapped lines at a glance.

### Variable panel

Every `{% assign x = ... %}` and `{% capture x %}...{% endcapture %}` variable is shown with
its resolved value. Click a variable row to jump to the line where it was assigned.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dotliquid.dotnetScriptPath` | `dotnet-script` | Path to dotnet-script executable |
| `dotliquid.autoRefresh` | `true` | Re-render on file save |
| `dotliquid.refreshDebounceMs` | `500` | Debounce delay before auto-refresh (ms) |
| `dotliquid.wrapContentObject` | `true` | Wrap input in `{ content: ... }` (Logic Apps mode) |

Set `wrapContentObject` to `false` if you are using DotLiquid outside of Logic Apps and
access variables directly without the `content.` prefix.

---

## Architecture

```
VS Code Extension (TypeScript)
  │
  ├─ PreviewPanel    — Webview with split output/variable/mapping panels
  ├─ LiquidBackend   — Spawns dotnet-script process per render
  │
  └─ backend/renderer.csx  (C# script, dotnet-script)
       │
       └─ DotLiquid 2.0.361 NuGet
            ├─ Template.Parse()
            ├─ Template.Render()
            ├─ Variable extraction (probe renders)
            └─ Line mapping (literal content matching)
```

### Why dotnet-script instead of a persistent .NET server?

- Zero setup: no separate process to manage, no port conflicts
- Cold start is ~300ms on first run (NuGet cache warm), ~50ms after
- Matches Logic Apps exactly: same NuGet package, same C# naming convention

### Known limitations

- **Step-through debugging**: not possible without forking DotLiquid — the engine has no
  execution hooks. This is a known gap in the DotLiquid ecosystem.
- **Line mapping accuracy**: based on literal string matching between template and output.
  Dynamic content (loops, conditionals) maps to the loop/block line, not the iteration.
- **First render latency**: ~300ms on cold start while dotnet-script resolves NuGet cache.

---

## Roadmap

- [ ] `{% include %}` support (resolve partials from workspace)
- [ ] JSON diff view (expected vs actual)
- [ ] Export test bundle (.liquid + .liquid.json + .ps1) — integrates with the Liquid skill
- [ ] DotLiquid fork with trace hooks → true step-through debugging

---

## Related

- [Liquid Skill for Claude Code](../liquid-skill/) — AI-powered template generation and debugging
- [XSLT Debugger](https://marketplace.visualstudio.com/items?itemName=danieljonathan.xsltdebugger-windows) — the XSLT equivalent

---

## License

MIT
