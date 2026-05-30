// Import-address modals: 24-word recovery phrase, and encrypted wallet.key.

import { useState } from "react";
import { Icon } from "../../lib/icons";
import { Modal, Field, Spinner } from "../ui";
import { useToast } from "../../lib/toast";
import { rpc, importWalletKey } from "../../lib/rpc";
import { shortAddress } from "../../lib/labels";
import { setLabel as saveLabel } from "../../lib/labels";
import { pickFile } from "../../lib/dialog";

export function ImportPhraseModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [phrase, setPhrase] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const valid = words.length === 24;

  async function go() {
    if (!valid) {
      toast.error("Recovery phrase must be 24 words", `You entered ${words.length}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await rpc<{ address: string }>("import_mnemonic", {
        mnemonic: phrase.trim(),
        label: label.trim() || null,
      });
      if (label.trim()) saveLabel(res.address, label.trim());
      await onImported();
      toast.success("Address imported", shortAddress(res.address));
      onClose();
    } catch (e) {
      toast.error("Import failed", String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import recovery phrase"
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
          <button className="btn btn-block" disabled={!valid || busy} onClick={go}>
            {busy ? <Spinner /> : "Import"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Imports one address from its 24-word recovery phrase. It joins your wallet
        as an independent key.
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label={`Recovery phrase (${words.length}/24 words)`}>
          <textarea
            className="field mono"
            style={{ height: 88, resize: "none", fontSize: 13 }}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 … word24"
            spellCheck={false}
            autoFocus
          />
        </Field>
        <Field label="Label (optional)">
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. cold storage"
          />
        </Field>
      </div>
    </Modal>
  );
}

export function ImportKeyFileModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function choose() {
    try {
      const p = await pickFile({
        title: "Choose wallet.key file",
        filters: [{ name: "Wallet key", extensions: ["key"] }],
      });
      if (p) setPath(p);
    } catch (e) {
      toast.error("Could not open file picker", String(e));
    }
  }

  async function go() {
    if (!path || !pw) return;
    setBusy(true);
    try {
      const address = await importWalletKey({
        path,
        filePassword: pw,
        label: label.trim() || undefined,
      });
      if (label.trim()) saveLabel(address, label.trim());
      await onImported();
      toast.success("Address imported", shortAddress(address));
      onClose();
    } catch (e) {
      toast.error("Import failed", String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import wallet.key"
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
          <button
            className="btn btn-block"
            disabled={!path || !pw || busy}
            onClick={go}
          >
            {busy ? <Spinner /> : "Import"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Adds an externally-held address from an encrypted <b>.key</b> file (e.g.
        exported from exfer.dev).
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <button
          className="card card-2 tap"
          onClick={choose}
          style={{
            padding: 14,
            border: "1px dashed var(--border)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 11,
            textAlign: "left",
          }}
        >
          <Icon name="key" size={22} />
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>
              {path ? "wallet.key selected" : "Choose wallet.key file"}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>
              {path ?? "Tap to browse"}
            </span>
          </span>
          {path && (
            <span style={{ color: "var(--accent)" }}>
              <Icon name="check" size={20} />
            </span>
          )}
        </button>
        <Field label="File password">
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        <Field label="Label (optional)">
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. cold storage"
          />
        </Field>
      </div>
    </Modal>
  );
}
