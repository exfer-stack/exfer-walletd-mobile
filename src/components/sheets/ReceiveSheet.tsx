// Receive — pick an address, show QR + full address, copy/share.

import { useState } from "react";
import { Icon } from "../../lib/icons";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc, formatBalanceCompact } from "../../lib/rpc";
import { isHidden } from "../../lib/hidden";
import { addrName } from "../../lib/format";
import { Sheet, CopyButton } from "../ui";
import { Qr } from "../Qr";

export function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { balance, refresh } = useWallet();
  const toast = useToast();
  const entries = (balance?.entries ?? []).filter((a) => !isHidden(a.address));
  const [sel, setSel] = useState<string | null>(entries[0]?.address ?? null);
  const entry = (balance?.entries ?? []).find((a) => a.address === sel);

  async function newAddress() {
    try {
      const res = await rpc<{ address: string }>("generate_independent_address");
      await refresh();
      setSel(res.address);
      toast.success("Address created", "A fresh address is ready.");
    } catch (e) {
      toast.error("Could not create address", String(e instanceof Error ? e.message : e));
    }
  }

  function share() {
    if (!sel) return;
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; text?: string }) => Promise<void>;
    };
    if (nav.share) {
      nav.share({ title: "My exfer address", text: sel }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(sel);
      toast.success("Copied", "Address copied — share it anywhere.");
    }
  }

  return (
    <Sheet title="Receive" onClose={onClose} height="92%">
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          padding: "2px 0 16px",
          scrollbarWidth: "none",
        }}
      >
        {entries.map((a) => (
          <button
            key={a.address}
            onClick={() => setSel(a.address)}
            className="tap"
            style={{
              flex: "0 0 auto",
              padding: "10px 15px",
              borderRadius: 999,
              cursor: "pointer",
              fontSize: 13.5,
              fontWeight: 600,
              border: "1px solid " + (sel === a.address ? "transparent" : "var(--border)"),
              background: sel === a.address ? "var(--accent)" : "var(--surface-2)",
              color: sel === a.address ? "var(--accent-ink)" : "var(--text-dim)",
              whiteSpace: "nowrap",
            }}
          >
            {addrName(a)}
          </button>
        ))}
        <button
          onClick={newAddress}
          className="tap"
          style={{
            flex: "0 0 auto",
            padding: "8px 12px",
            borderRadius: 999,
            cursor: "pointer",
            border: "1px dashed var(--border)",
            background: "none",
            color: "var(--text-dim)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 13.5,
            fontWeight: 600,
          }}
        >
          <Icon name="plus" size={15} /> New
        </button>
      </div>

      {entry && sel && (
        <div className="fade-up" key={sel}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <div
              style={{
                background: "#fff",
                padding: 18,
                borderRadius: 22,
                boxShadow: "var(--shadow)",
              }}
            >
              <Qr value={sel} size={222} />
            </div>
          </div>

          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{addrName(entry)}</div>
            <div className="mono dim" style={{ fontSize: 14, marginTop: 3 }}>
              {formatBalanceCompact(entry.balance)}
            </div>
          </div>

          <div
            className="card card-2"
            style={{
              padding: "13px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <code
              className="mono"
              style={{
                flex: 1,
                fontSize: 12.5,
                wordBreak: "break-all",
                lineHeight: 1.5,
                color: "var(--text-dim)",
              }}
            >
              {sel}
            </code>
            <CopyButton text={sel} label="Address copied" />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-secondary btn-block" onClick={share}>
              <Icon name="share" size={19} /> Share
            </button>
            <CopyButton
              text={sel}
              className="btn btn-block"
              label="Address copied"
              size={19}
            />
          </div>
        </div>
      )}
    </Sheet>
  );
}
