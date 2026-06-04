// A branded EXFER account picker, shared by the Swap and Liquidity sheets.
// Shows the selected account (identicon + name + short address + balance) and
// expands an inline list of the same — so the choice reads as "which of my
// accounts", not "a string". Extracted from SwapSheet so both flows look
// identical and the user can always see/choose which address funds an action.

import { useState } from "react";
import type { WalletEntry } from "../lib/types";
import { AddrAvatar } from "./ui";
import { shortAddress } from "../lib/labels";
import { addrName } from "../lib/format";
import { splitBalanceCompact } from "../lib/rpc";

export function BalCell({ bal }: { bal: number }) {
  const { whole, frac } = splitBalanceCompact(bal);
  return (
    <span style={{ textAlign: "right", flex: "0 0 auto" }}>
      <span className="mono" style={{ display: "block", fontSize: 13, fontWeight: 600, color: bal > 0 ? "var(--text)" : "var(--text-faint)" }}>
        {whole}
        {frac && <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>.{frac}</span>}
      </span>
      <span style={{ display: "block", fontSize: 10, color: "var(--text-faint)", letterSpacing: ".06em" }}>EXFER</span>
    </span>
  );
}

export function AddrPicker({
  items,
  value,
  onChange,
}: {
  items: WalletEntry[];
  value: string;
  onChange: (a: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sel = items.find((a) => a.address === value) ?? items[0];
  if (!sel) return null;
  return (
    <div style={{ position: "relative", marginBottom: 14 }}>
      <button
        type="button"
        className="field"
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left", ...(open ? { borderColor: "var(--accent)" } : null) }}
      >
        <AddrAvatar address={sel.address} size={30} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {addrName(sel)}
          </span>
          <span className="mono" style={{ display: "block", fontSize: 12, color: "var(--text-faint)" }}>
            {shortAddress(sel.address)}
          </span>
        </span>
        <BalCell bal={sel.balance} />
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          style={{ flex: "0 0 auto", transition: "transform .18s", transform: open ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className="card"
          style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 5, padding: 4, maxHeight: 240, overflowY: "auto", background: "var(--elevated)", boxShadow: "var(--shadow)" }}
        >
          {items.map((a) => {
            const active = a.address === sel.address;
            return (
              <button
                key={a.address}
                type="button"
                className="tap"
                onClick={() => { onChange(a.address); setOpen(false); }}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderRadius: 10, border: 0, cursor: "pointer", textAlign: "left", font: "inherit", color: "var(--text)", background: active ? "var(--surface-2)" : "none" }}
              >
                <AddrAvatar address={a.address} size={28} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {addrName(a)}
                  </span>
                  <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)" }}>
                    {shortAddress(a.address)}
                  </span>
                </span>
                <BalCell bal={a.balance} />
                <span style={{ width: 16, flex: "0 0 auto", display: "inline-flex", justifyContent: "center" }}>
                  {active && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
