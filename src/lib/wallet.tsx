import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { rpc, formatExfer } from "./rpc";
import type { AddressMempoolResponse, WalletBalance, WalletEntry } from "./types";
import { useToast } from "./toast";
import { recordReceived } from "./history";
import { isHidden } from "./hidden";

export interface UtxoInfo {
  utxo_count: number;
  truncated: boolean;
}

interface WalletData {
  balance: WalletBalance | null;
  loading: boolean;
  error: string | null;
  /** Manual refresh — call after a send or generate so the UI updates
   *  immediately instead of waiting for the next poll tick. */
  refresh: () => Promise<void>;
  /** Per-address UTXO counts, keyed by address. Empty until something
   *  calls refreshUtxos — the background poll skips UTXO scans to stay
   *  cheap, so counts are fetched on demand by the pages that show them. */
  utxos: Record<string, UtxoInfo>;
  /** Fetch UTXO counts (one extra upstream scan per address). Pages that
   *  display counts call this on mount and after mutating actions. */
  refreshUtxos: () => Promise<void>;
  /** Suspend the background balance poll (and SSE-triggered refreshes) and
   *  return a function that resumes it. The Send flow calls this so its own
   *  simulate/transfer queries get the full upstream rate-limit budget instead
   *  of competing with the poll — the public node caps balance/utxo queries
   *  per minute, and a poll running through a broadcast is what tips a normal
   *  send over the edge. Ref-counted, so nested/overlapping suspends are safe. */
  suspendPolling: () => () => void;
}

const WalletCtx = createContext<WalletData | null>(null);

export function useWallet(): WalletData {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}

// Poll cadence. The background poll asks for balance + pending
// ({ utxos: false, pending: true }) over the visible (non-hidden)
// addresses. With walletd's batched reads (v1.9.3+) the balances come
// back in ONE node scan (get_balances) regardless of address count, so a
// poll costs `1 + N` node scans (the +N is the per-address mempool, which
// has no batch form yet).
//
// The public node caps balance/utxo queries at 30/min/IP, and the poll is NOT
// the only consumer: a send fires simulate_transfer (a utxo scan) on each
// edit plus the transfer itself, Activity rebuilds fan out a mempool scan
// per address, an address sheet fetches utxo counts, and every SSE reconnect
// (the upstream node currently drops the stream every ~30s) triggers a
// refresh. At the old ~15/min steady pacing those stacked over the budget and
// a normal send failed with "Rate limit exceeded: max 30 balance/utxo queries
// per minute". We now pace one scan every ~10s, holding the steady poll near
// ~6/min for a 1–2 address wallet — that leaves the bulk of the budget for the
// actions the user actually takes (a send, opening Activity). The cost is a
// slightly staler hero balance when SSE is down, which is acceptable: deposits
// still surface instantly via the SSE push (wallet-nudge), a send does its own
// manual refresh, and the Send flow fully suspends the poll while open (see
// suspendPolling) so a broadcast never races it.
const MS_PER_SCAN = 10_000;
const MIN_POLL_MS = 15_000;
const MAX_POLL_MS = 60_000;

/** The current auto-refresh interval for `visibleCount` visible addresses.
 *  Exported so the UI can show the live rate and explain that more visible
 *  addresses (and only visible ones — hidden cost nothing) slow it down. */
export function pollIntervalMs(visibleCount: number): number {
  const m = visibleCount || 1;
  // 1 batched get_balances + m per-address mempool scans.
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (m + 1) * MS_PER_SCAN));
}

// Sort matches the daemon: index asc, imported/unindexed last, then address.
function byIndex(a: WalletEntry, b: WalletEntry): number {
  if (a.index != null && b.index != null) return a.index - b.index;
  if (a.index != null) return -1;
  if (b.index != null) return 1;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

// Resolve a just-detected deposit to its REAL crediting tx id(s). We diff
// per-address contributions to find which address(es) grew, then ask walletd's
// get_address_mempool for that address — each mempool tx's `received` outputs
// are the funds paying us, and the tx carries a true on-chain id.
//
// This drives the instant in-app "Received" toast and seeds a local fallback
// record (recordReceived, deduped by tx_id). It is NOT the source of truth for
// Activity anymore — that's the exfer-indexer's get_address_history, which
// surfaces every confirmed deposit with full detail even ones we never saw in
// the mempool. So there's deliberately NO synthetic placeholder here: a deposit
// either resolves to a real tx id (toast + cache) or it's left for the indexer
// to show. recordReceived's tx_id dedup also means the mempool→confirmed
// transition (which re-detects the same funds) fires neither a second toast nor
// a phantom row.
//
// `source` attributes each log line to the SSE push bridge ("sse") vs the
// background poll ("poll"), plus the non-deposit triggers (mount, manual).
type LoadSource = "mount" | "manual" | "poll" | "sse";

async function recordDeposit(
  entries: WalletEntry[],
  prevByAddr: Map<string, number>,
  source: LoadSource,
): Promise<boolean> {
  const grew = entries.filter((e) => {
    const cur =
      e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0);
    // Unknown address ⇒ no prior reading to compare; treat as no growth so
    // we don't scan it. The indexer-backed Activity still covers the deposit.
    const was = prevByAddr.get(e.address) ?? cur;
    return cur > was;
  });

  let addedNew = 0;
  for (const e of grew) {
    try {
      const m = await rpc<AddressMempoolResponse>("get_address_mempool", {
        address: e.address,
      });
      for (const tx of m.mempool ?? []) {
        const credit = (tx.received ?? []).reduce((s, r) => s + r.value, 0);
        if (credit <= 0) continue; // a tx that only spends from us
        if (recordReceived({ tx_id: tx.tx_id, amount: credit, address: e.address })) {
          addedNew++;
          console.info(
            `[deposit] recorded +${formatExfer(credit)} tx=${tx.tx_id.slice(0, 12)}… source=${source}`,
          );
        }
      }
    } catch {
      // Node too old for get_address_mempool, or a transient scan failure —
      // the indexer-backed Activity still surfaces the deposit on next refresh.
    }
  }

  // True only when a genuinely NEW deposit was resolved. The caller gates the
  // in-app toast on this so a transient mempool→confirmed double-count (which
  // only re-resolves an already-logged tx) fires neither a phantom row nor a
  // phantom toast.
  return addedNew > 0;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<Record<string, UtxoInfo>>({});
  // Track the last-seen total so we can detect deposits. `null` until the
  // first successful read so we don't toast the initial balance.
  const lastTotal = useRef<number | null>(null);
  // Per-address contribution (confirmed + pending credit − pending debit) at
  // the previous read, so a detected deposit can tell WHICH address grew and
  // query just that address's mempool for the real crediting tx id.
  const prevByAddr = useRef<Map<string, number>>(new Map());
  const inFlight = useRef(false);
  // Ref-counted poll suspension. >0 means the background poll + SSE-triggered
  // refreshes are paused (e.g. while the Send sheet is open) so user-initiated
  // queries get the upstream rate-limit budget to themselves.
  const suspendCount = useRef(0);
  // All known entries (including hidden, kept at their last-seen balance).
  // Used to compute the visible poll set and to merge poll results without
  // dropping hidden rows. A ref so the stable poll loop sees current data.
  const entriesRef = useRef<WalletEntry[]>([]);
  const loadedRef = useRef(false);

  // Visible = managed minus hidden. Empty until the first full load.
  const visibleAddrs = useCallback(
    () =>
      entriesRef.current
        .filter((e) => !isHidden(e.address))
        .map((e) => e.address),
    [],
  );

  const load = useCallback(
    async (isPoll: boolean, source: LoadSource) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (!isPoll) setLoading(true);
      try {
        // Full loads (manual refresh / mount) scan every managed address.
        // Polls scan only visible addresses — skip the ones the user hid.
        const known = entriesRef.current;
        const useFilter = isPoll && known.length > 0;
        const params: Record<string, unknown> = { utxos: false, pending: true };
        if (useFilter) params.addresses = visibleAddrs();

        const result = await rpc<WalletBalance>("get_wallet_balance", params);

        // On a filtered poll, merge fresh visible balances over the known
        // set so hidden rows survive (at their last-seen balance). A full
        // load replaces the set outright.
        let entries: WalletEntry[];
        if (useFilter) {
          const byAddr = new Map(known.map((e) => [e.address, e]));
          for (const e of result.entries) byAddr.set(e.address, e);
          entries = [...byAddr.values()].sort(byIndex);
        } else {
          entries = [...result.entries].sort(byIndex);
        }
        entriesRef.current = entries;
        loadedRef.current = true;

        const total = entries.reduce((acc, e) => acc + e.balance, 0);
        // Projected = confirmed + unconfirmed credit − unconfirmed debit.
        // pending_supported is false only if some entry came back without
        // the pending fields (upstream too old); then projected == total.
        const pendingSupported = entries.every(
          (e) => e.pending_received !== undefined,
        );
        const projected = entries.reduce(
          (acc, e) =>
            acc + e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0),
          0,
        );
        setBalance({ entries, total, projected, pending_supported: pendingSupported });
        setError(null);

        // Detect incoming funds on PROJECTED, not confirmed total: a
        // deposit shows up the moment it lands in the mempool (seconds
        // after the sender broadcasts), and when it later confirms,
        // pending_received → balance leaves projected unchanged, so we
        // don't double-notify.
        const prev = lastTotal.current;
        if (prev !== null && projected > prev) {
          const delta = projected - prev;
          // Lead with the amount — it reads as money that just landed, not a
          // status update. The balance already reflects it (feels instant).
          const amount = formatExfer(delta);
          // Resolve the REAL crediting tx id from the mempool and gate the
          // in-app toast on a genuinely NEW resolution — a transient
          // mempool→confirmed double-count re-detects the same funds (same tx
          // id, deduped), so it fires no second toast. Activity itself is now
          // driven by the indexer, so a deposit we can't resolve here still
          // shows up there with full detail.
          //
          // The OS-level notification fires separately from the native layer
          // (the walletd_supervisor SSE bridge) so a deposit notifies even
          // while this webview is suspended/backgrounded.
          void recordDeposit(entries, prevByAddr.current, source).then(
            (added) => {
              if (added) toast.incoming(`+${amount}`, "Received");
            },
          );
        }
        // Snapshot per-address contributions for the next deposit diff.
        const snap = new Map<string, number>();
        for (const e of entries) {
          snap.set(
            e.address,
            e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0),
          );
        }
        prevByAddr.current = snap;
        lastTotal.current = projected;
      } catch (e) {
        // Don't clobber a good balance on a transient poll failure;
        // only surface the error if we have nothing to show.
        if (!loadedRef.current) setError(String(e));
      } finally {
        if (!isPoll) setLoading(false);
        inFlight.current = false;
      }
    },
    [toast, visibleAddrs],
  );

  const refresh = useCallback(() => load(false, "manual"), [load]);

  const suspendPolling = useCallback(() => {
    suspendCount.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      suspendCount.current = Math.max(0, suspendCount.current - 1);
    };
  }, []);

  const refreshUtxos = useCallback(async () => {
    try {
      // Only the visible addresses — no point scanning hidden ones.
      const addrs = loadedRef.current ? visibleAddrs() : undefined;
      const r = await rpc<WalletBalance>("get_wallet_balance", {
        utxos: true,
        ...(addrs ? { addresses: addrs } : {}),
      });
      setUtxos((prev) => {
        const next = { ...prev };
        for (const e of r.entries) {
          if (e.utxo_count != null) {
            next[e.address] = {
              utxo_count: e.utxo_count,
              truncated: e.truncated ?? false,
            };
          }
        }
        return next;
      });
    } catch {
      /* on-demand; ignore transient failures */
    }
  }, [visibleAddrs]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const schedule = () => {
      // Recomputed every cycle from the *visible* count, so hiding/removing
      // an address speeds the next poll up automatically.
      const delay = pollIntervalMs(visibleAddrs().length);
      timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      // Skip the scan while suspended (Send flow open), but keep the loop
      // alive so it resumes on the next tick once the suspend is released.
      if (!suspendCount.current) await load(true, "poll");
      if (!cancelled) schedule();
    };
    // Initial full load, then begin the paced poll loop.
    load(false, "mount").finally(() => {
      if (!cancelled) schedule();
    });
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 2 SSE push: when the embedded walletd's SseClient gets a
  // script_changed / tip / resync nudge from the upstream node, the
  // Rust supervisor emits a "wallet-nudge" Tauri event. Listening
  // here means the balance refreshes the instant the mempool sees an
  // incoming tx, rather than waiting for the next poll tick.
  //
  // Falls back to polling silently when the node doesn't speak SSE
  // (pre-1.12): the walletd SseClient never connects, no nudges arrive,
  // and this listener is a no-op.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let lastRefreshAt = 0;
    const COALESCE_MS = 250;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen<{ kind?: string }>("wallet-nudge", (e) => {
          // SSE-push debug: confirms a wallet-nudge reached the webview (the
          // last hop of node→walletd→Tauri→JS). Pair with walletd's
          // `sse_client` tracing to localize a broken push chain.
          console.debug("[sse] wallet-nudge", e.payload, new Date().toISOString());
          // Suspended (Send flow open) → ignore the nudge; the post-send
          // refresh + resumed poll will catch up.
          if (suspendCount.current) return;
          const now = Date.now();
          if (now - lastRefreshAt < COALESCE_MS) return;
          lastRefreshAt = now;
          load(true, "sse").catch(() => {
            /* transient; next poll covers it */
          });
        });
        console.debug("[sse] wallet-nudge listener attached");
      } catch (err) {
        // listen unavailable (e.g. vite dev outside Tauri); stay on poll.
        console.debug("[sse] wallet-nudge listener unavailable, polling only", err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WalletCtx.Provider
      value={{ balance, loading, error, refresh, utxos, refreshUtxos, suspendPolling }}
    >
      {children}
    </WalletCtx.Provider>
  );
}
