import { loadConfig, saveConfig, readEffectiveSettings } from "@pi-archimedes/core/settings-io";

export const ANIMATION_STYLES = [
  "diagonal",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center-out",
  "wave",
  "horizontal",
  "vertical",
  "vertical-up",
] as const;
export type AnimationStyle = (typeof ANIMATION_STYLES)[number];

export type ThinkingStyle = "Full" | "Compact";
export const THINKING_STYLE_VALUES: readonly ThinkingStyle[] = [
  "Full",
  "Compact",
] as const;

/**
 * How tool rendering is handled. `Minimal` = the archimedes-styled tools
 * (bash/codemode overrides, minimal collapsed view); `Native` = no archimedes
 * styling at all — the overrides are not registered, so pi's native tool
 * rendering stands (and no built-in-takeover startup notice).
 */
export type ToolStyle = "Native" | "Minimal";
export const TOOL_STYLE_VALUES: readonly ToolStyle[] = [
  "Native",
  "Minimal",
] as const;

export const SPINNER_STYLES: readonly SpinnerStyle[] = [
  "typing",
  "pulse",
  "rain",
  "cascade",
  "columns",
  "wave-rows",
  "diagonal-swipe",
  "sparkle",
  "pendulum",
  "marquee",
];

export function normalizeThinkingStyle(value: unknown): ThinkingStyle {
  if (value === "Full" || value === "Compact") return value;
  if (value === "Off") return "Full";
  if (value === "1 line" || value === "3 lines" || value === "5 lines") return "Compact";
  return "Full";
}

/**
 * Legacy mappings: `Full` (auto-expand, dropped) → `Minimal` (the user opted
 * into archimedes styling, which is preserved); `Compact` (styled tools,
 * native-collapsed presentation) → `Minimal` (styled tools — the upgrade
 * must not silently strip styling from existing users).
 */
export function normalizeToolStyle(value: unknown): ToolStyle {
  if (value === "Native" || value === "Minimal") return value;
  if (value === "Full") return "Minimal";
  if (value === "Compact") return "Minimal";
  return "Minimal";
}

export type SpinnerStyle =
  | "typing"
  | "pulse"
  | "rain"
  | "cascade"
  | "columns"
  | "wave-rows"
  | "diagonal-swipe"
  | "sparkle"
  | "pendulum"
  | "marquee";

export interface UIConfig {
  bashToolStyling: boolean;
  codemodeToolStyling: boolean;
  mutedTheme: boolean;
  autoCollapseThinking: boolean;
  thinkingStyle: ThinkingStyle;
  toolStyle: ToolStyle;
  codeUnindent: boolean;
  labelText: string;
  labelColor: string;
  /**
   * Opt in to the Archimedes startup splash (logo reveal + `[Version]`/`[Models]`
   * rows). Default **off**: pi owns the startup screen unless the user asks.
   * See the truth table in `index.ts` for how this and `quietStartup` interact.
   */
  startupSplash: boolean;
  animationStyle: AnimationStyle;
  colorfulLogo: boolean;
  editorSpinBorder: boolean;
  editorSpinSpeed: "slow" | "normal" | "fast";
  editorSpinLabel: string;
  editorSpinStyle: SpinnerStyle;
}

export type CoreConfig = UIConfig;

export const DEFAULT_UI_CONFIG: UIConfig = {
  bashToolStyling: true,
  codemodeToolStyling: true,
  mutedTheme: false,
  autoCollapseThinking: false,
  thinkingStyle: "Full",
  toolStyle: "Minimal",
  codeUnindent: true,
  labelText: "Thinking...",
  labelColor: "255,215,0",
  // Off by default: the splash stays in the codebase, pi's own startup is what
  // a user sees unless they turn it on (`/archimedes` → Startup Splash).
  startupSplash: false,
  animationStyle: "vertical-up",
  colorfulLogo: false,
  editorSpinBorder: true,
  editorSpinSpeed: "normal",
  editorSpinLabel: "Working",
  editorSpinStyle: "pendulum",
};

export const SPIN_SPEED_MULT: Record<UIConfig["editorSpinSpeed"], number> = {
  slow: 1.5,
  normal: 1,
  fast: 0.6,
};

const NAMESPACE = "archimedes.ui";

export function loadUIConfig(): UIConfig {
  return loadConfig(NAMESPACE, DEFAULT_UI_CONFIG);
}

/**
 * Write the whole `archimedes.ui` namespace (core's `saveConfig` replaces the
 * section, it does not merge into it), so every key the caller holds lands —
 * including any this package has not heard of. A new field therefore needs no
 * handling here: it arrives on the `UIConfig` the `/archimedes` panel hands
 * back, and `loadUIConfig()` reads it back merged over `DEFAULT_UI_CONFIG` (an
 * absent key means the default, which is how `startupSplash: false` works for a
 * settings file written before the key existed).
 */
export function saveUIConfig(config: UIConfig): void {
  saveConfig(NAMESPACE, config);
}

/**
 * pi's own `quietStartup`, normalised to the three answers pi acts on.
 *
 * pi's semantics (`shouldShowStartupHeader()` / `shouldShowStartupDetails()` in
 * its interactive mode): the startup header is hidden only by `true`; the
 * startup *details* — the `Model scope:` line and the loaded-resource listing —
 * are shown only by `false`. `"header"` is the middle case: keep the header,
 * drop the details. Anything else, including an absent key (pi's default is
 * `false`), reads as `false`.
 *
 * Read through `readEffectiveSettings`, so a project-scoped `quietStartup` and
 * any in-process override count — the same object pi applies. One input is out
 * of reach: pi's verbose-startup CLI flag overrides the setting for pi's own
 * rendering and is not exposed to extensions, so on such a run the splash is
 * quieter than pi's output. Taking the `pi` handle (not `ctx`) is required —
 * `getSettings()` lives on `ExtensionAPI`.
 *
 * Only consulted when `startupSplash` is on (see the gate in `index.ts`): with
 * the splash off this package installs no header at all and has no use for the
 * answer.
 */
export function readQuietStartup(pi: unknown): boolean | "header" {
  const value = (readEffectiveSettings(pi) as { quietStartup?: unknown }).quietStartup;
  return value === true ? true : value === "header" ? "header" : false;
}
