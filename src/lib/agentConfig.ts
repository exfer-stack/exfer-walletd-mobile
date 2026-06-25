// User-configurable LLM provider for the agent ("bring your own LLM").
//
// The non-secret config (kind / baseUrl / model) lives in localStorage; the API
// key lives in the OS keychain via the Rust `set_llm_api_key` command (never in
// the webview). In browser-dev there is no keychain, so the key is kept in
// localStorage as a dev stand-in and the chat falls back to the scripted mock.

import { PROVIDER_PRESETS, type ProviderConfig, type ProviderKind } from "exfer-agent";

const LS_CFG = "exfer-agent-llm-config-v1";
const LS_KEY_DEV = "exfer-agent-llm-key-dev"; // browser-dev only

export interface SavedConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
}

function inTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export function loadConfig(): SavedConfig | null {
  try {
    const raw = localStorage.getItem(LS_CFG);
    return raw ? (JSON.parse(raw) as SavedConfig) : null;
  } catch {
    return null;
  }
}

export function saveConfig(c: SavedConfig): void {
  localStorage.setItem(LS_CFG, JSON.stringify(c));
}

export async function saveApiKey(providerId: string, key: string): Promise<void> {
  if (inTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_llm_api_key", { provider: providerId, key });
  } else {
    localStorage.setItem(LS_KEY_DEV, key);
  }
}

export async function hasApiKey(providerId: string): Promise<boolean> {
  if (inTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("has_llm_api_key", { provider: providerId });
  }
  return !!localStorage.getItem(LS_KEY_DEV);
}

/** Runtime ProviderConfig. In Tauri the apiKey is a placeholder (the real key is
 *  injected host-side by llm_fetch); in browser-dev it's the stored dev key. */
export function toProviderConfig(c: SavedConfig): ProviderConfig {
  const apiKey = inTauri() ? "host-managed" : (localStorage.getItem(LS_KEY_DEV) ?? "");
  return { id: c.id, label: c.label, kind: c.kind, baseUrl: c.baseUrl, model: c.model, apiKey };
}

export { PROVIDER_PRESETS };
