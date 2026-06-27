// Unified activity feed.
//
// Activity is no longer a fragile client-side capture log that only knows
// about transfers it happened to witness in the mempool. It's now DERIVED
// from authoritative sources and merged by tx_id:
//
//   1. exfer-indexer `get_address_history` (via walletd delegation) — the
//      authoritative CONFIRMED timeline for every one of our addresses, with
//      real tx ids + block heights. Robust to the app being closed: a deposit
//      that landed-and-confirmed while we weren't watching still shows up here,
//      with full detail. This is the source of truth.
//   2. `get_address_mempool` — the live PENDING view per address (incoming and
//      outgoing not yet confirmed), with real tx ids.
//   3. The local broadcast log (history.ts) — kept only because it carries the
//      rich SEND breakdown (exact recipients, fee, change, size) that the
//      per-address indexer rows don't. Used to enrich our own sends and to show
//      a just-broadcast send before the network has seen it.
//
// The indexer wins on status (confirmed > pending), the local log wins on send
// detail. No synthetic placeholder rows: with the indexer, a deposit either has
// a real tx id or it isn't ours.

import { rpc } from "./rpc";
import type {
  AddressHistoryResponse,
  AddressMempoolResponse,
} from "./types";
import {
  dropHistory,
  listHistory,
  loadConfirmed,
  rememberConfirmed,
  type HistoryEntry,
} from "./history";

// walletd `get_transaction` — authoritative per-tx status, straight from the
// node. `in_mempool` true ⇒ still pending; a non-null `block_height` with
// `in_mempool` false ⇒ confirmed. Used to resolve status independently of the
// indexer, which lags the tip (and during its initial back-fill hasn't seen
// recent blocks at all).
interface TxStatusResp {
  in_mempool?: boolean;
  block_height?: number;
  block_id?: string;
}

export interface ActivityItem {
  tx_id: string;
  kind: "received" | "sent";
  /** Received: value credited to our addresses. Sent: value that left the
   *  wallet — the exact recipients-sum when we have the local send record,
   *  else the net outflow (inputs − change) the indexer/mempool implies. */
  amount: number;
  status: "pending" | "confirmed";
  /** Set when confirmed (from the indexer). */
  block_height?: number;
  /** Best-effort ISO timestamp. Only known for transfers we logged locally
   *  (broadcast time / first-seen). Confirmed-only rows from the indexer have
   *  no timestamp — the UI shows the block height instead. */
  ts?: string;
  /** Received: which of our addresses got credited. */
  toAddresses?: string[];
  /** The other party, from the indexer: senders for a received item,
   *  recipients for a sent item. Drives the From/To detail rows natively
   *  (no per-tx re-decode). Empty for pending/mempool rows until indexed. */
  counterparties?: string[];
  /** A coinbase (mining) credit. */
  is_coinbase?: boolean;
  /** Rich local detail for our own sends (recipients, fee, change, size). */
  detail?: HistoryEntry;
  /** Where the authoritative status came from. */
  source: "indexer" | "mempool" | "local";
  /** Set for a native-BNB (BSC) transfer: `tx_id` is a 0x hash, `amount` is in
   *  BNB, and the explorer routes to BscScan. Absent = native EXFER. */
  asset?: "BNB";
  /** BSC chain id for a BNB item, so the UI picks the right explorer base. */
  chainId?: number;
  /** A BNB transfer whose receipt reverted (status "failed"). */
  failed?: boolean;
}

// Per-tx aggregation while merging address-scoped rows into one logical tx.
interface Agg {
  credit: number; // value paid TO our addresses in this tx
  debit: number; // value of our outputs SPENT by this tx
  height?: number;
  toAddresses: Set<string>;
  senders: Set<string>; // counterparties of our OUTPUT (received) rows
  recipients: Set<string>; // counterparties of our INPUT (spent) rows
  is_coinbase: boolean;
}

function aggOf(map: Map<string, Agg>, tx_id: string): Agg {
  let a = map.get(tx_id);
  if (!a) {
    a = {
      credit: 0,
      debit: 0,
      toAddresses: new Set(),
      senders: new Set(),
      recipients: new Set(),
      is_coinbase: false,
    };
    map.set(tx_id, a);
  }
  return a;
}

// One logical item from an aggregate. A tx that spends any of our outputs is a
// SEND (its credits to us are change); otherwise it's a pure RECEIVE.
function itemFromAgg(
  tx_id: string,
  a: Agg,
  status: "pending" | "confirmed",
  source: "indexer" | "mempool",
): ActivityItem {
  const sent = a.debit > 0;
  return {
    tx_id,
    kind: sent ? "sent" : "received",
    amount: sent ? Math.max(a.debit - a.credit, 0) : a.credit,
    status,
    block_height: a.height,
    toAddresses: sent ? undefined : [...a.toAddresses],
    // The other party: recipients of our spend (sent) / senders to us (received).
    counterparties: sent ? [...a.recipients] : [...a.senders],
    is_coinbase: a.is_coinbase,
    source,
  };
}

const HISTORY_PAGE = 200;
const MAX_PAGES = 8; // safety cap: up to 1600 rows/address

// Pull the full (paged) confirmed history for one address from the indexer.
async function addressHistory(address: string) {
  const rows: AddressHistoryResponse["history"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rpc<AddressHistoryResponse>("get_address_history", {
      address,
      limit: HISTORY_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...(r.history ?? []));
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return rows;
}

/** True when the failure is walletd reporting that no indexer is wired up
 *  (-32007 IndexerNotConfigured), so the caller can degrade gracefully to the
 *  mempool + local-log view instead of surfacing an error. */
export function isIndexerUnconfigured(e: unknown): boolean {
  const s = String((e as { message?: string })?.message ?? e);
  return s.includes("-32007") || /indexer.*not.*config/i.test(s);
}

/** True when get_transaction failed because the node positively reports the tx
 *  as unknown ("Transaction not found", -32602) — either straight from the node
 *  or wrapped by walletd ("upstream node returned error code -32602: …"). This
 *  is what tells a dropped/evicted transfer apart from a transient query
 *  failure (leave pending) and from "Method not found" / -32601 (an old node). */
function isTxNotFound(e: unknown): boolean {
  return /transaction not found/i.test(
    String((e as { message?: string })?.message ?? e),
  );
}

export interface BuildResult {
  items: ActivityItem[];
  /** False when the indexer is unreachable / unconfigured — the feed is then
   *  built from mempool + local log only (older, less complete). */
  indexerOk: boolean;
}

// Last-rendered feed, cached so reopening Activity paints instantly instead of
// cold-loading from the indexer every time. Keyed by the address set so a
// different wallet never flashes the previous one's history. It's only a
// first-paint cache — buildActivityFeed still refreshes in the background on
// every open, so the cache going stale is self-correcting.
const FEED_CACHE_KEY = "exfer-activity-feed-v1";

export function loadFeedCache(): { ownKey: string; items: ActivityItem[] } | null {
  try {
    const raw = localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v.ownKey === "string" && Array.isArray(v.items)) {
      return v as { ownKey: string; items: ActivityItem[] };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveFeedCache(ownKey: string, items: ActivityItem[]): void {
  try {
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({ ownKey, items }));
  } catch {
    /* quota / unavailable — caching is best-effort */
  }
}

// walletd `bsc_tx_history` — native-BNB transfers we initiated (currently
// withdrawals). No indexer watches the BSC address, so this local log is the
// only source; statuses are refreshed walletd-side from the on-chain receipt.
interface BnbTxWire {
  hash: string;
  direction: string; // "out"
  from: string;
  to: string;
  amount_wei: string;
  status: string; // "pending" | "confirmed" | "failed"
  created_at: number; // unix seconds
}

async function bnbActivity(): Promise<ActivityItem[]> {
  try {
    const r = await rpc<{ chain_id: number; txs: BnbTxWire[] }>(
      "bsc_tx_history",
    );
    return (r.txs ?? []).map((tx): ActivityItem => {
      const sent = tx.direction !== "in";
      const amount = Number(tx.amount_wei) / 1e18;
      // Treat confirmed AND failed as terminal (out of the pending bucket); the
      // BNB-specific UI renders the precise state from `failed`.
      const terminal = tx.status === "confirmed" || tx.status === "failed";
      return {
        tx_id: tx.hash,
        kind: sent ? "sent" : "received",
        amount,
        status: terminal ? "confirmed" : "pending",
        failed: tx.status === "failed",
        ts: new Date(tx.created_at * 1000).toISOString(),
        counterparties: sent ? [tx.to] : [tx.from],
        toAddresses: sent ? undefined : [tx.to],
        source: "local",
        asset: "BNB",
        chainId: r.chain_id,
      };
    });
  } catch {
    // Swap engine off / not configured — no BNB history to show.
    return [];
  }
}

export async function buildActivityFeed(
  ownAddresses: string[],
): Promise<BuildResult> {
  const byTx = new Map<string, ActivityItem>();
  let indexerOk = true;

  // Native-BNB transfers run in parallel with the EXFER history fetch below.
  const bnbItemsP = bnbActivity();

  // 1. Confirmed history from the indexer (authoritative). Fetch each address
  //    INDEPENDENTLY (allSettled, not Promise.all): one address failing — a
  //    transient indexer/network blip, or the embedded walletd hung/warming up —
  //    must NOT discard the confirmed history of every other address. The old
  //    Promise.all rejected as a whole on a single failure, and the caller then
  //    overwrote the cached feed with the empty result, wiping the entire
  //    visible history until a later refresh happened to have all addresses
  //    succeed (the "refresh / tab-switch erased my history" bug).
  const confirmed = new Map<string, Agg>();
  const settled = await Promise.allSettled(
    ownAddresses.map(async (address) => ({
      address,
      rows: await addressHistory(address),
    })),
  );
  let anyOk = false;
  let anyFail = false;
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      anyFail = true;
      // Surface WHY a confirmed-history fetch failed (device/network-side: the
      // backend path itself is robust). Lets an on-device webview console show
      // the real trigger when history degrades. Only fires on failure.
      console.warn(
        "[activity] get_address_history failed:",
        String((s.reason as { message?: string })?.message ?? s.reason),
      );
      continue;
    }
    anyOk = true;
    const { address, rows } = s.value;
    for (const r of rows) {
      const a = aggOf(confirmed, r.tx_id);
      if (r.direction === "output") {
        a.credit += r.amount;
        a.toAddresses.add(address);
        // counterparties of a received row = the senders.
        for (const c of r.counterparties ?? []) a.senders.add(c);
      } else {
        a.debit += r.amount;
        // counterparties of a spent row = the recipients.
        for (const c of r.counterparties ?? []) a.recipients.add(c);
      }
      a.height = Math.max(a.height ?? 0, r.block_height);
      if (r.is_coinbase) a.is_coinbase = true;
    }
  }
  for (const [tx_id, a] of confirmed) {
    byTx.set(tx_id, itemFromAgg(tx_id, a, "confirmed", "indexer"));
  }
  // indexerOk means "this is a COMPLETE confirmed snapshot". If any address
  // failed (or none succeeded), the confirmed view is incomplete — flag it so
  // the caller treats the feed as degraded and keeps the last-good cache instead
  // of persisting this partial result over it. No addresses ⇒ nothing to miss.
  if (ownAddresses.length > 0 && (anyFail || !anyOk)) indexerOk = false;

  // 2. Pending from the live mempool — only for txs not already confirmed.
  const pending = new Map<string, Agg>();
  try {
    const perAddr = await Promise.all(
      ownAddresses.map(async (address) => ({
        address,
        resp: await rpc<AddressMempoolResponse>("get_address_mempool", {
          address,
        }),
      })),
    );
    for (const { address, resp } of perAddr) {
      for (const tx of resp.mempool ?? []) {
        const a = aggOf(pending, tx.tx_id);
        for (const o of tx.received ?? []) {
          a.credit += o.value;
          a.toAddresses.add(address);
        }
        for (const s of tx.spent ?? []) a.debit += s.value;
      }
    }
    for (const [tx_id, a] of pending) {
      if (byTx.has(tx_id)) continue; // confirmed wins
      byTx.set(tx_id, itemFromAgg(tx_id, a, "pending", "mempool"));
    }
  } catch {
    // mempool view unavailable (old node) — confirmed + local still stand.
  }

  // 3. Local broadcast log: enrich our sends with rich detail, and surface a
  //    just-broadcast send the network hasn't shown us yet. Synthetic
  //    placeholder rows ("recv-…") are intentionally dropped — the indexer is
  //    now the source of truth for received funds, so phantoms have no place.
  for (const h of listHistory()) {
    if (h.tx_id.startsWith("recv-")) continue;
    const existing = byTx.get(h.tx_id);
    if (h.kind === "received") {
      // Fallback only: if neither indexer nor mempool surfaced it (indexer
      // lagging / unreachable), keep the locally-captured deposit so it
      // doesn't vanish. Otherwise the authoritative row already covers it.
      if (!existing) {
        byTx.set(h.tx_id, {
          tx_id: h.tx_id,
          kind: "received",
          amount: h.amount ?? 0,
          status: "pending",
          ts: h.broadcast_at,
          toAddresses: h.outputs.filter((o) => !o.is_change).map((o) => o.to),
          source: "local",
        });
      } else {
        existing.ts ??= h.broadcast_at;
      }
      continue;
    }
    // A send we authored.
    const recipientsSum = h.outputs
      .filter((o) => !o.is_change)
      .reduce((s, o) => s + o.amount, 0);
    if (existing) {
      existing.kind = "sent";
      existing.amount = recipientsSum; // exact, beats the net-outflow estimate
      existing.detail = h;
      existing.ts ??= h.broadcast_at;
    } else {
      byTx.set(h.tx_id, {
        tx_id: h.tx_id,
        kind: "sent",
        amount: recipientsSum,
        status: "pending",
        ts: h.broadcast_at,
        detail: h,
        source: "local",
      });
    }
  }

  // Resolve authoritative status for anything the indexer hasn't already
  // confirmed. The indexer is the source of truth for HISTORY (which txs
  // touched an address) but it trails the chain tip — during its initial
  // back-fill it hasn't even seen recent blocks — so a transfer that already
  // confirmed and left the mempool would otherwise linger as "in mempool".
  // The node's get_transaction gives up-to-the-second status; confirmed
  // heights are final, so we cache them (loadConfirmed/rememberConfirmed) to
  // avoid re-querying on every refresh.
  const all = [...byTx.values()];
  const cache = loadConfirmed();
  const unresolved: ActivityItem[] = [];
  for (const it of all) {
    if (it.status === "confirmed") continue;
    const c = cache[it.tx_id];
    if (c) {
      it.status = "confirmed";
      it.block_height = c.block_height;
    } else {
      unresolved.push(it);
    }
  }
  // A locally-recorded transfer the node reports as unknown ("Transaction not
  // found") is neither on chain nor in any mempool — the network dropped/
  // evicted it (e.g. it was broadcast to a node that never relayed it, then
  // cleared on that node's resync). Left alone it reads "in mempool" forever,
  // since the local log is permanent and status only ever climbs to confirmed.
  // We silently prune such zombies — but only after a grace period, so a send
  // the node hasn't ingested yet (it lands in the mempool within seconds of
  // broadcast) isn't deleted before it propagates.
  const DROP_AFTER_MS = 60_000;
  const dropped = new Set<string>();
  await Promise.all(
    unresolved.map(async (it) => {
      try {
        const r = await rpc<TxStatusResp>("get_transaction", { tx_id: it.tx_id });
        if (r.block_height != null && r.in_mempool !== true) {
          it.status = "confirmed";
          it.block_height = r.block_height;
          rememberConfirmed(it.tx_id, r.block_height, r.block_id);
        }
        // else: the node holds it in its mempool — a genuine pending tx; keep.
      } catch (e) {
        const old =
          it.ts != null &&
          Date.now() - new Date(it.ts).getTime() > DROP_AFTER_MS;
        if (it.source === "local" && old && isTxNotFound(e)) {
          dropped.add(it.tx_id);
          dropHistory(it.tx_id); // prune the local record so it can't return
        }
        // Any other failure (transient / network) leaves the row pending to
        // retry on the next refresh.
      }
    }),
  );

  // BNB transfers (no EXFER tx_id, no collision) join the same timeline. Their
  // status comes straight from walletd, so they skip the resolution loop above.
  const merged = [...all.filter((it) => !dropped.has(it.tx_id)), ...(await bnbItemsP)];

  // Newest first: pending above confirmed; then by block height when BOTH sides
  // have one (two EXFER txs), else by timestamp — so a recent BNB tx (height-
  // less) sorts by its time rather than sinking below every EXFER block.
  const items = merged.sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    if (a.block_height != null && b.block_height != null) {
      return b.block_height - a.block_height;
    }
    return (b.ts ?? "") < (a.ts ?? "") ? -1 : 1;
  });

  return { items, indexerOk };
}
