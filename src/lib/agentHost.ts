// Wires the headless exfer-agent core to the desktop host.
//
// The core (AgentSession) needs four injected effects. In the real Tauri app
// these go through Rust commands (llm_fetch, mcp_* sidecar, agent_confirm_consent);
// in browser dev (vite + Playwright, no Tauri) we substitute a scripted mock LLM
// + canned tools so the whole chat UX runs headless. `requestConsent` is always
// provided by the Agent page (it owns the confirmation card).

import {
  createProvider,
  type LLMProvider,
  type ProviderConfig,
  type StreamEvent,
  type ToolDef,
  type AgentToolResult,
} from "exfer-agent";

export function inTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export interface ToolSource {
  listTools(): Promise<ToolDef[]>;
  executeTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult>;
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

export const realTools: ToolSource = {
  listTools: () =>
    tauriInvoke<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>("mcp_list_tools").then((r) =>
      r.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      })),
    ),
  executeTool: (name, args) =>
    tauriInvoke<{ content: { type: string; text?: string }[]; isError?: boolean }>("mcp_call_tool", { name, args }).then((r) => ({
      content: r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
      isError: r.isError === true,
    })),
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
};

/** Pick provider + tools for the current environment. */
export function hostDeps(cfg?: ProviderConfig): { provider: LLMProvider; tools: ToolSource } {
  if (inTauri() && cfg?.apiKey) return { provider: realProvider(cfg), tools: realTools };
  return { provider: mockProvider, tools: mockTools };
}
