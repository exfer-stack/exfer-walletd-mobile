// Send — multi-recipient builder with live fee simulation, review, broadcast,
// and a receipt screen. Wired to simulate_transfer / transfer.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../lib/icons";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import {
  rpc,
  formatExfer,
  formatBalanceCompact,
  parseExferAmount,
} from "../../lib/rpc";
import type { TransferReceipt } from "../../lib/types";
import { isHidden } from "../../lib/hidden";
import { addrName } from "../../lib/format";
import { shortAddress } from "../../lib/labels";
import { appendHistory, listRecentRecipients, rememberRecipient } from "../../lib/history";
import { Sheet, CopyButton, AddrAvatar, RvRow, Spinner } from "../ui";
import { useCountUp } from "../../lib/anim";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const FEE_RATE = 1;

interface OutputDraft {
  to: string;
  amount: string;
}

export function SendSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (tab?: "wallet" | "activity" | "settings") => void;
}) {
  const { balance, refresh } = useWallet();
  const toast = useToast();
  const entries = balance?.entries ?? [];
  const sendable = entries.filter((a) => !isHidden(a.address) && a.balance > 0);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [from, setFrom] = useState<string>(sendable[0]?.address ?? "");
  const [outputs, setOutputs] = useState<OutputDraft[]>([{ to: "", amount: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  // Live fee from simulate_transfer; null until a valid template simulates.
  const [simFee, setSimFee] = useState<number | null>(null);

  const fromEntry = entries.find((a) => a.address === from);
  const total = useMemo(
    () =>
      outputs.reduce((s, o) => {
        try {
          return s + parseExferAmount(o.amount);
        } catch {
          return s;
        }
      }, 0),
    [outputs],
  );
  // Count the receipt amount up from 0 when the success screen appears.
  const shownTotal = useCountUp(step === 3 ? total : 0, 650);
  const recents = useMemo(() => listRecentRecipients().slice(0, 4), []);
  // Fall back to a rough local estimate before the sim returns.
  const fee = simFee ?? FEE_RATE * (70 + 45 * outputs.length);

  // Debounced fee simulation: whenever the (valid) template changes, ask the
  // node for the exact fee so the review total is real.
  useEffect(() => {
    if (step !== 1) return;
    const parsed: { to: string; amount: number }[] = [];
    for (const o of outputs) {
      if (!HEX64.test(o.to.trim())) {
        setSimFee(null);
        return;
      }
      try {
        const amt = parseExferAmount(o.amount);
        if (amt <= 0) {
          setSimFee(null);
          return;
        }
        parsed.push({ to: o.to.trim().toLowerCase(), amount: amt });
      } catch {
        setSimFee(null);
        return;
      }
    }
    if (!from) {
      setSimFee(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await rpc<{ fee: number }>("simulate_transfer", {
          from,
          outputs: parsed,
          fee_rate: FEE_RATE,
        });
        if (!cancelled) setSimFee(res.fee);
      } catch {
        if (!cancelled) setSimFee(null);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [outputs, from, step]);

  function setOut(i: number, patch: Partial<OutputDraft>) {
    setOutputs((p) => p.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function addRow() {
    if (outputs.length < 16) setOutputs((p) => [...p, { to: "", amount: "" }]);
  }
  function rmRow(i: number) {
    setOutputs((p) => p.filter((_, k) => k !== i));
  }

  function validate(): string | null {
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (!HEX64.test(o.to.trim()))
        return `Recipient ${i + 1}: that doesn't look like a valid address.`;
      try {
        if (parseExferAmount(o.amount) <= 0) return `Recipient ${i + 1}: enter an amount.`;
      } catch (e) {
        return `Recipient ${i + 1}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (!from) return "Pick a sending address.";
    if (total + fee > (fromEntry?.balance ?? 0))
      return "Insufficient confirmed balance for amount + fee.";
    return null;
  }

  function goReview() {
    const e = validate();
    if (e) {
      setErr(e);
      return;
    }
    setErr(null);
    setStep(2);
  }

  async function broadcast() {
    setBusy(true);
    try {
      const parsed = outputs.map((o) => ({
        to: o.to.trim().toLowerCase(),
        amount: parseExferAmount(o.amount),
      }));
      const r = await rpc<TransferReceipt>("transfer", {
        from,
        outputs: parsed,
        fee_rate: FEE_RATE,
      });
      appendHistory(r);
      for (const o of parsed) rememberRecipient(o.to);
      setReceipt(r);
      setStep(3);
      await refresh();
      toast.success("Transfer broadcast", `Sent ${formatExfer(total)}.`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setErr(msg);
      toast.error("Transfer failed", msg);
    } finally {
      setBusy(false);
    }
  }

  /* step 3 — receipt */
  if (step === 3 && receipt) {
    const recipientCount = receipt.outputs.filter((o) => !o.is_change).length;
    return (
      <Sheet title="Sent" onClose={onClose} height="86%">
        <div style={{ textAlign: "center", padding: "10px 0 22px" }}>
          <div style={{ position: "relative", width: 72, height: 72, margin: "0 auto 16px" }}>
            <span className="success-ring" />
            <div
              className="success-disc"
              style={{
                width: 72,
                height: 72,
                borderRadius: 999,
                display: "grid",
                placeItems: "center",
                background: "color-mix(in srgb,#34d399 18%,transparent)",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width={34}
                height={34}
                fill="none"
                stroke="#34d399"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path className="success-check" pathLength={1} d="M5 12.5l4.2 4.2L19 6.5" />
              </svg>
            </div>
          </div>
          <div className="mono" style={{ fontSize: 30, fontWeight: 600 }}>
            {formatExfer(shownTotal).replace(" EXFER", "")}
            <span className="dim" style={{ fontSize: 16 }}>
              {" "}
              EXFER
            </span>
          </div>
          <div className="dim" style={{ fontSize: 14, marginTop: 5 }}>
            sent · in mempool
          </div>
        </div>
        <div className="card" style={{ overflow: "hidden", marginBottom: 14 }}>
          <RvRow label="Recipients" value={`${recipientCount}`} />
          <RvRow label="Network fee" value={formatExfer(receipt.fee)} mono />
          <RvRow label="Size" value={`${receipt.size} bytes`} mono />
          <RvRow
            label="Built at height"
            value={receipt.built_at_height.toLocaleString()}
            mono
            last
          />
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
              {receipt.tx_id}
            </code>
            <CopyButton text={receipt.tx_id} label="Tx ID copied" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="btn btn-secondary btn-block"
            onClick={() => {
              onDone("activity");
              onClose();
            }}
          >
            View in Activity
          </button>
          <button className="btn btn-block" onClick={onClose}>
            Done
          </button>
        </div>
      </Sheet>
    );
  }

  /* step 2 — review */
  if (step === 2) {
    return (
      <Sheet
        title="Review & send"
        onBack={() => setStep(1)}
        onClose={onClose}
        height="90%"
        footer={
          <button className="btn btn-block" disabled={busy} onClick={broadcast}>
            {busy ? (
              <>
                <Spinner /> Broadcasting…
              </>
            ) : (
              `Confirm — send ${formatExfer(total).replace(" EXFER", "")} EXFER`
            )}
          </button>
        }
      >
        <div className="eyebrow" style={{ margin: "2px 0 9px" }}>
          From
        </div>
        <div
          className="card"
          style={{
            padding: "13px 14px",
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginBottom: 18,
          }}
        >
          <AddrAvatar address={from} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {fromEntry ? addrName(fromEntry) : "—"}
            </div>
            <div className="mono faint" style={{ fontSize: 12 }}>
              {shortAddress(from, 6, 6)}
            </div>
          </div>
          <div className="mono dim" style={{ fontSize: 13.5 }}>
            {formatBalanceCompact(fromEntry?.balance ?? 0).replace(" EXFER", "")}
          </div>
        </div>

        <div className="eyebrow" style={{ marginBottom: 9 }}>
          To
        </div>
        <div className="card" style={{ overflow: "hidden", marginBottom: 18 }}>
          {outputs.map((o, i) => (
            <div
              key={i}
              style={{
                padding: "13px 14px",
                borderBottom: i < outputs.length - 1 ? "1px solid var(--border-soft)" : "0",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <AddrAvatar address={o.to.trim().toLowerCase()} size={34} />
              <code className="mono" style={{ flex: 1, fontSize: 12.5, color: "var(--text-dim)" }}>
                {shortAddress(o.to.trim(), 8, 8)}
              </code>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14.5 }}>
                {o.amount}
              </span>
            </div>
          ))}
        </div>

        <div className="card card-2" style={{ overflow: "hidden" }}>
          <RvRow
            label="Amount"
            value={`${formatExfer(total).replace(" EXFER", "")} EXFER`}
            mono
          />
          <RvRow
            label="Network fee"
            value={`${formatExfer(fee).replace(" EXFER", "")} EXFER`}
            mono
          />
          <RvRow
            label="Total debit"
            value={`${formatExfer(total + fee).replace(" EXFER", "")} EXFER`}
            mono
            strong
            last
          />
        </div>
        {err && <div className="banner banner-danger" style={{ marginTop: 14 }}>{err}</div>}
      </Sheet>
    );
  }

  /* step 1 — recipients */
  return (
    <Sheet
      title="Send"
      onClose={onClose}
      height="92%"
      footer={
        <button
          className="btn btn-block"
          disabled={sendable.length === 0}
          onClick={goReview}
        >
          Review
        </button>
      }
    >
      {sendable.length === 0 ? (
        <div className="banner banner-warn">
          No spendable balance. Receive some EXFER first.
        </div>
      ) : (
        <>
          {sendable.length > 1 ? (
            <>
              <div className="eyebrow" style={{ margin: "2px 0 9px" }}>
                From
              </div>
              <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
                {sendable.map((a) => (
                  <button
                    key={a.address}
                    onClick={() => setFrom(a.address)}
                    className="tap"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      padding: "12px 13px",
                      borderRadius: 14,
                      cursor: "pointer",
                      textAlign: "left",
                      border:
                        "1px solid " +
                        (from === a.address ? "var(--accent)" : "var(--border-soft)"),
                      background:
                        from === a.address
                          ? "color-mix(in srgb,var(--accent) 10%,transparent)"
                          : "var(--surface)",
                    }}
                  >
                    <AddrAvatar address={a.address} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14.5 }}>{addrName(a)}</div>
                      <div className="mono faint" style={{ fontSize: 11.5 }}>
                        {shortAddress(a.address, 6, 6)}
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 13.5, fontWeight: 500 }}>
                      {formatBalanceCompact(a.balance).replace(" EXFER", "")}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            // Single fundable address: no decision to make — show it as a
            // calm, non-interactive line instead of a picker.
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "12px 13px",
                borderRadius: 14,
                border: "1px solid var(--border-soft)",
                background: "var(--surface)",
                marginBottom: 20,
              }}
            >
              <AddrAvatar address={sendable[0].address} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="eyebrow" style={{ marginBottom: 2 }}>From</div>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                  {addrName(sendable[0])}
                </div>
              </div>
              <div className="mono" style={{ fontSize: 13.5, fontWeight: 500 }}>
                {formatBalanceCompact(sendable[0].balance).replace(" EXFER", "")}
              </div>
            </div>
          )}

          <div className="h-row" style={{ marginBottom: 9 }}>
            <div className="eyebrow">Recipients ({outputs.length}/16)</div>
            <button
              className="tap"
              onClick={addRow}
              disabled={outputs.length >= 16}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "7px 13px",
                borderRadius: 999,
                cursor: "pointer",
                background: "var(--surface-2)",
                color: "var(--accent)",
                fontSize: 13.5,
                fontWeight: 600,
                opacity: outputs.length >= 16 ? 0.4 : 1,
              }}
            >
              <Icon name="plus" size={15} /> Add
            </button>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {outputs.map((o, i) => (
              <div key={i} className="card card-2" style={{ padding: 13 }}>
                <div className="h-row" style={{ marginBottom: 9 }}>
                  <span
                    className="faint"
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                    }}
                  >
                    Recipient {i + 1}
                  </span>
                  {outputs.length > 1 && (
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => rmRow(i)}
                      style={{ color: "#f87171", padding: "3px 7px" }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 9 }}>
                  <input
                    className="field mono"
                    style={{ flex: 1 }}
                    placeholder="Paste address"
                    value={o.to}
                    onChange={(e) => setOut(i, { to: e.target.value })}
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      try {
                        const t = await navigator.clipboard.readText();
                        if (t) setOut(i, { to: t.trim() });
                      } catch {
                        /* clipboard blocked — user can still type/scan */
                      }
                    }}
                  >
                    <Icon name="copy" size={15} /> Paste
                  </button>
                </div>
                <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                  <input
                    className="field mono"
                    style={{ flex: 1 }}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={o.amount}
                    onChange={(e) => setOut(i, { amount: e.target.value })}
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      if (!fromEntry) return;
                      const max = Math.max(0, fromEntry.balance - fee);
                      setOut(i, { amount: formatExfer(max).replace(" EXFER", "") });
                    }}
                  >
                    Max
                  </button>
                </div>
                {recents.length > 0 && i === 0 && !o.to && (
                  <div style={{ marginTop: 12 }}>
                    <div className="eyebrow" style={{ marginBottom: 8 }}>Recent</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {recents.map((r) => (
                        <button
                          key={r}
                          onClick={() => setOut(i, { to: r })}
                          className="tap"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 13px 7px 7px",
                            borderRadius: 999,
                            cursor: "pointer",
                            background: "var(--elevated)",
                            border: "1px solid var(--border)",
                          }}
                        >
                          <AddrAvatar address={r} size={22} />
                          <span
                            className="mono"
                            style={{ fontSize: 12.5, color: "var(--text)" }}
                          >
                            {shortAddress(r, 5, 4)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className="card"
            style={{
              padding: "13px 15px",
              marginTop: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <span className="dim" style={{ fontSize: 14 }}>
              Total to send
            </span>
            <span className="mono" style={{ fontSize: 19, fontWeight: 600 }}>
              {formatExfer(total).replace(" EXFER", "")}{" "}
              <span className="dim" style={{ fontSize: 13 }}>
                EXFER
              </span>
            </span>
          </div>
          {err && <div className="banner banner-danger" style={{ marginTop: 14 }}>{err}</div>}
        </>
      )}
    </Sheet>
  );
}
