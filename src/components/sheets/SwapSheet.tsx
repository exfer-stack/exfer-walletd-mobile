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
import { rpc, formatExfer, formatBalanceCompact, splitBalanceCompact } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isHidden } from "../../lib/hidden";
import { shortAddress } from "../../lib/labels";
import { addrName } from "../../lib/format";
import type { WalletEntry } from "../../lib/types";
import { Sheet, CopyButton, Spinner, AddrAvatar, BnbMark, StagedStepper, Modal } from "../ui";
import { Qr } from "../Qr";
import { usePrice, useBnbUsd } from "../../lib/market";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";
import { recordSwapUsd } from "../../lib/swapPrice";
import { SwapTimingHelp } from "../SwapTimingHelp";

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

interface PoolInfo {
  mid: number;
  feeBps: number;
  exferReserve: number;
  bnbReserve: number;
  maxSwapBps: number;
}

// Module-level cache for the indicative pool rate. The sheet remounts on every
// open, so without this the rate line ("1 EXFER ≈ … BNB") is absent for the
// first beat (while swap_pool_info is in flight), then pops in and shoves the
// rest of the form down. Seeding state from the cache makes reopens instant.
let poolInfoCache: PoolInfo | null = null;

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
  const bnbUsd = useBnbUsd();

  useEffect(() => suspendPolling(), [suspendPolling]);

  // The amount field used to use `autoFocus`. But the sheet mounts at
  // translateY(100%) (off the bottom) and slides up over ~300ms, so the default
  // focus fires a scrollIntoView while the input is still below the viewport —
  // the browser scrolls the background `.screen` down to "reveal" it, then it
  // snaps back as the sheet settles. That yank IS the top-to-bottom twitch /
  // skew behind the frosted glass. We focus manually with preventScroll AFTER
  // the slide finishes, so the background never moves.
  const amountRef = useRef<HTMLInputElement>(null);

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
  // Gate: a high-impact trade must be explicitly confirmed on the review step.
  const [showImpactConfirm, setShowImpactConfirm] = useState(false);
  const [live, setLive] = useState<SwapRec | null>(null);

  // BSC funding info (buy direction only).
  const [bscAddr, setBscAddr] = useState<string | null>(null);
  const [bscBal, setBscBal] = useState<{ bnb: string } | null>(null);
  const [bscBusy, setBscBusy] = useState(false);

  // Indicative pool rate (BNB per 1 EXFER), seeded from the module cache so a
  // reopen shows it immediately, then refreshed. May be absent on the very
  // first open ever (or when the swap engine is off) — the line reserves its
  // space (see the helper block) so its arrival never shifts the layout.
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(poolInfoCache);
  useEffect(() => {
    let cancelled = false;
    rpc<{
      mid_price_bnb_per_exfer: number; fee_bps: number;
      exfer_reserve: number | string | null; bnb_reserve: number | string | null; max_swap_bps: number | null;
    }>("swap_pool_info")
      .then((p) => {
        poolInfoCache = {
          mid: p.mid_price_bnb_per_exfer,
          feeBps: p.fee_bps,
          exferReserve: Number(p.exfer_reserve) || 0,
          bnbReserve: Number(p.bnb_reserve) || 0,
          maxSwapBps: Number(p.max_swap_bps) || 500,
        };
        if (!cancelled) setPoolInfo(poolInfoCache);
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

  // Focus the amount field once the sheet has slid into place, WITHOUT
  // scrolling the page (see amountRef above). Only on the build step, sell
  // direction or a funded buy — never when we're leading with the deposit card.
  useEffect(() => {
    if (step !== 1 || needsFunding) return;
    const id = window.setTimeout(() => {
      amountRef.current?.focus({ preventScroll: true });
    }, 320); // just past the .3s sheetUp slide
    return () => window.clearTimeout(id);
  }, [step, needsFunding]);

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

  // Live client-side estimate of the output as the user types (the real quote
  // still happens on Review). Uses the SAME constant-product formula as the pool
  // (Uniswap-v2 with fee) — NOT a flat amount×mid — so the estimate already
  // includes slippage: a bigger trade gets a visibly worse rate, matching what
  // swap_get_quote will return. (A flat mid made the per-unit rate look constant
  // regardless of size, which is misleading even though execution was honest.)
  // Falls back to the linear mid only when the reserves aren't known yet.
  const estOut = (() => {
    if (!poolInfo || !amountValid || poolInfo.mid <= 0) return null;
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return null;
    const reserveIn = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    const reserveOut = sell ? poolInfo.bnbReserve : poolInfo.exferReserve;
    if (reserveIn > 0 && reserveOut > 0) {
      const inWithFee = (a * (10_000 - poolInfo.feeBps)) / 10_000;
      return (inWithFee * reserveOut) / (reserveIn + inWithFee);
    }
    return sell ? a * poolInfo.mid : a / poolInfo.mid;
  })();
  // Effective per-EXFER rate for THIS trade (BNB per 1 EXFER), derived from the
  // slippage-aware estimate so it moves as the amount changes. Sell pays out BNB
  // for EXFER (out/in); buy spends BNB for EXFER (in/out).
  const effRate = (() => {
    const a = Number(amount);
    if (estOut == null || !isFinite(a) || a <= 0) return null;
    return sell ? estOut / a : a / estOut;
  })();
  // Effective EXFER/USD: derived from the LIVE pool ratio (pool BNB-per-EXFER ×
  // BNB/USD) so the price tracks the pool — every swap shifts it. Falls back to
  // the OTC EXFER quote when the pool rate or BNB/USD isn't available.
  // Prefer the pool-sourced, cached price (usePrice) so the figure doesn't
  // flicker on open (it changed once bnbUsd loaded and mid×bnbUsd replaced it).
  const exferUsd = price?.usd ?? (poolInfo && poolInfo.mid > 0 && bnbUsd ? poolInfo.mid * bnbUsd : null);
  // Per-EXFER USD price for THIS trade — what the user actually cares about.
  // effRate (BNB per EXFER, slippage-aware) × BNB/USD; falls back to the
  // mid-based exferUsd when the effective rate or BNB/USD isn't available.
  const effUsd = effRate != null && bnbUsd ? effRate * bnbUsd : exferUsd;

  // Price impact = the fraction of the input-side reserve this trade consumes
  // (constant-product). We DON'T cap the amount — the user may swap whatever
  // they want and eat the slippage — but we warn when the impact is high so the
  // consequence is clear before they commit. maxSwapBps (the old hard cap) is
  // reused here purely as the "high impact" threshold. 0 when pool/amount aren't
  // ready.
  const priceImpact = (() => {
    if (!poolInfo || !amountValid) return 0;
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return 0;
    const inReserve = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    if (inReserve <= 0) return 1;
    return a / (inReserve + a);
  })();
  const highImpact = !!poolInfo && priceImpact * 10_000 >= poolInfo.maxSwapBps;

  // Buy-side Max: all spendable BNB, less a small reserve to cover the lock
  // transaction's gas (BNB is also the gas token). Not capped by the pool — the
  // user can put in everything they have; the price-impact warning handles the
  // consequence of a too-big trade.
  const buyMax = (() => {
    if (sell || !bscBal) return 0;
    let bnbHuman = 0;
    try { bnbHuman = Number(BigInt(bscBal.bnb)) / 1e18; } catch { return 0; }
    const GAS_RESERVE = 0.002; // ample for a BSC HTLC lock (gas is ~0.0001 BNB)
    return Math.max(0, bnbHuman - GAS_RESERVE);
  })();

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

  // Tapping Confirm: a high-impact trade pops a confirmation first; everything
  // else goes straight to execute.
  function confirm() {
    if (!quote) return;
    if (highImpact) { setShowImpactConfirm(true); return; }
    void doExecute();
  }

  async function doExecute() {
    if (!quote) return;
    setShowImpactConfirm(false);
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
      // Snapshot the effective (pool-driven) EXFER/USD now, so the record can
      // later show what this swap was worth at execution time.
      if (exferUsd != null) recordSwapUsd(quote.swap_id, exferUsd);
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, width: "100%" }}>
          <span style={{ flex: 1, minWidth: 0, fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.55, textAlign: "center" }}>{bscAddr}</span>
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
          <button className="btn btn-block" disabled={busy || !amountValid} onClick={getQuote}>
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
            ref={amountRef}
            className="field"
            inputMode="decimal"
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
          {!sell && buyMax > 0 && (
            <button
              className="btn-ghost btn-sm"
              style={{ padding: "4px 10px", color: "var(--accent)" }}
              onClick={() => setAmount(sigFmt(buyMax, 8))}
            >
              {t("swap.max")}
            </button>
          )}
        </div>
        {/* Quote card — the price is the most important thing on this screen, so
            give it a flat panel with a large Geist figure and one supporting
            line. Each value appears once: before an amount is typed it's the
            EXFER price (USD figure, BNB rate beneath); after, it's the estimated
            output (figure) with its USD value beneath. */}
        {poolInfo && (
          <div className="quote-card">
            {estOut != null ? (
              <>
                <div className="quote-label">{t("swap.youGet")}</div>
                <div className="quote-figure">
                  {sigFmt(estOut, 6)}
                  <span className="quote-unit">{recvUnit}</span>
                </div>
                {/* Effective rate for THIS trade (moves with the amount, since it
                    includes slippage) + the price impact, like a real swap app. */}
                <div className="quote-sub">
                  1 EXFER ≈ {effUsd != null ? `$${sigFmt(effUsd, 4)} · ` : ""}{sigFmt(effRate ?? poolInfo.mid)} BNB
                </div>
                {priceImpact > 0 && (
                  <div
                    className="quote-sub"
                    style={{ marginTop: 2, color: highImpact ? "#fbbf24" : "var(--text-faint)" }}
                  >
                    {t("swap.priceImpact")} {(priceImpact * 100).toFixed(2)}%
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="quote-label">{t("swap.priceTitle")}</div>
                {exferUsd != null ? (
                  <>
                    <div className="quote-figure">
                      <span className="quote-cur">$</span>
                      {sigFmt(exferUsd, 4)}
                      <span className="quote-per">{t("swap.perExfer")}</span>
                    </div>
                    <div className="quote-sub">≈ {sigFmt(poolInfo.mid)} BNB</div>
                  </>
                ) : (
                  <div className="quote-figure">
                    {sigFmt(poolInfo.mid, 4)}
                    <span className="quote-unit">BNB</span>
                    <span className="quote-per">{t("swap.perExfer")}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <label className="eyebrow">{sell ? t("swap.from") : t("swap.receiveTo")}</label>
        <AddrPicker items={pickList} value={fromAddr} onChange={setFrom} />

        {/* Funded buy: the BNB already in the wallet IS the payment, so show the
            wallet as the source rather than a redundant deposit QR. The QR only
            appears (above) when there's no BNB yet and the user must top up. */}
        {!sell && !needsFunding && bscAddr && (
          <>
            <div
              style={{
                display: "flex", alignItems: "center", gap: 11,
                padding: "11px 13px", borderRadius: 12,
                background: "var(--surface-2)", marginBottom: 8,
              }}
            >
              <BnbMark size={30} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t("swap.payFrom")}</span>
                <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)" }}>
                  {shortAddress(bscAddr)}
                </span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtUnits(bscBal?.bnb, 18, 4)} BNB</span>
            </div>
            <div className="banner banner-info" style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 14 }}>
              {t("swap.payFromHint")}
            </div>
          </>
        )}

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
      <>
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
          {priceImpact > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{t("swap.priceImpact")}</span>
              <span style={{ fontSize: 14, fontWeight: 500, color: highImpact ? "#fbbf24" : "var(--text)" }}>
                {(priceImpact * 100).toFixed(2)}%
              </span>
            </div>
          )}
          {typeof quote.fee_bps === "number" && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
                {t("swap.fee", { pct: sigFmt(quote.fee_bps / 100) })}
              </span>
              <span style={{ color: "var(--text-faint)", fontSize: 12 }}>{t("swap.feeIncluded")}</span>
            </div>
          )}
          <Row label={t("swap.from")} value={shortAddress(fromAddr)} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{t("swap.etaLabel")}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 500 }}>
              {t("swap.etaValue")}
              <SwapTimingHelp />
            </span>
          </div>
          <div className="banner banner-info" style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.55 }}>
            {t("swap.safetyNote")}
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </div>
      </Sheet>
      {showImpactConfirm && (
        <Modal
          title={t("swap.impactConfirmTitle")}
          onClose={() => setShowImpactConfirm(false)}
          footer={
            <>
              <button className="btn btn-secondary btn-block" onClick={() => setShowImpactConfirm(false)}>
                {t("sheet.cancel")}
              </button>
              <button className="btn btn-block" onClick={() => void doExecute()}>
                {t("swap.impactConfirmCta")}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            {t("swap.impactConfirmBody", { pct: (priceImpact * 100).toFixed(1) })}
          </div>
        </Modal>
      )}
      </>
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

        {/* horizontal staged stepper — shared with the liquidity flow */}
        <StagedStepper labels={stepLabels} doneCount={doneCount} />

        <div style={{ color: "var(--text-faint)", fontSize: 12.5, textAlign: "center", lineHeight: 1.5, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, alignSelf: "center", flexWrap: "wrap" }}>
          <span>{t("swap.etaHint")}</span>
          <SwapTimingHelp />
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

/** The EXFER balance of an account, right-aligned (whole bold + faint frac +
 *  small EXFER tag) — so each picker entry shows how much it holds, like the
 *  Home address list. */
function BalCell({ bal }: { bal: number }) {
  const { whole, frac } = splitBalanceCompact(bal);
  return (
    <span style={{ textAlign: "right", flex: "0 0 auto" }}>
      <span
        className="mono"
        style={{ display: "block", fontSize: 13, fontWeight: 600, color: bal > 0 ? "var(--text)" : "var(--text-faint)" }}
      >
        {whole}
        {frac && <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>.{frac}</span>}
      </span>
      <span style={{ display: "block", fontSize: 10, color: "var(--text-faint)", letterSpacing: ".06em" }}>EXFER</span>
    </span>
  );
}

/** A branded account picker — replaces the raw native <select> (which rendered
 *  as the OS dropdown, the ugliest element on the sheet). Shows the selected
 *  account with its identicon, name, short address and EXFER balance, and
 *  expands an inline list of the same. Each row carries the avatar so the
 *  choice reads as "which of my accounts", not "a string". */
function AddrPicker({
  items,
  value,
  onChange,
}: {
  items: WalletEntry[];
  value: string;
  onChange: (a: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sel = items.find((a) => a.address === value) ?? items[0];
  if (!sel) return null;
  return (
    <div style={{ position: "relative", marginBottom: 14 }}>
      <button
        type="button"
        className="field"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          textAlign: "left",
          ...(open ? { borderColor: "var(--accent)" } : null),
        }}
      >
        <AddrAvatar address={sel.address} size={30} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {addrName(sel)}
          </span>
          <span className="mono" style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>
            {shortAddress(sel.address)}
          </span>
        </span>
        <BalCell bal={sel.balance} />
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          style={{ flex: "0 0 auto", transition: "transform .18s", transform: open ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 5,
            padding: 4, maxHeight: 240, overflowY: "auto",
            background: "var(--elevated)", boxShadow: "var(--shadow)",
          }}
        >
          {items.map((a) => {
            const active = a.address === sel.address;
            return (
              <button
                key={a.address}
                type="button"
                className="tap"
                onClick={() => { onChange(a.address); setOpen(false); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 8px", borderRadius: 10, border: 0, cursor: "pointer",
                  textAlign: "left", font: "inherit", color: "var(--text)",
                  background: active ? "var(--surface-2)" : "none",
                }}
              >
                <AddrAvatar address={a.address} size={28} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {addrName(a)}
                  </span>
                  <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)" }}>
                    {shortAddress(a.address)}
                  </span>
                </span>
                <BalCell bal={a.balance} />
                <span style={{ width: 16, flex: "0 0 auto", display: "inline-flex", justifyContent: "center" }}>
                  {active && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
