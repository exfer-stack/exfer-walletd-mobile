// Import-address modals: 24-word recovery phrase, and encrypted wallet.key.

import { useState } from "react";
import { Modal, Field, Spinner } from "../ui";
import { useToast } from "../../lib/toast";
import { rpc, importWalletKey } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { shortAddress } from "../../lib/labels";
import { setLabel as saveLabel } from "../../lib/labels";

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
      toast.error("Import failed", humanizeError(e));
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
  const [pw, setPw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  // The file is picked inside importWalletKey() (a document picker that
  // works on iOS + Android); the user taps Import, then chooses the file.
  async function go() {
    if (!pw) return;
    setBusy(true);
    try {
      const address = await importWalletKey({
        filePassword: pw,
        label: label.trim() || undefined,
      });
      if (label.trim()) saveLabel(address, label.trim());
      await onImported();
      toast.success("Address imported", shortAddress(address));
      onClose();
    } catch (e) {
      toast.error("Import failed", humanizeError(e));
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
            disabled={!pw || busy}
            onClick={go}
          >
            {busy ? <Spinner /> : "Choose file & import"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Adds an externally-held address from an encrypted <b>.key</b> file (e.g.
        exported from exfer.dev). Enter the file's password, then tap Import to
        choose the <b>.key</b> file.
      </div>
      <div style={{ display: "grid", gap: 12 }}>
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
