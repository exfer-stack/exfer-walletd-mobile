// Swap — EXFER ↔ USDT (BSC) cross-chain atomic swap. Wired to the walletd swap
// engine: swap_get_quote → swap_execute → poll swap_status. The daemon owns the
// preimage and both HTLC legs; this is just the 3-step UI.
//
// Flow:
//   step 1  pick direction + from-address + amount        → tap Review
//   step 2  review quote (amount_out / rate) + biometric   → tap Confirm
//   step 3  progress: poll swap_status until terminal
//
// We quote on the Review tap (not per keystroke) because each quote reserves a
// preimage and seals the journal — too costly to run on every input change.

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc, formatExfer, formatBalanceCompact } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isHidden } from "../../lib/hidden";
import { shortAddress } from "../../lib/labels";
import { Sheet, CopyButton, Spinner } from "../ui";
import { Qr } from "../Qr";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";

/** Trim a human decimal string to at most `dp` fractional digits (drops
 *  trailing zeros). Keeps big USDT amounts from rendering 18 raw decimals. */
function fmtAmt(s: string | undefined, dp = 4): string {
  if (!s) return s ?? "";
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w;
}

/** Format a smallest-unit integer string (e.g. wei) to a short human amount. */
function fmtUnits(raw: string | undefined, decimals: number, frac = 4): string {
  if (!raw) return "0";
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const fracStr = (n % base).toString().padStart(decimals, "0").slice(0, frac).replace(/0+$/, "");
    return fracStr ? `${n / base}.${fracStr}` : `${n / base}`;
  } catch {
    return "0";
  }
}

/** Light haptic feedback where supported (no-op on desktop / unsupported). */
function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

/** A branded result badge — a tinted circle with a stroked glyph, replacing
 *  the raw emoji that rendered inconsistently across OEM ROMs. */
function ResultBadge({ kind }: { kind: "success" | "refunded" | "failed" }) {
  const color = kind === "success" ? "#34d399" : kind === "refunded" ? "#fbbf24" : "#f87171";
  const path =
    kind === "success"
      ? "M5 13l4 4L19 7" // check
      : kind === "refunded"
        ? "M9 14l-4-4 4-4M5 10h8a6 6 0 0 1 0 12h-1" // undo arrow
        : "M6 6l12 12M18 6L6 18"; // x
  return (
    <div
      style={{
        width: 64,
        height: 64,
        borderRadius: 999,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </div>
  );
}

type Direction = "exfer_to_usdt" | "usdt_to_exfer";

/** Subset of walletd's SwapRecord (serde snake_case) the UI reads. */
interface SwapRec {
  swap_id: string;
  direction: Direction;
  status:
    | "quoted"
    | "user_locked"
    | "pool_locked"
    | "claiming"
    | "completed"
    | "refunding"
    | "refunded"
    | "failed";
  amount_in: string;
  amount_out: string;
  our_bsc_address?: string | null;
  error?: string | null;
}

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

export function SwapSheet({
  onClose,
  onDone,
  initialFrom,
  resumeSwapId,
}: {
  onClose: () => void;
  onDone: (tab?: "wallet" | "activity" | "settings") => void;
  initialFrom?: string;
  /** When set, jump straight to the progress screen and watch this existing
   *  swap (e.g. resumed from Home after the app was reopened). */
  resumeSwapId?: string;
}) {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();
  const { t } = useT();

  useEffect(() => suspendPolling(), [suspendPolling]);

  const entries = balance?.entries ?? [];
  const visible = entries.filter((a) => !isHidden(a.address));
  const fundable = visible.filter((a) => a.balance > 0);

  const [step, setStep] = useState<1 | 2 | 3>(resumeSwapId ? 3 : 1);
  const [direction, setDirection] = useState<Direction>("exfer_to_usdt");
  const [from, setFrom] = useState<string>(initialFrom ?? "");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<SwapRec | null>(null);
  const [live, setLive] = useState<SwapRec | null>(null);

  // BSC funding info (buy direction only).
  const [bscAddr, setBscAddr] = useState<string | null>(null);
  const [bscBal, setBscBal] = useState<{ bnb: string; usdt: string } | null>(null);
  const [bscBusy, setBscBusy] = useState(false);

  const sell = direction === "exfer_to_usdt";
  // For sell we lock EXFER from a funded address; for buy we receive EXFER to one.
  const pickList = sell ? fundable : visible;
  const fromAddr = from || pickList[0]?.address || "";
  const sendBal = pickList.find((a) => a.address === fromAddr)?.balance ?? 0;
  const bnbZero = bscBal != null && (() => { try { return BigInt(bscBal.bnb) === 0n; } catch { return false; } })();

  const refreshBsc = useCallback(async () => {
    setBscBusy(true);
    try {
      const a = await rpc<{ address: string }>("bsc_get_address");
      setBscAddr(a.address);
      const b = await rpc<{ bnb_wei: string; usdt_units: string }>("bsc_get_balances");
      setBscBal({ bnb: b.bnb_wei, usdt: b.usdt_units });
    } catch {
      /* engine may be disabled; surfaced on Review */
    } finally {
      setBscBusy(false);
    }
  }, []);

  useEffect(() => {
    if (direction === "usdt_to_exfer") refreshBsc();
  }, [direction, refreshBsc]);

  const amountValid = AMOUNT_RE.test(amount.trim()) && Number(amount) > 0;
  const sendUnit = sell ? "EXFER" : "USDT";
  const recvUnit = sell ? "USDT" : "EXFER";

  async function getQuote() {
    if (!amountValid) {
      setErr(t("swap.amountInvalid"));
      return;
    }
    if (!fromAddr) {
      setErr(t("swap.noFunds"));
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const q = await rpc<SwapRec>("swap_get_quote", {
        direction,
        amount_in: amount.trim(),
        from: fromAddr,
      });
      setQuote(q);
      setStep(2);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote) return;
    buzz(10);
    const bio = await biometricStatus();
    if (bio.available) {
      const ok = await biometricUnlock(
        t("swap.confirmBio", { amt: `${amount} ${sendUnit}` }),
      );
      if (!ok) {
        toast.error(t("swap.notConfirmedTitle"), t("swap.notConfirmedBody"));
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await rpc<SwapRec>("swap_execute", { swap_id: quote.swap_id });
      setLive(r);
      setStep(3);
      toast.success(t("swap.started"), t("swap.startedBody"));
    } catch (e) {
      // An expired quote is recoverable: bounce back to step 1 to re-quote.
      if (/expired/i.test(String((e as { message?: string })?.message ?? e))) {
        setQuote(null);
        setStep(1);
        toast.error(t("swap.failedTitle"), t("swap.expired"));
      } else {
        setErr(humanizeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  // Manual reclaim after a stalled/timed-out swap (the monitor also does this
  // automatically past the deadline; this gives the user an explicit lever).
  async function manualRefund() {
    if (!watchId) return;
    setBusy(true);
    try {
      const r = await rpc<SwapRec>("swap_refund", { swap_id: watchId });
      setLive(r);
      toast.success(t("swap.refundedTitle"), "");
    } catch (e) {
      toast.error(t("swap.failedTitle"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Poll status while in progress (works for both a freshly-executed swap and
  // a resumed one).
  const watchId = quote?.swap_id ?? resumeSwapId;
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (step !== 3 || !watchId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await rpc<SwapRec>("swap_status", { swap_id: watchId });
        if (cancelled) return;
        setLive(r);
        if (["completed", "refunded", "failed"].includes(r.status)) {
          refresh();
          return; // stop polling
        }
      } catch {
        /* transient; keep polling */
      }
      pollRef.current = window.setTimeout(tick, 2000);
    };
    tick();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [step, watchId, refresh]);

  // Elapsed seconds on the progress screen, for a "taking longer than usual" hint.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (step !== 3) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [step]);

  // On completion: celebratory haptic + a gentle auto-dismiss so the user
  // isn't left staring at a finished screen. Refund/fail get a single buzz.
  useEffect(() => {
    if (step !== 3) return;
    const s = live?.status;
    if (s === "completed") {
      buzz([0, 30, 40, 30]);
      const id = window.setTimeout(() => {
        onDone();
        onClose();
      }, 3200);
      return () => window.clearTimeout(id);
    }
    if (s === "refunded" || s === "failed") buzz(60);
  }, [step, live?.status, onDone, onClose]);

  // ---------- step 1: build ----------
  if (step === 1) {
    return (
      <Sheet
        title={t("swap.title")}
        onClose={onClose}
        footer={
          <button className="btn btn-block" disabled={busy || !amountValid} onClick={getQuote}>
            {busy ? <Spinner /> : t("swap.review")}
          </button>
        }
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            className={sell ? "btn btn-block" : "btn btn-secondary btn-block"}
            style={{ flex: 1 }}
            onClick={() => { setDirection("exfer_to_usdt"); setFrom(""); }}
          >
            {t("swap.sell")}
          </button>
          <button
            className={!sell ? "btn btn-block" : "btn btn-secondary btn-block"}
            style={{ flex: 1 }}
            onClick={() => { setDirection("usdt_to_exfer"); setFrom(""); }}
          >
            {t("swap.buy")}
          </button>
        </div>

        <label className="eyebrow">{t("swap.youSend")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            className="field"
            inputMode="decimal"
            autoFocus
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ flex: 1, fontSize: 22, fontWeight: 600 }}
          />
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>{sendUnit}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px 14px" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
            {t("swap.balance")}: {sell ? formatBalanceCompact(sendBal) : `${fmtUnits(bscBal?.usdt, 18, 2)} USDT`}
          </span>
          {sell && sendBal > 0 && (
            <button
              className="btn-ghost btn-sm"
              style={{ padding: "4px 10px", color: "var(--accent)" }}
              onClick={() => setAmount(formatExfer(sendBal).replace(" EXFER", ""))}
            >
              {t("swap.max")}
            </button>
          )}
        </div>

        <label className="eyebrow">{sell ? t("swap.from") : t("swap.receiveTo")}</label>
        <select
          className="field"
          value={fromAddr}
          onChange={(e) => setFrom(e.target.value)}
          style={{ width: "100%", marginBottom: 14 }}
        >
          {pickList.map((a) => (
            <option key={a.address} value={a.address}>
              {shortAddress(a.address)}
            </option>
          ))}
        </select>

        {!sell && bscAddr && (
          <div
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 12,
              background: "var(--surface-2, rgba(127,127,127,0.08))",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div className="eyebrow">{t("swap.bscAddress")}</div>
            <Qr value={bscAddr} size={150} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ fontFamily: "monospace" }}>{shortAddress(bscAddr)}</span>
              <CopyButton text={bscAddr} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-faint)", display: "flex", gap: 12 }}>
              <span>USDT: {fmtUnits(bscBal?.usdt, 18, 2)}</span>
              <span>BNB: {fmtUnits(bscBal?.bnb, 18, 4)}</span>
              <button className="btn-ghost btn-sm" disabled={bscBusy} onClick={refreshBsc}>
                {bscBusy ? "…" : "↻"}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-faint)", textAlign: "center" }}>
              {t("swap.fundHint")}
            </div>
            {bnbZero && <div style={{ color: "#fbbf24", fontSize: 12 }}>{t("swap.needBnb")}</div>}
          </div>
        )}

        {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
      </Sheet>
    );
  }

  // ---------- step 2: review ----------
  if (step === 2 && quote) {
    return (
      <Sheet
        title={t("swap.review")}
        onClose={onClose}
        onBack={() => setStep(1)}
        footer={
          <button className="btn btn-block" disabled={busy} onClick={confirm}>
            {busy ? <Spinner /> : t("swap.confirm")}
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label={t("swap.youSend")} value={`${fmtAmt(quote.amount_in)} ${sendUnit}`} />
          <Row label={t("swap.youReceive")} value={`${fmtAmt(quote.amount_out)} ${recvUnit}`} strong />
          {(() => {
            const a = Number(quote.amount_in);
            const b = Number(quote.amount_out);
            if (!a || !b) return null;
            return <Row label={t("swap.rate")} value={`1 ${sendUnit} ≈ ${(b / a).toPrecision(4)} ${recvUnit}`} />;
          })()}
          <Row label={t("swap.from")} value={shortAddress(fromAddr)} />
          <div className="banner banner-info" style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.55 }}>
            {t("swap.safetyNote")}
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </div>
      </Sheet>
    );
  }

  // ---------- step 3: progress ----------
  const s = live?.status ?? "user_locked";
  const terminal = ["completed", "refunded", "failed"].includes(s);
  const inUnit = live?.direction === "exfer_to_usdt" ? "EXFER" : "USDT";
  const outUnit = live?.direction === "exfer_to_usdt" ? "USDT" : "EXFER";
  const amounts = live ? `${fmtAmt(live.amount_in)} ${inUnit} → ${fmtAmt(live.amount_out)} ${outUnit}` : "";

  // A "quoted" swap was never confirmed — no funds moved. Be honest instead of
  // claiming funds are locked (the old UI's biggest correctness bug).
  if (s === "quoted") {
    return (
      <Sheet
        title={t("swap.notConfirmedTitle")}
        onClose={onClose}
        footer={<button className="btn btn-block" onClick={onClose}>{t("swap.done")}</button>}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "22px 0" }}>
          <ResultBadge kind="refunded" />
          {amounts && <div style={{ fontSize: 15, fontWeight: 600 }}>{amounts}</div>}
          <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.55 }}>
            {t("swap.notConfirmedResumeBody")}
          </div>
        </div>
      </Sheet>
    );
  }

  // Terminal states get a branded result badge (no raw emoji).
  if (terminal) {
    const kind = s === "completed" ? "success" : s === "refunded" ? "refunded" : "failed";
    const title =
      s === "completed" ? t("swap.completedTitle") : s === "refunded" ? t("swap.refundedTitle") : t("swap.failedTitle");
    return (
      <Sheet
        title={title}
        onClose={onClose}
        footer={<button className="btn btn-block" onClick={() => { onDone(); onClose(); }}>{t("swap.done")}</button>}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "24px 0" }}>
          <ResultBadge kind={kind} />
          {amounts && <div style={{ fontSize: 16, fontWeight: 700 }}>{amounts}</div>}
          {s === "completed" && (
            <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
              {t("swap.completedBody", { amt: `${fmtAmt(live?.amount_out ?? "")} ${outUnit}` })}
            </div>
          )}
          {s === "refunded" && (
            <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
              {t("swap.refundedBody")}
            </div>
          )}
          {live?.error && <div style={{ color: "#f87171", fontSize: 13, textAlign: "center" }}>{live.error}</div>}
        </div>
      </Sheet>
    );
  }

  // Refunding: an amber in-between state while the daemon reverses the lock.
  if (s === "refunding") {
    return (
      <Sheet title={t("swap.refundingTitle")} onClose={onClose} footer={<button className="btn btn-block" onClick={onClose}>{t("swap.closeKeepSettling")}</button>}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "22px 0" }}>
          <ResultBadge kind="refunded" />
          {amounts && <div style={{ fontSize: 15, fontWeight: 600 }}>{amounts}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 13 }}>
            <Spinner size={13} /> {t("swap.statusRefunding")}
          </div>
        </div>
      </Sheet>
    );
  }

  // In-progress (user_locked / pool_locked / claiming): a 3-step checklist so
  // "in progress" reads as measurable forward motion, not an endless spinner.
  const doneCount = s === "pool_locked" || s === "claiming" ? 2 : 1;
  const pct = s === "pool_locked" || s === "claiming" ? 82 : 40;
  const stepLabels = [t("swap.stepLocked"), t("swap.stepMatched"), t("swap.stepSettling")];
  const stuck = elapsed > 90;
  const canRefund = ["user_locked", "pool_locked"].includes(s);
  return (
    <Sheet
      title={t("swap.submittedTitle")}
      onClose={onClose}
      // The user's leg is on-chain — their part is done. Let them leave; the
      // daemon's monitor settles the rest in the background.
      footer={<button className="btn btn-block" onClick={onClose}>{t("swap.closeKeepSettling")}</button>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 0 4px" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("swap.submittedHeading")}</div>
          {amounts && <div style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>{amounts}</div>}
        </div>

        {/* determinate-ish progress bar */}
        <div style={{ height: 6, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              borderRadius: 999,
              background: "var(--accent)",
              transition: "width .6s var(--ease, ease)",
            }}
          />
        </div>

        {/* 3-step checklist */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {stepLabels.map((label, i) => {
            const done = i < doneCount;
            const active = i === doneCount;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                  {done ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : active ? (
                    <Spinner size={16} />
                  ) : (
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--text-faint)", opacity: 0.5 }} />
                  )}
                </span>
                <span
                  style={{
                    fontSize: 14.5,
                    fontWeight: done || active ? 600 : 500,
                    color: done || active ? "var(--text)" : "var(--text-faint)",
                  }}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ color: "var(--text-faint)", fontSize: 12.5, textAlign: "center", lineHeight: 1.5 }}>
          {t("swap.etaHint")}
        </div>

        {stuck && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ color: "#fbbf24", fontSize: 12, textAlign: "center" }}>{t("swap.takingLong")}</div>
            {canRefund && (
              <button className="btn-ghost btn-sm" disabled={busy} onClick={manualRefund}>
                {busy ? <Spinner size={13} /> : t("swap.refundNow")}
              </button>
            )}
          </div>
        )}
        {live?.error && <div style={{ color: "#f87171", fontSize: 13, textAlign: "center" }}>{live.error}</div>}
      </div>
    </Sheet>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, fontSize: strong ? 18 : 14 }}>{value}</span>
    </div>
  );
}
