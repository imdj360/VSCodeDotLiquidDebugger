# Change Log

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

---

## [0.3.0] — 2026-04-03

### Added

- **`type: "dotliquid"` launch configs** — press F5 from the Run and Debug panel to open any `.liquid` file directly in a preview panel. Input JSON is auto-detected (`<name>.liquid.json`); falls back to a file picker dialog if not found. No manual Extension Development Host reload needed.
- **Per-sample launch configurations** in `.vscode/launch.json` covering all seven sample templates.
- **Debug bar two-row layout** — step label (`? if: ...`, `assign`, etc.) now appears on its own line below the controls row, full-width and untruncated.
- **Sidebar panel rebalancing** — collapsing Variables expands Line Map to full height, and vice versa. Horizontal resize handle hides when either panel is collapsed.
- **New icon** — matches the XSLT Debugger family: purple gradient, Logic Apps badge, .NET badge, debug bug circle, `{ Liquid }` curly braces.
- **Sample templates** — HTML order confirmation email, XML ERP customer import, and plain-text shipping label/packing slip (each paired with `.liquid.json` input).
- **README** expanded with full requirements table, cross-platform notes, feature table, settings reference, architecture overview, and known limitations.

---

## [0.2.0] — 2026-04-02

### Added

- **Filter call tracing** — step debugger shows a filter chain row below the debug bar for every `assign` step that uses filters (e.g. `499.9 | Times:5 → 2499.5 | DividedBy:100 → 24.995`). 31 math, string, and array filters are covered: `Times`, `DividedBy`, `Plus`, `Minus`, `Modulo`, `Round`, `Ceil`, `Floor`, `Abs`, `AtLeast`, `AtMost`, `Upcase`, `Downcase`, `Capitalize`, `Append`, `Prepend`, `Strip`, `Lstrip`, `Rstrip`, `Replace`, `ReplaceFirst`, `Remove`, `Truncate`, `Size`, `Join`, `Split`, `First`, `Last`, `Reverse`, `Sort`, `Map`.
- **Condition evaluation** — `if`, `elsif`, `else`, `unless`, and `when` debug steps show the branch condition and a `✓ taken` indicator in the debug bar. Un-taken branches produce no step (absence = false, which matches DotLiquid's execution model).
- **Step debugger** — replay-based line-by-line debugger over `assign`, `for`, `if`/`elsif`/`else`/`unless`/`when`, and output steps. Slider, Prev/Next buttons, and keyboard-navigable.
- **Output reveal** — at each debug step, produced output is shown normally; future output is dimmed at 25% opacity.
- **Variable timeline** — all final variables shown at every step; variables not yet assigned are dimmed at 30% opacity.
- **Per-iteration loop steps** — loop body lines produce one output step per iteration, not one per unique line.
- Sample templates in `docs/`: `person-transform`, `order-to-xml`, `invoice-flat`, `sales-order-transform` (complex B2B with coupon codes, SLA lookup, state tax, and order tier logic).

### Fixed

- Line Map now expands to fill the full available sidebar height when Variables panel is collapsed.
- Debug exit restores full output and variable list.
- Last output step now covers the closing `}` / `]` tokens (clamp to `rawOutput.Length`).
- Build failure toast includes combined stdout + stderr (previously stderr-only, which could be blank).

---

## [0.1.0] — 2026-03-31

### Added

- Live preview panel for `.liquid` files — opens with `Ctrl+Shift+L` or the toolbar button.
- Auto-refresh on save (debounced; configurable via `dotliquid.refreshDebounceMs`).
- Persistent .NET 8 renderer subprocess — spawned once, kept alive, restarted automatically on crash. NDJSON wire protocol over stdin/stdout with `id`-paired responses.
- Build-on-demand — renderer is compiled from source (`backend/DotLiquidRenderer/`) on first activation if the DLL is missing. Clear error toast if .NET 8 SDK is absent.
- `content.*` wrapping toggle to match Azure Logic Apps Standard input shape (configurable via `dotliquid.wrapContentObject`).
- Variables panel — all `assign` values with line numbers; click to jump to source.
- Line Map panel — output lines linked back to template source line; click to jump.
- Resizable sidebar (drag handle) with collapse/expand toggle.
- Collapsible Variables and Line Map sections (horizontal resize handle between them).
- JSON pretty-print toggle for JSON output.
- Liquid syntax highlighting and language configuration.
- `dotliquid.dotnetPath` setting for custom .NET SDK path.
- Error panel with clickable line locations.
- 15 unit tests: NDJSON protocol (renderer subprocess) + build-failure regression (TypeScript backend mock).
