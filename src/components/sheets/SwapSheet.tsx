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
import { rpc, formatBalanceCompact, splitBalanceCompact } from "../../lib/rpc";
import { notifySwapChanged } from "../../lib/inflightLp";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isHidden } from "../../lib/hidden";
import { shortAddress } from "../../lib/labels";
import { addrName, txExplorerUrl } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { WalletEntry } from "../../lib/types";
import { Sheet, CopyButton, Spinner, AddrAvatar, BnbMark, StagedStepper } from "../ui";
import { Qr } from "../Qr";
import { usePrice, useBnbUsd } from "../../lib/market";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";
import { recordSwapUsd } from "../../lib/swapPrice";
import { SwapTimingHelp } from "../SwapTimingHelp";
import { useBscWallet } from "../../lib/bscWallet";
import { CreateBnbWalletSheet } from "./CreateBnbWalletSheet";
import tokenCoin from "../../assets/exfer-token.png";

/** The EXFER coin mark — same treatment as the liquidity sheet (a thin white
 *  ring so it reads as a coin on the dark sheet, like BNB). */
function ExferMark({ size = 26 }: { size?: number }) {
  return (
    <img
      src={tokenCoin}
      alt=""
      width={size}
      height={size}
      style={{ borderRadius: 999, display: "block", flex: "0 0 auto", boxSizing: "border-box", border: "1px solid rgba(255,255,255,0.55)" }}
    />
  );
}

/** A non-interactive token chip (icon + symbol) used in the pay / receive
 *  cards. EXFER and BNB are tokens here, never verbs — the direction is owned
 *  by the ⇅ reverse button, not by which word you tap. */
function TokenChip({ unit }: { unit: "EXFER" | "BNB" }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "6px 12px 6px 8px", borderRadius: 999,
        background: "var(--surface)", border: "1px solid var(--border-soft)",
        fontSize: 15, fontWeight: 600, flex: "0 0 auto",
      }}
    >
      {unit === "EXFER" ? <ExferMark size={22} /> : <BnbMark size={22} />}
      {unit}
    </span>
  );
}

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
  /** Pool's settlement-gas fee (human BNB), already deducted from amount_out. */
  network_fee_bnb?: string | null;
  /** Unix seconds when this firm quote stops being honored by the pool. */
  expires_at?: number | null;
  our_bsc_address?: string | null;
  error?: string | null;
  // Tx references for each leg, passed through from walletd's SwapRecord
  // (item [10]). 0x-prefixed → BscScan (BNB leg); otherwise the EXFER explorer.
  // Field names match the daemon's serde snake_case (see Activity.tsx). May be
  // absent until the corresponding on-chain action has happened.
  user_lock_tx?: string | null;
  pool_lock_ref?: string | null;
  claim_tx?: string | null;
  refund_tx?: string | null;
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

/** Format a USD figure with 2 decimals for amounts >= $1, else significant
 *  digits so tiny values don't read as "$0.00". Returns null when no price. */
function usdStr(n: number | null | undefined): string | null {
  if (n == null || !isFinite(n) || n < 0) return null;
  if (n === 0) return "0.00";
  return n >= 1
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : sigFmt(n, 2);
}

/** mm:ss for the quote countdown. Clamps at 0:00. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  onReceive,
  initialFrom,
  resumeSwapId,
}: {
  onClose: () => void;
  onDone: (tab?: "wallet" | "activity" | "settings") => void;
  /** Open the Receive flow (e.g. from the "no EXFER to sell" empty state). */
  onReceive: () => void;
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

  // The wallet's BNB (BSC) key, up front. Seedless wallets (every in-app create
  // + vault import) have NO key — `created === false` — and BOTH directions
  // need one (sell = BNB receive address, buy = BNB source). When it's missing
  // we replace the whole form with a "Set up your BNB wallet" CTA before the
  // user fills anything, instead of letting them hit a raw error on Review.
  const bsc = useBscWallet();
  const [showCreateBnb, setShowCreateBnb] = useState(false);

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
  // Inline high-impact acknowledgement (review step) — arms Confirm. Replaces
  // the old Confirm→modal→"Swap anyway" double prompt.
  const [impactAck, setImpactAck] = useState(false);
  const [feeOpen, setFeeOpen] = useState(false);
  // Plain-language tooltip for the price-impact "?" (step-1 + review).
  const [impactHelpOpen, setImpactHelpOpen] = useState(false);
  // Quote countdown (item [1]): seconds left before the firm quote expires, and
  // an in-place "refreshing price" flag so expiry re-quotes instead of failing.
  const [quoteLeft, setQuoteLeft] = useState<number | null>(null);
  const [requoting, setRequoting] = useState(false);
  const [live, setLive] = useState<SwapRec | null>(null);

  // BSC funding info (buy direction only). The address comes from the hook
  // (single source of truth); only the BNB balance is fetched here.
  const bscAddr = bsc.address;
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
  // Sell with no EXFER to sell: every visible address holds 0 EXFER. Mirror the
  // buy "Add BNB" empty state — show a clear "nothing to sell" card with a way
  // out (receive EXFER, or flip to Buy) instead of an inert form that only
  // errors on Review. `fundable` is the addresses with a positive EXFER balance.
  const noExferToSell = sell && fundable.length === 0;

  // Fetch only the BNB balance — the address is owned by the hook. No-op (and
  // no balance) when there's no BNB key yet; the CTA gate handles that case.
  const refreshBsc = useCallback(async () => {
    if (!bsc.created) return;
    setBscBusy(true);
    try {
      const b = await rpc<{ bnb_wei: string }>("bsc_get_balances");
      setBscBal({ bnb: b.bnb_wei });
    } catch {
      /* engine may be disabled; surfaced on Review */
    } finally {
      setBscBusy(false);
    }
  }, [bsc.created]);

  useEffect(() => {
    // The wallet's BNB (BSC) balance is shown in both directions: alongside the
    // payment source when buying, and the receive address when selling. Only
    // meaningful once a BNB key exists.
    refreshBsc();
  }, [direction, refreshBsc]);

  // Focus the amount field once the sheet has slid into place, WITHOUT
  // scrolling the page (see amountRef above). Only on the build step, sell
  // direction or a funded buy — never when we're leading with the deposit card.
  useEffect(() => {
    if (step !== 1 || needsFunding || noExferToSell) return;
    const id = window.setTimeout(() => {
      amountRef.current?.focus({ preventScroll: true });
    }, 320); // just past the .3s sheetUp slide
    return () => window.clearTimeout(id);
  }, [step, needsFunding, noExferToSell]);

  // Auto-poll the BNB balance while the buy deposit UI is visible (step 1, buy
  // direction). When it increases vs. the last seen value, celebrate with a
  // toast so a fresh deposit is never silent.
  const lastBnbRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (step !== 1 || direction !== "bnb_to_exfer" || !bsc.created) return;
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
  }, [step, direction, bsc.created, toast, t]);

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
  // Net of the pool's network fee — what actually ARRIVES — so the step-1
  // "You receive" matches the review (which deducts it). Without this, the form
  // showed the gross output and the review then dropped ~5× for a small swap.
  const estNetFee = quote?.network_fee_bnb && Number(quote.network_fee_bnb) > 0 ? Number(quote.network_fee_bnb) : 0.0002;
  const estOutNet = (() => {
    if (estOut == null) return null;
    if (sell) return Math.max(0, estOut - estNetFee); // BNB out, minus the fee
    // Buy: the pool prices EXFER on (BNB in − fee); re-derive on the net input.
    const a = Number(amount);
    if (!poolInfo || !isFinite(a)) return estOut;
    const net = a - estNetFee;
    if (net <= 0) return 0;
    const ri = poolInfo.bnbReserve, ro = poolInfo.exferReserve;
    if (ri > 0 && ro > 0) {
      const inWithFee = (net * (10_000 - poolInfo.feeBps)) / 10_000;
      return (inWithFee * ro) / (ri + inWithFee);
    }
    return net / poolInfo.mid;
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
    // Keep back a little for the lock tx's gas (BNB is the gas token). 0.0005 is
    // ~5× a BSC HTLC lock (~0.0001 BNB) — enough headroom, but small enough that
    // a modestly-funded wallet still gets a Max button (0.002 hid it too often).
    const GAS_RESERVE = 0.0005;
    return Math.max(0, bnbHuman - GAS_RESERVE);
  })();

  // Spendable ceiling in the pay unit, for the 25/50/75/Max chips (item [19]).
  // Sell: the address's EXFER balance (human). Buy: buyMax (BNB less gas hold).
  // sendBal is in smallest units (1e8/EXFER); the % chips + Max work in HUMAN
  // EXFER, so convert. (This was the "25% set 28,750,000,000" bug — the chips
  // were taking a percentage of the raw unit count.)
  const payMax = sell ? sendBal / 1e8 : buyMax;

  // ── Money everywhere (item [5]) ──
  // Live USD value of the typed input and the estimated output, so the user can
  // see "I'm sending $X / getting $Y" before committing.
  // Value each leg at MARKET price (EXFER at the market mid, BNB at spot), and
  // the receive side at the NET output (estOutNet), so "send $X / get $Y" is
  // honest and matches the review — the X−Y gap is the fees.
  const sendUsd = (() => {
    const a = Number(amount);
    if (!amountValid || !isFinite(a)) return null;
    return sell ? (exferUsd != null ? a * exferUsd : null) : (bnbUsd != null ? a * bnbUsd : null);
  })();
  const recvUsd = (() => {
    if (estOutNet == null) return null;
    return sell ? (bnbUsd != null ? estOutNet * bnbUsd : null) : (exferUsd != null ? estOutNet * exferUsd : null);
  })();

  // ── Client-side minimum (item [6]) ──
  // The pool deducts a settlement-gas fee (network_fee_bnb, in BNB) from the
  // output. A trade whose whole output is eaten by that fee is pointless and the
  // daemon 400s it. Estimate the floor from the live quote's fee when we have it,
  // else a conservative BSC-lock estimate, and convert to the INPUT unit so we
  // can show "Min ~N {unit}" under the field and block Review below it.
  const netFeeBnb = (() => {
    const q = quote?.network_fee_bnb;
    if (q && Number(q) > 0) return Number(q);
    return 0.0002; // matches the pool's default SWAP_GAS_FEE_BNB until a quote lands
  })();
  // The pool accepts any trade whose output exceeds the network fee. Mirror that
  // (with a small buffer for the AMM/30bps gap so we don't allow something the
  // pool then 400s) rather than a heavy 3× margin that blocked legit small swaps.
  const minOutBnb = netFeeBnb * 1.2;
  const minAmount = (() => {
    if (!poolInfo || poolInfo.mid <= 0) return 0;
    // Convert the BNB output floor back to the input unit at the mid rate.
    return sell ? minOutBnb / poolInfo.mid : minOutBnb;
  })();
  const belowMin = amountValid && minAmount > 0 && Number(amount) < minAmount;
  const minUnit = sendUnit;

  // ── Consolidated fees (item [4]) ──
  // Network fee in USD, and the all-in fee total (liquidity fee + price impact +
  // network fee), in USD — the single figure shown on the "Fees ≈ $X" chip.
  const netFeeUsd = bnbUsd != null && netFeeBnb > 0 ? netFeeBnb * bnbUsd : null;
  const liqFeeUsd = (() => {
    if (!poolInfo || sendUsd == null) return null;
    return sendUsd * (poolInfo.feeBps / 10_000);
  })();
  const impactUsd = (() => {
    if (sendUsd == null || priceImpact <= 0) return null;
    return sendUsd * priceImpact;
  })();
  const feesTotalUsd = (() => {
    const parts = [liqFeeUsd, impactUsd, netFeeUsd].filter((x): x is number => x != null);
    if (parts.length === 0) return null;
    return parts.reduce((s, x) => s + x, 0);
  })();

  async function getQuote() {
    // Both directions need the BNB key (sell = receive address, buy = source).
    // Never quote without it — route to setup instead of erroring on Review.
    if (!bsc.created) {
      setShowCreateBnb(true);
      return;
    }
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
      setImpactAck(false);
      setStep(2);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Re-quote in place on the review step (item [1]) — when the firm quote
  // expires, refresh the price WITHOUT bouncing the user back to step 1. Keeps
  // the same direction/amount/address; only the numbers refresh.
  const requote = useCallback(async () => {
    if (!amountValid || !fromAddr || requoting) return;
    setRequoting(true);
    setErr(null);
    try {
      const q = await rpc<SwapRec>("swap_get_quote", {
        direction,
        amount_in: amount.trim(),
        from: fromAddr,
      });
      setQuote(q);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setRequoting(false);
    }
  }, [amountValid, fromAddr, requoting, direction, amount]);

  // Flip direction via the central ⇅ button. We KEEP the typed amount (the
  // pair is reversible, not a reset) and KEEP the selected From address — only
  // the now-stale quote is dropped so Review re-quotes. The old Sell/Buy buttons
  // wiped `from` on every tap; that was a data-loss bug, not a feature.
  function reverse() {
    buzz(8);
    setErr(null);
    setQuote(null);
    setDirection((d) => (d === "exfer_to_bnb" ? "bnb_to_exfer" : "exfer_to_bnb"));
  }

  // High-impact trades require the inline acknowledgement (item [17]) before
  // Confirm fires — a single confirmation, then biometric. No more modal.
  const confirmArmed = !highImpact || impactAck;

  async function doExecute() {
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
      // Snapshot the effective (pool-driven) EXFER/USD now, so the record can
      // later show what this swap was worth at execution time.
      if (exferUsd != null) recordSwapUsd(quote.swap_id, exferUsd);
      // Tell the Swap tab to refresh its in-progress list immediately so the
      // card is there the instant the user closes this sheet (not 8s later).
      notifySwapChanged();
      setLive(r);
      setStep(3);
      toast.success(t("swap.started"), t("swap.startedBody"));
    } catch (e) {
      // An expired quote is recoverable: re-quote IN PLACE on the review step
      // (don't bounce to step 1 and lose context). The countdown should normally
      // refresh before this fires; this is the backstop.
      if (/expired/i.test(String((e as { message?: string })?.message ?? e))) {
        toast.error(t("swap.requoting"), "");
        void requote();
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

  // Quote countdown (item [1]): tick once a second on the review step while the
  // quote carries an expiry. At ~0 we re-quote in place (firm HTLC quote, no
  // slippage — just a fresh price), never failing Confirm.
  const expiresAt = quote?.expires_at ?? null;
  useEffect(() => {
    if (step !== 2 || expiresAt == null) {
      setQuoteLeft(null);
      return;
    }
    let fired = false;
    const tick = () => {
      const left = expiresAt - Math.floor(Date.now() / 1000);
      setQuoteLeft(left);
      // Re-quote just before expiry so Confirm always has a live quote.
      if (left <= 1 && !fired) {
        fired = true;
        void requote();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [step, expiresAt, requote]);

  // Elapsed seconds on the progress screen, for a "taking longer than usual" hint.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (step !== 3) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [step]);

  // On a terminal state, just a haptic. We DON'T auto-dismiss the success
  // screen anymore (item [11]) — that stole the moment the user wants to read
  // the amount / screenshot it. They tap Done (or View in Activity) themselves.
  useEffect(() => {
    if (step !== 3) return;
    const s = live?.status;
    if (s === "completed") buzz([0, 30, 40, 30]);
    if (s === "refunded" || s === "failed") buzz(60);
  }, [step, live?.status]);

  // Closing while a swap is still settling: reassure that it keeps going and
  // can be tracked on the Swap tab (item [12]). Used by the progress / refunding
  // footers' Close button instead of a bare onClose.
  const closeSettling = useCallback(() => {
    toast.info(t("swap.stillSettlingToast"), "");
    onClose();
  }, [toast, t, onClose]);

  // Open a support / help channel for a stuck or failed swap (item [10]). Uses
  // the Tauri opener when available, else copies a mailto so it's never a dead
  // end on a restricted webview.
  const openHelp = useCallback(async () => {
    const url = "mailto:support@exfer.dev?subject=Swap%20help";
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      try { window.open(url, "_blank", "noopener"); }
      catch { navigator.clipboard?.writeText("support@exfer.dev"); toast.info(t("act.explorerCopied"), "support@exfer.dev"); }
    }
  }, [toast, t]);

  // Toast helper for tx-link / id copy fallbacks (item [10]).
  const onRefCopied = useCallback((urlOrId: string) => {
    toast.info(t("act.explorerCopied"), urlOrId);
  }, [toast, t]);

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
        <div className="eyebrow" style={{ alignSelf: "flex-start" }}>{needsFunding ? t("swap.fundStep") : t("swap.bscAddress")}</div>
        <Qr value={bscAddr} size={150} />
        {/* Left-aligned address block — monospace shouldn't be centered (item [3]). */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, width: "100%" }}>
          <span style={{ flex: 1, minWidth: 0, fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.55, textAlign: "left" }}>{bscAddr}</span>
          <CopyButton text={bscAddr} />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-faint)", display: "flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
          <span>BNB: {fmtUnits(bscBal?.bnb, 18, 4)}</span>
          {/* Compact inline refresh — btn-ghost btn-sm padded it up so it looked
              like a chunky control on its own line next to the tiny balance. */}
          <button
            onClick={refreshBsc}
            disabled={bscBusy}
            aria-label="Refresh BNB balance"
            style={{ background: "none", border: 0, padding: 2, color: "var(--text-faint)", cursor: "pointer", fontSize: 13, lineHeight: 1, opacity: bscBusy ? 0.5 : 1 }}
          >
            {bscBusy ? "…" : "↻"}
          </button>
        </div>
        {/* Cross-network loss warning — a prominent amber banner with an icon,
            positive instruction first (item [3]). Replaces the old grey footnote. */}
        <div
          className="banner banner-warn"
          style={{ width: "100%", display: "flex", gap: 9, alignItems: "flex-start", textAlign: "left", padding: "10px 12px" }}
        >
          <span style={{ flex: "0 0 auto", marginTop: 1, color: "#fbbf24" }}>
            <Icon name="shield" size={16} />
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 700 }}>{t("swap.fundOnlyBnb")}</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5, marginTop: 2 }}>{t("swap.fundOnlyBnbBody")}</span>
          </span>
        </div>
        {bnbZero && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 12 }}>
            <Spinner size={12} /> {t("swap.waitingBnb")}
          </div>
        )}
      </div>
    ) : null;

  // ---------- step 1: build ----------
  // Seedless wallet with no BNB key: gate the WHOLE form behind a clear setup
  // CTA (both directions need a BNB key). Wait for the first fetch (loading) so
  // we don't flash the CTA before we know. Skeleton over a premature CTA.
  const needsBnbWallet = !bsc.loading && !bsc.created;

  if (step === 1) {
    if (needsBnbWallet) {
      return (
        <>
          <Sheet
            title={t("swap.title")}
            onClose={onClose}
            footer={
              <button className="btn btn-block" onClick={() => setShowCreateBnb(true)}>
                {t("bnb.createCta")}
              </button>
            }
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 14,
                padding: "26px 8px 12px",
              }}
            >
              <span
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  display: "grid",
                  placeItems: "center",
                  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                  color: "var(--accent)",
                }}
              >
                <BnbMark size={34} />
              </span>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{t("bnb.notCreatedTitle")}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-faint)", maxWidth: 320 }}>
                {t("bnb.swapNeedsWallet")}
              </div>
            </div>
          </Sheet>
          {showCreateBnb && (
            <CreateBnbWalletSheet
              onClose={() => setShowCreateBnb(false)}
              onCreated={() => {
                setShowCreateBnb(false);
                void bsc.refresh();
              }}
            />
          )}
        </>
      );
    }
    return (
      <>
      <Sheet
        title={t("swap.title")}
        onClose={onClose}
        footer={
          <button
            className="btn btn-block"
            // While the buy side still needs BNB the amount can't be acted on —
            // keep Review truly inert (not just dimmed) until funded.
            disabled={busy || !amountValid || needsFunding || noExferToSell || belowMin}
            onClick={getQuote}
          >
            {busy ? <Spinner /> : t("swap.review")}
          </button>
        }
      >
        {/* Sell side with nothing to sell: a clear empty state with a way out
            (receive EXFER, or flip to Buy) — mirrors the buy "Add BNB" state,
            instead of an inert form that only errors on Review. */}
        {noExferToSell ? (
          <div
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              textAlign: "center", gap: 14, padding: "26px 8px 8px",
            }}
          >
            <span
              style={{
                width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center",
                background: "color-mix(in srgb, var(--accent) 14%, transparent)",
              }}
            >
              <ExferMark size={34} />
            </span>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{t("swap.noExferTitle")}</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-faint)", maxWidth: 320 }}>
              {t("swap.noExferBody")}
            </div>
            <div style={{ display: "flex", gap: 10, width: "100%", marginTop: 4 }}>
              <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={onReceive}>
                {t("swap.receiveExfer")}
              </button>
              <button className="btn btn-block" style={{ flex: 1 }} onClick={reverse}>
                {t("swap.switchToBuy")}
              </button>
            </div>
          </div>
        ) : (
        <>
        {/* Buy with no BNB: lead with the deposit step so the order of
            operations reads top-to-bottom (1. Add BNB → 2. Enter amount). */}
        {needsFunding && depositCard}

        {/* The canonical reversible pair: a "You pay" card over a "You receive"
            card with a circular ⇅ between them. Tapping ⇅ flips direction while
            keeping the typed amount and the selected address. EXFER / BNB are
            token chips, not verbs. */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
          <div className="swap-leg" style={needsFunding ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <span className="eyebrow">{t("swap.youPay")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <input
                  ref={amountRef}
                  className="swap-amount"
                  style={{ width: "100%" }}
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  // Truly inert while the buy side still needs funding (item [15]).
                  disabled={needsFunding}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {/* Live USD value of what's being paid (item [5]). */}
                <span style={{ display: "block", fontSize: 12.5, color: "var(--text-faint)", marginTop: 2, minHeight: 16 }}>
                  {usdStr(sendUsd) != null ? t("swap.approxUsd", { usd: usdStr(sendUsd)! }) : ""}
                </span>
              </span>
              <TokenChip unit={sendUnit as "EXFER" | "BNB"} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
              <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
                {t("swap.balance")}: {sell ? formatBalanceCompact(sendBal) : `${fmtUnits(bscBal?.bnb, 18, 4)} BNB`}
              </span>
              {/* Client-side minimum (item [6]): a persistent floor hint. */}
              {minAmount > 0 && (
                <span style={{ fontSize: 11.5, color: belowMin ? "#fbbf24" : "var(--text-faint)" }}>
                  {t("swap.minAmount", { n: sigFmt(minAmount, 2), unit: minUnit })}
                </span>
              )}
            </div>
            {/* 25/50/75/Max quick-fill chips, both directions (item [19]). */}
            <PercentChips max={payMax} onPick={(v) => setAmount(sigFmt(v, 8))} t={t} />
            {/* Caption the buy-Max gas hold-back so it doesn't look like a shortfall. */}
            {!sell && buyMax > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>{t("swap.maxGasHold")}</div>
            )}
          </div>

          {/* Centered reverse button, overlapping the gap between the two legs. */}
          <button
            type="button"
            aria-label={t("swap.reverse")}
            onClick={reverse}
            style={{
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
              width: 38, height: 38, borderRadius: 999, zIndex: 2,
              display: "grid", placeItems: "center", cursor: "pointer",
              background: "var(--elevated)", border: "1px solid var(--border)",
              color: "var(--text)", boxShadow: "var(--shadow)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 4v14M7 4L4 7M7 4l3 3M17 20V6m0 14l3-3m-3 3l-3-3" />
            </svg>
          </button>

          <div className="swap-leg">
            <span className="eyebrow">{t("swap.youReceiveEst")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 26, fontWeight: 600, letterSpacing: "-.02em", fontVariantNumeric: "tabular-nums", color: estOutNet != null ? "var(--text)" : "var(--text-faint)" }}>
                  {estOutNet != null ? sigFmt(estOutNet, 6) : "0.0"}
                </span>
                {/* Live USD value of the estimated output (item [5]). */}
                <span style={{ display: "block", fontSize: 12.5, color: "var(--text-faint)", marginTop: 2, minHeight: 16 }}>
                  {usdStr(recvUsd) != null ? t("swap.approxUsd", { usd: usdStr(recvUsd)! }) : ""}
                </span>
              </span>
              <TokenChip unit={recvUnit as "EXFER" | "BNB"} />
            </div>
          </div>
        </div>

        {/* Quote card — the price is the most important thing on this screen, so
            give it a flat panel with a large Geist figure and one supporting
            line. Each value appears once: before an amount is typed it's the
            EXFER price (USD figure, BNB rate beneath); after, it's the estimated
            output (figure) with its USD value beneath. */}
        {/* Price + impact for the typed trade only. The standalone "EXFER price"
            card (shown before any amount) was redundant — the price is on the
            Swap tab and previewed live here — so it's gone. */}
        {poolInfo && estOut != null && (
          <div className="quote-card" style={belowMin ? { opacity: 0.45 } : undefined}>
            <div className="quote-detail quote-detail-bare">
              <div className="quote-row">
                <span className="quote-row-k">{t("swap.priceLabel")}</span>
                <span className="quote-row-v">
                  {effUsd != null ? `$${sigFmt(effUsd, 4)}` : `${sigFmt(effRate ?? poolInfo.mid)} BNB`}
                  <small>/ EXFER</small>
                </span>
              </div>
              {priceImpact > 0 && (
                <div className="quote-row">
                  <span className="quote-row-k" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {t("swap.priceImpact")}
                    <HelpDot open={impactHelpOpen} onClick={() => setImpactHelpOpen((o) => !o)} />
                  </span>
                  <span className="quote-row-v" style={{ color: impactColor(priceImpact, highImpact) }}>
                    {(priceImpact * 100).toFixed(2)}%
                  </span>
                </div>
              )}
              {impactHelpOpen && priceImpact > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, padding: "0 2px 2px" }}>
                  {t("swap.impactHelp")}
                </div>
              )}
            </div>
          </div>
        )}
        {/* ONE consolidated fee disclosure (item [4]) — identical here and on
            review. Only meaningful once an amount is entered (so the impact /
            network-fee portions are real); collapses to "Fees ≈ $X ▾". */}
        {poolInfo && estOut != null && (
          <FeesDisclosure
            t={t}
            open={feeOpen}
            onToggle={() => setFeeOpen((o) => !o)}
            totalUsd={feesTotalUsd}
            feePct={sigFmt(poolInfo.feeBps / 100, 2)}
            impactPct={priceImpact > 0 ? (priceImpact * 100).toFixed(2) : null}
            impactColorVal={priceImpact > 0 ? impactColor(priceImpact, highImpact) : undefined}
            netFeeBnb={netFeeBnb > 0 ? sigFmt(netFeeBnb, 4) : null}
            netFeeUsd={netFeeUsd != null ? usdStr(netFeeUsd) : null}
          />
        )}
        {/* Below the client-side minimum: an inline reason, the same wording as
            the daemon's reject (item [6]). Review is disabled in the footer. */}
        {belowMin && (
          <div style={{ color: "#fbbf24", fontSize: 12.5, lineHeight: 1.5, marginBottom: 4 }}>{t("err.amountTooSmall")}</div>
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
          </>
        )}

        {sell && bscAddr && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "11px 13px", borderRadius: 12,
              background: "var(--surface-2)", marginBottom: 8,
            }}
          >
            <BnbMark size={30} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t("swap.bnbReceiveTo")}</span>
              <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)" }}>
                {shortAddress(bscAddr)}
              </span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtUnits(bscBal?.bnb, 18, 4)} BNB</span>
          </div>
        )}

        {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </>
        )}
      </Sheet>
      {showCreateBnb && (
        <CreateBnbWalletSheet
          onClose={() => setShowCreateBnb(false)}
          onCreated={() => {
            setShowCreateBnb(false);
            void bsc.refresh();
          }}
        />
      )}
      </>
    );
  }

  // ---------- step 2: review ----------
  if (step === 2 && quote) {
    // Derive the headline numbers from the ACTUAL quote (item [13]) so the
    // receive amount, the price, and the rate can never disagree (they used to
    // come from a different reserve snapshot than amount_out).
    const qIn = Number(quote.amount_in);
    const qOut = Number(quote.amount_out);
    // Receive-per-pay rate straight from the quote.
    const qRate = qIn > 0 && qOut > 0 ? qOut / qIn : null;
    // BNB per 1 EXFER this quote settles at → USD per EXFER via bnbUsd. Sell
    // pays BNB out per EXFER in (qRate); buy spends BNB in per EXFER out (1/qRate).
    const qBnbPerExfer = qRate == null ? null : sell ? qRate : 1 / qRate;
    const qExferUsd = qBnbPerExfer != null && bnbUsd != null ? qBnbPerExfer * bnbUsd : effUsd;
    // USD totals — value each leg at its MARKET price (EXFER at the market mid,
    // BNB at spot), NOT the post-fee effective rate. The gap between the two is
    // the fees (shown below). Using the effective rate made "You send 145 EXFER"
    // read its post-fee value ($0.028) instead of its real ~$0.15 market worth.
    const sendUsdR = sell ? (exferUsd != null ? qIn * exferUsd : null) : (bnbUsd != null ? qIn * bnbUsd : null);
    const recvUsdR = sell ? (bnbUsd != null ? qOut * bnbUsd : null) : (exferUsd != null ? qOut * exferUsd : null);
    // Fees total in USD, mirroring step-1 (item [4]).
    const liqFeeUsdR = sendUsdR != null && typeof quote.fee_bps === "number" ? sendUsdR * (quote.fee_bps / 10_000) : (sendUsdR != null && poolInfo ? sendUsdR * (poolInfo.feeBps / 10_000) : null);
    const impactUsdR = sendUsdR != null && priceImpact > 0 ? sendUsdR * priceImpact : null;
    const feesTotalUsdR = (() => {
      const parts = [liqFeeUsdR, impactUsdR, netFeeUsd].filter((x): x is number => x != null);
      return parts.length ? parts.reduce((s, x) => s + x, 0) : null;
    })();
    const feePctR = sigFmt(((typeof quote.fee_bps === "number" ? quote.fee_bps : poolInfo?.feeBps ?? 0) / 100), 2);
    // Countdown styling.
    const left = quoteLeft;
    const lowTime = left != null && left <= 10;
    const sendUsdStr = usdStr(sendUsdR);
    const recvUsdStr = usdStr(recvUsdR);
    return (
      <>
      <Sheet
        title={t("swap.review")}
        onClose={onClose}
        onBack={() => setStep(1)}
        footer={
          <button className="btn btn-block" disabled={busy || requoting || !confirmArmed} onClick={() => void doExecute()}>
            {busy || requoting ? <Spinner /> : t("swap.confirm")}
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label={t("swap.youSend")} value={`${fmtAmt(quote.amount_in)} ${sendUnit}${sendUsdStr ? ` ($${sendUsdStr})` : ""}`} />
          <Row label={t("swap.youReceive")} value={`${fmtAmt(quote.amount_out)} ${recvUnit}${recvUsdStr ? ` ($${recvUsdStr})` : ""}`} strong />

          {/* One market Price line (USD per EXFER). The firm-HTLC guarantee that
              "you receive == what arrives, or it's refunded" is stated once in
              the note below — no separate Minimum-received box repeating the same
              number, and no redundant BNB Rate line. */}
          {exferUsd != null && (
            <Row label={t("swap.priceLabel")} value={`1 EXFER ≈ $${sigFmt(exferUsd, 4)}`} />
          )}

          {/* Price impact with the same "?" affordance as step-1, severity-coloured. */}
          {priceImpact > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "var(--text-faint)", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("swap.priceImpact")}
                  <HelpDot open={impactHelpOpen} onClick={() => setImpactHelpOpen((o) => !o)} />
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: impactColor(priceImpact, highImpact) }}>
                  {(priceImpact * 100).toFixed(2)}%
                </span>
              </div>
              {impactHelpOpen && (
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5, marginTop: -4 }}>{t("swap.impactHelp")}</div>
              )}
            </>
          )}

          {/* ONE consolidated fees disclosure — identical to step-1 (item [4]). */}
          <FeesDisclosure
            t={t}
            open={feeOpen}
            onToggle={() => setFeeOpen((o) => !o)}
            totalUsd={feesTotalUsdR}
            feePct={feePctR}
            impactPct={priceImpact > 0 ? (priceImpact * 100).toFixed(2) : null}
            impactColorVal={priceImpact > 0 ? impactColor(priceImpact, highImpact) : undefined}
            netFeeBnb={netFeeBnb > 0 ? sigFmt(netFeeBnb, 4) : null}
            netFeeUsd={netFeeUsd != null ? usdStr(netFeeUsd) : null}
          />

          {/* Fee-heavy warning — when the (mostly fixed) fees eat a big share of
              the trade, the user gets back far less than they put in. Flag it like
              a high price impact so a tiny, inefficient swap isn't a surprise. */}
          {feesTotalUsdR != null && sendUsdR != null && sendUsdR > 0 && feesTotalUsdR / sendUsdR >= 0.2 && (
            <div className="banner banner-warn" style={{ marginTop: 2, fontSize: 12.5, lineHeight: 1.55 }}>
              {t("swap.feeHeavy", { pct: String(Math.round((feesTotalUsdR / sendUsdR) * 100)) })}
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

          {/* Quote countdown (item [1]) — amber under ~10s. At expiry it
              re-quotes IN PLACE; Confirm never fails for a stale quote. */}
          {left != null && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{t("swap.quoteValid", { time: mmss(left) })}</span>
              {requoting && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-faint)" }}><Spinner size={12} /> {t("swap.requoting")}</span>}
              {!requoting && (
                <span style={{ fontSize: 13, fontWeight: 600, color: lowTime ? "#fbbf24" : "var(--text)" }}>{mmss(left)}</span>
              )}
            </div>
          )}

          {/* High-impact inline acknowledgement (item [17]) — arms Confirm. A
              single confirmation, then biometric. Leads with the money. */}
          {highImpact && (() => {
            const ideal = qExferUsd != null && recvUsdR != null && priceImpact > 0
              ? `$${usdStr(recvUsdR / (1 - priceImpact)) ?? ""}` : `${fmtAmt(quote.amount_out)} ${recvUnit}`;
            const lessUsd = recvUsdR != null && priceImpact > 0 ? usdStr((recvUsdR / (1 - priceImpact)) - recvUsdR) : null;
            return (
              <div className="banner banner-warn" style={{ marginTop: 2, fontSize: 12.5, lineHeight: 1.55, display: "flex", flexDirection: "column", gap: 8 }}>
                <span>
                  {lessUsd != null
                    ? t("swap.impactMoney", { got: fmtAmt(quote.amount_out), unit: recvUnit, ideal, less: lessUsd })
                    : t("swap.highImpact", { pct: (priceImpact * 100).toFixed(1) })}
                </span>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={impactAck} onChange={(e) => setImpactAck(e.target.checked)} style={{ marginTop: 2 }} />
                  <span>{t("swap.impactAck", { pct: (priceImpact * 100).toFixed(1) })}</span>
                </label>
              </div>
            );
          })()}

          <div className="banner banner-info" style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.55 }}>
            {t("swap.minReceivedNote")}
          </div>
          {/* Honest "can't be cancelled / auto-refunds" line near Confirm (item [12]). */}
          <div style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5, textAlign: "center" }}>
            {t("swap.noCancelNote")}
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </div>
      </Sheet>
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
    const swapId = live?.swap_id ?? watchId ?? "";
    // failed/refunded keep a persistent "funds are safe / refunded" line, a
    // copyable swap ID + Help, and the raw error tucked into Details (item [10]).
    const notTerminalSuccess = s !== "completed";
    return (
      <Sheet
        title={title}
        onClose={onClose}
        footer={
          s === "completed" ? (
            // Two actions, no auto-dismiss (item [11]): primary Done + a quiet
            // "View in Activity" so the receipt is one tap away.
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={() => onDone("activity")}>{t("swap.viewActivity")}</button>
              <button className="btn btn-block" style={{ flex: 1 }} onClick={() => { onDone(); onClose(); }}>{t("swap.done")}</button>
            </div>
          ) : (
            <button className="btn btn-block" onClick={() => { onDone(); onClose(); }}>{t("swap.done")}</button>
          )
        }
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "20px 0 4px" }}>
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
          {/* Persistent reassurance for failed/refunded (item [10]). */}
          {notTerminalSuccess && (
            <div className="banner banner-info" style={{ width: "100%", fontSize: 12.5, lineHeight: 1.55, textAlign: "center" }}>
              {s === "refunded" ? t("swap.fundsRefunded") : t("swap.fundsSafe")}
            </div>
          )}
          {/* Per-leg explorer links (item [10]). */}
          <TxRefs rec={live} t={t} onCopied={onRefCopied} />
          {/* failed/refunded: copyable swap ID + Help. */}
          {notTerminalSuccess && swapId && (
            <SwapIdHelp swapId={swapId} t={t} onCopied={onRefCopied} onHelp={openHelp} />
          )}
          {/* Raw error moved into a Details disclosure, not the headline (item [10]). */}
          {live?.error && <ErrorDetails error={live.error} t={t} />}
        </div>
      </Sheet>
    );
  }

  // Refunding: an amber in-between state while the daemon reverses the lock.
  if (s === "refunding") {
    return (
      <Sheet title={t("swap.refundingTitle")} onClose={closeSettling} footer={<button className="btn btn-block" onClick={closeSettling}>{t("swap.closeKeepSettling")}</button>}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "22px 0" }}>
          <ResultBadge kind="refunded" />
          {amounts && <div style={{ fontSize: 15, fontWeight: 600 }}>{amounts}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-faint)", fontSize: 13 }}>
            <Spinner size={13} /> {t("swap.statusRefunding")}
          </div>
          <div className="banner banner-info" style={{ width: "100%", fontSize: 12.5, lineHeight: 1.55, textAlign: "center" }}>{t("swap.fundsSafe")}</div>
          <TxRefs rec={live} t={t} onCopied={onRefCopied} />
        </div>
      </Sheet>
    );
  }

  // In-progress (user_locked / pool_locked / claiming): a 3-step checklist so
  // "in progress" reads as measurable forward motion, not an endless spinner.
  const doneCount = s === "pool_locked" || s === "claiming" ? 2 : 1;
  const stepLabels = [t("swap.stepLocked"), t("swap.stepMatched"), t("swap.stepSettling")];
  // Raised threshold (item [9]): a healthy swap is ~60s and can run to ~2 min on
  // a slow block. Don't cry "taking long" until ~165s so the happy path never
  // looks broken.
  const stuck = elapsed > 165;
  const canRefund = ["user_locked", "pool_locked"].includes(s);
  const swapId = live?.swap_id ?? watchId ?? "";
  // Up-front, honest ETA (item [9]): a soft countdown from a ~60s budget. Once
  // past budget we drop to the neutral "usually ~60s" so it never goes negative
  // or implies it's late.
  const secLeft = Math.max(0, 60 - elapsed);
  const etaText = secLeft > 0 ? t("swap.etaCountdown", { sec: secLeft }) : t("swap.etaUsual");
  return (
    <Sheet
      title={t("swap.submittedTitle")}
      onClose={closeSettling}
      // The user's leg is on-chain — their part is done. Let them leave; the
      // daemon's monitor settles the rest in the background.
      footer={<button className="btn btn-block" onClick={closeSettling}>{t("swap.closeKeepSettling")}</button>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 0 4px" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t("swap.submittedHeading")}</div>
          {amounts && <div style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>{amounts}</div>}
        </div>

        {/* horizontal staged stepper — shared with the liquidity flow */}
        <StagedStepper labels={stepLabels} doneCount={doneCount} />

        {/* What it's actively waiting on right now + an up-front ETA (item [9]). */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600 }}>
            <Spinner size={13} />
            <span>{t("swap.confirmingChain")}</span>
          </div>
          <div style={{ color: "var(--text-faint)", fontSize: 12.5 }}>{etaText}</div>
        </div>

        <div style={{ color: "var(--text-faint)", fontSize: 12.5, textAlign: "center", lineHeight: 1.5, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, alignSelf: "center", flexWrap: "wrap" }}>
          <span>{t("swap.safeToClose")}</span>
          <SwapTimingHelp />
        </div>

        {/* Per-leg explorer links once they land (item [10]). */}
        <TxRefs rec={live} t={t} onCopied={onRefCopied} />

        {stuck && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ color: "#fbbf24", fontSize: 12, textAlign: "center" }}>{t("swap.takingLong")}</div>
            {canRefund ? (
              <button className="btn-ghost btn-sm" disabled={busy} onClick={manualRefund}>
                {busy ? <Spinner size={13} /> : t("swap.refundNow")}
              </button>
            ) : (
              // claiming can't be self-refunded (the pool is mid-claim) — give a
              // copyable swap ID + Help instead of a dead end (item [10]).
              swapId && <SwapIdHelp swapId={swapId} t={t} onCopied={onRefCopied} onHelp={openHelp} />
            )}
          </div>
        )}
        {/* Raw error tucked into Details, not shouted in red (item [10]). */}
        {live?.error && <ErrorDetails error={live.error} t={t} />}
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

/** Open an explorer link for a leg — BscScan for the BNB (0x) tx, the EXFER
 *  explorer otherwise. Falls back to copying the URL when the webview blocks
 *  window.open (item [10]). */
function openTxRef(
  txid: string,
  onCopied: (url: string) => void,
) {
  const url = txExplorerUrl(txid);
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    navigator.clipboard?.writeText(url);
    onCopied(url);
  }
}

/** The per-leg transaction links shown on the progress + terminal screens
 *  (item [10]). Each present ref becomes a tappable row that opens the right
 *  explorer. Renders nothing when no ref has landed yet. */
function TxRefs({
  rec, t, onCopied,
}: {
  rec: SwapRec | null;
  t: (k: import("../../lib/i18n").MsgKey, p?: Record<string, string | number>) => string;
  onCopied: (url: string) => void;
}) {
  if (!rec) return null;
  const rows: { key: import("../../lib/i18n").MsgKey; value: string }[] = [];
  if (rec.user_lock_tx) rows.push({ key: "swap.refUserLock", value: rec.user_lock_tx });
  if (rec.pool_lock_ref) rows.push({ key: "swap.refPoolLock", value: rec.pool_lock_ref });
  if (rec.claim_tx) rows.push({ key: "swap.refClaim", value: rec.claim_tx });
  if (rec.refund_tx) rows.push({ key: "swap.refRefund", value: rec.refund_tx });
  if (!rows.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      <div className="eyebrow">{t("swap.txLinks")}</div>
      {rows.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => openTxRef(r.value, onCopied)}
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            background: "var(--surface-2)", border: 0, borderRadius: 10,
            padding: "9px 11px", cursor: "pointer", textAlign: "left", font: "inherit",
            color: "var(--text)",
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--text-faint)", flex: "0 0 auto" }}>{t(r.key)}</span>
          <code className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
            {shortAddress(r.value)}
          </code>
          <Icon name="share" size={13} />
        </button>
      ))}
    </div>
  );
}

/** A copyable swap-ID row + Help button for the failed / refunded terminals
 *  (item [10]). Keeps a persistent reassurance and a way to reach support. */
function SwapIdHelp({
  swapId, t, onCopied, onHelp,
}: {
  swapId: string;
  t: (k: import("../../lib/i18n").MsgKey, p?: Record<string, string | number>) => string;
  onCopied: (text: string) => void;
  onHelp: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <button
        type="button"
        onClick={() => { navigator.clipboard?.writeText(swapId); onCopied(swapId); }}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "var(--surface-2)", border: 0, borderRadius: 10,
          padding: "9px 11px", cursor: "pointer", textAlign: "left", font: "inherit", color: "var(--text)",
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--text-faint)", flex: "0 0 auto" }}>{t("swap.swapIdLabel")}</span>
        <code className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
          {shortAddress(swapId)}
        </code>
        <Icon name="copy" size={13} />
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={onHelp} style={{ alignSelf: "center" }}>
        {t("swap.getHelp")}
      </button>
    </div>
  );
}

/** A collapsible "Details" disclosure for the raw error string (item [10]) —
 *  keeps the scary technical text out of the primary message. */
function ErrorDetails({ error, t }: { error: string; t: (k: import("../../lib/i18n").MsgKey) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: 0, padding: "2px 0", cursor: "pointer", font: "inherit", color: "var(--text-faint)", fontSize: 12.5 }}
      >
        {t("swap.detailsToggle")}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform .18s", transform: open ? "rotate(180deg)" : "none" }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: "9px 11px", borderRadius: 10, background: "var(--surface-2)", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong, valueColor }: { label: string; value: string; strong?: boolean; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, fontSize: strong ? 18 : 14, color: valueColor }}>{value}</span>
    </div>
  );
}

/** A small circular "?" affordance — the same chip used by the fee disclosure,
 *  reused for the price-impact tooltip so both read as the same kind of help. */
function HelpDot({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="?"
      onClick={onClick}
      style={{
        display: "inline-grid", placeItems: "center", width: 15, height: 15, borderRadius: 999,
        border: `1px solid ${open ? "var(--accent)" : "var(--text-faint)"}`, background: "none",
        color: open ? "var(--accent)" : "var(--text-faint)", fontSize: 10, fontWeight: 700,
        lineHeight: 1, cursor: "pointer", padding: 0, flex: "0 0 auto",
      }}
    >?</button>
  );
}

/** 25/50/75/Max quick-fill chips (item [19]). `max` is the spendable ceiling in
 *  the pay unit; each chip sets the amount to that fraction. */
function PercentChips({ max, onPick, t }: { max: number; onPick: (v: number) => void; t: (k: import("../../lib/i18n").MsgKey, p?: Record<string, string | number>) => string }) {
  if (!(max > 0) || !isFinite(max)) return null;
  const fracs: [number, string][] = [[0.25, "25"], [0.5, "50"], [0.75, "75"]];
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
      {fracs.map(([f, lbl]) => (
        <button
          key={lbl}
          type="button"
          className="btn-ghost btn-sm"
          style={{ flex: 1, padding: "4px 0", color: "var(--accent)", background: "var(--surface-2)", borderRadius: 8 }}
          onClick={() => onPick(max * f)}
        >
          {t("swap.pctMax", { pct: lbl })}
        </button>
      ))}
      <button
        type="button"
        className="btn-ghost btn-sm"
        style={{ flex: 1, padding: "4px 0", color: "var(--accent)", background: "var(--surface-2)", borderRadius: 8 }}
        onClick={() => onPick(max)}
      >
        {t("swap.max")}
      </button>
    </div>
  );
}

/** Severity colour for a price-impact fraction (0..1): green / neutral / amber
 *  / red. Used both for the value text and to escalate the warning. */
function impactColor(impact: number, high: boolean): string {
  if (high || impact >= 0.06) return "#f87171";
  if (impact >= 0.03) return "#fbbf24";
  if (impact >= 0.01) return "var(--text)";
  return "#34d399";
}

/** The ONE consolidated cost disclosure — identical on step-1 and review.
 *  Collapsed: "Fees ≈ $X ▾". Expanded: liquidity fee %, price impact %, network
 *  fee BNB (≈$). All three live here so cost reads the same in both places. */
function FeesDisclosure({
  t, open, onToggle, totalUsd, feePct, impactPct, impactColorVal, netFeeBnb, netFeeUsd,
}: {
  t: (k: import("../../lib/i18n").MsgKey, p?: Record<string, string | number>) => string;
  open: boolean;
  onToggle: () => void;
  totalUsd: number | null;
  feePct: string;
  impactPct: string | null;
  impactColorVal?: string;
  netFeeBnb: string | null;
  netFeeUsd: string | null;
}) {
  const total = usdStr(totalUsd);
  return (
    <div style={{ marginTop: 2, marginBottom: 4 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", background: "none", border: 0, padding: "4px 0", cursor: "pointer", font: "inherit", color: "var(--text-faint)", fontSize: 13 }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("swap.fees")}
          <span style={{ display: "inline-grid", placeItems: "center", width: 14, height: 14, borderRadius: 999, border: "1px solid var(--text-faint)", fontSize: 9.5, fontWeight: 700, lineHeight: 1 }}>?</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text)", fontWeight: 600 }}>
          {total != null ? t("swap.feesValue", { usd: total }) : "—"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform .18s", transform: open ? "rotate(180deg)" : "none", color: "var(--text-faint)" }}><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: "10px 12px", borderRadius: 10, background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
            <span style={{ color: "var(--text-faint)" }}>{t("swap.liquidityFee")}</span>
            <span>{feePct}%</span>
          </div>
          {impactPct != null && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
              <span style={{ color: "var(--text-faint)" }}>{t("swap.priceImpact")}</span>
              <span style={{ color: impactColorVal }}>{impactPct}%</span>
            </div>
          )}
          {netFeeBnb != null && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
              <span style={{ color: "var(--text-faint)" }}>{t("swap.networkFee")}</span>
              <span>{netFeeBnb} BNB{netFeeUsd != null ? ` (≈ $${netFeeUsd})` : ""}</span>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5, marginTop: 2 }}>{t("swap.feeBreakdownInfo")}</div>
        </div>
      )}
    </div>
  );
}
