// Derived UI state machine for a cross-chain swap. walletd's raw `status` is
// the protocol's view; the UI needs an honest phase on top of it. The key
// insight (from a production incident): `user_locked` long past the quote's
// expiry is NOT "matching" — the pool never took the other side, and the only
// remaining destination is the automatic HTLC refund at the timeout. Rendering
// it as a stuck progress bar (with a refund button that can't work yet) lied
// twice. This module derives the real phase, pure and testable.

import type { Lang } from "./i18n";

/** Grace after the quote expiry before we call a swap "unmatched" — mirrors
 *  the pool's reported-lock confirmation grace (it may still match a lock it
 *  saw just before expiry). */
export const GRACE_SEC = 15 * 60;

/** EXFER block target, for converting a timeout height into seconds. */
export const EXFER_BLOCK_SEC = 10;

/** The subset of walletd's SwapRecord (serde snake_case) the phase needs. */
export interface SwapPhaseRec {
  status: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  /** Unix seconds when the firm quote stops being honored by the pool. */
  expires_at?: number | null;
  /** Sell (lock on EXFER): block height at which the refund unlocks. */
  exfer_timeout_height?: number | null;
  /** Buy (lock on BSC): unix seconds at which the refund unlocks. */
  bsc_timeout_sec?: number | null;
}

export type SwapPhase =
  | { kind: "loading" }
  /** v2 BUY only: we committed and the pool is fronting its EXFER lock; the
   *  daemon will lock our BNB on its own. Nothing of ours is locked yet, so this
   *  is a distinct PRE-lock phase — it must NOT render the "Locked your BNB"
   *  stepper node (that would lie). The user can already close the app. */
  | { kind: "committing" }
  | { kind: "matching" }
  | { kind: "settling" }
  /** Quote expired unmatched; funds locked until the HTLC timeout. etaSec is
   *  seconds until the automatic refund unlocks (null = unknown → "a few
   *  hours" copy). */
  | { kind: "unmatched"; etaSec: number | null }
  /** The HTLC timeout has passed: the refund is possible NOW (the daemon's
   *  monitor does it automatically; a manual button is also honest here). */
  | { kind: "refundable" }
  | { kind: "refunding" }
  | { kind: "completed" }
  | { kind: "refunded" }
  | { kind: "failed" };

/** Seconds until this swap's locked funds can be reclaimed (<= 0 means the
 *  timeout has passed). Sell locks on EXFER, so the timeout is a block height
 *  and needs the current tip; buy locks on BSC, a plain unix timestamp.
 *  Returns null when the figure can't be computed (no tip height / field
 *  missing) — copy degrades to "a few hours". */
export function refundEta(
  rec: SwapPhaseRec,
  nowSec: number,
  chainHeight: number | null,
): number | null {
  if (rec.direction === "exfer_to_bnb") {
    if (chainHeight == null || rec.exfer_timeout_height == null) return null;
    return (rec.exfer_timeout_height - chainHeight) * EXFER_BLOCK_SEC;
  }
  if (rec.bsc_timeout_sec == null) return null;
  return rec.bsc_timeout_sec - nowSec;
}

/** Map a swap record (or none yet) to the UI phase. Pure — callers supply the
 *  clock and the EXFER tip height (null when unknown). */
export function derivePhase(
  rec: SwapPhaseRec | null | undefined,
  nowSec: number,
  chainHeight: number | null,
): SwapPhase {
  if (rec == null) return { kind: "loading" };
  switch (rec.status) {
    case "committing":
      // v2 BUY: committed, pool fronting its lock, our BNB not locked yet.
      return { kind: "committing" };
    case "completed":
      return { kind: "completed" };
    case "refunded":
      return { kind: "refunded" };
    case "failed":
      return { kind: "failed" };
    case "refunding":
      return { kind: "refunding" };
    case "pool_locked":
    case "claiming":
      return { kind: "settling" };
    case "user_locked": {
      // Within the quote validity (+ grace) the pool may still match.
      const exp = rec.expires_at;
      if (exp == null || nowSec <= exp + GRACE_SEC) return { kind: "matching" };
      const etaSec = refundEta(rec, nowSec, chainHeight);
      if (etaSec == null) return { kind: "unmatched", etaSec: null };
      if (etaSec > 0) return { kind: "unmatched", etaSec };
      return { kind: "refundable" };
    }
    case "quoted":
    default:
      // A quoted record is rarely visible in progress UIs (no funds moved).
      return { kind: "matching" };
  }
}

/** Human ETA — "~3 h 50 min" EN / "约 3 小时 50 分" ZH. Sub-minute clamps to
 *  "~1 min". Interpolated into the {eta} slots of the unmatched copy. */
export function formatEta(sec: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (lang === "zh") {
    if (h > 0) return m > 0 ? `约 ${h} 小时 ${m} 分` : `约 ${h} 小时`;
    return `约 ${Math.max(1, m)} 分钟`;
  }
  if (h > 0) return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
  return `~${Math.max(1, m)} min`;
}
