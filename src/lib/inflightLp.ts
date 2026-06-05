// In-progress liquidity operations, tracked locally so the Swap tab's "in
// progress" list can show LP adds/removes alongside swaps — and so they survive
// the user closing the liquidity sheet mid-flow (the deposit finishes in the
// background). Adds are removed when their on-chain status goes terminal;
// removes (no per-id status endpoint, settle in seconds) fall off by a TTL.

export interface LpOp {
  id: string;
  kind: "add" | "remove";
  exfer: string; // human amount for display
  bnb: string;   // human amount for display
  startedAt: number;
}

const KEY = "exfer-inflight-lp";
// Backstop so a crashed/abandoned flow never lingers forever. Adds are normally
// removed the moment their status goes terminal; this only catches the strays.
const MAX_AGE: Record<LpOp["kind"], number> = { add: 10 * 60_000, remove: 60_000 };

function readRaw(): LpOp[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeRaw(ops: LpOp[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ops)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event("inflight-lp")); } catch { /* ignore */ }
}

/** Active ops, with stale entries (by age) filtered out for display. */
export function getLpOps(): LpOp[] {
  const now = Date.now();
  return readRaw().filter((o) => o && o.id && now - o.startedAt < (MAX_AGE[o.kind] ?? 60_000));
}
export function addLpOp(op: LpOp): void {
  writeRaw([...readRaw().filter((o) => o.id !== op.id), op]);
}
export function removeLpOp(id: string): void {
  writeRaw(readRaw().filter((o) => o.id !== id));
}
/** Subscribe to changes — same-tab custom event + cross-tab storage event. */
export function onLpOpsChange(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener("inflight-lp", h);
  window.addEventListener("storage", h);
  return () => {
    window.removeEventListener("inflight-lp", h);
    window.removeEventListener("storage", h);
  };
}

/** Ping when a swap is just executed so the in-progress list refreshes NOW
 *  instead of waiting for the next poll tick (the swap card otherwise appears
 *  up to a full interval late after you close the sheet). */
export function notifySwapChanged(): void {
  try { window.dispatchEvent(new Event("inflight-swap")); } catch { /* ignore */ }
}
export function onSwapChanged(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener("inflight-swap", h);
  return () => window.removeEventListener("inflight-swap", h);
}
