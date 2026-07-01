// User-added MCP server registry — the TS face of the Rust `mcp_registry`
// commands. Shape is identical across Rust + both UIs (see the shared interface
// contract). The built-in `exfer` server is implicit: it is never stored here,
// never listed, and not user-removable.
//
// In the real Tauri app these go through the Rust commands (which persist to
// `<datadir>/mcp-servers.json`, the same file the native tool router reads). In
// browser-dev (vite, no Tauri) there is no Rust side, so each call falls back to
// a localStorage-backed registry so the settings UI is still drivable headless.

import { inTauri } from "./agentHost";

export interface McpServerConfig {
  id: string;
  label: string;
  // Remote-only going forward: `httptool` (single-URL tool endpoint) or `http`
  // (streamable-http MCP). `stdio` is kept only so any legacy entry already in
  // the registry still renders; the backend refuses to add or run one.
  transport: "stdio" | "httptool" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  defaultConsent: "auto" | "gated";
}

const LS_KEY = "exfer.mcpServers";

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ── browser-dev localStorage fallback ─────────────────────────────────────────

function lsLoad(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

function lsSave(servers: McpServerConfig[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(servers));
  } catch {
    /* dev-only; ignore quota / disabled-storage */
  }
}

// ── public API (Tauri command, localStorage fallback in browser-dev) ──────────

export async function mcpListServers(): Promise<McpServerConfig[]> {
  if (!inTauri()) return lsLoad();
  return tauriInvoke<McpServerConfig[]>("mcp_list_servers");
}

export async function mcpAddServer(cfg: McpServerConfig): Promise<void> {
  if (cfg.id === "exfer") throw new Error('"exfer" is reserved for the built-in wallet server');
  if (!inTauri()) {
    const servers = lsLoad().filter((s) => s.id !== cfg.id);
    servers.push(cfg);
    lsSave(servers);
    return;
  }
  await tauriInvoke<void>("mcp_add_server", { cfg });
}

export async function mcpRemoveServer(id: string): Promise<void> {
  if (!inTauri()) {
    lsSave(lsLoad().filter((s) => s.id !== id));
    return;
  }
  await tauriInvoke<void>("mcp_remove_server", { id });
}

export async function mcpSetEnabled(id: string, enabled: boolean): Promise<void> {
  if (!inTauri()) {
    lsSave(lsLoad().map((s) => (s.id === id ? { ...s, enabled } : s)));
    return;
  }
  await tauriInvoke<void>("mcp_set_enabled", { id, enabled });
}
