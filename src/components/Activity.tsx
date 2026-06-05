// Activity — a unified, derived transfer feed. Confirmed rows come from the
// exfer-indexer (`get_address_history`, the authoritative per-address on-chain
// timeline), pending rows from the live mempool, and our own sends are enriched
// with the rich local broadcast record (recipients, fee, change). Every row —
// incoming or outgoing, confirmed or pending — opens a detail sheet with a real
// tx id + explorer link. See lib/activity.ts for the merge model.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import { formatExfer, formatBalanceCompact, rpc } from "../lib/rpc";
import { shortAddress } from "../lib/labels";
import { addrName, EXPLORER, txExplorerUrl, formatBnb } from "../lib/format";
import { getSwapUsd } from "../lib/swapPrice";
import { useT, tStatic, type MsgKey } from "../lib/i18n";
import {
  buildActivityFeed,
  loadFeedCache,
  saveFeedCache,
  type ActivityItem,
} from "../lib/activity";
import { AppBar, Sheet, CopyButton, AddrAvatar, RvRow, Spinner } from "./ui";

/** A swap record from walletd's journal (serde snake_case), for the Swaps
 *  section — so a cross-chain swap shows as one labeled record (both legs +
 *  status), not just its raw EXFER transfer. */
interface SwapRow {
  swap_id: string;
  direction: "exfer_to_bnb" | "bnb_to_exfer";
  status: string;
  amount_in: string;
  amount_out: string;
  fee_bps?: number;
  created_at: number;
  updated_at: number;
  // The swap's own EXFER-leg tx ids, so we can hide them from the raw transfer
  // feed (a swap shows once as a unified record, not twice).
  user_lock_tx?: string | null;
  pool_lock_ref?: string | null;
  claim_tx?: string | null;
  refund_tx?: string | null;
  error?: string | null;
}

function fmtA(s: string, dp = 4): string {
  if (!s) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  if (!frac && w === "0") {
    // Tiny value (e.g. ~1e-6 BNB) — show significant digits, not "0".
    const n = Number(s);
    if (isFinite(n) && n !== 0) {
      return n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
    }
  }
  return frac ? `${w}.${frac}` : w;
}

/** Swap status → label key + pill class. */
function swapPill(status: string): { key: MsgKey; cls: string } {
  switch (status) {
    case "completed": return { key: "swap.statusCompleted", cls: "pill-success" };
    case "refunded": return { key: "swap.statusRefunded", cls: "pill-warn" };
    case "failed": return { key: "swap.statusFailed", cls: "pill-danger" };
    case "refunding": return { key: "swap.statusRefunding", cls: "pill-warn" };
    default: return { key: "swap.inflightTitle", cls: "pill-accent" };
  }
}

function relTime(iso: string): string {
  const ts = new Date(iso).getTime();
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return tStatic("act.justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return tStatic("act.minAgo", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return tStatic("act.hAgo", { h });
  const d = Math.floor(h / 24);
  if (d < 7) return tStatic("act.dAgo", { d });
  return new Date(ts).toLocaleDateString();
}

// A row's status pill — just the status word. The block height (for rows with
// no local timestamp) lives in the subtitle via whenLabel, so the pill must NOT
// repeat it ("block 682,431" subtitle + "confirmed @ 682,431" pill read as a
// bug). The full "@ height" detail still shows in the TxSheet header.
function statusPill(it: ActivityItem): { text: string; cls: string } {
  if (it.failed) {
    return { text: tStatic("act.failed"), cls: "pill-danger" };
  }
  if (it.status === "confirmed") {
    return { text: tStatic("act.confirmed"), cls: "pill-success" };
  }
  return { text: tStatic("act.inMempool"), cls: "pill-accent" };
}

// When a row has no local timestamp (a confirmed-only deposit the indexer
// surfaced — e.g. it landed while the app was closed), fall back to the block.
function whenLabel(it: ActivityItem): string {
  if (it.ts) return relTime(it.ts);
  if (it.block_height) return tStatic("act.block", { n: it.block_height.toLocaleString() });
  return "";
}

export function Activity() {
  const { balance } = useWallet();
  const { t } = useT();
  // Seed from the cached feed so reopening Activity paints instantly instead of
  // flashing a skeleton and cold-loading every time. `loading` is only true
  // when there's nothing cached to show.
  const [items, setItems] = useState<ActivityItem[]>(
    () => loadFeedCache()?.items ?? [],
  );
  const [loading, setLoading] = useState(() => !loadFeedCache());
  const [refreshing, setRefreshing] = useState(false);
  const [indexerOk, setIndexerOk] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [openSwap, setOpenSwap] = useState<string | null>(null);

  // Cross-chain swaps live in walletd's journal, not the EXFER chain feed —
  // surface them as their own labeled records (both legs + status). No-ops when
  // the swap engine isn't configured.
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await rpc<SwapRow[]>("swap_list");
        if (cancelled) return;
        // Drop quotes the user never executed — no funds ever moved, so they're
        // not swaps and must not look like failures. New records use the benign
        // "expired" status; older builds marked them "failed (never executed)",
        // so drop those too. Show everything that actually locked.
        const real = (all ?? []).filter(
          (s) =>
            s.status !== "quoted" &&
            s.status !== "expired" &&
            !(s.status === "failed" && /never executed/i.test(s.error ?? "")),
        );
        real.sort((a, b) => b.created_at - a.created_at);
        setSwaps(real);
      } catch {
        if (!cancelled) setSwaps([]);
      }
    };
    load();
    const id = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const ownAddrs = useMemo(
    () => (balance?.entries ?? []).map((e) => e.address),
    [balance],
  );
  // Stable key so the load effect re-runs only when the address set changes.
  const ownKey = ownAddrs.join(",");

  const load = useCallback(
    async (announce: boolean) => {
      if (!ownAddrs.length) {
        setItems([]);
        setLoading(false);
        return;
      }
      if (announce) setRefreshing(true);
      try {
        const { items, indexerOk } = await buildActivityFeed(ownAddrs);
        setItems(items);
        setIndexerOk(indexerOk);
        saveFeedCache(ownKey, items);
      } finally {
        setLoading(false);
        if (announce) setRefreshing(false);
      }
    },
    [ownAddrs, ownKey],
  );

  // Re-seed from cache when the wallet (address set) changes: show its cached
  // feed at once, or a skeleton if there's nothing cached for it. Guarded on a
  // non-empty key so the brief "balance not loaded yet" tick doesn't wipe the
  // first-paint cache.
  useEffect(() => {
    if (!ownKey) return;
    const cached = loadFeedCache();
    if (cached && cached.ownKey === ownKey && cached.items.length) {
      setItems(cached.items);
      setLoading(false);
    } else {
      setItems([]);
      setLoading(true);
    }
  }, [ownKey]);

  // Refresh on mount and whenever the wallet's balance moves — both the
  // confirmed `total` (a tx confirmed) AND the `projected` total (a tx just hit
  // the mempool, pending). Keying on both means a pending deposit/send appears
  // within one provider poll (~4–18s) or instantly on an SSE push, and flips to
  // confirmed when it lands — without re-running on no-op polls (the numbers
  // only change when money actually moves). No separate timer: we piggyback on
  // the provider's existing poll + SSE so Activity never out-of-syncs the
  // balance. The cached feed stays on screen while the refresh runs.
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownKey, balance?.total, balance?.projected]);

  const opened = items.find((t) => t.tx_id === open) ?? null;

  // Hide the EXFER legs that belong to a swap — they're already represented by
  // the unified swap record in the Swaps section, so showing the raw transfer
  // too would double-count the same swap.
  const swapTxIds = useMemo(() => {
    const s = new Set<string>();
    for (const sw of swaps) {
      for (const tx of [sw.user_lock_tx, sw.claim_tx, sw.refund_tx]) if (tx) s.add(tx);
    }
    return s;
  }, [swaps]);
  const visibleItems = useMemo(
    () => items.filter((it) => !swapTxIds.has(it.tx_id)),
    [items, swapTxIds],
  );

  return (
    <div className="screen">
      <div className="screen-pad">
        <AppBar
          large
          title={t("act.title")}
          subtitle={(() => {
            const n = visibleItems.length + swaps.length; // swaps + transfers
            return t(n === 1 ? "act.item1" : "act.itemN", { n });
          })()}
          right={
            <button
              className="icon-btn"
              onClick={() => load(true)}
              aria-label="Refresh"
            >
              {refreshing ? <Spinner /> : <Icon name="refresh" size={19} />}
            </button>
          }
        />

        {!indexerOk && items.length > 0 && (
          <div
            className="faint"
            style={{ fontSize: 11.5, margin: "0 2px 10px", lineHeight: 1.5 }}
          >
            {t("act.degraded")}
          </div>
        )}

        {swaps.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ margin: "0 2px 9px" }}>{t("act.swaps")}</div>
            <div style={{ display: "grid", gap: 11 }}>
              {swaps.map((s) => (
                <SwapActivityRow key={s.swap_id} s={s} onOpen={() => setOpenSwap(s.swap_id)} />
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ display: "grid", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : visibleItems.length === 0 && swaps.length === 0 ? (
          <div
            className="card"
            style={{ padding: "36px 22px", textAlign: "center", marginTop: 8 }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                margin: "0 auto 14px",
                display: "grid",
                placeItems: "center",
                background: "var(--surface-2)",
                color: "var(--text-faint)",
              }}
            >
              <Icon name="activity" size={26} />
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("act.emptyTitle")}</div>
            <div className="faint" style={{ fontSize: 13 }}>
              {t("act.emptyBody")}
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 11 }}>
            {visibleItems.map((t) => (
              <ActivityRow
                key={t.tx_id}
                item={t}
                entries={balance?.entries ?? []}
                onOpen={() => setOpen(t.tx_id)}
              />
            ))}
          </div>
        )}
      </div>

      {opened && (
        <TxSheet
          item={opened}
          entries={balance?.entries ?? []}
          onClose={() => setOpen(null)}
        />
      )}

      {openSwap && (() => {
        const s = swaps.find((x) => x.swap_id === openSwap);
        return s ? <SwapDetailSheet s={s} onClose={() => setOpenSwap(null)} /> : null;
      })()}
    </div>
  );
}

type Entry = NonNullable<ReturnType<typeof useWallet>["balance"]>["entries"][number];

// Shimmering placeholder row (shared `.skeleton` animation), shaped like a real
// activity row so the cold-load state reads as "loading" rather than empty.
function SkeletonRow() {
  return (
    <div
      className="card"
      style={{
        padding: "14px 15px",
        border: "1px solid var(--border-soft)",
        background: "var(--surface)",
      }}
    >
      <div className="h-row">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className="skeleton"
            style={{ width: 36, height: 36, borderRadius: 11 }}
          />
          <div style={{ display: "grid", gap: 6 }}>
            <span
              className="skeleton"
              style={{ width: 124, height: 14, borderRadius: 6 }}
            />
            <span
              className="skeleton"
              style={{ width: 64, height: 11, borderRadius: 6 }}
            />
          </div>
        </div>
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          <span
            className="skeleton"
            style={{ width: 58, height: 15, borderRadius: 6 }}
          />
          <span
            className="skeleton"
            style={{ width: 74, height: 18, borderRadius: 999 }}
          />
        </div>
      </div>
    </div>
  );
}

function SwapActivityRow({ s, onOpen }: { s: SwapRow; onOpen: () => void }) {
  const { t } = useT();
  const sell = s.direction === "exfer_to_bnb";
  const outUnit = sell ? "BNB" : "EXFER";
  const pill = swapPill(s.status);
  const when = relTime(new Date(s.created_at * 1000).toISOString());
  return (
    <button
      className="card tap"
      onClick={onOpen}
      style={{
        padding: "14px 15px",
        textAlign: "left",
        cursor: "pointer",
        border: "1px solid var(--border-soft)",
        background: "var(--surface)",
        display: "block",
        width: "100%",
      }}
    >
      {/* Same row anatomy as transfer rows: icon + title/time on the left,
          a signed amount + status pill stacked on the right. The full X→Y pair
          lives in the detail sheet. */}
      <div className="h-row">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 36, height: 36, borderRadius: 11, display: "grid", placeItems: "center",
              background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)",
            }}
          >
            <Icon name="refresh" size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14.5 }}>
              {sell ? t("act.soldExfer") : t("act.boughtExfer")}
            </div>
            <div className="faint" style={{ fontSize: 11.5 }}>{when}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontWeight: 600, fontSize: 15, color: "#34d399" }}>
            +{fmtA(s.amount_out)}
            <span style={{ color: "var(--text-faint)", fontWeight: 500, fontSize: 11.5 }}> {outUnit}</span>
          </div>
          <span className={"pill " + pill.cls} style={{ marginTop: 6, padding: "3px 9px", fontSize: 11 }}>
            {t(pill.key)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** Detail sheet for a single swap — amounts, status, fee, time, and the
 *  on-chain references (only those present), each copyable. Mirrors the
 *  TxSheet's eyebrow + mono-code styling. */
function SwapDetailSheet({ s, onClose }: { s: SwapRow; onClose: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const sell = s.direction === "exfer_to_bnb";

  // Jump to the right explorer for a leg — BscScan for the BNB (0x) tx, the
  // EXFER explorer otherwise. Falls back to copying the URL if the webview
  // blocks window.open.
  function openRef(txid: string) {
    const url = txExplorerUrl(txid);
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      navigator.clipboard?.writeText(url);
      toast.info(t("act.explorerCopied"), url);
    }
  }
  const inUnit = sell ? "EXFER" : "BNB";
  const outUnit = sell ? "BNB" : "EXFER";
  const pill = swapPill(s.status);
  const created = new Date(s.created_at * 1000).toLocaleString();

  // Price/value at the time of the swap. The executed rate is exact (derived
  // from the on-chain amounts); the USD anchor is the EXFER/USD spot we
  // snapshotted at execute time (per-device, may be absent for old swaps).
  const exferAmt = sell ? Number(s.amount_in) : Number(s.amount_out);
  const bnbAmt = sell ? Number(s.amount_out) : Number(s.amount_in);
  const rate = exferAmt > 0 && isFinite(bnbAmt) ? bnbAmt / exferAmt : null; // BNB per EXFER
  const usdThen = getSwapUsd(s.swap_id);
  const valueThen = usdThen != null && exferAmt > 0 ? exferAmt * usdThen : null;
  const sig = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
  const usd = (u: number) => (u >= 1 ? u.toFixed(2) : u.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false }));

  const refs: { key: MsgKey; value: string }[] = [];
  if (s.user_lock_tx) refs.push({ key: "swap.refUserLock", value: s.user_lock_tx });
  if (s.pool_lock_ref) refs.push({ key: "swap.refPoolLock", value: s.pool_lock_ref });
  if (s.claim_tx) refs.push({ key: "swap.refClaim", value: s.claim_tx });
  if (s.refund_tx) refs.push({ key: "swap.refRefund", value: s.refund_tx });

  return (
    <Sheet title={t("swap.detailTitle")} subtitle={created} onClose={onClose} height="90%">
      <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>
          {fmtA(s.amount_in)}
          <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}> {inUnit}</span>
          {" → "}
          {fmtA(s.amount_out)}
          <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}> {outUnit}</span>
        </div>
        <span className={"pill " + pill.cls} style={{ marginTop: 10 }}>
          {t(pill.key)}
        </span>
      </div>

      <div className="card card-2" style={{ overflow: "hidden", marginBottom: 16 }}>
        {rate != null && (
          <RvRow label={t("swap.detailRate")} value={`1 EXFER ≈ ${sig(rate)} BNB`} mono />
        )}
        {usdThen != null && (
          <RvRow label={t("swap.detailPriceThen")} value={`≈ $${usd(usdThen)}`} mono />
        )}
        {valueThen != null && (
          <RvRow label={t("swap.detailValueThen")} value={`≈ $${usd(valueThen)}`} mono strong />
        )}
        {typeof s.fee_bps === "number" && (
          <RvRow label={t("swap.detailFee")} value={`${s.fee_bps / 100}%`} mono />
        )}
        <RvRow label={t("swap.detailCreated")} value={created} last />
      </div>

      {refs.length > 0 && (
        <div className="card card-2" style={{ padding: "12px 14px", marginBottom: 16 }}>
          {refs.map((r, i) => (
            <div key={r.key} style={{ marginTop: i === 0 ? 0 : 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                {t(r.key)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Full hash, tappable — opens the right explorer (BscScan for
                    the BNB leg, the EXFER explorer otherwise). */}
                <button
                  type="button"
                  className="tap"
                  onClick={() => openRef(r.value)}
                  style={{
                    flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8,
                    background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left",
                  }}
                >
                  <code
                    className="mono"
                    style={{ flex: 1, minWidth: 0, fontSize: 12, wordBreak: "break-all", color: "var(--accent)", lineHeight: 1.5 }}
                  >
                    {r.value}
                  </code>
                  <Icon name="share" size={14} />
                </button>
                <CopyButton text={r.value} label="Copied" />
              </div>
            </div>
          ))}
        </div>
      )}

      {s.error && (
        <div style={{ color: "#f87171", fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
          {s.error}
        </div>
      )}
    </Sheet>
  );
}

function ActivityRow({
  item,
  entries,
  onOpen,
}: {
  item: ActivityItem;
  entries: Entry[];
  onOpen: () => void;
}) {
  const { t } = useT();
  const st = statusPill(item);
  const received = item.kind === "received";
  const bnb = item.asset === "BNB";

  // Received: name the address that got credited (if it's one we can name).
  const toEntry = received
    ? entries.find((e) => item.toAddresses?.includes(e.address))
    : null;
  // Sent: name the funding (change-returning) address when we have local detail.
  const fromAddr = item.detail?.outputs.find((o) => o.is_change)?.to;
  const fromEntry = fromAddr ? entries.find((e) => e.address === fromAddr) : null;

  const title = bnb
    ? received
      ? t("act.receivedBnb")
      : t("act.sentBnb")
    : received
    ? item.is_coinbase
      ? t("act.miningReward")
      : toEntry
        ? t("act.receivedTo", { name: addrName(toEntry) })
        : t("act.received")
    : fromEntry
      ? t("act.sentFrom", { name: addrName(fromEntry) })
      : t("act.sent");

  return (
    <button
      className="card tap"
      onClick={onOpen}
      style={{
        padding: "14px 15px",
        textAlign: "left",
        cursor: "pointer",
        border: "1px solid var(--border-soft)",
        background: "var(--surface)",
        display: "block",
        width: "100%",
      }}
    >
      <div className="h-row">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              display: "grid",
              placeItems: "center",
              background: received
                ? "color-mix(in srgb,#34d399 16%,transparent)"
                : "var(--surface-2)",
              color: received ? "#34d399" : "var(--text-dim)",
            }}
          >
            <Icon name={received ? "receive" : "send"} size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14.5 }}>{title}</div>
            <div className="faint" style={{ fontSize: 11.5 }}>
              {whenLabel(item)}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            className="mono"
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: received ? "#34d399" : undefined,
            }}
          >
            {received ? "+" : "−"}
            {bnb ? formatBnb(item.amount) : formatBalanceCompact(item.amount).replace(" EXFER", "")}
            <span style={{ color: "var(--text-faint)", fontWeight: 500, fontSize: 11.5 }}> {bnb ? "BNB" : "EXFER"}</span>
          </div>
          <span
            className={"pill " + st.cls}
            style={{ marginTop: 6, padding: "3px 9px", fontSize: 11 }}
          >
            {st.text}
          </span>
        </div>
      </div>
    </button>
  );
}

function TxSheet({
  item,
  entries,
  onClose,
}: {
  item: ActivityItem;
  entries: Entry[];
  onClose: () => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const st = statusPill(item);
  const received = item.kind === "received";
  const detail = item.detail;

  // From/To come natively from the indexer's counterparties (resolved at index
  // time): senders for a received deposit, recipients for a send. No per-tx
  // re-decode. Empty only for a still-pending tx the indexer hasn't seen yet.
  const senders = received ? (item.counterparties ?? []) : [];

  function openExplorer() {
    const url = `${EXPLORER}/tx/${item.tx_id}`;
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      navigator.clipboard?.writeText(url);
      toast.info(t("act.explorerCopied"), url);
    }
  }

  const subtitle = item.ts
    ? new Date(item.ts).toLocaleString()
    : item.block_height
      ? t("act.blockN", { n: item.block_height.toLocaleString() })
      : undefined;

  const txIdCard = (
    <div className="card card-2" style={{ padding: "12px 14px", marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        {t("act.txId")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <code
          className="mono"
          style={{
            flex: 1,
            fontSize: 12,
            wordBreak: "break-all",
            color: "var(--text-dim)",
            lineHeight: 1.5,
          }}
        >
          {item.tx_id}
        </code>
        <CopyButton text={item.tx_id} label="Tx ID copied" />
      </div>
    </div>
  );

  const explorerBtn = (
    <button className="btn btn-secondary btn-block" onClick={openExplorer}>
      <Icon name="share" size={18} /> {t("act.viewExplorer")}
    </button>
  );

  // ---- BNB (BSC) — its own sheet: no EXFER inputs/outputs/fee/change ------
  if (item.asset === "BNB") {
    const peer = item.counterparties?.[0];
    const openBsc = () => {
      const url = txExplorerUrl(item.tx_id, item.chainId);
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        navigator.clipboard?.writeText(url);
        toast.info(t("act.explorerCopied"), url);
      }
    };
    return (
      <Sheet title={t("act.transfer")} subtitle={subtitle} onClose={onClose} height="90%">
        <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
          <div
            className="mono"
            style={{ fontSize: 30, fontWeight: 600, color: received ? "#34d399" : undefined }}
          >
            {received ? "+" : "−"}
            {formatBnb(item.amount)}
            <span className="dim" style={{ fontSize: 15 }}> BNB</span>
          </div>
          <span className={"pill " + st.cls} style={{ marginTop: 10 }}>
            {st.text}
          </span>
        </div>

        {peer && (
          <>
            <div className="eyebrow" style={{ marginBottom: 9 }}>
              {received ? t("act.from") : t("act.to")}
            </div>
            <div
              className="card"
              style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}
            >
              <AddrAvatar address={peer} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t("act.externalAddr")}</div>
                <code className="mono faint" style={{ fontSize: 11.5 }}>
                  {shortAddress(peer, 8, 8)}
                </code>
              </div>
              <CopyButton text={peer} label="Address copied" />
            </div>
          </>
        )}

        {txIdCard}
        <button className="btn btn-secondary btn-block" onClick={openBsc}>
          <Icon name="share" size={18} /> {t("act.viewBscScan")}
        </button>
      </Sheet>
    );
  }

  // ---- Received ----------------------------------------------------------
  if (received) {
    const toAddr = item.toAddresses?.[0];
    const toEntry = toAddr ? entries.find((e) => e.address === toAddr) : null;
    return (
      <Sheet title={t("act.deposit")} subtitle={subtitle} onClose={onClose} height="90%">
        <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
          <div
            className="mono"
            style={{ fontSize: 30, fontWeight: 600, color: "#34d399" }}
          >
            +{formatExfer(item.amount).replace(" EXFER", "")}
            <span className="dim" style={{ fontSize: 15 }}>
              {" "}
              EXFER
            </span>
          </div>
          <span className={"pill " + st.cls} style={{ marginTop: 10 }}>
            {st.text}
          </span>
        </div>

        {senders && senders.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginBottom: 9 }}>
              {t("act.from")}
            </div>
            <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
              {senders.map((addr, i) => {
                const e = entries.find((x) => x.address === addr);
                return (
                  <div
                    key={addr}
                    style={{
                      padding: "12px 14px",
                      borderBottom:
                        i < senders.length - 1
                          ? "1px solid var(--border-soft)"
                          : "0",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <AddrAvatar address={addr} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                        {e ? addrName(e) : t("act.externalAddr")}
                      </div>
                      <code className="mono faint" style={{ fontSize: 11.5 }}>
                        {shortAddress(addr, 8, 8)}
                      </code>
                    </div>
                    <CopyButton text={addr} label="Address copied" />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {toAddr && (
          <>
            <div className="eyebrow" style={{ marginBottom: 9 }}>
              {t("act.to")}
            </div>
            <div
              className="card"
              style={{
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <AddrAvatar address={toAddr} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {toEntry ? addrName(toEntry) : t("act.thisWallet")}
                </div>
                <code className="mono faint" style={{ fontSize: 11.5 }}>
                  {shortAddress(toAddr, 8, 8)}
                </code>
              </div>
              <CopyButton text={toAddr} label="Address copied" />
            </div>
          </>
        )}

        {txIdCard}
        {explorerBtn}
      </Sheet>
    );
  }

  // ---- Sent --------------------------------------------------------------
  const recips = detail?.outputs.filter((o) => !o.is_change) ?? [];
  const change = detail?.outputs.find((o) => o.is_change);
  const fromAddr = change?.to;
  const fromEntry = fromAddr ? entries.find((e) => e.address === fromAddr) : null;
  // Fallback recipients for a send with no local record (broadcast from another
  // device): the indexer's counterparties, minus any of our own addresses
  // (those are change, not recipients).
  const peerRecipients = (item.counterparties ?? []).filter(
    (a) => !entries.some((e) => e.address === a),
  );

  return (
    <Sheet title={t("act.transfer")} subtitle={subtitle} onClose={onClose} height="90%">
      <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
        <div className="mono" style={{ fontSize: 30, fontWeight: 600 }}>
          −{formatExfer(item.amount).replace(" EXFER", "")}
          <span className="dim" style={{ fontSize: 15 }}>
            {" "}
            EXFER
          </span>
        </div>
        <span className={"pill " + st.cls} style={{ marginTop: 10 }}>
          {st.text}
        </span>
      </div>

      {fromAddr && (
        <>
          <div className="eyebrow" style={{ marginBottom: 9 }}>
            {t("act.from")}
          </div>
          <div
            className="card"
            style={{
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <AddrAvatar address={fromAddr} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                {fromEntry ? addrName(fromEntry) : t("act.thisWallet")}
              </div>
              <code className="mono faint" style={{ fontSize: 11.5 }}>
                {shortAddress(fromAddr, 8, 8)}
              </code>
            </div>
            <CopyButton text={fromAddr} label="Address copied" />
          </div>
        </>
      )}

      {recips.length > 0 ? (
        <>
          <div className="eyebrow" style={{ marginBottom: 9 }}>
            {t("act.sentTo")}
          </div>
          <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
            {recips.map((o, i) => (
              <div
                key={i}
                style={{
                  padding: "12px 14px",
                  borderBottom:
                    i < recips.length - 1 ? "1px solid var(--border-soft)" : "0",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AddrAvatar address={o.to} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    {t("act.externalAddr")}
                  </div>
                  <code className="mono faint" style={{ fontSize: 11.5 }}>
                    {shortAddress(o.to, 8, 8)}
                  </code>
                </div>
                <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>
                  {formatBalanceCompact(o.amount).replace(" EXFER", "")}
                </span>
                <CopyButton text={o.to} label="Address copied" />
              </div>
            ))}
          </div>
        </>
      ) : peerRecipients.length > 0 ? (
        <>
          <div className="eyebrow" style={{ marginBottom: 9 }}>
            {t("act.sentTo")}
          </div>
          <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
            {peerRecipients.map((addr, i) => (
              <div
                key={addr}
                style={{
                  padding: "12px 14px",
                  borderBottom:
                    i < peerRecipients.length - 1
                      ? "1px solid var(--border-soft)"
                      : "0",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AddrAvatar address={addr} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    {t("act.externalAddr")}
                  </div>
                  <code className="mono faint" style={{ fontSize: 11.5 }}>
                    {shortAddress(addr, 8, 8)}
                  </code>
                </div>
                <CopyButton text={addr} label="Address copied" />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div
          className="card card-2"
          style={{ padding: "12px 14px", marginBottom: 16 }}
        >
          <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            {t("act.noRecipNote")}
          </div>
        </div>
      )}

      {detail && (
        <div className="card card-2" style={{ overflow: "hidden", marginBottom: 16 }}>
          <RvRow
            label={t("act.networkFee")}
            value={formatExfer(detail.fee).replace(" EXFER", "") + " EXFER"}
            mono
          />
          <RvRow
            label={t("act.inOutLabel")}
            value={t("act.inOut", { in: detail.inputs.length, out: detail.outputs.length })}
            mono
          />
          {change && (
            <RvRow
              label={t("act.changeReturned")}
              value={
                formatBalanceCompact(change.amount).replace(" EXFER", "") +
                " EXFER"
              }
              mono
            />
          )}
          <RvRow label={t("act.size")} value={t("snd.sizeVal", { n: detail.size })} mono last />
        </div>
      )}

      {txIdCard}
      {explorerBtn}
    </Sheet>
  );
}
