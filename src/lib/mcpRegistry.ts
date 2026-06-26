// MCP server registry (mobile). Same config shape as desktop/Rust (the shared
// contract) so it plugs straight into a native multi-MCP host when mobile Rust
// lands. Until then mobile only runs the built-in exfer-mcp on-device, so this
// is purely the manager UI's persistence layer: the list of *user-added*
// servers, kept in localStorage. The built-in "exfer" server is implicit
// (always enabled, not user-removable) and never stored here.

const STORAGE_KEY = "exfer.mcp.servers.v1";

/** A user-added MCP server. Identical fields to the desktop/Rust contract. */
export interface McpServerConfig {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  defaultConsent: "auto" | "gated";
}

function read(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

function write(list: McpServerConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage full / unavailable — registry stays in-memory for this session */
  }
}

/** User-added servers only (the built-in exfer server is implicit, never here). */
export function listServers(): McpServerConfig[] {
  return read();
}

/** Add (or replace, on id collision) a server. */
export function addServer(cfg: McpServerConfig): void {
  const list = read().filter((s) => s.id !== cfg.id);
  list.push(cfg);
  write(list);
}

export function removeServer(id: string): void {
  write(read().filter((s) => s.id !== id));
}

export function setEnabled(id: string, enabled: boolean): void {
  write(read().map((s) => (s.id === id ? { ...s, enabled } : s)));
}
