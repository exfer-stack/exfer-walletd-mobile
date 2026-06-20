// Persistent local log of broadcast transfers. walletd doesn't track
// per-wallet tx history, so we keep one client-side.

import type { TransferReceipt } from "./types";
import { addressKey } from "./address";

const HISTORY_KEY = "exfer-walletd-desktop-history-v1";
const RECENT_RECIPS_KEY = "exfer-walletd-desktop-recents-v1";

export interface HistoryEntry {
  // Omitted on older entries → treated as "sent" (back-compat).
  kind?: "sent" | "received";
  tx_id: string;
  fee: number;
  size: number;
  inputs: TransferReceipt["inputs"];
  outputs: TransferReceipt["outputs"];
  built_at_height: number;
  // ISO timestamp when we broadcast (sent) or first saw the credit (received).
  broadcast_at: string;
  // Credited amount, set on "received" entries — the value the crediting tx
  // pays this wallet (sum of its outputs to our addresses).
  amount?: number;
}

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function save(v: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(v));
}

export function listHistory(): HistoryEntry[] {
  // Newest first.
  return load().sort((a, b) =>
    a.broadcast_at < b.broadcast_at ? 1 : -1,
  );
}

export function appendHistory(receipt: TransferReceipt) {
  const entries = load();
  entries.push({
    tx_id: receipt.tx_id,
    fee: receipt.fee,
    size: receipt.size,
    inputs: receipt.inputs,
    outputs: receipt.outputs,
    built_at_height: receipt.built_at_height,
    broadcast_at: new Date().toISOString(),
  });
  save(entries);
}

/** Remove a broadcast record by tx_id. Used to silently prune a transfer the
 *  network dropped — never confirmed AND gone from every mempool (the node
 *  reports it as unknown) — so it stops reappearing in Activity as a zombie
 *  "in mempool" row. No-op if the tx_id isn't recorded. */
export function dropHistory(tx_id: string) {
  const before = load();
  const after = before.filter((e) => e.tx_id !== tx_id);
  if (after.length !== before.length) save(after);
}

/** Log an inbound deposit. The caller resolves the REAL crediting tx id from
 *  walletd's `get_address_mempool`, so a received row carries a true on-chain
 *  id — its explorer link, status confirmation, and copyable id all work, the
 *  same as a sent row. `address` (the credited address) is recorded as the
 *  output so the detail sheet can show where the funds landed.
 *
 *  Dedupes by `tx_id`: a mempool tx is seen on several polls before it
 *  confirms, and we only want one row per deposit. Returns true when a new
 *  row was added, false when this tx was already logged.
 *
 *  When the real id can't be resolved (a deposit that confirmed between polls,
 *  or a node too old for `get_address_mempool`), the caller passes a synthetic
 *  `recv-…` id so the deposit still appears in Activity. */
export function recordReceived(rx: {
  tx_id: string;
  amount: number;
  address?: string;
  broadcast_at?: string;
}): boolean {
  const entries = load();
  if (entries.some((e) => e.tx_id === rx.tx_id)) return false;
  entries.push({
    kind: "received",
    tx_id: rx.tx_id,
    fee: 0,
    size: 0,
    inputs: [],
    outputs: rx.address
      ? [{ to: rx.address, amount: rx.amount, is_change: false }]
      : [],
    built_at_height: 0,
    broadcast_at: rx.broadcast_at ?? new Date().toISOString(),
    amount: rx.amount,
  });
  save(entries);
  return true;
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(TXSTATUS_KEY);
}

// Cache of confirmed transactions. Once a tx is mined into a block its
// height is final (barring a deep reorg, which we don't surface), so we
// persist it. The Activity page seeds from this on mount instead of
// re-querying the node for every old transfer — which is what made
// already-confirmed rows flash back to "checking" on each visit.
const TXSTATUS_KEY = "exfer-walletd-desktop-txstatus-v1";

export interface ConfirmedTx {
  block_height: number;
  block_id?: string;
}

export function loadConfirmed(): Record<string, ConfirmedTx> {
  try {
    const raw = localStorage.getItem(TXSTATUS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, ConfirmedTx>) : {};
  } catch {
    return {};
  }
}

export function rememberConfirmed(
  tx_id: string,
  block_height: number,
  block_id?: string,
) {
  const m = loadConfirmed();
  m[tx_id] = { block_height, block_id };
  localStorage.setItem(TXSTATUS_KEY, JSON.stringify(m));
}

// Recent recipient addresses (for the Send page's quick-pick).
const MAX_RECENT = 12;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_RECIPS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function listRecentRecipients(): string[] {
  return loadRecents();
}

export function rememberRecipient(address: string) {
  // Dedup by canonical key so the same recipient entered once as hex and once
  // as bech32m doesn't appear twice; keep the most recent spelling for display.
  const key = addressKey(address);
  let v = loadRecents().filter((a) => addressKey(a) !== key);
  v.unshift(address);
  if (v.length > MAX_RECENT) v = v.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_RECIPS_KEY, JSON.stringify(v));
}
