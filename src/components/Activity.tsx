// Activity — local transfer history with per-tx status from the node, plus a
// TxSheet detail view (From block + copy buttons + explorer link).

import { useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import { rpc, formatExfer, formatBalanceCompact } from "../lib/rpc";
import { shortAddress } from "../lib/labels";
import { addrName, EXPLORER } from "../lib/format";
import {
  listHistory,
  loadConfirmed,
  rememberConfirmed,
  type HistoryEntry,
} from "../lib/history";
import { AppBar, Sheet, CopyButton, AddrAvatar, RvRow, Spinner } from "./ui";

type Confirmed = Record<string, { block_height: number; block_id?: string }>;

function relTime(iso: string): string {
  const ts = new Date(iso).getTime();
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function statusOf(
  tx: HistoryEntry,
  confirmed: Confirmed,
): { text: string; cls: string; height?: number } {
  const c = confirmed[tx.tx_id];
  if (c) return { text: "confirmed", cls: "pill-success", height: c.block_height };
  return { text: "in mempool", cls: "pill-accent" };
}

// The node's get_transaction shape (best-effort; not all nodes/dev-mock
// implement it, so reads are wrapped in try/catch).
interface TxStatusResp {
  status?: { block_height?: number; block_id?: string; in_mempool?: boolean };
  block_height?: number;
}

export function Activity() {
  const toast = useToast();
  const { balance } = useWallet();
  const [history] = useState<HistoryEntry[]>(() => listHistory());
  const [confirmed, setConfirmed] = useState<Confirmed>(() => loadConfirmed());
  const [polling, setPolling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const ownAddrs = useMemo(
    () => new Set((balance?.entries ?? []).map((e) => e.address)),
    [balance],
  );

  async function refresh() {
    setPolling(true);
    let newlyConfirmed = 0;
    const next: Confirmed = { ...confirmed };
    for (const tx of history) {
      if (next[tx.tx_id]) continue;
      try {
        const r = await rpc<TxStatusResp>("get_transaction", { tx_id: tx.tx_id });
        const h = r.status?.block_height ?? r.block_height;
        if (h != null) {
          next[tx.tx_id] = { block_height: h, block_id: r.status?.block_id };
          rememberConfirmed(tx.tx_id, h, r.status?.block_id);
          newlyConfirmed++;
        }
      } catch {
        // Node may not implement get_transaction — leave as in-mempool.
      }
    }
    setConfirmed(next);
    setPolling(false);
    if (newlyConfirmed) {
      toast.success(
        "Status updated",
        `${newlyConfirmed} transfer${newlyConfirmed > 1 ? "s" : ""} confirmed.`,
      );
    } else {
      toast.info("Up to date", "No newly-confirmed transfers.");
    }
  }

  return (
    <div className="screen">
      <div className="screen-pad">
        <AppBar
          large
          title="Activity"
          subtitle={`${history.length} ${
            history.length === 1 ? "transfer" : "transfers"
          } · local to this device`}
          right={
            <button className="icon-btn" onClick={refresh} aria-label="Refresh">
              {polling ? <Spinner /> : <Icon name="refresh" size={19} />}
            </button>
          }
        />

        {history.length === 0 ? (
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
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No transfers yet</div>
            <div className="faint" style={{ fontSize: 13 }}>
              Every transfer you broadcast lands here.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 11 }}>
            {history.map((t) => {
              const recips = t.outputs.filter((o) => !o.is_change);
              const sent = recips.reduce((s, o) => s + o.amount, 0);
              const st = statusOf(t, confirmed);
              const change = t.outputs.find((o) => o.is_change);
              const fromAddr = change?.to;
              const fromEntry =
                fromAddr && ownAddrs.has(fromAddr)
                  ? (balance?.entries ?? []).find((a) => a.address === fromAddr)
                  : null;
              const fromName = fromEntry ? addrName(fromEntry) : "this wallet";
              return (
                <button
                  key={t.tx_id}
                  className="card tap"
                  onClick={() => setOpen(t.tx_id)}
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
                  <div className="h-row" style={{ marginBottom: 11 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 11,
                          display: "grid",
                          placeItems: "center",
                          background: "var(--surface-2)",
                          color: "var(--text-dim)",
                        }}
                      >
                        <Icon name="send" size={18} />
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                          Sent from {fromName}
                        </div>
                        <div className="faint" style={{ fontSize: 11.5 }}>
                          {relTime(t.broadcast_at)}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="mono" style={{ fontWeight: 600, fontSize: 15 }}>
                        −{formatBalanceCompact(sent).replace(" EXFER", "")}
                      </div>
                      <span
                        className={"pill " + st.cls}
                        style={{ marginTop: 4, padding: "2px 8px", fontSize: 10.5 }}
                      >
                        {st.text}
                        {st.height ? ` @ ${st.height.toLocaleString()}` : ""}
                      </span>
                    </div>
                  </div>
                  <div
                    className="faint"
                    style={{ fontSize: 12, display: "flex", justifyContent: "space-between" }}
                  >
                    <span>
                      {recips.length} recipient{recips.length > 1 ? "s" : ""} · fee{" "}
                      {formatExfer(t.fee).replace(" EXFER", "")}
                    </span>
                    <span className="mono">{shortAddress(t.tx_id, 6, 5)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {open && (
        <TxSheet
          tx={history.find((t) => t.tx_id === open)!}
          confirmed={confirmed}
          ownAddrs={ownAddrs}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function TxSheet({
  tx,
  confirmed,
  ownAddrs,
  onClose,
}: {
  tx: HistoryEntry;
  confirmed: Confirmed;
  ownAddrs: Set<string>;
  onClose: () => void;
}) {
  const toast = useToast();
  const { balance } = useWallet();
  const recips = tx.outputs.filter((o) => !o.is_change);
  const change = tx.outputs.find((o) => o.is_change);
  const sent = recips.reduce((s, o) => s + o.amount, 0);
  const st = statusOf(tx, confirmed);
  const dt = new Date(tx.broadcast_at);
  const fromAddr = change?.to;
  const fromEntry =
    fromAddr && ownAddrs.has(fromAddr)
      ? (balance?.entries ?? []).find((a) => a.address === fromAddr)
      : null;

  function openExplorer() {
    const url = `${EXPLORER}/tx/${tx.tx_id}`;
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      navigator.clipboard?.writeText(url);
      toast.info("Explorer link copied", url);
    }
  }

  return (
    <Sheet title="Transfer" subtitle={dt.toLocaleString()} onClose={onClose} height="90%">
      <div style={{ textAlign: "center", padding: "6px 0 18px" }}>
        <div className="mono" style={{ fontSize: 30, fontWeight: 600 }}>
          −{formatExfer(sent).replace(" EXFER", "")}
          <span className="dim" style={{ fontSize: 15 }}>
            {" "}
            EXFER
          </span>
        </div>
        <span className={"pill " + st.cls} style={{ marginTop: 10 }}>
          {st.text}
          {st.height ? ` @ ${st.height.toLocaleString()}` : ""}
        </span>
      </div>

      {fromAddr && (
        <>
          <div className="eyebrow" style={{ marginBottom: 9 }}>
            From
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
                {fromEntry ? addrName(fromEntry) : "This wallet"}
              </div>
              <code className="mono faint" style={{ fontSize: 11.5 }}>
                {shortAddress(fromAddr, 8, 8)}
              </code>
            </div>
            <CopyButton text={fromAddr} label="Address copied" />
          </div>
        </>
      )}

      <div className="eyebrow" style={{ marginBottom: 9 }}>
        Sent to
      </div>
      <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
        {recips.map((o, i) => (
          <div
            key={i}
            style={{
              padding: "12px 14px",
              borderBottom: i < recips.length - 1 ? "1px solid var(--border-soft)" : "0",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <AddrAvatar address={o.to} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>External address</div>
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

      <div className="card card-2" style={{ overflow: "hidden", marginBottom: 16 }}>
        <RvRow
          label="Network fee"
          value={formatExfer(tx.fee).replace(" EXFER", "") + " EXFER"}
          mono
        />
        <RvRow
          label="Inputs / outputs"
          value={`${tx.inputs.length} in · ${tx.outputs.length} out`}
          mono
        />
        {change && (
          <RvRow
            label="Change returned"
            value={formatBalanceCompact(change.amount).replace(" EXFER", "") + " EXFER"}
            mono
          />
        )}
        <RvRow label="Size" value={`${tx.size} bytes`} mono last />
      </div>

      <div className="card card-2" style={{ padding: "12px 14px", marginBottom: 16 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Transaction ID
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
            {tx.tx_id}
          </code>
          <CopyButton text={tx.tx_id} label="Tx ID copied" />
        </div>
      </div>

      <button className="btn btn-secondary btn-block" onClick={openExplorer}>
        <Icon name="share" size={18} /> View on Exfer Explorer
      </button>
    </Sheet>
  );
}
