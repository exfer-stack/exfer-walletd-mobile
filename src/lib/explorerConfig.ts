// User-supplied block-explorer API key (Etherscan V2 — ONE key works across
// BSC / ETH / Base / … on the V2 endpoint) for reading VERIFIED contract source
// in crypto_contract_source. Like the search key (and unlike the LLM key, which
// the host injects), the explorer call is client-direct, so the key lives
// client-side: a build-time default (VITE_ETHERSCAN_API_KEY) or the user's own
// from localStorage. Empty => crypto_contract_source honestly reports "source
// unavailable — no key" instead of guessing the contract's code.

const LS = "exfer-agent-explorer-key-v1";
const BUILTIN = (import.meta.env.VITE_ETHERSCAN_API_KEY as string) || "";

export function loadExplorerKey(): string {
  try {
    return localStorage.getItem(LS) ?? "";
  } catch {
    return "";
  }
}

export function saveExplorerKey(key: string): void {
  try {
    if (key) localStorage.setItem(LS, key);
    else localStorage.removeItem(LS);
  } catch {
    /* ignore */
  }
}

/** The effective explorer key passed to capabilityTools: the user's own if set,
 *  else the build-time default, else "" (the tool honestly degrades). */
export function resolveExplorerKey(): string {
  return loadExplorerKey().trim() || BUILTIN || "";
}
