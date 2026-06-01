// Import-address modals: 24-word recovery phrase, and encrypted wallet.key.

import { useState } from "react";
import { Modal, Field, Spinner } from "../ui";
import { useToast } from "../../lib/toast";
import { rpc, importWalletKey } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
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
  const { t } = useT();
  const [phrase, setPhrase] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const valid = words.length === 24;

  async function go() {
    if (!valid) {
      toast.error(t("imp.must24"), t("imp.must24Body", { n: words.length }));
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
      toast.success(t("imp.imported"), shortAddress(res.address));
      onClose();
    } catch (e) {
      toast.error(t("imp.importFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("imp.phraseTitle")}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-secondary btn-block"
            onClick={onClose}
            disabled={busy}
          >
            {t("sheet.cancel")}
          </button>
          <button className="btn btn-block" disabled={!valid || busy} onClick={go}>
            {busy ? <Spinner /> : t("imp.import")}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        {t("imp.phraseInfo")}
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label={t("imp.phraseLabel", { n: words.length })}>
          <textarea
            className="field mono"
            style={{ height: 88, resize: "none", fontSize: 13 }}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={t("imp.phrasePlaceholder")}
            spellCheck={false}
            autoFocus
          />
        </Field>
        <Field label={t("imp.labelOptional")}>
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("imp.labelPlaceholder")}
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
  const { t } = useT();
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
      toast.success(t("imp.imported"), shortAddress(address));
      onClose();
    } catch (e) {
      toast.error(t("imp.importFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("imp.keyTitle")}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-secondary btn-block"
            onClick={onClose}
            disabled={busy}
          >
            {t("sheet.cancel")}
          </button>
          <button
            className="btn btn-block"
            disabled={!pw || busy}
            onClick={go}
          >
            {busy ? <Spinner /> : t("imp.chooseImport")}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        {t("imp.keyInfo")}
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label={t("imp.filePassword")}>
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        <Field label={t("imp.labelOptional")}>
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("imp.labelPlaceholder")}
          />
        </Field>
      </div>
    </Modal>
  );
}
