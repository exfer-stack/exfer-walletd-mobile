// Local record of the EXFER/USD spot price at the moment a swap was executed.
// walletd's swap journal stores the on-chain amounts but no fiat — the price
// feed lives only in the app — so to show "what this was worth then" we snapshot
// the spot price here, keyed by swap_id, at execute time.
//
// Best-effort and per-device: a swap made on another device (or before this
// existed) simply won't have an entry, and the detail sheet hides those rows.

const KEY = "exfer-swap-usd";

type Store = Record<string, number>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

/** Snapshot the EXFER/USD spot for a swap (first write wins — the execute-time
 *  price is the one we want, not a later re-render's). */
export function recordSwapUsd(swapId: string, usdPerExfer: number): void {
  if (!swapId || !isFinite(usdPerExfer) || usdPerExfer <= 0) return;
  try {
    const s = read();
    if (s[swapId]) return;
    s[swapId] = usdPerExfer;
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage disabled/full — the row just won't show */
  }
}

/** The recorded EXFER/USD spot for a swap, or null if we never captured it. */
export function getSwapUsd(swapId: string): number | null {
  const v = read()[swapId];
  return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
}
