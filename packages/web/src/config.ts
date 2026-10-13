import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readEffectiveSettings } from "@pi-archimedes/core/settings-io";

export interface WebConfig {
  braveApiKey?: string;
  tavilyApiKey?: string;
  openaiApiKey?: string;
  perplexityApiKey?: string;
  searxngUrl?: string;
  proxy?: string;
  defaultProvider?: string;
}

/**
 * The web package's view of settings, from the effective settings the running pi
 * applies.
 *
 * `pi` is the `ExtensionAPI` handle, threaded in by the tool `execute` and the
 * `/web` command handler — the two places that have it. It is optional because
 * it is not always available (and older pi has no `getSettings`), and
 * `readEffectiveSettings` falls back to reading `~/.pi/agent/settings.json` by
 * hand in that case. Passing the handle is what makes a key configured only in
 * the project's `.pi/settings.json`, or set by an in-process override, visible
 * here: the hand-rolled file read sees the global file and nothing else.
 *
 * Note the handle is used and then dropped — it is never stored.
 */
export function loadConfig(pi?: ExtensionAPI): WebConfig {
  const effective = readEffectiveSettings(pi);
  const config = (effective["archimedes.web"] ?? {}) as Record<string, any>;

  return {
    braveApiKey: process.env.BRAVE_API_KEY || config.braveApiKey,
    tavilyApiKey: process.env.TAVILY_API_KEY || config.tavilyApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
    perplexityApiKey: process.env.PERPLEXITY_API_KEY || config.perplexityApiKey,
    searxngUrl: process.env.SEARXNG_URL || config.searxngUrl,
    proxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || config.proxy,
    defaultProvider: config.defaultProvider,
  };
}
