// Send — multi-recipient builder with live fee simulation, review, broadcast,
// and a receipt screen. Wired to simulate_transfer / transfer.

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { scanSupported } from "../../lib/scan";
import { ScannerOverlay } from "../ScannerOverlay";
import { biometricStatus, biometricUnlock } from "../../lib/biometric";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const FEE_RATE = 1;

interface OutputDraft {
  to: string;
  amount: string;
}

type NoteKind = "err" | "warn" | "ok" | "info";

const NOTE_COLOR: Record<NoteKind, string> = {
  err: "#f87171",
  warn: "#fbbf24",
  ok: "#34d399",
  info: "var(--text-faint)",
};

/** Small inline field-level hint shown under a recipient's address/amount. */
function FieldNote({ kind, children }: { kind: NoteKind; children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        lineHeight: 1.4,
        color: NOTE_COLOR[kind],
        padding: "1px 2px",
      }}
    >
      {children}
    </div>
  );
}

export function SendSheet({
  onClose,
  onDone,
  initialFrom,
}: {
  onClose: () => void;
  onDone: (tab?: "wallet" | "activity" | "settings") => void;
  /** Preselect the sending address — set when Send is opened from an
   *  address's detail sheet so the user sends from the address they tapped. */
  initialFrom?: string;
}) {
  const { balance, refresh, suspendPolling } = useWallet();
  const toast = useToast();

  // Pause the background balance poll for the lifetime of the Send sheet so the
  // upstream node's balance/utxo rate-limit budget is free for this flow's own
  // simulate_transfer + transfer queries. Resumes on close.
  useEffect(() => suspendPolling(), [suspendPolling]);
  const entries = balance?.entries ?? [];
  const sendable = entries.filter((a) => !isHidden(a.address) && a.balance > 0);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [from, setFrom] = useState<string>(initialFrom ?? "");
  // Effective sender: the user pick, else the first fundable address.
  // Derived (not frozen) so it is correct even if balance loads after mount.
  const fromAddr = from || sendable[0]?.address || "";
  const [outputs, setOutputs] = useState<OutputDraft[]>([{ to: "", amount: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  // Which recipient row (index) is currently scanning a QR, or null.
  const [scanRow, setScanRow] = useState<number | null>(null);
  // Live fee from simulate_transfer; null until a valid template simulates.
  const [simFee, setSimFee] = useState<number | null>(null);
  // Which recipient row (if any) is pinned to "Max". Its amount auto-tracks
  // (balance − fee − other rows) so it stays exact as the fee re-simulates
  // and never trips the insufficient-funds guard. Cleared when that row's
  // amount is edited by hand.
  const [maxRow, setMaxRow] = useState<number | null>(null);

  const fromEntry = entries.find((a) => a.address === fromAddr);
  // Own addresses + addresses we've sent to before — used to flag a brand-new
  // recipient (the classic "one wrong character, funds gone" footgun) and to
  // note when a recipient is actually one of the user's own addresses.
  const ownSet = useMemo(
    () => new Set(entries.map((a) => a.address.toLowerCase())),
    [entries],
  );
  const recentSet = useMemo(
    () => new Set(listRecentRecipients().map((a) => a.toLowerCase())),
    [],
  );
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
    if (!fromAddr) {
      setSimFee(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await rpc<{ fee: number }>("simulate_transfer", {
          from: fromAddr,
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
  }, [outputs, fromAddr, step]);

  // Sum of every row except the pinned "Max" row — what Max has to leave room
  // for. Bad/empty amounts count as 0.
  const othersTotal = useMemo(() => {
    if (maxRow === null) return 0;
    return outputs.reduce((s, o, k) => {
      if (k === maxRow) return s;
      try {
        return s + parseExferAmount(o.amount);
      } catch {
        return s;
      }
    }, 0);
  }, [outputs, maxRow]);

  // Keep the Max row exact. Re-runs when the fee re-simulates (`simFee`) or the
  // other rows change (`othersTotal`), so "send max" respects amounts already
  // entered elsewhere and lands exactly on balance − fee — never over. Writing
  // the Max row doesn't change `othersTotal` (it's excluded), so this can't
  // loop; it converges once the simulated fee settles.
  useEffect(() => {
    if (maxRow === null) return;
    const avail = Math.max(0, (fromEntry?.balance ?? 0) - fee - othersTotal);
    const amt = formatExfer(avail).replace(" EXFER", "");
    setOutputs((prev) => {
      if (maxRow >= prev.length || prev[maxRow].amount === amt) return prev;
      return prev.map((o, k) => (k === maxRow ? { ...o, amount: amt } : o));
    });
    // `fee` derives from `simFee` + outputs.length; both are covered via
    // simFee/othersTotal, so they're intentionally omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simFee, othersTotal, maxRow, fromEntry?.balance]);

  function setOut(i: number, patch: Partial<OutputDraft>) {
    setOutputs((p) => p.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  }
  function addRow() {
    if (outputs.length < 16) setOutputs((p) => [...p, { to: "", amount: "" }]);
  }
  function rmRow(i: number) {
    setOutputs((p) => p.filter((_, k) => k !== i));
    // Indices shift on removal — drop the Max pin rather than track it wrong.
    setMaxRow(null);
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
    if (!fromAddr) return "Pick a sending address.";
    if (total + fee > (fromEntry?.balance ?? 0))
      return "Insufficient confirmed balance for amount + fee.";
    return null;
  }

  // Every row has a syntactically-valid address + positive amount. Cross-row
  // checks (sufficient balance) still run in validate() on Review, so the
  // user gets the inline reasons first and only the funds check at the gate.
  const formValid =
    sendable.length > 0 &&
    outputs.every((o) => {
      if (!HEX64.test(o.to.trim())) return false;
      try {
        return parseExferAmount(o.amount) > 0;
      } catch {
        return false;
      }
    });

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
    // Per-send authentication: on a device with biometrics (or a device
    // passcode, via allowDeviceCredential) require a confirm before moving
    // funds — the embedded keystore is unlocked for the session, so without
    // this anyone holding the unlocked phone could send. Devices with no
    // secure lock can't be gated, so we proceed there (and in browser dev).
    const bio = await biometricStatus();
    if (bio.available) {
      const ok = await biometricUnlock(
        `Confirm sending ${formatExfer(total)}`,
      );
      if (!ok) {
        toast.error("Send not confirmed", "Authentication was cancelled or failed.");
        return;
      }
    }
    setBusy(true);
    try {
      const parsed = outputs.map((o) => ({
        to: o.to.trim().toLowerCase(),
        amount: parseExferAmount(o.amount),
      }));
      const r = await rpc<TransferReceipt>("transfer", {
        from: fromAddr,
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
        title="Confirm send"
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
          <AddrAvatar address={fromAddr} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {fromEntry ? addrName(fromEntry) : "—"}
            </div>
            <div className="mono faint" style={{ fontSize: 12 }}>
              {shortAddress(fromAddr, 6, 6)}
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
          {outputs.map((o, i) => {
            const lower = o.to.trim().toLowerCase();
            const tag: { kind: NoteKind; text: string } = ownSet.has(lower)
              ? { kind: "info", text: "Your address" }
              : recentSet.has(lower)
                ? { kind: "ok", text: "Sent here before" }
                : { kind: "warn", text: "New address" };
            return (
            <div
              key={i}
              style={{
                padding: "13px 14px",
                borderBottom: i < outputs.length - 1 ? "1px solid var(--border-soft)" : "0",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <AddrAvatar address={lower} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Full address, wrapped, so the user can verify every
                    character before broadcasting — short forms hide typos. */}
                <code
                  className="mono"
                  style={{
                    display: "block",
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    wordBreak: "break-all",
                    color: "var(--text-dim)",
                  }}
                >
                  {o.to.trim()}
                </code>
                <span
                  style={{
                    display: "inline-block",
                    marginTop: 5,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: ".04em",
                    textTransform: "uppercase",
                    color: NOTE_COLOR[tag.kind],
                  }}
                >
                  {tag.text}
                </span>
              </div>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14.5, whiteSpace: "nowrap" }}>
                {o.amount}
              </span>
            </div>
            );
          })}
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
          disabled={!formValid}
          onClick={goReview}
        >
          Send
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
                        (fromAddr === a.address ? "var(--accent)" : "var(--border-soft)"),
                      background:
                        fromAddr === a.address
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
            {outputs.map((o, i) => {
              // Per-row, live validation + safety hints (#4 / #7). Nothing
              // shows until the field is non-empty, so we don't nag mid-typing.
              const to = o.to.trim();
              const addrValid = HEX64.test(to);
              const lower = to.toLowerCase();
              const isOwn = addrValid && ownSet.has(lower);
              const isKnown = addrValid && recentSet.has(lower);
              const addrNote: { kind: NoteKind; text: string } | null =
                to.length > 0 && !addrValid
                  ? {
                      kind: "err",
                      text: `Address must be 64 hex characters (${to.length}/64).`,
                    }
                  : isOwn
                    ? { kind: "info", text: "This is one of your own addresses." }
                    : addrValid && !isKnown
                      ? {
                          kind: "warn",
                          text: "New address — double-check every character. Transfers can't be reversed.",
                        }
                      : addrValid && isKnown
                        ? { kind: "ok", text: "You've sent to this address before." }
                        : null;
              let amtNote: string | null = null;
              const amtRaw = o.amount.trim();
              if (amtRaw.length > 0) {
                try {
                  if (parseExferAmount(amtRaw) <= 0)
                    amtNote = "Enter an amount greater than 0.";
                } catch (e) {
                  amtNote = e instanceof Error ? e.message : "Invalid amount.";
                }
              }
              return (
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
                <input
                  className="field mono"
                  style={{
                    marginBottom: addrNote ? 6 : 8,
                    borderColor:
                      addrNote?.kind === "err" ? "#f87171" : undefined,
                  }}
                  placeholder="Paste or scan address"
                  value={o.to}
                  onChange={(e) => setOut(i, { to: e.target.value })}
                />
                {addrNote && <FieldNote kind={addrNote.kind}>{addrNote.text}</FieldNote>}
                <div style={{ display: "flex", gap: 8, margin: "8px 0 9px" }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ flex: 1 }}
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
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => {
                      if (!scanSupported()) {
                        toast.info("Scan on device", "QR scanning uses the phone camera.");
                        return;
                      }
                      setScanRow(i);
                    }}
                  >
                    <Icon name="qr" size={15} /> Scan QR
                  </button>
                </div>
                <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                  <input
                    className="field mono"
                    style={{
                      flex: 1,
                      borderColor: amtNote ? "#f87171" : undefined,
                    }}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={o.amount}
                    onChange={(e) => {
                      // A manual edit releases the Max pin on this row.
                      if (maxRow === i) setMaxRow(null);
                      setOut(i, { amount: e.target.value });
                    }}
                  />
                  <button
                    className={
                      "btn btn-sm " + (maxRow === i ? "" : "btn-secondary")
                    }
                    onClick={() => setMaxRow(maxRow === i ? null : i)}
                  >
                    Max
                  </button>
                </div>
                {amtNote && <FieldNote kind="err">{amtNote}</FieldNote>}
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
              );
            })}
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
          {scanRow !== null && (
            <ScannerOverlay
              onResult={(addr) => {
                if (addr && scanRow !== null) setOut(scanRow, { to: addr });
                else if (!addr)
                  toast.info("No address scanned", "Scan cancelled or unreadable.");
                setScanRow(null);
              }}
            />
          )}
        </>
      )}
    </Sheet>
  );
}
