import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSession, type AgentEvent, type ChatMessage, type ConsentCard, type ConsentField, type ToolPolicy } from "exfer-agent";
import { useT, type Lang, type MsgKey } from "../lib/i18n";
import { hostDeps } from "../lib/agentHost";
import { loadConfig, toProviderConfig, PROVIDER_PRESETS, saveConfig, saveApiKey, hasApiKey, type SavedConfig } from "../lib/agentConfig";
import { formatExfer } from "../lib/rpc";
import { agentError } from "../lib/errors";
import { biometricStatus, biometricUnlock } from "../lib/biometric";
import { Sheet, CopyButton, AppBar, Field, PasswordField, Spinner } from "./ui";
import { Icon } from "../lib/icons";
import { Markdown } from "./Markdown";
import { McpManagerSheet } from "./McpManagerSheet";
import { ConversationsSheet } from "./ConversationsSheet";
import * as convs from "../lib/conversationStore";

// In-wallet AI agent chat (mobile). Same headless core as desktop; mobile look
// (phone shell + a consent sheet gated by Face/Touch ID). The chat reducer is
// the same pure block model as desktop.

interface ToolCard {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  summary?: string;
  gated: boolean;
}
// A read-only research sub-agent the parent spawned. We render its forwarded
// transcript (text + the tools it ran) as a nested collapsible card.
interface SubAgentCard {
  id: string;
  task: string;
  status: "running" | "done";
  text: string;
  tools: string[];
}
type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; card: ToolCard }
  | { kind: "subagent"; card: SubAgentCard };
interface Turn {
  role: "user" | "assistant";
  text?: string;
  thinking?: string;
  blocks: Block[];
}
interface PendingConsent {
  card: ConsentCard;
  resolve: (ok: boolean) => void;
}

function swapFields(q: Record<string, unknown>): ConsentField[] {
  const dir = String(q.direction ?? "");
  const pretty = dir === "bnb_to_exfer" ? "BNB → EXFER" : dir === "exfer_to_bnb" ? "EXFER → BNB" : dir;
  const payUnit = dir === "bnb_to_exfer" ? "BNB" : "EXFER";
  const getUnit = dir === "bnb_to_exfer" ? "EXFER" : "BNB";
  return [
    { label: "Direction", labelKey: "direction", value: pretty },
    { label: "You pay", labelKey: "you_pay", value: `${q.amount_in} ${payUnit}` },
    { label: "You receive", labelKey: "you_receive", value: `≈ ${q.amount_out} ${getUnit}` },
    { label: "Fee", labelKey: "fee", value: q.fee_bps != null ? `${Number(q.fee_bps) / 100}%` : "" },
  ];
}

type T = ReturnType<typeof useT>["t"];

// A friendly, localized label for a tool, so the card header reads like a human
// action (in the user's language) — not a stack trace. Falls back to the
// de-prefixed, spaced name for anything new.
function toolLabel(t: T, name: string): string {
  const key = `agent.toolLabel.${name}` as MsgKey;
  const label = t(key);
  // t() returns the EN fallback string when a key is missing only if the key
  // exists; for a genuinely-unknown tool the key isn't in the table so t()
  // returns the key itself — detect that and de-prefix the raw name instead.
  if (label === key) return name.replace(/^exfer_/, "").replace(/_/g, " ");
  return label;
}

// A short copyable id (full value lives in Details + is selectable).
function shortHash(v: string): string {
  return v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;
}

// A localized one-line summary of a tool result. Falls back to a clipped raw
// summary for anything we don't have a template for.
function humanizeTool(t: T, name: string, summary: string): string {
  try {
    const r = JSON.parse(summary) as Record<string, unknown>;
    switch (name) {
      case "exfer_get_balance":
        return t("agent.tool.sub.balance", { amt: formatExfer(Number(r.balance)) });
      case "exfer_list_addresses": {
        const n = Array.isArray(r) ? r.length : Array.isArray((r as { addresses?: unknown[] }).addresses) ? (r as { addresses: unknown[] }).addresses.length : 1;
        return t("agent.tool.sub.addresses", { n });
      }
      case "exfer_generate_address":
        return r.address ? t("agent.tool.sub.newAddress", { addr: shortHash(String(r.address)) }) : t("agent.toolLabel.exfer_generate_address");
      case "exfer_simulate_transfer":
        return t("agent.tool.sub.preview", { fee: formatExfer(Number(r.fee ?? 0)) });
      case "exfer_transfer":
        return t("agent.tool.sub.submitted", { fee: formatExfer(Number(r.fee ?? 0)), tx: shortHash(String(r.tx_id ?? "")) });
      case "exfer_swap_get_quote":
        return t("agent.tool.sub.quote", { in: String(r.amount_in), out: String(r.amount_out) });
      case "exfer_swap_execute":
        return t("agent.tool.sub.swapStarted", { id: shortHash(String(r.swap_id ?? "")) });
      default:
        return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    }
  } catch {
    return summary;
  }
}

// Pretty-print the raw tool payload for the collapsed Details disclosure.
function prettyRaw(summary: string): string {
  try {
    return JSON.stringify(JSON.parse(summary), null, 2);
  } catch {
    return summary;
  }
}

export function AgentTab({ lang }: { lang: Lang }) {
  const { t } = useT();
  // Bind to a conversation lazily (no empty shell persisted until first turn).
  const [convId, setConvId] = useState<string>(() => convs.ensureActive().id);
  const initialConv = useMemo(() => convs.getActive(), []); // snapshot at mount
  const [turns, setTurns] = useState<Turn[]>(() => (initialConv?.turns as Turn[] | undefined) ?? []);
  const [truncated, setTruncated] = useState<boolean>(() => initialConv?.truncated ?? false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showConvs, setShowConvs] = useState(false);
  const [hasKey, setHasKey] = useState(true); // assume yes until checked (no flicker)
  const [policy, setPolicy] = useState<ToolPolicy | undefined>(undefined);
  const [cfgVersion, setCfgVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuoteRef = useRef<Record<string, unknown> | null>(null);
  const lastUserText = useRef<string>("");
  // The seed transcript for the (re)built session: the active conversation's
  // messages, so a lang/provider/MCP change preserves context instead of resetting.
  const seedRef = useRef<ChatMessage[]>((initialConv?.messages as ChatMessage[] | undefined) ?? []);

  // Whether a real provider key is configured. Drives the "connect your provider"
  // nudge instead of silently running the scripted mock. Re-checked on config change.
  useEffect(() => {
    let live = true;
    const saved = loadConfig();
    if (!saved) {
      setHasKey(false);
      return;
    }
    hasApiKey(saved.id)
      .then((ok) => {
        if (live) setHasKey(ok);
      })
      .catch(() => {
        if (live) setHasKey(false);
      });
    return () => {
      live = false;
    };
  }, [cfgVersion]);

  // Resolve the merged consent policy from the active tool source (async; on
  // mobile this is just the exfer policy today). Recomputed when the config
  // changes so a provider swap re-derives it.
  useEffect(() => {
    let live = true;
    const saved = loadConfig();
    const { tools } = hostDeps(saved ? toProviderConfig(saved) : undefined);
    Promise.resolve(tools.getPolicy?.())
      .then((p) => {
        if (live) setPolicy(p);
      })
      .catch(() => {
        /* fall back to the session's built-in default policy */
      });
    return () => {
      live = false;
    };
  }, [cfgVersion]);

  const session = useMemo(() => {
    const saved = loadConfig();
    const cfg = saved ? toProviderConfig(saved) : undefined;
    const { provider, tools } = hostDeps(cfg);
    const langName = lang === "zh" ? "Chinese (简体中文)" : "English";
    return new AgentSession({
      provider,
      model: saved?.model ?? "deepseek-chat",
      listTools: tools.listTools,
      executeTool: tools.executeTool,
      policy,
      // Seed from the active conversation so a lang/provider/MCP rebuild resumes
      // mid-thread (the session is rebuilt on [lang, cfgVersion, policy, convId]).
      initialMessages: seedRef.current,
      requestConsent: (req) =>
        new Promise<boolean>((resolve) => {
          let card = req.card;
          if (card.toolName === "exfer_swap_execute") {
            const q = lastQuoteRef.current;
            const idField = card.fields.find((f) => f.labelKey === "swap_id");
            if (q && idField && String(q.swap_id) === String(idField.value)) {
              card = { ...card, fields: [...swapFields(q), ...card.fields] };
            }
          }
          setConsent({ card, resolve });
        }),
      systemPrompt:
        "You are the exfer wallet agent. Use tools to fulfil the user's request; the app shows a confirmation card for any money move, so never ask the user to confirm or remind them that they must approve. " +
        "Be concise: lead with the answer, skip preamble and recap, and don't narrate which tool you're about to call. Format with Markdown — short paragraphs, bullet lists, and a table when presenting balances or a quote. " +
        // Pin BOTH the parent's replies AND the {task} it hands to a research
        // sub-agent to the active language, so a 中文 session never shows an
        // English research task line next to a Chinese frame.
        `When you call spawn_research_agent, write its task in ${langName}. ` +
        `Always respond in ${langName}.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, cfgVersion, policy, convId]);

  // Persist a snapshot (turns + the model transcript) of the active conversation.
  // trimHistory caps the transcript at the SEED boundary without orphaning a
  // tool_use from its result. Called on turn_done / error / stop.
  const flushSnapshot = useCallback(
    (nextTurns: Turn[]) => {
      const trimmed = convs.trimHistory(session.snapshot, { maxMessages: 40, keepHead: 2 });
      seedRef.current = trimmed.messages;
      if (trimmed.truncated) setTruncated(true);
      convs.save(convId, nextTurns, trimmed.messages, trimmed.truncated || undefined);
    },
    [convId, session],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Auto-grow the composer: reset to one row, then grow to fit content up to a
  // ~6-row cap (after which it scrolls). Runs on every input change.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 132; // ~6 rows at the field's line-height
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  const patchLast = useCallback((fn: (t: Turn) => void) => {
    setTurns((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = { ...next[next.length - 1], blocks: next[next.length - 1].blocks.slice() };
      fn(last);
      next[next.length - 1] = last;
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      lastUserText.current = text;
      setErrorBanner(null);
      setInput("");
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      setTurns((p) => [...p, { role: "user", text, blocks: [] }, { role: "assistant", blocks: [] }]);
      try {
        for await (const ev of session.send(text, controller.signal) as AsyncIterable<AgentEvent>) {
          switch (ev.type) {
            case "thinking_delta":
              patchLast((tn) => (tn.thinking = (tn.thinking ?? "") + ev.text));
              break;
            case "text_delta":
              patchLast((tn) => {
                const i = tn.blocks.length - 1;
                const tail = tn.blocks[i];
                if (tail?.kind === "text") tn.blocks[i] = { kind: "text", text: tail.text + ev.text };
                else tn.blocks.push({ kind: "text", text: ev.text });
              });
              break;
            case "tool_call_started":
              patchLast((tn) => tn.blocks.push({ kind: "tool", card: { id: ev.id, name: ev.name, args: ev.args, status: "running", gated: ev.consentClass !== "auto" } }));
              break;
            case "tool_result":
              if (ev.name === "exfer_swap_get_quote" && ev.ok) {
                try {
                  lastQuoteRef.current = JSON.parse(ev.summary) as Record<string, unknown>;
                } catch {
                  /* ignore */
                }
              }
              if (ev.name === "exfer_swap_execute") lastQuoteRef.current = null;
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "tool" && b.card.id === ev.id);
                if (i >= 0) {
                  const b = tn.blocks[i] as { kind: "tool"; card: ToolCard };
                  tn.blocks[i] = { kind: "tool", card: { ...b.card, status: ev.ok ? "ok" : "error", summary: ev.summary } };
                }
              });
              break;
            case "subagent_started":
              patchLast((tn) => tn.blocks.push({ kind: "subagent", card: { id: ev.id, task: ev.task, status: "running", text: "", tools: [] } }));
              break;
            case "subagent_event":
              // Fold the child's forwarded transcript into its card: accumulate
              // its assistant text and record each tool it ran.
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "subagent" && b.card.id === ev.id);
                if (i < 0) return;
                const b = tn.blocks[i] as { kind: "subagent"; card: SubAgentCard };
                const inner = ev.event;
                if (inner.type === "text_delta") {
                  tn.blocks[i] = { kind: "subagent", card: { ...b.card, text: b.card.text + inner.text } };
                } else if (inner.type === "tool_call_started") {
                  tn.blocks[i] = { kind: "subagent", card: { ...b.card, tools: [...b.card.tools, inner.name] } };
                }
              });
              break;
            case "subagent_done":
              patchLast((tn) => {
                const i = tn.blocks.findIndex((b) => b.kind === "subagent" && b.card.id === ev.id);
                if (i < 0) return;
                const b = tn.blocks[i] as { kind: "subagent"; card: SubAgentCard };
                // Prefer the explicit summary; keep streamed text if the summary is empty.
                tn.blocks[i] = { kind: "subagent", card: { ...b.card, status: "done", text: ev.summary || b.card.text } };
              });
              break;
            case "error":
              // Map raw backend strings to a calm, localized line; keep the raw
              // text for the collapsed Details disclosure on the banner.
              setErrorRaw(ev.message);
              setErrorBanner(agentError(ev.message));
              break;
          }
        }
      } catch (e) {
        setErrorRaw(e instanceof Error ? e.message : String(e));
        setErrorBanner(agentError(e));
      } finally {
        abortRef.current = null;
        setBusy(false);
        // Snapshot the completed (or stopped/errored) turn. Read the latest turns
        // via a functional update so we don't race the streaming setState calls.
        setTurns((cur) => {
          flushSnapshot(cur);
          return cur;
        });
      }
    },
    [busy, session, patchLast, flushSnapshot],
  );

  // Switch to a different conversation: rebuild the session from its transcript.
  // Blocked while busy; any dangling consent is resolved(false) so a fund move
  // never carries across a switch.
  const switchConversation = useCallback(
    (id: string) => {
      if (busy) return;
      if (consent) {
        consent.resolve(false);
        setConsent(null);
      }
      convs.setActive(id);
      const c = convs.getActive();
      seedRef.current = (c?.messages as ChatMessage[] | undefined) ?? [];
      lastQuoteRef.current = null;
      setErrorBanner(null);
      setErrorRaw(null);
      setTurns((c?.turns as Turn[] | undefined) ?? []);
      setTruncated(c?.truncated ?? false);
      setConvId(id); // rebuilds the session (it's in the useMemo deps)
    },
    [busy, consent],
  );

  // Start a fresh chat. Reuses the active conversation if it's already empty
  // (avoids stacking empty shells), else creates a new one.
  const newConversation = useCallback(() => {
    if (busy) return;
    if (consent) {
      consent.resolve(false);
      setConsent(null);
    }
    const active = convs.getActive();
    const c = active && active.turns.length === 0 ? active : convs.create();
    seedRef.current = [];
    lastQuoteRef.current = null;
    setErrorBanner(null);
    setErrorRaw(null);
    setTurns([]);
    setTruncated(false);
    setConvId(c.id);
  }, [busy, consent]);

  // Refill the composer with the last user message (edit/retry a turn without
  // depending on the error banner). Focuses the textarea for an immediate edit.
  const editLast = useCallback(() => {
    if (busy || !lastUserText.current) return;
    setInput(lastUserText.current);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [busy]);

  // Resend the last user message (regenerate after a stopped/finished/errored turn).
  const regenerate = useCallback(() => {
    if (busy || !lastUserText.current) return;
    void send(lastUserText.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, send]);

  const examples = [t("agent.empty.ex1"), t("agent.empty.ex2"), t("agent.empty.ex3")];

  return (
    <div className="agent-tab" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ padding: "6px 14px 0" }}>
        <AppBar
          title={t("nav.agent")}
          right={
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              <button type="button" className="icon-btn" onClick={newConversation} disabled={busy} aria-label={t("agent.conv.new")} data-testid="agent-new-chat">
                <Icon name="plus" size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setShowConvs(true)} aria-label={t("agent.conv.open")} data-testid="agent-convs-open">
                <Icon name="clock" size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setShowMcp(true)} aria-label={t("agent.mcp.open")} data-testid="agent-mcp-open">
                <Icon name="node" size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setShowSettings(true)} aria-label={t("agent.settings.open")} data-testid="agent-settings-open">
                <Icon name="settings" size={18} />
              </button>
            </div>
          }
        />
      </div>
      <div ref={scrollRef} className="agent-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 12px 12px" }}>
        {turns.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: "16%" }}>
            <h2 className="title-lg">{t("agent.empty.title")}</h2>
            <p className="dim" style={{ margin: "8px 0 6px", fontSize: "14px", lineHeight: 1.5 }}>{t("agent.empty.subtitle")}</p>
            <p className="faint" style={{ margin: "0 8px 18px", fontSize: "12.5px", lineHeight: 1.5 }}>{t("agent.empty.safety")}</p>
            {!hasKey && (
              <div className="banner banner-info" style={{ margin: "0 4px 16px", textAlign: "left", display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }} data-testid="agent-nokey-nudge">
                <span>{t("agent.nudge.connect")}</span>
                <button type="button" className="btn btn-sm" style={{ flex: "0 0 auto" }} onClick={() => setShowSettings(true)}>{t("agent.nudge.connectCta")}</button>
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px" }}>
              {examples.map((ex) => (
                <button key={ex} type="button" className="agent-chip" onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {truncated && turns.length > 0 && (
          <p className="faint" style={{ textAlign: "center", fontSize: "12px", margin: "8px 0 2px" }} data-testid="agent-trimmed">{t("agent.conv.trimmed")}</p>
        )}

        {turns.map((tn, i) =>
          tn.role === "user" ? (
            <div key={i} style={{ textAlign: "right", margin: "8px 0" }}>
              <span className="card" style={{ display: "inline-block", padding: "8px 12px", textAlign: "left" }}>{tn.text}</span>
              {/* Edit/retry this turn independent of the error banner. */}
              {i === turns.length - 2 && !busy && (
                <div style={{ marginTop: "3px" }}>
                  <button type="button" className="btn-ghost btn-sm" onClick={editLast} data-testid="agent-edit-last">{t("agent.composer.editLast")}</button>
                </div>
              )}
            </div>
          ) : (
            <div key={i} style={{ margin: "8px 0" }} data-testid="assistant-turn">
              {tn.thinking && (
                <details open={busy && i === turns.length - 1} className="agent-card agent-disc" style={{ padding: "8px", marginBottom: "6px" }}>
                  <summary className="h-row" style={{ gap: "6px", alignItems: "center" }}>
                    <Icon name="spark" size={14} />
                    <span className="agent-disc-label">{t("agent.thinking.label")}</span>
                    <span className="agent-disc-status">{busy && i === turns.length - 1 ? t("agent.thinking.active") : ""}</span>
                  </summary>
                  <div className="faint" style={{ whiteSpace: "pre-wrap", marginTop: "4px" }}>{tn.thinking}</div>
                </details>
              )}
              {tn.blocks.map((b, j) => {
                if (b.kind === "text") {
                  return b.text ? (
                    <div key={j} style={{ margin: "4px 0" }}>
                      <Markdown source={b.text} />
                    </div>
                  ) : null;
                }
                if (b.kind === "subagent") {
                  return (
                    <details
                      key={j}
                      open={b.card.status === "running"}
                      className="agent-card agent-disc agent-subagent"
                      style={{ padding: "8px 8px 8px 12px", margin: "4px 0 4px 14px" }}
                      data-testid="subagent-card"
                    >
                      <summary className="h-row" style={{ gap: "6px", alignItems: "center" }}>
                        <Icon name="spark" size={14} />
                        <span className="agent-disc-label">{t("agent.subagent.label")}</span>
                        <span className="agent-disc-status">
                          {b.card.status === "running" ? t("agent.subagent.running") : t("agent.subagent.done")}
                        </span>
                      </summary>
                      <div className="faint" style={{ marginTop: "4px", fontSize: "12.5px" }}>{b.card.task}</div>
                      {b.card.tools.length > 0 && (
                        <div className="h-row" style={{ flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                          {b.card.tools.map((nm, k) => (
                            <span key={k} className="pill pill-muted mono" style={{ fontSize: "0.68rem", padding: "2px 7px" }}>{nm}</span>
                          ))}
                        </div>
                      )}
                      {b.card.text && (
                        <div style={{ marginTop: "6px" }}>
                          <Markdown source={b.card.text} />
                        </div>
                      )}
                    </details>
                  );
                }
                {
                  const s = b.card.summary ?? "";
                  const running = b.card.status === "running";
                  // walletd errors come back as non-isError content, so trust the
                  // status OR sniff an error shape — never show a green check on a
                  // failed call.
                  const errored = b.card.status === "error" || (s !== "" && s !== "declined" && /(\berror\b|invalid params|\bfailed\b|code\s*-?\d|no [\w/]+ key|seedless)/i.test(s));
                  const declined = s === "declined";
                  const showRaw = s !== "" && !declined;
                  return (
                    <div key={j} className="agent-card" style={{ padding: "9px 11px", margin: "5px 0", overflow: "hidden" }} data-testid="tool-card">
                      <div style={{ display: "flex", alignItems: "center", gap: "7px", minWidth: 0 }}>
                        {running ? (
                          <span style={{ flex: "0 0 auto", display: "inline-flex" }}><Spinner size={14} /></span>
                        ) : (
                          <span style={{ flex: "0 0 auto", color: errored ? "#f87171" : "#34d399" }}>{errored ? "✕" : "✓"}</span>
                        )}
                        <span className="agent-tool-title">{toolLabel(t, b.card.name)}</span>
                        {b.card.gated && b.card.status === "running" && <span className="pill pill-warn" style={{ flex: "0 0 auto" }}>{t("agent.tool.gated")}</span>}
                      </div>
                      {s && (declined ? (
                        <div className="dim" style={{ marginTop: "5px" }}>{t("agent.consent.declined")}</div>
                      ) : (
                        // Route the humanized subline through Markdown so any full
                        // tx_id / address / swap_id becomes a copyable chip.
                        <div className="agent-tool-sub" data-testid="tool-card-sub">
                          <Markdown source={humanizeTool(t, b.card.name, s)} />
                        </div>
                      ))}
                      {showRaw && (
                        <details className="agent-disc" style={{ marginTop: "6px" }} data-testid="tool-card-details">
                          <summary className="faint" style={{ fontSize: "12px" }}>{t("agent.tool.details")}</summary>
                          <div className="md" style={{ marginTop: "5px" }}>
                            <pre className="mono" style={{ fontSize: "11.5px" }}><code>{prettyRaw(s)}</code></pre>
                          </div>
                        </details>
                      )}
                    </div>
                  );
                }
              })}
            </div>
          ),
        )}
      </div>

      {errorBanner && (
        <div className="banner banner-danger" style={{ margin: "0 12px" }} role="alert" data-testid="agent-error-banner">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
            <span>{errorBanner}</span>
            <button type="button" className="btn-ghost btn-sm" style={{ flex: "0 0 auto" }} onClick={regenerate}>{t("agent.error.retry")}</button>
          </div>
          {errorRaw && errorRaw !== errorBanner && (
            <details className="agent-disc" style={{ marginTop: "6px" }}>
              <summary className="faint" style={{ fontSize: "12px" }}>{t("agent.tool.details")}</summary>
              <div className="md" style={{ marginTop: "5px" }}>
                <pre className="mono" style={{ fontSize: "11.5px" }}><code>{errorRaw}</code></pre>
              </div>
            </details>
          )}
        </div>
      )}

      <div className="agent-composer" style={{ display: "flex", gap: "8px", alignItems: "flex-end", padding: "12px 12px calc(12px + env(safe-area-inset-bottom))" }}>
        <textarea
          ref={inputRef}
          className="field"
          style={{ flex: 1, resize: "none", lineHeight: 1.4 }}
          rows={1}
          placeholder={t("agent.composer.placeholder")}
          value={input}
          // Editable while busy — only the Send button swaps to Stop, so the user
          // can draft the next message during a reply.
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // ArrowUp on an empty composer recalls the last user message (shell-
            // style history), so a quick edit/retry doesn't need the banner.
            if (e.key === "ArrowUp" && input === "" && lastUserText.current) {
              e.preventDefault();
              setInput(lastUserText.current);
              return;
            }
            // Cmd/Ctrl+Enter is a send alias. Plain Enter sends; Shift+Enter is a
            // newline. Guard isComposing so a Chinese IME confirm (which also fires
            // Enter) never sends mid-input.
            const sendChord = (e.metaKey || e.ctrlKey) && e.key === "Enter";
            if ((sendChord || (e.key === "Enter" && !e.shiftKey)) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
          data-testid="agent-input"
        />
        {busy ? (
          <button type="button" className="btn btn-secondary" onClick={() => abortRef.current?.abort()} data-testid="agent-stop">{t("agent.composer.stop")}</button>
        ) : input.trim() ? (
          <button type="button" className="btn" onClick={() => send(input)} data-testid="agent-send">{t("agent.composer.send")}</button>
        ) : turns.length > 0 && lastUserText.current ? (
          // Composer empty after a finished/stopped turn → offer a regenerate.
          <button type="button" className="btn btn-secondary" onClick={regenerate} data-testid="agent-regenerate">{t("agent.composer.regenerate")}</button>
        ) : (
          <button type="button" className="btn" disabled data-testid="agent-send">{t("agent.composer.send")}</button>
        )}
      </div>

      {consent && (
        <AgentConsentSheet
          card={consent.card}
          t={t}
          onResolve={(ok) => {
            consent.resolve(ok);
            setConsent(null);
          }}
        />
      )}

      {showSettings && (
        <AgentSettingsSheet
          t={t}
          onClose={(saved) => {
            setShowSettings(false);
            if (saved) setCfgVersion((v) => v + 1);
          }}
        />
      )}

      {showMcp && <McpManagerSheet onClose={() => setShowMcp(false)} />}

      {showConvs && (
        <ConversationsSheet
          lang={lang}
          activeId={convId}
          busy={busy}
          onClose={() => setShowConvs(false)}
          onSwitch={(id) => {
            switchConversation(id);
            setShowConvs(false);
          }}
          onNew={() => {
            newConversation();
            setShowConvs(false);
          }}
        />
      )}
    </div>
  );
}

// Bring-your-own-LLM settings as a bottom sheet — the mobile entry point to a
// real provider (without it the chat is stuck on the scripted mock). Non-secret
// config → localStorage; the API key → OS keychain via saveApiKey.
function AgentSettingsSheet({ t, onClose }: { t: ReturnType<typeof useT>["t"]; onClose: (saved: boolean) => void }) {
  const existing = loadConfig();
  const [presetIdx, setPresetIdx] = useState(() => {
    const i = PROVIDER_PRESETS.findIndex((p) => p.baseUrl === existing?.baseUrl);
    return i >= 0 ? i : 0;
  });
  const preset = PROVIDER_PRESETS[presetIdx];
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? preset.baseUrl);
  const [model, setModel] = useState(existing?.model ?? preset.defaultModel);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const onPreset = (i: number) => {
    setPresetIdx(i);
    const p = PROVIDER_PRESETS[i];
    setBaseUrl(p.baseUrl);
    setModel(p.defaultModel);
  };

  // Whether a key is already on file for this provider, so we can show a calm
  // "Key saved" indicator instead of an empty field that looks unconfigured.
  const [keySaved, setKeySaved] = useState(false);
  useEffect(() => {
    let live = true;
    hasApiKey("user")
      .then((ok) => {
        if (live) setKeySaved(ok);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const onSave = async () => {
    setSaving(true);
    const cfg: SavedConfig = { id: "user", label: preset.label, kind: preset.kind, baseUrl, model };
    saveConfig(cfg);
    if (apiKey.trim()) await saveApiKey("user", apiKey.trim());
    setSaving(false);
    onClose(true);
  };

  const footer = (
    <div className="h-row" style={{ gap: "10px" }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => onClose(false)}>
        {t("agent.settings.cancel")}
      </button>
      <button type="button" className="btn btn-block" disabled={saving} onClick={onSave} data-testid="settings-save">
        {t("agent.settings.save")}
      </button>
    </div>
  );

  return (
    <Sheet title={t("agent.settings.title")} onClose={() => onClose(false)} footer={footer}>
      <div data-testid="agent-settings" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <Field label={t("agent.settings.provider")}>
          <select className="field" value={presetIdx} onChange={(e) => onPreset(Number(e.target.value))} data-testid="settings-provider">
            {PROVIDER_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {(p.labelKey && t(p.labelKey as MsgKey)) || p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("agent.settings.baseUrl")}>
          <input className="field mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
        </Field>
        <Field label={t("agent.settings.model")}>
          <input className="field mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
        </Field>
        <Field label={t("agent.settings.apiKey")} help={`${t("agent.settings.keyExplain")} ${t("agent.settings.keyNote")}`}>
          <PasswordField className="field" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keySaved ? "••••••••" : "sk-…"} data-testid="settings-apikey" />
          {keySaved && (
            <div className="h-row" style={{ gap: "5px", justifyContent: "flex-start", marginTop: "7px", color: "#34d399", fontSize: "12.5px" }} data-testid="settings-key-saved">
              <Icon name="check" size={14} />
              <span>{t("agent.settings.keySaved")}</span>
            </div>
          )}
        </Field>
      </div>
    </Sheet>
  );
}

function AgentConsentSheet({ card, t, onResolve }: { card: ConsentCard; t: ReturnType<typeof useT>["t"]; onResolve: (ok: boolean) => void }) {
  const [verifying, setVerifying] = useState(false);

  // Read biometric status AT ACTION TIME (not a pre-paint default) so an early
  // tap can never approve a fund move without Face/Touch ID on a capable device.
  const approve = async () => {
    if (verifying) return;
    setVerifying(true);
    const s = await biometricStatus().catch(() => ({ available: false, type: 0 }));
    const ok = s.available ? await biometricUnlock(t("agent.consent.reason")).catch(() => false) : true;
    setVerifying(false);
    if (ok) onResolve(true);
  };

  const titleText = (card.titleKey && t(`agent.consent.title.${card.titleKey}` as MsgKey)) || card.title;
  const risky = card.consentClass === "gated";

  // Pull the amount + fee fields to compute a Total — the single most important
  // number, otherwise absent on mobile. Amounts are base exfers (strings). A
  // blank fee means "estimated at send"; we still show the amount as the total
  // and flag it as an estimate rather than hiding the number entirely.
  const amountField = card.fields.find((f) => f.kind === "amount" && f.labelKey === "amount");
  const feeField = card.fields.find((f) => f.labelKey === "fee");
  const amt = amountField ? Number(amountField.value) : NaN;
  const feeRaw = feeField ? Number(feeField.value) : NaN;
  const feeKnown = feeField != null && feeField.value !== "" && !Number.isNaN(feeRaw);
  const showTotal = amountField != null && !Number.isNaN(amt);
  const totalSafe = showTotal && Number.isSafeInteger(amt) && (!feeKnown || Number.isSafeInteger(feeRaw));
  const totalVal = amt + (feeKnown ? feeRaw : 0);

  const renderValue = (f: ConsentField) => {
    if (f.kind === "amount") {
      const n = Number(f.value);
      if (f.value === "" || Number.isNaN(n)) return <span className="mono dim" style={{ fontSize: "14px" }}>{t("agent.consent.feeEstimated")}</span>;
      // Guard against precision loss above MAX_SAFE_INTEGER — show the raw base
      // amount rather than a silently-wrong formatted number.
      const text = Number.isSafeInteger(n) ? formatExfer(n) : `${f.value} exfers`;
      return <span className="mono agent-amount">{text}</span>;
    }
    // An address is the irreversible part of a transfer — make it copyable so
    // the user can cross-check it (a hallucinated/injected address is otherwise
    // undetectable on a phone) before Face/Touch ID fires.
    if (f.kind === "address") {
      return (
        <span className="h-row" style={{ gap: "6px", justifyContent: "flex-end", alignItems: "flex-start" }}>
          <span className="mono" style={{ wordBreak: "break-all", textAlign: "right", fontSize: "13px" }}>{f.value || "—"}</span>
          {f.value && <CopyButton text={f.value} label={t("agent.consent.copied")} size={15} />}
        </span>
      );
    }
    return <span className="mono" style={{ wordBreak: "break-all" }}>{f.value || "—"}</span>;
  };

  const footer = (
    <div className="h-row" style={{ gap: "10px" }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => onResolve(false)} data-testid="consent-decline">
        {t("agent.consent.decline")}
      </button>
      <button type="button" className="btn btn-block" disabled={verifying} onClick={approve} data-testid="consent-approve">
        {t("agent.consent.approve")}
      </button>
    </div>
  );

  // Render through the app's Sheet primitive: inherits the contained scrim,
  // slide-up animation, grip, scroll cap, safe-area-padded footer, scrim-tap +
  // hardware-back dismissal, and the correct radius — none of which the previous
  // hand-rolled position:fixed overlay had.
  return (
    <Sheet title={titleText} onClose={() => onResolve(false)} footer={footer}>
      <div data-testid="consent-card">
        <dl style={{ margin: 0 }}>
          {card.fields.map((f) => (
            <div key={f.label} className="h-row" style={{ justifyContent: "space-between", gap: "12px", margin: "8px 0" }}>
              <dt className="dim">{(f.labelKey && t(`agent.consent.field.${f.labelKey}` as MsgKey)) || f.label}</dt>
              <dd style={{ margin: 0, textAlign: "right" }}>{renderValue(f)}</dd>
            </div>
          ))}
        </dl>
        {showTotal && (
          <div className="h-row" style={{ justifyContent: "space-between", gap: "12px", borderTop: "1px solid var(--border)", marginTop: "6px", paddingTop: "10px", alignItems: "baseline" }} data-testid="consent-total">
            <dt className="dim" style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              {feeKnown ? t("agent.consent.total") : t("agent.consent.totalEst")}
              <span title={t("agent.consent.feeTip")} aria-label={t("agent.consent.feeTip")} style={{ display: "inline-flex", color: "var(--text-faint)" }}>
                <Icon name="info" size={13} />
              </span>
            </dt>
            <dd style={{ margin: 0, textAlign: "right" }}>
              <span className="mono agent-amount">{totalSafe ? formatExfer(totalVal) : `${totalVal} exfers`}</span>
            </dd>
          </div>
        )}
        {risky && (
          // Irreversible fund move → a danger banner (not the softer warn) with an
          // alert glyph, so the gravity reads at a glance.
          <p className="banner banner-danger" role="alert" style={{ marginTop: "10px", display: "flex", gap: "8px", alignItems: "flex-start" }}>
            <span style={{ flex: "0 0 auto", display: "inline-flex", marginTop: "1px" }}><Icon name="alert" size={16} /></span>
            <span>{t("agent.consent.risk")}</span>
          </p>
        )}
        {/* Reassure that declining is safe — it just cancels, nothing moves. */}
        <p className="faint" style={{ fontSize: "12px", lineHeight: 1.5, marginTop: "10px", textAlign: "center" }}>
          {t("agent.consent.declineNote")}
        </p>
      </div>
    </Sheet>
  );
}
