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
  /** The EXFER leg went out but the BNB leg failed: the deposit can't complete
   *  and is headed for the pool's expiry auto-refund. The in-flight row says
   *  so instead of pretending the add is still progressing. */
  partial?: boolean;
}

const KEY = "exfer-inflight-lp";
// Backstop so a crashed/abandoned flow never lingers forever. Adds are normally
// removed the moment their status goes terminal (the status poll is the real
// cleanup) — the TTL only catches strays, so it must be generous: a slow
// deposit that's still pending must not silently vanish from "In progress".
const MAX_AGE: Record<LpOp["kind"], number> = { add: 60 * 60_000, remove: 60_000 };

function readRaw(): LpOp[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeRaw(ops: LpOp[], notify = true): void {
  try { localStorage.setItem(KEY, JSON.stringify(ops)); } catch { /* ignore */ }
  if (notify) {
    try { window.dispatchEvent(new Event("inflight-lp")); } catch { /* ignore */ }
  }
}

/** Active ops. Entries past their TTL are DELETED from storage, not just
 *  hidden — otherwise the localStorage list grows without bound. The prune is
 *  silent (no change event): the dropped entries were already invisible, and
 *  this is called from render paths where a synchronous notify could re-enter. */
export function getLpOps(): LpOp[] {
  const now = Date.now();
  const all = readRaw();
  const live = all.filter((o) => o && o.id && now - o.startedAt < (MAX_AGE[o.kind] ?? 60_000));
  if (live.length !== all.length) writeRaw(live, false);
  return live;
}
export function addLpOp(op: LpOp): void {
  writeRaw([...readRaw().filter((o) => o.id !== op.id), op]);
}
export function markLpOpPartial(id: string): void {
  writeRaw(readRaw().map((o) => (o.id === id ? { ...o, partial: true } : o)));
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
