# UI Package

TUI enhancements for the Pi Archimedes monorepo.

## Features

### Bash Tool Styling
- **Pi's tool, our row**: `bash` stays pi's own built-in tool — this package never registers it. It installs one `pi.registerToolRenderer()` resolver that decides how calls to `bash` are drawn, so pi keeps the executor, description, reachability and activation of that tool.
- **Collapsed/Expanded Views**: Toggleable tool execution details.
- **Live Timer**: Track tool execution duration.
- **Status Indicators**:
  - `▸` Running (Orange)
  - `✓` Success (Green)
  - `✗` Error (Red)

### Codemode Tool Styling
- **Styling follows the `toolStyle` master switch**:
  - **Minimal** (default): the resolver answers with our row — the collapsed row is the `codemode` header plus the nested tool calls the script made (last five, with an expand hint when there are more) — no script dump, no summary line. A script that made no calls shows a single `<glyph> <duration>` line instead.
  - **Native**: the resolver answers `next()` — pi's own codemode rendering stands.
- **Expanded View**: The syntax-highlighted script, every nested call (status glyph, args, duration, and cost for `models.*` calls, with a `Model calls: $total` line when several were priced), the script output without the executor's `Script completed/failed` header (image blocks show a `[Image: …]` indicator — the renderer is text-only), the full-output path when truncated, and the timing + final status.
- **Live Timer**: In-flight calls show the `…` running glyph and update every second.
- **Native Behaviour Preserved**: `codemode` is pi's own built-in extension and stays that way — nothing in this package registers it, so pi keeps the QuickJS executor, the dynamic description, the per-tool prompt guidelines and `defaultActive: false`, and no "built-in extension was not loaded" startup notice appears because nothing was replaced. Only the presentation is ours (ADR 0029).
- **Graceful Fallback**: The styling is installed behind `typeof pi.registerToolRenderer === "function"` (pi 1.0.1+), so a host without that API gets pi's own rendering for `bash` and `codemode` alike; a session with no `codemode` tool is simply never asked about it.

### Editor
- **HephaestusEditor**: Advanced text editing capabilities.
- **Border Spinner Animations**: Visual feedback during operations.
- **Spin Quips**: Enjoyable messages while waiting for processes.

### Thinking
- **Full/Compact Output Style**: Full or one-line thinking (`thinkingStyle`). The tool-side master switch is `toolStyle` (Minimal = archimedes styled, Native = no archimedes tool styling).
- **Collapsible Thinking**: Expandable for deeper inspection.
- **Theme**: Unified styling for thinking blocks.

### Startup
- **The splash is opt-in, and off by default.** Out of the box you get **pi's own startup screen** — its header, its key hints, its loaded-resource listing. `startupSplash: true` installs the Archimedes splash in pi's header slot instead; with it off nothing is installed, so pi's `quietStartup` keeps working exactly as it does with no Archimedes loaded.
- **Splash Logo Reveal** (`startupSplash: true`): An animated logo reveal with the running Pi version and the session's model scope (`ctx.scopedModels` — the set `/scoped-models` shows), drawn in pi's own row style so it reads as one document with the listing below it.
- **Honours Pi's `quietStartup`** (when the splash is on): `false` = splash with its details, `"header"` = splash alone, `true` = Pi's own quiet startup (the splash hands the header back). With the splash off, that setting is pi's alone to act on. Nothing is scraped from Pi's output to decide any of this, and the splash makes no network request — Pi's own update check is the only one.

## Settings (`archimedes.ui`)

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `bashToolStyling` | boolean | `true` | Custom styled bash tool rendering (applies when `toolStyle` is Minimal) |
| `codemodeToolStyling` | boolean | `true` | Custom styled codemode tool rendering (applies when `toolStyle` is Minimal) while keeping the native executor |
| `mutedTheme` | boolean | `false` | Muted theme for thinking blocks |
| `autoCollapseThinking` | boolean | `false` | Automatically collapse thinking blocks |
| `thinkingStyle` | "Full" \| "Compact" | `"Full"` | Thinking block display (Full = full text, Compact = one line, click to expand) |
| `toolStyle` | "Native" \| "Minimal" | `"Minimal"` | Tool rendering master switch (Minimal = archimedes styled, Native = pi native, no archimedes styling) |
| `codeUnindent` | boolean | `true` | Strip common indentation from code blocks |
| `labelText` | string | `"Thinking..."` | Text shown before thinking blocks |
| `labelColor` | string | `"255,215,0"` | RGB color for the thinking label (e.g. `255,215,0`) |
| `startupSplash` | boolean | `false` | Install the Archimedes startup splash (off = pi's own startup screen) |
| `animationStyle` | "diagonal" \| "top-right" \| "bottom-left" \| "bottom-right" \| "center-out" \| "wave" \| "horizontal" \| "vertical" \| "vertical-up" | `"vertical-up"` | Startup logo animation (applies when `startupSplash` is true) |
| `colorfulLogo` | boolean | `false` | Use pi's brand colors for the splash logo (applies when `startupSplash` is true) |
| `editorSpinBorder` | boolean | `true` | Animated spinner border on editor |
| `editorSpinSpeed` | "slow" \| "normal" \| "fast" | `"normal"` | Editor border spinner speed |
| `editorSpinStyle` | "typing" \| "pulse" \| "rain" \| "cascade" \| "columns" \| "wave-rows" \| "diagonal-swipe" \| "sparkle" \| "pendulum" \| "marquee" | `"pendulum"` | Editor spinner style |
| `editorSpinLabel` | string | `"Working"` | Spinner frame label |

## Install

```bash
pi install @pi-archimedes/ui
```
