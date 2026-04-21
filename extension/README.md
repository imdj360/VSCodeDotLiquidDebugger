# DotLiquid Debugger for VS Code

Live preview, step debugging, variable inspection, and line mapping for **DotLiquid templates** targeting
**Azure Logic Apps Standard** with **DotLiquid 2.0.361**.

---

## Requirements

| Requirement  | Version       | Notes                                    |
|--------------|---------------|------------------------------------------|
| **VS Code**  | 1.85 or later | Windows, Linux, macOS                    |
| **.NET SDK** | 8.0 or later  | Required to build and run the renderer   |

### Install .NET 8 SDK

Download from [https://dotnet.microsoft.com/download](https://dotnet.microsoft.com/download) and choose **.NET 8**.

Verify your installation:

```bash
dotnet --version
# should print 8.x.x or later
```

The extension builds the renderer once on first use. Subsequent renders reuse the same process for the session.

> **No other runtime or dependency is required.** The VSIX is a single cross-platform file that works on Windows, Linux, and macOS.

---

## Features

| Feature | Details |
| ------- | ------- |
| **Live preview** | Side-by-side output panel, auto-refreshes on save or keystroke (debounced) |
| **Step debugger** | Replay-based line-by-line debugger over `assign`, `for`, `if/elsif/else/unless`, and output steps |
| **Filter chain tracing** | Each `assign` step shows the full filter chain (e.g. `499.9 \| Times:5 → 2499.5 \| DividedBy:100 → 24.995`) |
| **Variable timeline** | All variables shown at every debug step; not-yet-assigned variables dimmed |
| **Condition evaluation** | `if`/`elsif`/`unless`/`when` steps show the branch condition and a ✓ taken indicator |
| **Variable panel** | Shows all `{% assign %}` and `{% capture %}` variables with their resolved values |
| **Line mapping** | Click any output region to jump to the template line that produced it |
| **Error highlighting** | Parse and render errors with line and column, clickable to jump |
| **Logic Apps mode** | Wraps input in `{ "content": ... }` to match Logic Apps Standard runtime |
| **Exact engine** | Uses DotLiquid 2.0.361, the same version shipped in Logic Apps Standard |

---

## Setup

### Install from Marketplace

Search for **DotLiquid Debugger** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension danieljonathan.dotliquid-template-debugger
```

### Install from VSIX

1. Download `dotliquid-template-debugger-0.6.0.vsix`
2. In VS Code open **Extensions** (`Ctrl+Shift+X`)
3. Click `...` → **Install from VSIX…**

### Build from source

```bash
cd extension
npm install
npm run compile
```

To package locally:

```bash
cd extension
npm run package
```

---

## Usage

1. Open a `.liquid` file
2. Press `Ctrl+Shift+L` (`Cmd+Shift+L` on macOS) or click the preview icon in the editor toolbar
3. The preview panel opens beside the editor

### Input file

The extension looks for a paired input file named `<template>.liquid.json` in the same folder:

```text
orders.liquid
orders.liquid.json
```

If no input file exists, use **DotLiquid: Create Input JSON File** from the editor context menu — it creates a sample file and opens it for editing.

### Step debugger

Press the **Debug** button in the preview panel toolbar (or `F5`) to enter step-debug mode. Use the slider, **Prev/Next** buttons, or arrow keys to step through the template execution. Each step highlights the source line, shows the current variable state, and — for `assign` steps — displays the full filter chain.

---

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `dotliquid.dotnetPath` | `dotnet` | Path to the .NET executable. Set this if `dotnet` is not on your PATH. |
| `dotliquid.autoRefresh` | `true` | Re-render automatically on file save or text change |
| `dotliquid.refreshDebounceMs` | `500` | Debounce delay in milliseconds before auto-refresh triggers |
| `dotliquid.wrapContentObject` | `true` | Wrap input JSON in `{ "content": ... }` to match Logic Apps Standard |

---

## Architecture

```text
VS Code Extension (TypeScript)
  ├─ PreviewPanel      — WebView UI, step debugger controls
  ├─ LiquidBackend     — spawns and manages the renderer subprocess
  └─ backend/DotLiquidRenderer/   (.NET 8 console app, NDJSON over stdin/stdout)
       ├─ Program.cs              — render loop, TraceTag, line mapping
       └─ FilterReplay.cs         — filter chain replay for step debugger
```

The renderer is compiled from source and kept alive for the session. It is restarted automatically if it crashes.

---

## Known Limitations

- `capture` tag variables appear in the Variables panel but produce no step-debugger checkpoint
- Line mapping is heuristic for loop bodies that share text with a static line appearing after them in the template
- Filters `Compact`, `Uniq`, `SortNatural`, and `Where` pass through without step-debugger tracing
- `dotliquid.dotnetPath` validates that `dotnet` is present but does not verify the SDK major version

---

## Related

- [XSLT Debugger](https://marketplace.visualstudio.com/items?itemName=danieljonathan.xsltdebugger-windows) — sister extension for XSLT transforms in Logic Apps Standard

---

## License

MIT
