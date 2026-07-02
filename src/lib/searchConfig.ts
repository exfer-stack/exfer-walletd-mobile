// User-configurable web-search provider ("bring your own search key", with a
// built-in default so it works out of the box — the hybrid model).
//
// Unlike the LLM key (injected host-side by llm_fetch), the search call is
// client-direct (no host proxy layer), so the key lives client-side: either the
// built-in default baked in at build time, or the user's own from localStorage.
// An empty key or the "free" provider => the keyless DuckDuckGo -> Wikipedia
// cascade in exfer-agent. A paid provider that errors also falls back to it, so
// search never hard-fails.

import type { SearchConfig } from "exfer-agent";

const LS = "exfer-agent-search-config-v1";

// Built-in default: set VITE_SEARCH_API_KEY (+ optionally VITE_SEARCH_PROVIDER)
// at build time to ship out-of-the-box search. Empty => free cascade until the
// user configures their own key in Settings.
const BUILTIN: SearchConfig = {
  provider: ((import.meta.env.VITE_SEARCH_PROVIDER as SearchConfig["provider"]) || "tavily"),
  apiKey: (import.meta.env.VITE_SEARCH_API_KEY as string) || "",
};

export type SearchProvider = NonNullable<SearchConfig["provider"]>;

export interface SavedSearch {
  provider: SearchProvider;
  apiKey: string;
}

export function loadSearchConfig(): SavedSearch | null {
  try {
    const raw = localStorage.getItem(LS);
    return raw ? (JSON.parse(raw) as SavedSearch) : null;
  } catch {
    return null;
  }
}

export function saveSearchConfig(c: SavedSearch): void {
  localStorage.setItem(LS, JSON.stringify(c));
}

/** The effective config passed to capabilityTools: the user's own choice if set,
 *  else the built-in default. */
export function resolveSearchConfig(): SearchConfig {
  const u = loadSearchConfig();
  const provider = u?.provider || BUILTIN.provider;
  const apiKey = (u?.apiKey ?? "").trim() || BUILTIN.apiKey || "";
  return { provider, apiKey };
}
