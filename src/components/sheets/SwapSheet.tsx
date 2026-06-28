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
import { copyText } from "../../lib/clipboard";
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
import { usePrice, useBnbUsd, getBlockHeight } from "../../lib/market";
import { derivePhase, formatEta } from "../../lib/swapPhase";
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
  /** Sell (lock on EXFER): block height at which the refund unlocks. */
  exfer_timeout_height?: number | null;
  /** Buy (lock on BSC): unix seconds at which the refund unlocks. */
  bsc_timeout_sec?: number | null;
  /** Unix seconds — when the swap record was created / last touched. */
  created_at?: number | null;
  updated_at?: number | null;
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
  const { t, lang } = useT();
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
  // Two-way amount binding: `amount` (the pay side) is canonical and drives the
  // quote. When the user types into the RECEIVE field instead, editSide flips to
  // "receive", recvInput holds what they typed, and an effect back-computes the
  // pay `amount` from it. Editing the pay side (or a % chip) flips back.
  const [editSide, setEditSide] = useState<"pay" | "receive">("pay");
  const [recvInput, setRecvInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the From-address balances fresh while the sheet is open. suspendPolling()
  // (above) pauses the AUTO-poll so a broadcast isn't raced — but that also froze
  // the From-address dropdown, so a deposit/withdrawal wouldn't show for ages.
  // refresh() forces a load even while suspended, so poll it ourselves (paused
  // during a broadcast via `busy`).
  useEffect(() => {
    if (busy) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(id);
  }, [busy, refresh]);
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
  // Reverse binding: when the user types a desired RECEIVE amount, back-compute
  // the pay `amount` (constant-product inverse + the network fee) so the rest of
  // the sheet — quote, USD, Review — works off `amount` as usual.
  useEffect(() => {
    if (editSide !== "receive" || !poolInfo) return;
    const want = Number(recvInput);
    if (!isFinite(want) || want <= 0) { setAmount(""); return; }
    const reserveIn = sell ? poolInfo.exferReserve : poolInfo.bnbReserve;
    const reserveOut = sell ? poolInfo.bnbReserve : poolInfo.exferReserve;
    // Gross output the AMM must produce to NET `want`: a sell nets BNB (the fee
    // is taken from the BNB output), a buy receives EXFER (the fee is on the BNB
    // input, added below).
    const grossOut = sell ? want + estNetFee : want;
    if (!(reserveIn > 0 && reserveOut > 0) || grossOut >= reserveOut) return; // too big — leave the typed value
    // Uniswap-v2 inverse: input needed for a desired output, incl. the 30bps fee.
    const inHuman = (reserveIn * grossOut) / ((reserveOut - grossOut) * (1 - poolInfo.feeBps / 10_000));
    const payHuman = sell ? inHuman : inHuman + estNetFee; // buy pays the fee on the BNB it sends
    setAmount(payHuman > 0 && isFinite(payHuman) ? sigFmt(payHuman, 8) : "");
  }, [editSide, recvInput, poolInfo, sell, estNetFee]);
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
  // Sell-side Max holds back a little EXFER for the lock transaction's OWN fee.
  // Paying out the entire balance left nothing to cover it, so the lock couldn't
  // be built and Max read as "insufficient fee" (EXFER fees are tiny at
  // FEE_RATE=1, so 0.05 is a generous-but-negligible cushion). Buy-side already
  // holds back BNB gas via buyMax.
  const SELL_FEE_HOLD_EXFER = 0.05;
  const payMax = sell ? Math.max(0, sendBal / 1e8 - SELL_FEE_HOLD_EXFER) : buyMax;

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
  // The "Fees ≈ $X" chip = ONLY the money that actually leaves the user: the
  // liquidity fee (to the pool) + the on-chain network fee. Price impact is NOT a
  // fee — no one collects it; it's slippage baked into the rate by the pool's
  // depth — so it's shown on its own line and never summed in here.
  const netFeeUsd = bnbUsd != null && netFeeBnb > 0 ? netFeeBnb * bnbUsd : null;
  const liqFeeUsd = (() => {
    if (!poolInfo || sendUsd == null) return null;
    return sendUsd * (poolInfo.feeBps / 10_000);
  })();
  const feesTotalUsd = (() => {
    const parts = [liqFeeUsd, netFeeUsd].filter((x): x is number => x != null);
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
        // v2 (reversed) flow: the pool locks first; the user locks once and can
        // leave, and the pool settles both legs. Requires a v2-capable walletd.
        flow: "v2",
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
        flow: "v2",
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
    // Editing always restarts from the pay side after a flip, so the stale
    // receive input from the old direction doesn't drive the new one.
    setEditSide("pay");
    setRecvInput("");
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
      // Snapshot the REALIZED EXFER/USD for THIS swap (amount_out/amount_in ×
      // BNB/USD), not the pool mid — so the history detail reconciles with the
      // on-chain BNB actually received. Sell: BNB out per EXFER in; buy: BNB in
      // per EXFER out. Falls back to the mid only if the quote rate is unusable.
      const exIn = Number(quote.amount_in);
      const exOut = Number(quote.amount_out);
      const rRate = exIn > 0 && exOut > 0 ? (sell ? exOut / exIn : exIn / exOut) : null;
      const realizedUsd = rRate != null && bnbUsd != null ? rRate * bnbUsd : exferUsd;
      if (realizedUsd != null) recordSwapUsd(quote.swap_id, realizedUsd);
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
      // Ping the swap-changed listeners so Home's "{amt} EXFER in an active
      // swap" line clears immediately instead of on the next poll tick.
      notifySwapChanged();
      toast.success(t("swap.refundedTitle"), "");
    } catch (e) {
      // A failed refund ATTEMPT is not a failed swap — the dominant case is the
      // HTLC timelock simply not having elapsed yet (humanized separately).
      toast.error(t("swap.refundFailedTitle"), humanizeError(e));
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

  // Swap age on the progress screen, for a "taking longer than usual" hint.
  // Anchored to the record's created_at (fallback: mount time) so reopening
  // the sheet doesn't reset the clock — a resumed 10-minute-old swap is 10
  // minutes old, not 0s. The 1s tick also drives the derived-phase clock and
  // the unmatched auto-refund countdown below.
  const createdAtMs = live?.created_at ? live.created_at * 1000 : null;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (step !== 3) return;
    const t0 = createdAtMs ?? Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [step, createdAtMs]);

  // EXFER tip height — needed only to turn a sell's refund timeout HEIGHT into
  // seconds for the unmatched countdown. Polled lazily (~30s) and only while
  // the swap could need it (a sell sitting in user_locked); buys carry a plain
  // unix timeout. Unavailable (null) degrades the copy to "a few hours".
  const [chainHeight, setChainHeight] = useState<number | null>(null);
  const needHeight =
    step === 3 && live?.status === "user_locked" && live?.direction === "exfer_to_bnb";
  useEffect(() => {
    if (!needHeight) return;
    let cancelled = false;
    const tick = () => {
      void getBlockHeight().then((h) => {
        if (!cancelled && h != null) setChainHeight(h);
      });
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [needHeight]);

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
      catch { copyText("support@exfer.dev"); toast.info(t("act.explorerCopied"), "support@exfer.dev"); }
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
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
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
                  onChange={(e) => { setEditSide("pay"); setAmount(e.target.value); }}
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
            <PercentChips max={payMax} onPick={(v) => { setEditSide("pay"); setAmount(sigFmt(v, 8)); }} t={t} />
            {/* Caption the Max hold-back so it doesn't look like a shortfall. */}
            {!sell && buyMax > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>{t("swap.maxGasHold")}</div>
            )}
            {sell && payMax > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 6 }}>{t("swap.maxFeeHoldExfer")}</div>
            )}
          </div>

          {/* Reverse — sewn onto the seam between the two cards: a zero-height row
              so the cards stay tight together (just the 4px gap), with the button
              centered ON the seam line, straddling both edges. */}
          <div style={{ position: "relative", height: 0, zIndex: 2 }}>
            <button
              type="button"
              aria-label={t("swap.reverse")}
              onClick={reverse}
              style={{
                position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                width: 30, height: 30, borderRadius: 999,
                display: "grid", placeItems: "center", cursor: "pointer",
                background: "var(--elevated)", border: "1px solid var(--border)",
                color: "var(--text)", boxShadow: "var(--shadow)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4v14M7 4L4 7M7 4l3 3M17 20V6m0 14l3-3m-3 3l-3-3" />
              </svg>
            </button>
          </div>

          <div className="swap-leg">
            <span className="eyebrow">{t("swap.youReceiveEst")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {/* Editable: type a desired receive amount and the pay side is
                    back-computed (the reverse-binding effect above). When editing
                    the pay side, it shows the live net estimate. */}
                <input
                  className="swap-amount"
                  style={{ width: "100%" }}
                  inputMode="decimal"
                  placeholder="0.0"
                  disabled={needsFunding || noExferToSell}
                  value={editSide === "receive" ? recvInput : (estOutNet != null ? sigFmt(estOutNet, 6) : "")}
                  onChange={(e) => { setEditSide("receive"); setRecvInput(e.target.value); }}
                />
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
    // Realized price impact = how far the FIRM amount_out sits below what the pool
    // mid implies for this amount_in (mid × in for a sell, in / mid for a buy).
    // This is what the user actually pays, vs the reserve-fraction `priceImpact`
    // (raw mid) which can read far lower than reality when the firm quote is
    // depressed (e.g. by another swap's reservation). Clamp at 0 — a quote better
    // than mid isn't a cost.
    const midOut = poolInfo && poolInfo.mid > 0 ? (sell ? qIn * poolInfo.mid : qIn / poolInfo.mid) : null;
    const realizedImpact = midOut != null && midOut > 0 && qOut > 0 ? Math.max(0, 1 - qOut / midOut) : null;
    // Prefer the realized impact on Review; fall back to the reserve-fraction one.
    const reviewImpact = realizedImpact ?? priceImpact;
    // Estimate-vs-firm divergence guard. estOutNet is the step-1 mid-based net
    // estimate the user was shown BEFORE quoting; qOut is the firm quote. When the
    // firm quote lands materially below the estimate, the user is about to receive
    // noticeably less than promised — make it impossible to miss and require an
    // explicit ack (like a high-impact trade), rather than a silently smaller
    // number under a biometric prompt that only names the SEND amount.
    const estForQuote = estOutNet;
    const quoteShortfall = estForQuote != null && estForQuote > 0 && qOut > 0 ? Math.max(0, 1 - qOut / estForQuote) : 0;
    const quoteDiverged = quoteShortfall >= 0.03; // firm quote >3% below the estimate
    // USD totals — value each leg at its MARKET price (EXFER at the market mid,
    // BNB at spot), NOT the post-fee effective rate. The gap between the two is
    // the fees (shown below). Using the effective rate made "You send 145 EXFER"
    // read its post-fee value ($0.028) instead of its real ~$0.15 market worth.
    const sendUsdR = sell ? (exferUsd != null ? qIn * exferUsd : null) : (bnbUsd != null ? qIn * bnbUsd : null);
    const recvUsdR = sell ? (bnbUsd != null ? qOut * bnbUsd : null) : (exferUsd != null ? qOut * exferUsd : null);
    // Fees total in USD, mirroring step-1 (item [4]).
    const liqFeeUsdR = sendUsdR != null && typeof quote.fee_bps === "number" ? sendUsdR * (quote.fee_bps / 10_000) : (sendUsdR != null && poolInfo ? sendUsdR * (poolInfo.feeBps / 10_000) : null);
    const feesTotalUsdR = (() => {
      const parts = [liqFeeUsdR, netFeeUsd].filter((x): x is number => x != null);
      return parts.length ? parts.reduce((s, x) => s + x, 0) : null;
    })();
    const feePctR = sigFmt(((typeof quote.fee_bps === "number" ? quote.fee_bps : poolInfo?.feeBps ?? 0) / 100), 2);
    // Countdown styling. `expired` is the backstop for a FAILED in-place
    // re-quote (the countdown normally refreshes itself just before expiry):
    // the quote is truly stale, so Confirm is disabled until a fresh one lands.
    const left = quoteLeft;
    const lowTime = left != null && left <= 10;
    const expired = left != null && left <= 0 && !requoting;
    const sendUsdStr = usdStr(sendUsdR);
    const recvUsdStr = usdStr(recvUsdR);
    return (
      <>
      <Sheet
        title={t("swap.review")}
        onClose={onClose}
        onBack={() => setStep(1)}
        footer={
          <button className="btn btn-block" disabled={busy || requoting || !confirmArmed || (quoteDiverged && !impactAck) || expired} onClick={() => void doExecute()}>
            {busy || requoting ? <Spinner /> : t("swap.confirm")}
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label={t("swap.youSend")} value={`${fmtAmt(quote.amount_in)} ${sendUnit}${sendUsdStr ? ` ($${sendUsdStr})` : ""}`} />
          <Row label={t("swap.youReceive")} value={`${fmtAmt(quote.amount_out)} ${recvUnit}${recvUsdStr ? ` ($${recvUsdStr})` : ""}`} strong />

          {/* Price line = the EFFECTIVE per-EXFER price THIS quote settles at
              (qExferUsd, derived from amount_out/amount_in), NOT the pool mid. The
              mid was internally inconsistent with the firm receive amount — price ×
              amount_in must reconcile with amount_out. The market mid is shown
              alongside as a reference so the user sees how far execution is from
              spot. The firm-HTLC "you receive == what arrives, or it's refunded"
              guarantee is stated once in the note below. */}
          {qExferUsd != null && (
            <Row
              label={t("swap.priceLabel")}
              value={
                exferUsd != null && exferUsd > 0
                  ? t("swap.priceEffVsMid", { eff: sigFmt(qExferUsd, 4), mid: sigFmt(exferUsd, 4) })
                  : `1 EXFER ≈ $${sigFmt(qExferUsd, 4)}`
              }
            />
          )}

          {/* Price impact — always in the breakdown once it's computable
              (muted normally, severity-coloured past the warning thresholds),
              with the same "?" affordance as step-1. */}
          {poolInfo != null && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: reviewImpact >= 0.03 || highImpact ? impactColor(reviewImpact, highImpact) : "var(--text-faint)" }}>
                <span>{t("swap.priceImpactLine", { pct: `${(reviewImpact * 100).toFixed(2)}%` })}</span>
                <HelpDot open={impactHelpOpen} onClick={() => setImpactHelpOpen((o) => !o)} />
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
              re-quotes IN PLACE; if that refresh failed the quote is truly
              stale, so say so (amber) and keep Confirm disabled (footer). */}
          {left != null && (expired ? (
            <div style={{ color: "#fbbf24", fontSize: 12.5, lineHeight: 1.5 }}>{t("swap.quoteExpired")}</div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: lowTime ? 600 : 400, color: lowTime ? "#fbbf24" : "var(--text-faint)" }}>
                {t("swap.quoteValidFor", { t: mmss(left) })}
              </span>
              {requoting && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-faint)" }}><Spinner size={12} /> {t("swap.requoting")}</span>}
            </div>
          ))}

          {/* Firm quote landed materially below the step-1 estimate — the user is
              about to receive less than they were shown (e.g. the rate moved or
              another swap's reservation depressed the pool while they were
              quoting). Hard-to-miss, and requires an explicit ack before Confirm
              (reuses impactAck). Suppressed when highImpact already shows its own
              ack block below — both bind the same impactAck so arming stays
              consistent and the user never faces two competing checkboxes. */}
          {quoteDiverged && !highImpact && (
            <div className="banner banner-warn" style={{ marginTop: 2, fontSize: 12.5, lineHeight: 1.55, display: "flex", flexDirection: "column", gap: 8 }}>
              <span>
                {t("swap.quoteDiverged", {
                  pct: String(Math.round(quoteShortfall * 100)),
                  got: `${fmtAmt(quote.amount_out)} ${recvUnit}`,
                  est: `${sigFmt(estForQuote ?? 0, 6)} ${recvUnit}`,
                })}
              </span>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontWeight: 600 }}>
                <input type="checkbox" checked={impactAck} onChange={(e) => setImpactAck(e.target.checked)} style={{ marginTop: 2 }} />
                <span>{t("swap.quoteDivergedAck")}</span>
              </label>
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
  // The DERIVED phase (src/lib/swapPhase.ts) — never fabricate a status while
  // the record is still loading, and treat "user_locked past the quote expiry"
  // as unmatched-awaiting-auto-refund instead of a stuck "matching" bar. The 1s
  // `elapsed` tick above re-renders this, keeping nowSec and the countdown live.
  const nowSec = Math.floor(Date.now() / 1000);
  const phase = derivePhase(live, nowSec, chainHeight);
  const s = live?.status ?? "";
  const inUnit = live?.direction === "exfer_to_bnb" ? "EXFER" : "BNB";
  const outUnit = live?.direction === "exfer_to_bnb" ? "BNB" : "EXFER";
  const amounts = live ? `${fmtAmt(live.amount_in)} ${inUnit} → ${fmtAmt(live.amount_out)} ${outUnit}` : "";
  const terminal = ["completed", "refunded", "failed"].includes(s);
  const swapId = live?.swap_id ?? watchId ?? "";

  // Resumed swap, record not loaded yet: a minimal reading state — NOT a
  // fabricated "step 1 of 3" stepper for a swap whose status we don't know.
  if (phase.kind === "loading") {
    return (
      <Sheet title={t("swap.submittedTitle")} onClose={onClose}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "44px 0" }}>
          <Spinner size={22} />
          <div style={{ color: "var(--text-faint)", fontSize: 13 }}>{t("swap.loadingStatus")}</div>
        </div>
      </Sheet>
    );
  }

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

  // Unmatched / refundable: the quote expired and the pool never took the other
  // side. This is a DIFFERENT destination, not a stalled progress bar — no
  // stepper, no spinner. Funds are locked on-chain and return automatically at
  // the HTLC timeout; before that timeout a manual refund is protocol-impossible,
  // so the refund button exists ONLY once the timeout has passed (refundable).
  if (phase.kind === "unmatched" || phase.kind === "refundable") {
    const eta =
      phase.kind === "unmatched" && phase.etaSec != null
        ? formatEta(phase.etaSec, lang)
        : phase.kind === "refundable"
          // Timeout passed — but never fabricate a minutes figure: the refund
          // broadcast can retry for a while, so promise "any moment", not "~1 min".
          ? t("swap.etaMoments")
          : t("swap.etaFewHours");
    return (
      <Sheet
        title={t("swap.unmatchedTitle")}
        onClose={closeSettling}
        footer={<button className="btn btn-block" onClick={closeSettling}>{t("swap.closeKeepSettling")}</button>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "14px 0 4px" }}>
          {amounts && (
            <div style={{ textAlign: "center", fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>{amounts}</div>
          )}
          <div style={{ color: "var(--text-dim)", fontSize: 13, lineHeight: 1.6, textAlign: "center" }}>
            {t("swap.unmatchedBody", { eta })}
          </div>
          {phase.kind === "unmatched" ? (
            // Live countdown to the automatic refund — this line is the
            // destination; there is no button to press before the timeout.
            <div style={{ textAlign: "center", fontSize: 14, fontWeight: 600 }}>
              {t("swap.autoRefundIn", { eta })}
            </div>
          ) : (
            <>
              <div style={{ textAlign: "center", fontSize: 13, color: "var(--text-dim)" }}>
                {t("swap.refundingAuto")}
              </div>
              <button className="btn-ghost btn-sm" style={{ alignSelf: "center" }} disabled={busy} onClick={manualRefund}>
                {busy ? <Spinner size={13} /> : t("swap.refundNow")}
              </button>
            </>
          )}
          <TxRefs rec={live} t={t} onCopied={onRefCopied} />
        </div>
      </Sheet>
    );
  }

  // In-progress (matching / settling): a 3-step checklist so "in progress"
  // reads as measurable forward motion, not an endless spinner.
  const doneCount = phase.kind === "settling" ? 2 : 1;
  const stepLabels = [t("swap.stepLocked"), t("swap.stepMatched"), t("swap.stepSettling")];
  // Raised threshold (item [9]): a healthy swap is ~60s and can run to ~2 min on
  // a slow block. Don't cry "taking long" until ~165s so the happy path never
  // looks broken.
  const stuck = elapsed > 165;
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

        {/* horizontal staged stepper — shared with the liquidity flow. The
            active step already says what's happening, so no verbose "Confirming
            on BNB Chain… / about Ns left" status lines below it. */}
        <StagedStepper labels={stepLabels} doneCount={doneCount} />

        <div style={{ color: "var(--text-faint)", fontSize: 12.5, textAlign: "center", lineHeight: 1.5 }}>
          {t("swap.safeToClose")}
        </div>

        {/* Per-leg explorer links once they land (item [10]). */}
        <TxRefs rec={live} t={t} onCopied={onRefCopied} />

        {stuck && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ color: "#fbbf24", fontSize: 12, textAlign: "center" }}>{t("swap.takingLong")}</div>
            {/* No refund button here: before the HTLC timeout a refund is
                protocol-impossible (it only toasted a failure). The unmatched
                panel above takes over once the quote expires unmatched, and the
                manual refund appears only in its refundable state. For a stuck
                settling swap (the pool is mid-claim), offer the swap ID + Help. */}
            {phase.kind === "settling" && swapId && (
              <SwapIdHelp swapId={swapId} t={t} onCopied={onRefCopied} onHelp={openHelp} />
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
    copyText(url);
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
        onClick={() => { copyText(swapId); onCopied(swapId); }}
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
 *  Collapsed: "Fees ≈ $X ▾". Expanded: liquidity fee %, network fee BNB (≈$).
 *  Price impact is NOT here — it's not a fee; it has its own dedicated line
 *  above this disclosure on both step-1 and review. */
function FeesDisclosure({
  t, open, onToggle, totalUsd, feePct, netFeeBnb, netFeeUsd,
}: {
  t: (k: import("../../lib/i18n").MsgKey, p?: Record<string, string | number>) => string;
  open: boolean;
  onToggle: () => void;
  totalUsd: number | null;
  feePct: string;
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
