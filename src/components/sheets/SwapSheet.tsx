// Swap — EXFER ↔ BNB (BSC) cross-chain atomic swap. Wired to the walletd swap
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
import { usePrice } from "../../lib/market";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";

/** Trim a human decimal string to at most `dp` fractional digits (drops
 *  trailing zeros). Keeps big BNB amounts from rendering 18 raw decimals.
 *  For very small values that would round to "0" at `dp` (e.g. ~1e-6 BNB at
 *  the real EXFER price), fall back to significant digits so the amount never
 *  reads as a misleading "0". */
function fmtAmt(s: string | undefined, dp = 4): string {
  if (!s) return s ?? "";
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    const n = Number(s);
    if (isFinite(n) && n !== 0) return sigFmt(n, 4);
  }
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

type Direction = "exfer_to_bnb" | "bnb_to_exfer";

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
  fee_bps?: number;
  our_bsc_address?: string | null;
  error?: string | null;
}

/** Trim a number to ~`sig` significant digits as a plain decimal — never
 *  scientific notation (tiny BNB amounts like 7.6e-7 must read as
 *  "0.000000764", not "7.63858e-7"). */
function sigFmt(n: number, sig = 4): string {
  if (!isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US", {
    maximumSignificantDigits: sig,
    useGrouping: false,
  });
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
  const price = usePrice();

  useEffect(() => suspendPolling(), [suspendPolling]);

  const entries = balance?.entries ?? [];
  const visible = entries.filter((a) => !isHidden(a.address));
  const fundable = visible.filter((a) => a.balance > 0);

  const [step, setStep] = useState<1 | 2 | 3>(resumeSwapId ? 3 : 1);
  const [direction, setDirection] = useState<Direction>("exfer_to_bnb");
  const [from, setFrom] = useState<string>(initialFrom ?? "");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<SwapRec | null>(null);
  const [live, setLive] = useState<SwapRec | null>(null);

  // BSC funding info (buy direction only).
  const [bscAddr, setBscAddr] = useState<string | null>(null);
  const [bscBal, setBscBal] = useState<{ bnb: string } | null>(null);
  const [bscBusy, setBscBusy] = useState(false);

  // Indicative pool rate (BNB per 1 EXFER), fetched once on open. May be absent
  // when the swap engine is off — the preview simply hides.
  const [poolInfo, setPoolInfo] = useState<
    { mid: number; feeBps: number; exferReserve: number; bnbReserve: number; maxSwapBps: number } | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    rpc<{
      mid_price_bnb_per_exfer: number; fee_bps: number;
      exfer_reserve: number | string | null; bnb_reserve: number | string | null; max_swap_bps: number | null;
    }>("swap_pool_info")
      .then((p) => {
        if (!cancelled)
          setPoolInfo({
            mid: p.mid_price_bnb_per_exfer,
            feeBps: p.fee_bps,
            exferReserve: Number(p.exfer_reserve) || 0,
            bnbReserve: Number(p.bnb_reserve) || 0,
            maxSwapBps: Number(p.max_swap_bps) || 500,
          });
      })
      .catch(() => {
        /* engine off — hide the preview */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sell = direction === "exfer_to_bnb";
  // For sell we lock EXFER from a funded address; for buy we receive EXFER to one.
  const pickList = sell ? fundable : visible;
  const fromAddr = from || pickList[0]?.address || "";
  const sendBal = pickList.find((a) => a.address === fromAddr)?.balance ?? 0;
  const bnbZero = bscBal != null && (() => { try { return BigInt(bscBal.bnb) === 0n; } catch { return false; } })();
  // Buy with no BNB yet: lead with the deposit step and de-emphasize the amount
  // field so the order of operations is obvious (1. Add BNB → 2. Enter amount).
  const needsFunding = direction === "bnb_to_exfer" && bnbZero;

  const refreshBsc = useCallback(async () => {
    setBscBusy(true);
    try {
      const a = await rpc<{ address: string }>("bsc_get_address");
      setBscAddr(a.address);
      const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
      setBscBal({ bnb: b.bnb_wei });
    } catch {
      /* engine may be disabled; surfaced on Review */
    } finally {
      setBscBusy(false);
    }
  }, []);

  useEffect(() => {
    if (direction === "bnb_to_exfer") refreshBsc();
  }, [direction, refreshBsc]);

  // Auto-poll the BNB balance while the buy deposit UI is visible (step 1, buy
  // direction). When it increases vs. the last seen value, celebrate with a
  // toast so a fresh deposit is never silent.
  const lastBnbRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (step !== 1 || direction !== "bnb_to_exfer") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
        if (cancelled) return;
        setBscBal({ bnb: b.bnb_wei });
        const now = BigInt(b.bnb_wei);
        const prev = lastBnbRef.current;
        if (prev != null && now > prev) {
          const delta = fmtUnits((now - prev).toString(), 18, 5);
          toast.success(t("swap.bnbReceived"), t("swap.bnbReceivedBody", { delta }));
        }
        lastBnbRef.current = now;
      } catch {
        /* transient / engine off; keep polling */
      }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [step, direction, toast, t]);

  const amountValid = AMOUNT_RE.test(amount.trim()) && Number(amount) > 0;
  const sendUnit = sell ? "EXFER" : "BNB";
  const recvUnit = sell ? "BNB" : "EXFER";

  // Indicative rate line: 1 EXFER ≈ {mid} BNB · ≈ ${usd}. USD only when we have
  // the EXFER spot price; otherwise show the BNB ratio alone.
  const rateLine = poolInfo
    ? price
      ? t("swap.indicativeRate", { bnb: sigFmt(poolInfo.mid), usd: sigFmt(price.usd) })
      : t("swap.indicativeRateNoUsd", { bnb: sigFmt(poolInfo.mid) })
    : null;

  // Live client-side estimate of the output as the user types (the real quote
  // still happens on Review). For sell: EXFER→BNB = amount * mid. For buy:
  // BNB→EXFER = amount / mid.
  const estLine = (() => {
    if (!poolInfo || !amountValid || poolInfo.mid <= 0) return null;
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return null;
    const est = sell ? a * poolInfo.mid : a / poolInfo.mid;
    // USD value of the trade (EXFER side × spot) — meaningful even when the BNB
    // figure is tiny. Sell: input EXFER; buy: output EXFER.
    const exferAmt = sell ? a : est;
    if (price) {
      const usd = exferAmt * price.usd;
      const usdStr = usd < 1 ? usd.toFixed(4) : usd.toFixed(2);
      return t("swap.estOutUsd", { est: sigFmt(est, 6), unit: recvUnit, usd: usdStr });
    }
    return t("swap.estOut", { est: sigFmt(est, 6), unit: recvUnit });
  })();

  // Max the pool can fill right now, in input units — the smaller of the
  // per-swap size cap (input side) and what keeps the output within the
  // output-side reserve. Lets us warn BEFORE the user taps Review (rather than
  // only failing there). 0/unknown when pool info isn't loaded.
  const maxIn = (() => {
    if (!poolInfo || poolInfo.mid <= 0) return 0;
    const outReserve = sell ? poolInfo.bnbReserve : poolInfo.exferReserve;
    const inReserve = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    const capByOut = sell ? outReserve / poolInfo.mid : outReserve * poolInfo.mid;
    const capBySize = inReserve * (poolInfo.maxSwapBps / 10_000);
    return Math.max(0, Math.min(capByOut, capBySize) * 0.98); // small safety margin
  })();
  const overLimit = amountValid && maxIn > 0 && Number(amount) > maxIn;

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
    // A reclaim broadcasts a spend from the unlocked keystore — gate it behind
    // biometrics too, exactly like Confirm, so it's consistent (no money-moving
    // action on the unlocked phone is un-authed).
    const bio = await biometricStatus();
    if (bio.available) {
      const ok = await biometricUnlock(t("swap.refundNow"));
      if (!ok) {
        toast.error(t("swap.notConfirmedTitle"), t("swap.notConfirmedBody"));
        return;
      }
    }
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

  // The BNB deposit card (buy direction). Reused in both layout orders — leads
  // the screen when there's no BNB yet, otherwise sits below the amount field.
  const depositCard =
    !sell && bscAddr ? (
      <div
        style={{
          marginBottom: 14,
          padding: 12,
          borderRadius: 12,
          background: "var(--surface-2, rgba(127,127,127,0.08))",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div className="eyebrow">{needsFunding ? t("swap.fundStep") : t("swap.bscAddress")}</div>
        <Qr value={bscAddr} size={150} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span style={{ fontFamily: "monospace" }}>{shortAddress(bscAddr)}</span>
          <CopyButton text={bscAddr} />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-faint)", display: "flex", gap: 12 }}>
          <span>BNB: {fmtUnits(bscBal?.bnb, 18, 4)}</span>
          <button className="btn-ghost btn-sm" disabled={bscBusy} onClick={refreshBsc}>
            {bscBusy ? "…" : "↻"}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", textAlign: "center" }}>
          {t("swap.fundHint")}
        </div>
        {bnbZero && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 12 }}>
            <Spinner size={12} /> {t("swap.waitingBnb")}
          </div>
        )}
      </div>
    ) : null;

  // ---------- step 1: build ----------
  if (step === 1) {
    return (
      <Sheet
        title={t("swap.title")}
        onClose={onClose}
        footer={
          <button className="btn btn-block" disabled={busy || !amountValid || overLimit} onClick={getQuote}>
            {busy ? <Spinner /> : t("swap.review")}
          </button>
        }
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            className={sell ? "btn btn-block" : "btn btn-secondary btn-block"}
            style={{ flex: 1 }}
            onClick={() => { setDirection("exfer_to_bnb"); setFrom(""); }}
          >
            {t("swap.sell")}
          </button>
          <button
            className={!sell ? "btn btn-block" : "btn btn-secondary btn-block"}
            style={{ flex: 1 }}
            onClick={() => { setDirection("bnb_to_exfer"); setFrom(""); }}
          >
            {t("swap.buy")}
          </button>
        </div>

        {/* Buy with no BNB: lead with the deposit step so the order of
            operations reads top-to-bottom (1. Add BNB → 2. Enter amount). */}
        {needsFunding && depositCard}

        <label className="eyebrow">{needsFunding ? t("swap.amountStep") : t("swap.youSend")}</label>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            // De-emphasize the amount field until there's BNB to swap.
            opacity: needsFunding ? 0.5 : 1,
          }}
        >
          <input
            className="field"
            inputMode="decimal"
            autoFocus={!needsFunding}
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ flex: 1, fontSize: 22, fontWeight: 600 }}
          />
          <span style={{ color: "var(--text-faint)", fontWeight: 600 }}>{sendUnit}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px 4px" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
            {t("swap.balance")}: {sell ? formatBalanceCompact(sendBal) : `${fmtUnits(bscBal?.bnb, 18, 4)} BNB`}
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
        {/* Live client-side estimate of the output as you type, then the
            indicative pool rate — both subtle helper lines. */}
        <div style={{ margin: "0 2px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Estimate is the primary helper (brighter, larger — it's the answer
              to "what do I get?"); the indicative rate is secondary. */}
          {estLine && (
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{estLine}</span>
          )}
          {rateLine && (
            <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{rateLine}</span>
          )}
        </div>
        {overLimit && (
          <div
            className="banner banner-warn"
            style={{ margin: "0 0 14px", display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto", marginTop: 1 }}>
              <path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z" />
            </svg>
            <span>{t("swap.overLimit", { max: `${sigFmt(maxIn, 4)} ${sendUnit}` })}</span>
          </div>
        )}

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

        {/* When already funded, the deposit card sits below the amount. */}
        {!needsFunding && depositCard}

        {sell && (
          <div className="banner banner-info" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {t("swap.sellReceiveHint")}
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
            return <Row label={t("swap.rate")} value={`1 ${sendUnit} ≈ ${sigFmt(b / a)} ${recvUnit}`} />;
          })()}
          {typeof quote.fee_bps === "number" && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
                {t("swap.fee", { pct: sigFmt(quote.fee_bps / 100) })}
              </span>
              <span style={{ color: "var(--text-faint)", fontSize: 12 }}>{t("swap.feeIncluded")}</span>
            </div>
          )}
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
  const inUnit = live?.direction === "exfer_to_bnb" ? "EXFER" : "BNB";
  const outUnit = live?.direction === "exfer_to_bnb" ? "BNB" : "EXFER";
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
          {s === "completed" && (
            <div style={{ fontSize: 18, fontWeight: 700 }}>{t("swap.completedHeading")}</div>
          )}
          {amounts && <div style={{ fontSize: 16, fontWeight: 700 }}>{amounts}</div>}
          {s === "completed" && (
            <div style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
              {t("swap.completedReceived", { amt: `${fmtAmt(live?.amount_out ?? "")} ${outUnit}` })}
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

        {/* horizontal staged stepper: 3 nodes with chevrons flowing into the
            active stage, so the wait reads as visible forward motion. */}
        <div>
          <div style={{ display: "flex", alignItems: "center", padding: "0 4px" }}>
            {[0, 1, 2].map((i) => {
              const done = i < doneCount;
              const active = i === doneCount;
              const node = (
                <div
                  key={`n${i}`}
                  className={active ? "swap-node-active" : undefined}
                  style={{
                    width: 30, height: 30, borderRadius: 999, flex: "0 0 auto",
                    display: "grid", placeItems: "center",
                    background: done ? "#34d399" : active ? "var(--accent)" : "var(--surface-2)",
                    border: done || active ? "none" : "1px solid var(--border)",
                    color: done || active ? "var(--accent-ink)" : "var(--text-faint)",
                  }}
                >
                  {done ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                  ) : active ? (
                    <Spinner size={14} />
                  ) : (
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--text-faint)", opacity: 0.5 }} />
                  )}
                </div>
              );
              if (i === 2) return node;
              const connDone = i + 1 < doneCount;
              const connActive = i + 1 === doneCount;
              // One connector language — chevrons throughout: green where done,
              // animated cyan into the active step, dim where still ahead.
              const conn = (
                <div key={`c${i}`} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", height: 30 }}>
                  <div
                    className={connActive ? "swap-flow" : undefined}
                    style={{
                      display: "flex", gap: 1,
                      color: connDone ? "#34d399" : connActive ? "var(--accent)" : "var(--text-faint)",
                      opacity: connDone || connActive ? 1 : 0.35,
                    }}
                  >
                    {[0, 1, 2].map((k) => (
                      <svg key={k} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                    ))}
                  </div>
                </div>
              );
              return [node, conn];
            })}
          </div>
          <div style={{ display: "flex", marginTop: 8 }}>
            {stepLabels.map((label, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  textAlign: i === 0 ? "left" : i === 2 ? "right" : "center",
                  fontWeight: i <= doneCount ? 600 : 500,
                  color: i <= doneCount ? "var(--text)" : "var(--text-faint)",
                }}
              >
                {label}
              </span>
            ))}
          </div>
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
