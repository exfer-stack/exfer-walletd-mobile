// Wires the headless exfer-agent core to the desktop host.
//
// The core (AgentSession) needs four injected effects. In the real Tauri app
// these go through Rust commands (llm_fetch, mcp_* sidecar, agent_confirm_consent);
// in browser dev (vite + Playwright, no Tauri) we substitute a scripted mock LLM
// + canned tools so the whole chat UX runs headless. `requestConsent` is always
// provided by the Agent page (it owns the confirmation card).

import {
  capabilityTools,
  createProvider,
  mergePolicies,
  EXFER_POLICY,
  type ConsentClass,
  type HostBridge,
  type LLMProvider,
  type ProviderConfig,
  type StreamEvent,
  type ToolDef,
  type ToolPolicy,
  type AgentToolResult,
} from "exfer-agent";
import { rpc } from "./rpc";
import { resolveSearchConfig } from "./searchConfig";
import { resolveExplorerKey } from "./explorerConfig";

export function inTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export interface ToolSource {
  listTools(): Promise<ToolDef[]>;
  executeTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult>;
  /** Merged consent policy across all mounted tool sources. Optional so older
   *  callers keep working; the host passes this into the AgentSession so unknown
   *  tools fail closed to the strictest source default. On mobile only the
   *  built-in exfer-mcp runs on-device (no native multi-MCP host yet), so this
   *  is the exfer policy — same shape it will keep once mobile Rust lands. */
  getPolicy?(): Promise<ToolPolicy>;
}

// ── real Tauri wiring (used when running inside the app) ───────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, string>;
}

/** LLM provider whose fetch is proxied through the Rust `llm_fetch` command:
 *  the real API key is injected host-side from the OS keychain (never in the
 *  webview) and webview CORS is bypassed. The config carries a placeholder key. */
export function realProvider(cfg: ProviderConfig): LLMProvider {
  const hostFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null;
    const res = await tauriInvoke<{ status: number; headers: Record<string, string>; body: string }>("llm_fetch", {
      req: { url, method: init?.method ?? "POST", headers: normalizeHeaders(init?.headers), body },
      provider: cfg.id,
      kind: cfg.kind,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
  return createProvider({ ...cfg, apiKey: "host-managed" }, hostFetch);
}

/** Re-authenticate a money-moving action before it runs. In Tauri this is a
 *  constant-time passphrase check in the OS keychain (biometric on mobile);
 *  in browser-dev there is no keychain, so it passes through. */
export async function confirmConsent(passphrase: string): Promise<boolean> {
  if (!inTauri()) return true;
  return tauriInvoke<boolean>("agent_confirm_consent", { passphrase });
}

// ── first-party capability tools (native, in-process) ────────────────────────
//
// The shared exfer-agent core owns the first-party capability layer: the market
// price/network/block/transaction readers, web_fetch/web_search/time, AND the
// on-device CPU miner (mine_start/stop/status — a NATIVE Tauri command, since
// iOS/Android can't run the desktop downloaded-binary path). Each tool reaches
// existing plumbing through three host primitives (walletd rpc, native command,
// CORS-free fetch). We inject `cap.defs` alongside the MCP tools and route any
// `cap.has(name)` call to `cap.call(...)`; mine_start stays consent-gated
// (policy "earn") → biometric on a real device.
const tauriBridge: HostBridge = {
  rpc: (method, params) => rpc(method, params ?? {}),
  command: (name, args) => tauriInvoke(name, args ?? {}),
  fetchText: (url, init) =>
    tauriInvoke("fetch_url", { req: { url, method: init?.method, body: init?.body, headers: init?.headers } }),
};
const cap = capabilityTools(tauriBridge);

export const realTools: ToolSource = {
  listTools: () =>
    tauriInvoke<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>("tool_list").then((r) => [
      ...r.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      })),
      ...cap.defs,
    ]),
  executeTool: (name, args) =>
    cap.has(name)
      ? capabilityTools(tauriBridge, { search: resolveSearchConfig(), etherscanKey: resolveExplorerKey() }).call(name, args)
      : tauriInvoke<{ content: { type: string; text?: string }[]; isError?: boolean }>("tool_call", { name, args }).then((r) => ({
          content: r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
          isError: r.isError === true,
        })),
  // Only the built-in exfer-mcp runs on-device today, so the merged policy is
  // just the exfer policy. When mobile gains a native multi-MCP host this will
  // merge per-server defaultConsent like desktop does.
  getPolicy: async () => EXFER_POLICY,
};

// ── browser-REAL path (web + walletd + CORS) ──────────────────────────────────
//
// When VITE_USE_REAL_AGENT="true" and we're NOT in Tauri, the mobile WEB build
// hits the SAME real backend a phone would — just over dev proxies instead of
// Rust commands. The /llm proxy injects the API key server-side (the browser
// never sees it); /mcp proxies to the Node http-bridge running REAL exfer-mcp +
// a REAL funded walletd. Nothing here is mocked. confirmConsent stays
// passthrough in the browser (biometric is the only allowed mock).

export function useRealBrowserAgent(): boolean {
  return import.meta.env.VITE_USE_REAL_AGENT === "true" && !inTauri();
}

/** LLM provider for the browser-real path: talks to the same-origin /llm proxy,
 *  which injects the real key. The config key is a placeholder. The base URL
 *  must be ABSOLUTE — the AI SDK does `new URL(baseUrl)` which throws on a bare
 *  "/llm" path, so we anchor it to the page origin (still same-origin → the vite
 *  /llm proxy → real LLM with the key injected server-side). */
export function browserRealProvider(cfg: ProviderConfig): LLMProvider {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:1430";
  return createProvider(
    { id: cfg.id, label: cfg.label, kind: "openai", baseUrl: `${origin}/llm`, apiKey: "proxy-managed", model: cfg.model },
    fetch,
  );
}

interface BridgeListToolsResult {
  tools: { name: string; description?: string; inputSchema?: unknown; server?: string }[];
  servers?: { id: string; defaultConsent: ConsentClass }[];
}

// Browser-preview capability bridge. walletd rpc goes through the same `rpc`
// helper (which forwards to the REAL walletd on the browser-real path), so the
// pure-rpc capability tools (price/network/block/tx) run for real in the
// preview. Native commands don't exist without Tauri: the miner reports it's
// app-only (non-error, so the consent gate + UI still exercise), any other
// command rejects, and get_bnb_price failure is swallowed by the price tool.
// `fetchText` uses the browser's own fetch, so web_fetch/web_search degrade on
// CORS — acceptable, they need the native host to read the open web.
// Same-origin /webfetch dev proxy → server-side fetch (no CORS). Returns {status, body}.
async function devWebfetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  const r = await fetch("/webfetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, method: init?.method, body: init?.body, headers: init?.headers }),
  });
  if (!r.ok) return { status: r.status, body: "" };
  return (await r.json()) as { status: number; body: string };
}

// Read-only chain RPC methods safe to proxy to a real node in the browser preview.
const DEV_CHAIN_RPC = new Set(["get_block_height", "get_status", "get_block_by_height", "get_block_by_id", "get_transaction", "get_node_info", "swap_price_klines"]);

const browserBridge: HostBridge = {
  // Browser preview normally routes rpc to devmock (fake). When VITE_EXFER_NODE_RPC
  // / VITE_EXFER_SWAP_URL are set (dev QA only), proxy the READ-ONLY chain/swap
  // reads to the real node/swap via /webfetch so the exfer-native tools
  // (exfer_price / exfer_self_audit / network_status) exercise real data. Off by
  // default; no endpoint is hardcoded (both come from the launch env).
  async rpc<T>(method: string, params?: unknown): Promise<T> {
    const NODE = import.meta.env.VITE_EXFER_NODE_RPC as string | undefined;
    const SWAP = import.meta.env.VITE_EXFER_SWAP_URL as string | undefined;
    if (SWAP && method === "swap_pool_info") {
      const { status, body } = await devWebfetch(`${SWAP}/api/pool`, { method: "GET" });
      if (status >= 200 && status < 400 && body) return JSON.parse(body) as T;
      throw new Error(`swap_pool_info proxy HTTP ${status}`);
    }
    if (NODE && DEV_CHAIN_RPC.has(method)) {
      const { body } = await devWebfetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }) });
      const j = (body ? JSON.parse(body) : {}) as { result?: T; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "node rpc error");
      return j.result as T;
    }
    return rpc(method, params ?? {}) as Promise<T>;
  },
  async command<T>(name: string): Promise<T> {
    // Real BNB/USD anchor in the browser preview (used by exfer_price / self_audit).
    if (name === "get_bnb_price") {
      const { status, body } = await devWebfetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { method: "GET" });
      if (status >= 200 && status < 400 && body) return JSON.stringify({ price: (JSON.parse(body) as { price?: string }).price }) as T;
      throw new Error("BNB price unavailable in preview");
    }
    if (name === "mine_start" || name === "mine_stop" || name === "mine_status") {
      return {
        running: false,
        note: "The on-device miner runs in the installed Android/iOS app; it is not available in the browser dev preview.",
      } as T;
    }
    throw new Error(`native command "${name}" is only available in the installed app`);
  },
  // Route through the same-origin /webfetch dev proxy (vite middleware) so the
  // crypto_*/web_* tools read the open web WITHOUT CORS — the browser-preview
  // equivalent of the phone's Rust fetch_url. A direct browser fetch here would
  // be CORS-blocked for GeckoTerminal / GoPlus / DexScreener / DuckDuckGo.
  fetchText: async (url, init) => {
    try {
      const r = await fetch("/webfetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, method: init?.method, body: init?.body, headers: init?.headers }),
      });
      if (!r.ok) return { status: r.status, body: "" };
      return (await r.json()) as { status: number; body: string };
    } catch (e) {
      return { status: 0, body: `webfetch unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
const browserCap = capabilityTools(browserBridge);

/** Real ToolSource over the /mcp bridge (POST /mcp/list_tools, /mcp/call_tool).
 *  Mirrors realTools/desktop but with global fetch through the vite proxy. */
export const browserRealTools: ToolSource = {
  listTools: async () => {
    // Wallet tools come from the /mcp bridge (real exfer-mcp + walletd). If that
    // bridge isn't running (e.g. a research-only preview with no walletd), don't
    // lose EVERY tool — still expose the first-party capability tools so the
    // agent's on-chain research surface works standalone.
    let walletDefs: ToolDef[] = [];
    try {
      const res = await fetch("/mcp/list_tools", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const r = (await res.json()) as BridgeListToolsResult;
      walletDefs = r.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    } catch {
      // walletd bridge down — capability-only research mode.
    }
    return [
      ...walletDefs,
      // First-party capability defs (price/network/web/crypto/time + miner) so the
      // agent + consent gate + UI are exercisable in the browser preview.
      ...browserCap.defs,
    ];
  },
  executeTool: async (name, args) => {
    // First-party capability tools run in-process via the browser bridge (native
    // ones — the miner — degrade honestly; the consent gate still fires).
    if (browserCap.has(name)) return capabilityTools(browserBridge, { search: resolveSearchConfig(), etherscanKey: resolveExplorerKey() }).call(name, args);
    const res = await fetch("/mcp/call_tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const r = (await res.json()) as { content: { type: string; text?: string }[]; isError?: boolean };
    return {
      content: (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
      isError: r.isError === true,
    };
  },
  // Build the merged policy from the bridge's server list, same as desktop:
  // the built-in "exfer" server uses EXFER_POLICY's per-tool classes; any other
  // server's tools take its defaultConsent. mergePolicies keeps the strictest
  // default so unknown tools stay fail-closed.
  getPolicy: async () => {
    let r: BridgeListToolsResult;
    try {
      const res = await fetch("/mcp/list_tools", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      r = (await res.json()) as BridgeListToolsResult;
    } catch {
      return EXFER_POLICY; // no bridge → capability-only; exfer policy classifies them
    }
    const servers = r.servers ?? [{ id: "exfer", defaultConsent: "auto" as ConsentClass }];
    const consentOf = new Map(servers.map((s) => [s.id, s.defaultConsent]));
    const policies: ToolPolicy[] = [EXFER_POLICY];
    for (const s of servers) {
      if (s.id === "exfer") continue;
      const classes: Record<string, ConsentClass> = {};
      for (const t of r.tools) {
        if (t.server === s.id) classes[t.name] = consentOf.get(s.id) ?? "gated";
      }
      policies.push({ classes, default: s.defaultConsent });
    }
    return mergePolicies(...policies);
  },
};

// ── browser-dev mock (scripted LLM + canned tools) ─────────────────────────────

const SELF_EXFER = "91e01411670779bf8df3f593f02da7b83b72b8ab315c15bc7f4de8a5adbbc042";
const PAYEE = "8c721d0534f232c767afd6672c007e561e4dd70ac5d57105d35450f2c6b1336e";

const MOCK_TOOLS: ToolDef[] = [
  { name: "exfer_get_balance", description: "Get EXFER balance for an address.", parameters: { type: "object", properties: { address: { type: "string" } } } },
  { name: "exfer_transfer", description: "Send EXFER. Moves funds.", parameters: { type: "object", properties: { to_address: { type: "string" }, amount: { type: "number" } }, required: ["to_address", "amount"] } },
  { name: "exfer_swap_get_quote", description: "Quote a BNB<->EXFER swap.", parameters: { type: "object", properties: { direction: { type: "string" }, amount_in: { type: "string" } } } },
  { name: "exfer_swap_execute", description: "Execute a swap. Moves funds.", parameters: { type: "object", properties: { swap_id: { type: "string" } } } },
];

// DEV-ONLY scripted strings. The mock provider is selected only in browser-dev
// (not in Tauri, and not on the browser-real path) — see hostDeps below — so a
// shipped, funded app never streams these. They intentionally stay un-i18n'd to
// avoid threading the active language through the provider factory (which the
// real Tauri/browser-real paths share). Do not surface in production.
async function* say(text: string): AsyncIterable<StreamEvent> {
  for (const chunk of text.match(/.{1,8}/g) ?? []) {
    yield { type: "text_delta", text: chunk };
    await new Promise((r) => setTimeout(r, 12));
  }
}

async function* scriptedStream(userText: string): AsyncIterable<StreamEvent> {
  const t = userText.toLowerCase();
  if (/balance|余额|how much/.test(t)) {
    yield { type: "thinking_delta", text: "The user wants their balance — I'll call exfer_get_balance for their address." };
    yield* say("Let me check your balance.");
    yield { type: "tool_call", call: { id: "c1", name: "exfer_get_balance", args: { address: SELF_EXFER } } };
    yield { type: "done", stopReason: "tool_use" };
    return;
  }
  if (/send|transfer|转/.test(t)) {
    yield { type: "thinking_delta", text: "A transfer request. I'll call exfer_transfer; the app will ask the user to confirm." };
    yield* say("I'll send that now.");
    // amount is base exfers (1 EXFER = 1e8) — 5 EXFER = 500_000_000.
    yield { type: "tool_call", call: { id: "c2", name: "exfer_transfer", args: { to_address: PAYEE, amount: 500_000_000, fee: 69 } } };
    yield { type: "done", stopReason: "tool_use" };
    return;
  }
  if (/swap|兑换|换/.test(t)) {
    yield { type: "thinking_delta", text: "Swap request — quote first, then execute (execute is gated)." };
    yield* say("Getting a quote first.");
    yield { type: "tool_call", call: { id: "c3q", name: "exfer_swap_get_quote", args: { direction: "bnb_to_exfer", amount_in: "0.002" } } };
    yield { type: "done", stopReason: "tool_use" };
    return;
  }
  yield { type: "thinking_delta", text: "General question about exfer." };
  yield* say(
    "I'm your exfer wallet agent. I can check your balance, send EXFER, and swap BNB↔EXFER — every money move asks for your fingerprint first. Try \"check my balance\".",
  );
  yield { type: "done", stopReason: "end_turn" };
}

// After a quote returns, proceed to the (gated) swap execution.
async function* swapExecuteStream(quoteJson: string): AsyncIterable<StreamEvent> {
  let swapId = "2e53ce5c";
  try {
    swapId = String((JSON.parse(quoteJson) as { swap_id?: string }).swap_id ?? swapId);
  } catch {
    /* keep default */
  }
  yield* say("Quote looks good — executing the swap.");
  yield { type: "tool_call", call: { id: "c3x", name: "exfer_swap_execute", args: { swap_id: swapId } } };
  yield { type: "done", stopReason: "tool_use" };
}

// After a tool runs, the mock summarizes and ends the turn (mirrors a real model
// reacting to the tool result, instead of re-calling the tool forever). A
// declined/errored tool never gets a success-flavored close.
async function* finalStream(toolName: string, resultJson: string, isError: boolean): AsyncIterable<StreamEvent> {
  if (isError) {
    yield* say(resultJson.toLowerCase().includes("declined") ? "Okay — I won't do that. Nothing was sent." : "That didn't go through.");
    yield { type: "done", stopReason: "end_turn" };
    return;
  }
  let line = "Done.";
  try {
    const r = JSON.parse(resultJson) as Record<string, unknown>;
    if (toolName === "exfer_get_balance") line = `Your balance is ${(Number(r.balance) / 1e8).toLocaleString("en-US")} EXFER.`;
    else if (toolName === "exfer_transfer") line = `Sent. Transaction ${String(r.tx_id ?? "").slice(0, 14)}…`;
    else if (toolName === "exfer_swap_execute") line = `Swap ${String(r.swap_id ?? "")} started (${String(r.state ?? "")}); it settles in the background.`;
  } catch {
    /* keep default */
  }
  yield* say(line);
  yield { type: "done", stopReason: "end_turn" };
}

export const mockProvider: LLMProvider = {
  kind: "openai",
  stream: ({ messages }) => {
    const last = messages[messages.length - 1];
    if (last && last.role === "tool") {
      if (last.name === "exfer_swap_get_quote" && !last.isError) return swapExecuteStream(last.content);
      return finalStream(last.name, last.content, last.isError === true);
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    return scriptedStream(lastUser && "content" in lastUser ? lastUser.content : "");
  },
};

export const mockTools: ToolSource = {
  listTools: async () => MOCK_TOOLS,
  executeTool: async (name) => {
    switch (name) {
      case "exfer_get_balance":
        return { content: JSON.stringify({ address: SELF_EXFER, balance: 100000000000 }) };
      case "exfer_transfer":
        return { content: JSON.stringify({ tx_id: "ca898cd9ad72d39d6d34b8c2268a5", fee: 69, submitted: true }) };
      case "exfer_swap_get_quote":
        return { content: JSON.stringify({ swap_id: "2e53ce5c", direction: "bnb_to_exfer", amount_in: "0.002", amount_out: "4039.99561830", fee_bps: 30 }) };
      case "exfer_swap_execute":
        return { content: JSON.stringify({ swap_id: "2e53ce5c", state: "user_locked", amount_out: "4039.99561830" }) };
      default:
        return { content: "{}" };
    }
  },
  getPolicy: async () => EXFER_POLICY,
};

/** Pick provider + tools for the current environment. */
export function hostDeps(cfg?: ProviderConfig): { provider: LLMProvider; tools: ToolSource } {
  if (inTauri() && cfg?.apiKey) return { provider: realProvider(cfg), tools: realTools };
  // Browser-real: same real LLM + real exfer-mcp/walletd as a phone, via dev
  // proxies. The key is proxy-managed, so we don't require cfg.apiKey here.
  if (useRealBrowserAgent() && cfg) return { provider: browserRealProvider(cfg), tools: browserRealTools };
  return { provider: mockProvider, tools: mockTools };
}
