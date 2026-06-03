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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc } from "../../lib/rpc";
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

  const statusLabel = useMemo(() => {
    const s = live?.status ?? "quoted";
    const map: Record<string, string> = {
      quoted: t("swap.statusQuoted"),
      user_locked: t("swap.statusUserLocked"),
      pool_locked: t("swap.statusPoolLocked"),
      claiming: t("swap.statusClaiming"),
      completed: t("swap.statusCompleted"),
      refunding: t("swap.statusRefunding"),
      refunded: t("swap.statusRefunded"),
      failed: t("swap.statusFailed"),
    };
    return map[s] ?? s;
  }, [live, t]);

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
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ flex: 1, fontSize: 22, padding: "10px 12px" }}
          />
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>{sendUnit}</span>
        </div>

        <label className="eyebrow">{sell ? t("swap.from") : t("swap.receiveTo")}</label>
        <select
          value={fromAddr}
          onChange={(e) => setFrom(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", marginBottom: 14 }}
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
          {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </div>
      </Sheet>
    );
  }

  // ---------- step 3: progress ----------
  const s = live?.status ?? "user_locked";
  const terminal = ["completed", "refunded", "failed"].includes(s);
  const title =
    s === "completed"
      ? t("swap.completedTitle")
      : s === "refunded"
        ? t("swap.refundedTitle")
        : s === "failed"
          ? t("swap.failedTitle")
          : t("swap.started");
  const stuck = !terminal && elapsed > 90;
  const canRefund = !terminal && ["user_locked", "pool_locked"].includes(s);
  const inUnit = live?.direction === "exfer_to_usdt" ? "EXFER" : "USDT";
  const outUnit = live?.direction === "exfer_to_usdt" ? "USDT" : "EXFER";
  return (
    <Sheet
      title={terminal ? title : t("swap.submittedTitle")}
      onClose={onClose}
      footer={
        terminal ? (
          <button className="btn btn-block" onClick={() => { onDone(); onClose(); }}>
            {t("swap.done")}
          </button>
        ) : (
          // The user's leg is on-chain — their part is done. Let them leave;
          // the daemon's monitor settles the rest in the background.
          <button className="btn btn-block" onClick={onClose}>
            {t("swap.closeKeepSettling")}
          </button>
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "16px 0" }}>
        {terminal ? (
          <div style={{ fontSize: 30 }}>{s === "completed" ? "✅" : s === "refunded" ? "↩️" : "⚠️"}</div>
        ) : (
          <div style={{ fontSize: 30 }}>✅</div>
        )}
        {!terminal && (
          <div style={{ fontSize: 16, fontWeight: 700 }}>{t("swap.submittedHeading")}</div>
        )}
        {live && (
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {fmtAmt(live.amount_in)} {inUnit} → {fmtAmt(live.amount_out)} {outUnit}
          </div>
        )}
        {!terminal && (
          <>
            <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
              {t("swap.bgSettleBody", { amt: `${fmtAmt(live?.amount_out ?? "")} ${outUnit}` })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 12 }}>
              <Spinner size={13} /> {statusLabel}
            </div>
            {stuck && (
              <div style={{ color: "#fbbf24", fontSize: 12, textAlign: "center" }}>{t("swap.takingLong")}</div>
            )}
            {stuck && canRefund && (
              <button className="btn-ghost btn-sm" disabled={busy} onClick={manualRefund}>
                {busy ? <Spinner size={13} /> : t("swap.refundNow")}
              </button>
            )}
          </>
        )}
        {s === "refunded" && (
          <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center" }}>{t("swap.refundedBody")}</div>
        )}
        {live?.error && <div style={{ color: "#f87171", fontSize: 13 }}>{live.error}</div>}
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
