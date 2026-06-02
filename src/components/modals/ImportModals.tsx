// Import-address modals: 24-word recovery phrase, and encrypted wallet.key.

import { useEffect, useState } from "react";
import { Modal, Field, Spinner } from "../ui";
import { useToast } from "../../lib/toast";
import {
  importWalletKey,
  previewMnemonicImport,
  importMnemonicScheme,
  formatBalanceCompact,
  type MnemonicScheme,
  type MnemonicCandidate,
} from "../../lib/rpc";
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
  const [scheme, setScheme] = useState<MnemonicScheme>("standard");
  const [preview, setPreview] = useState<{
    standard: MnemonicCandidate;
    legacy: MnemonicCandidate;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const valid = words.length === 24;

  // The same 24 words map to two different addresses (standard BIP39 vs the
  // legacy raw-key scheme), so once a full phrase is entered we derive both
  // and let the user pick. Debounced so we don't derive on every keystroke.
  useEffect(() => {
    if (!valid) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewErr(null);
    const handle = setTimeout(() => {
      previewMnemonicImport(phrase.trim())
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          // Default to the address that actually holds coins, so a user
          // migrating an old phrase lands on their funded address without
          // having to understand the scheme. Tie / both-empty → standard.
          const sb = p.standard.balance ?? 0;
          const lb = p.legacy.balance ?? 0;
          if (lb > 0 && sb === 0) setScheme("legacy");
          else setScheme("standard");
        })
        .catch((e) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewErr(humanizeError(e));
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [phrase, valid]);

  const chosenAddress = preview ? preview[scheme].address : null;
  // Exactly one candidate funded → no choice to make: show "found your wallet"
  // and import it. null (both funded, both empty, or chain unreachable) → keep
  // the picker so the user decides.
  const fundedScheme: MnemonicScheme | null = preview
    ? ((preview.standard.balance ?? 0) > 0) !== ((preview.legacy.balance ?? 0) > 0)
      ? (preview.standard.balance ?? 0) > 0
        ? "standard"
        : "legacy"
      : null
    : null;

  async function go() {
    if (!valid) {
      toast.error(t("imp.must24"), t("imp.must24Body", { n: words.length }));
      return;
    }
    setBusy(true);
    try {
      const res = await importMnemonicScheme(
        phrase.trim(),
        scheme,
        label.trim() || undefined,
      );
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
          <button
            className="btn btn-block"
            disabled={!valid || busy || !!previewErr}
            onClick={go}
          >
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

        {valid && (previewing || preview || previewErr) && (
          <Field label={preview && fundedScheme ? t("imp.foundTitle") : t("imp.schemeTitle")}>
            {!fundedScheme && (
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 8 }}>
                {t("imp.schemeHint")}
              </div>
            )}
            {previewing && (
              <div className="dim" style={{ fontSize: 13 }}>
                <Spinner /> {t("imp.previewing")}
              </div>
            )}
            {previewErr && (
              <div className="banner banner-danger" style={{ fontSize: 12.5 }}>
                {t("imp.previewFail")}
              </div>
            )}
            {preview && fundedScheme && (
              <div
                style={{
                  padding: "13px 14px",
                  borderRadius: 12,
                  border: "1px solid var(--accent)",
                  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                  display: "grid",
                  gap: 4,
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 700 }}>
                  {formatBalanceCompact(preview[fundedScheme].balance ?? 0)}
                </span>
                <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {shortAddress(preview[fundedScheme].address)}
                </span>
              </div>
            )}
            {preview && !fundedScheme && (
              <div style={{ display: "grid", gap: 8 }}>
                {(
                  [
                    ["standard", t("imp.schemeStandard"), preview.standard],
                    ["legacy", t("imp.schemeLegacy"), preview.legacy],
                  ] as [MnemonicScheme, string, MnemonicCandidate][]
                ).map(([key, title, cand]) => {
                  const active = scheme === key;
                  const funded = (cand.balance ?? 0) > 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setScheme(key)}
                      style={{
                        textAlign: "left",
                        cursor: "pointer",
                        padding: "11px 12px",
                        borderRadius: 11,
                        border: `1px solid ${active ? "var(--accent)" : "var(--border-soft)"}`,
                        background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--surface-2)",
                        display: "grid",
                        gap: 3,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: funded ? "var(--accent)" : "var(--text-dim)",
                          }}
                        >
                          {cand.balance == null ? "—" : formatBalanceCompact(cand.balance)}
                        </span>
                      </div>
                      <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {shortAddress(cand.address)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        )}

        <Field label={t("imp.labelOptional")}>
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("imp.labelPlaceholder")}
          />
        </Field>

        {chosenAddress && !fundedScheme && (
          <div className="dim" style={{ fontSize: 12.5 }}>
            {t("imp.willImport")}{" "}
            <span className="mono">{shortAddress(chosenAddress)}</span>
          </div>
        )}
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
  // The password is OPTIONAL — an unencrypted key file imports with it blank.
  async function go() {
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
            disabled={busy}
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
        <Field label={t("imp.filePasswordOpt")}>
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t("imp.filePwPlaceholder")}
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
