// Startup version rows: the "Latest: v…" line needs the newest published pi.
//
// The version *comparator* used to live here. It moved to
// `@pi-archimedes/core/pi-support` (Task 7), where the runtime pi-support guard
// needs the same arithmetic — a second implementation in the tree is how
// `1.10.0 < 1.2.0` bugs happen. Task 8 deletes `fetchLatestVersion()` below in
// favour of pi's own update check.

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest";
const FETCH_TIMEOUT_MS = 4000;

export async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}
