// Create a new address — generate a fresh independent key and (optionally)
// name it in one step. The primary action is "create"; importing an existing
// address is a secondary link so the common case is one tap, not a menu.

import { useState } from "react";
import { Modal, Field, Spinner } from "../ui";
import { Icon } from "../../lib/icons";
import { useToast } from "../../lib/toast";
import { rpc } from "../../lib/rpc";
import { setLabel, shortAddress } from "../../lib/labels";

export function NewAddressModal({
  onClose,
  onCreated,
  onImport,
}: {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  onImport: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await rpc<{ address: string }>("generate_independent_address");
      const label = name.trim();
      if (label) setLabel(res.address, label);
      await onCreated();
      toast.success(
        "Address created",
        label ? `“${label}” is ready to receive.` : shortAddress(res.address),
      );
      onClose();
    } catch (e) {
      toast.error(
        "Could not create address",
        String(e instanceof Error ? e.message : e),
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New address"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-secondary btn-block"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn btn-block" disabled={busy} onClick={create}>
            {busy ? <Spinner /> : "Create"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Generates a fresh key in your wallet. Give it a name so you can tell it
        apart — a private nickname, stored only on this device.
      </div>
      <Field label="Name (optional)">
        <input
          className="field"
          autoFocus
          value={name}
          maxLength={28}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. deposits, savings…"
          onKeyDown={(e) => e.key === "Enter" && !busy && create()}
        />
      </Field>
      {/* Secondary path as a tappable list-row — clearly an entry point, not
          body copy. */}
      <button
        className="tap"
        onClick={onImport}
        disabled={busy}
        style={{
          marginTop: 18,
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "11px 13px",
          borderRadius: 14,
          border: "1px solid var(--border-soft)",
          background: "var(--surface-2)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            background: "color-mix(in srgb, var(--accent) 15%, transparent)",
            color: "var(--accent)",
          }}
        >
          <Icon name="key" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Import an existing key
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            Recovery phrase or wallet.key
          </div>
        </div>
        <Icon name="chevron" size={18} />
      </button>
    </Modal>
  );
}
