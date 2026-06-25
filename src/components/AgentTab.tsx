import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentSession, type AgentEvent, type ConsentCard, type ConsentField } from "exfer-agent";
import { useT, type Lang, type MsgKey } from "../lib/i18n";
import { hostDeps } from "../lib/agentHost";
import { loadConfig, toProviderConfig } from "../lib/agentConfig";
import { formatExfer } from "../lib/rpc";
import { biometricStatus, biometricUnlock } from "../lib/biometric";

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
type Block = { kind: "text"; text: string } | { kind: "tool"; card: ToolCard };
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

function humanizeTool(name: string, summary: string): string {
  try {
    const r = JSON.parse(summary) as Record<string, unknown>;
    switch (name) {
      case "exfer_get_balance":
        return `Balance: ${formatExfer(Number(r.balance))}`;
      case "exfer_transfer":
        return `Submitted · fee ${formatExfer(Number(r.fee ?? 0))} · tx ${String(r.tx_id ?? "").slice(0, 12)}…`;
      case "exfer_swap_get_quote":
        return `Quote: ${r.amount_in} → ≈ ${r.amount_out}`;
      case "exfer_swap_execute":
        return `Swap ${String(r.swap_id ?? "")} started · settling`;
      default:
        return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    }
  } catch {
    return summary;
  }
}

export function AgentTab({ lang }: { lang: Lang }) {
  const { t } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuoteRef = useRef<Record<string, unknown> | null>(null);
  const lastUserText = useRef<string>("");

  const session = useMemo(() => {
    const saved = loadConfig();
    const cfg = saved ? toProviderConfig(saved) : undefined;
    const { provider, tools } = hostDeps(cfg);
    return new AgentSession({
      provider,
      model: saved?.model ?? "deepseek-chat",
      listTools: tools.listTools,
      executeTool: tools.executeTool,
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
        "You are the exfer wallet agent. Use tools to fulfil requests; the app handles confirmation. " +
        `Always respond to the user in ${lang === "zh" ? "Chinese (简体中文)" : "English"}.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [turns]);

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
            case "error":
              setErrorBanner(ev.message);
              break;
          }
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, session, patchLast],
  );

  const examples = [t("agent.empty.ex1"), t("agent.empty.ex2"), t("agent.empty.ex3")];

  return (
    <div className="agent-tab" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
        {turns.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: "20%" }}>
            <h2 className="eyebrow" style={{ fontSize: "1.4rem" }}>{t("agent.empty.title")}</h2>
            <p className="dim" style={{ margin: "8px 0 16px" }}>{t("agent.empty.subtitle")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {examples.map((ex) => (
                <button key={ex} type="button" className="btn btn-secondary btn-block" onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((tn, i) =>
          tn.role === "user" ? (
            <div key={i} style={{ textAlign: "right", margin: "8px 0" }}>
              <span className="card" style={{ display: "inline-block", padding: "8px 12px", textAlign: "left" }}>{tn.text}</span>
            </div>
          ) : (
            <div key={i} style={{ margin: "8px 0" }} data-testid="assistant-turn">
              {tn.thinking && (
                <details open={busy && i === turns.length - 1} className="card card-2" style={{ padding: "8px", marginBottom: "6px" }}>
                  <summary className="dim">{busy && i === turns.length - 1 ? t("agent.thinking.active") : t("agent.thinking.label")}</summary>
                  <div className="faint" style={{ whiteSpace: "pre-wrap", marginTop: "4px" }}>{tn.thinking}</div>
                </details>
              )}
              {tn.blocks.map((b, j) =>
                b.kind === "text" ? (
                  b.text ? (
                    <div key={j} style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{b.text}</div>
                  ) : null
                ) : (
                  <div key={j} className="card card-2" style={{ padding: "8px", margin: "4px 0" }} data-testid="tool-card">
                    <div className="h-row" style={{ gap: "6px", alignItems: "center" }}>
                      <span className={b.card.status === "ok" ? "success-check" : b.card.status === "error" ? "banner-danger" : "dim"}>
                        {b.card.status === "running" ? "…" : b.card.status === "ok" ? "✓" : "✕"}
                      </span>
                      <span className="mono">{b.card.name}</span>
                      {b.card.gated && <span className="banner banner-warn" style={{ padding: "0 6px", fontSize: "0.7rem" }}>{t("agent.tool.gated")}</span>}
                    </div>
                    {b.card.summary && (b.card.summary === "declined" ? (
                      <div className="dim" style={{ marginTop: "4px" }}>{t("agent.consent.declined")}</div>
                    ) : (
                      <div className="faint" style={{ marginTop: "4px" }}>{humanizeTool(b.card.name, b.card.summary)}</div>
                    ))}
                  </div>
                ),
              )}
            </div>
          ),
        )}
      </div>

      {errorBanner && (
        <div className="banner banner-danger" style={{ margin: "0 12px", display: "flex", justifyContent: "space-between", gap: "8px" }} role="alert">
          <span>{t("agent.error.generic", { message: errorBanner })}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => send(lastUserText.current)}>{t("agent.error.retry")}</button>
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", padding: "12px" }}>
        <input
          className="field"
          style={{ flex: 1 }}
          placeholder={t("agent.composer.placeholder")}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
          data-testid="agent-input"
        />
        {busy ? (
          <button type="button" className="btn btn-secondary" onClick={() => abortRef.current?.abort()} data-testid="agent-stop">{t("agent.composer.stop")}</button>
        ) : (
          <button type="button" className="btn" disabled={!input.trim()} onClick={() => send(input)} data-testid="agent-send">{t("agent.composer.send")}</button>
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
    </div>
  );
}

function AgentConsentSheet({ card, t, onResolve }: { card: ConsentCard; t: ReturnType<typeof useT>["t"]; onResolve: (ok: boolean) => void }) {
  const titleId = useId();
  const [verifying, setVerifying] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);

  useEffect(() => {
    biometricStatus().then((s) => setBioAvail(s.available)).catch(() => setBioAvail(false));
  }, []);

  const approve = async () => {
    setVerifying(true);
    // On a real device, gate behind Face/Touch ID; in the browser web layer
    // (no biometric) approve directly so the flow is testable.
    const ok = bioAvail ? await biometricUnlock(t("agent.consent.reason")).catch(() => false) : true;
    setVerifying(false);
    if (ok) onResolve(true);
  };

  const titleText = (card.titleKey && t(`agent.consent.title.${card.titleKey}` as MsgKey)) || card.title;
  const risky = card.consentClass === "gated";

  const renderValue = (f: ConsentField) => {
    if (f.kind === "amount") {
      const n = Number(f.value);
      return <span className="mono" style={{ fontSize: "1.2rem" }}>{f.value === "" || Number.isNaN(n) ? t("agent.consent.feeEstimated") : formatExfer(n)}</span>;
    }
    return <span className="mono" style={{ wordBreak: "break-all" }}>{f.value || "—"}</span>;
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end" }} data-testid="consent-card">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="card" style={{ width: "100%", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: "16px" }}>
        <h2 id={titleId} className="eyebrow" style={{ fontSize: "1.1rem", marginBottom: "12px" }}>{titleText}</h2>
        <dl style={{ margin: 0 }}>
          {card.fields.map((f) => (
            <div key={f.label} className="h-row" style={{ justifyContent: "space-between", gap: "12px", margin: "6px 0" }}>
              <dt className="dim">{(f.labelKey && t(`agent.consent.field.${f.labelKey}` as MsgKey)) || f.label}</dt>
              <dd style={{ margin: 0, textAlign: "right" }}>{renderValue(f)}</dd>
            </div>
          ))}
        </dl>
        {risky && <p className="banner banner-warn" role="alert" style={{ marginTop: "10px" }}>{t("agent.consent.risk")}</p>}
        <div className="h-row" style={{ gap: "10px", marginTop: "14px" }}>
          <button type="button" className="btn btn-secondary btn-block" onClick={() => onResolve(false)} data-testid="consent-decline">{t("agent.consent.decline")}</button>
          <button type="button" className="btn btn-block" disabled={verifying} onClick={approve} data-testid="consent-approve">
            {bioAvail ? t("agent.consent.approveBio") : t("agent.consent.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}
