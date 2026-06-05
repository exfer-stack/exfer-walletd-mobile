// Set up the wallet's BNB (BSC/EVM) key — generate a fresh one or import an
// existing MetaMask account. This is the single creation surface the Home /
// Swap / Liquidity entry points all route to when `created == false`.
//
// GENERATE: bsc_create_address → show the 24-word mnemonic → require an "I've
// backed it up" confirmation before Done. The BNB wallet has its OWN mnemonic
// (independent of the EXFER seed), MetaMask-compatible at m/44'/60'/0'/0/0.
//
// IMPORT: a raw private key (0x + 64 hex) via bsc_import_key, or a 12/24-word
// BIP-39 phrase via bsc_import_mnemonic. Both MetaMask-compatible.

import { useState } from "react";
import { copyText } from "../../lib/clipboard";
import { Modal, Field, Spinner, CopyButton } from "../ui";
import { Icon } from "../../lib/icons";
import { useToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";
import { humanizeError } from "../../lib/errors";
import {
  createBscWallet,
  importBscKey,
  importBscMnemonic,
} from "../../lib/bscWallet";

type Mode = "choose" | "generate" | "import";
type ImportKind = "key" | "phrase";

export function CreateBnbWalletSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>("choose");

  return (
    <Modal title={t("bnb.setupTitle")} onClose={onClose}>
      {mode === "choose" && <ChoosePane onPick={setMode} />}
      {mode === "generate" && (
        <GeneratePane onClose={onClose} onCreated={onCreated} onBack={() => setMode("choose")} />
      )}
      {mode === "import" && (
        <ImportPane onClose={onClose} onCreated={onCreated} onBack={() => setMode("choose")} />
      )}
    </Modal>
  );
}

/** First step: generate a new BNB wallet, or import one you already have. */
function ChoosePane({ onPick }: { onPick: (m: Mode) => void }) {
  const { t } = useT();
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="banner banner-info" style={{ marginBottom: 2 }}>
        {t("bnb.setupBody")}
      </div>
      <OptionRow
        icon="plus"
        title={t("bnb.genTitle")}
        sub={t("bnb.genSub")}
        onClick={() => onPick("generate")}
      />
      <OptionRow
        icon="key"
        title={t("bnb.importTitle")}
        sub={t("bnb.importSub")}
        onClick={() => onPick("import")}
      />
    </div>
  );
}

function OptionRow({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      className="tap"
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 13px",
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
        <Icon name={icon} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.4 }}>{sub}</div>
      </div>
      <Icon name="chevron" size={18} />
    </button>
  );
}

/** Generate a fresh BNB wallet, reveal the 24 words, require a backup confirm. */
function GeneratePane({
  onClose,
  onCreated,
  onBack,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ address: string; words: string[] } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await createBscWallet();
      setResult({ address: r.address, words: r.mnemonic });
    } catch (e) {
      toast.error(t("bnb.genFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  function done() {
    if (!result) return;
    onCreated(result.address);
    toast.success(t("bnb.created"), t("bnb.createdBody"));
    onClose();
  }

  if (!result) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div className="banner banner-info">{t("bnb.genIntro")}</div>
        <button className="btn btn-block" disabled={busy} onClick={generate}>
          {busy ? <Spinner /> : t("bnb.genAction")}
        </button>
        <button className="btn-ghost btn-block" disabled={busy} onClick={onBack}>
          {t("sheet.back")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="banner banner-warn">{t("bnb.backupWarn")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {result.words.map((w, i) => (
          <div
            key={i}
            className="card card-2"
            style={{ padding: "9px 11px", display: "flex", gap: 8, alignItems: "baseline" }}
          >
            <span className="faint mono" style={{ fontSize: 11, width: 16, textAlign: "right" }}>
              {i + 1}
            </span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{w}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            copyText(result.words.join(" "));
            toast.success(t("bnb.copied"));
          }}
        >
          <Icon name="copy" size={15} /> {t("bnb.copyPhrase")}
        </button>
      </div>
      <div>
        <label className="eyebrow">{t("bnb.address")}</label>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--surface-2)",
            borderRadius: 12,
            padding: "10px 12px",
            marginTop: 4,
          }}
        >
          <span className="mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: 12.5 }}>
            {result.address}
          </span>
          <CopyButton text={result.address} />
        </div>
      </div>
      <label
        className="tap"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "11px 12px",
          borderRadius: 12,
          border: `1px solid ${confirmed ? "var(--accent)" : "var(--border-soft)"}`,
          background: confirmed ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--surface-2)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          style={{ marginTop: 2, accentColor: "var(--accent)", width: 16, height: 16, flex: "0 0 auto" }}
        />
        <span style={{ fontSize: 13, lineHeight: 1.5 }}>{t("bnb.backupConfirm")}</span>
      </label>
      <button className="btn btn-block" disabled={!confirmed} onClick={done}>
        {t("sheet.done")}
      </button>
    </div>
  );
}

/** Import an existing MetaMask account: raw private key or BIP-39 phrase. */
function ImportPane({
  onClose,
  onCreated,
  onBack,
}: {
  onClose: () => void;
  onCreated: (address: string) => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [kind, setKind] = useState<ImportKind>("key");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = value.trim();
  const keyValid = /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed);
  const phraseWords = trimmed.split(/\s+/).filter(Boolean);
  const phraseValid = phraseWords.length === 12 || phraseWords.length === 24;
  const valid = kind === "key" ? keyValid : phraseValid;

  async function go() {
    if (!valid) return;
    setBusy(true);
    try {
      const r =
        kind === "key"
          ? await importBscKey(trimmed)
          : await importBscMnemonic(phraseWords.join(" "));
      onCreated(r.address);
      toast.success(t("bnb.imported"), t("bnb.importedBody"));
      onClose();
    } catch (e) {
      toast.error(t("bnb.importFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {(["key", "phrase"] as ImportKind[]).map((k) => {
          const active = kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setValue("");
              }}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 11,
                cursor: "pointer",
                fontSize: 13.5,
                fontWeight: 600,
                border: `1px solid ${active ? "var(--accent)" : "var(--border-soft)"}`,
                background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--surface-2)",
                color: active ? "var(--accent)" : "var(--text)",
              }}
            >
              {k === "key" ? t("bnb.tabKey") : t("bnb.tabPhrase")}
            </button>
          );
        })}
      </div>

      {kind === "key" ? (
        <Field label={t("bnb.keyLabel")} help={t("bnb.keyHelp")}>
          <input
            className="field mono"
            placeholder="0x…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoFocus
            style={{ fontSize: 13 }}
          />
        </Field>
      ) : (
        <Field label={t("bnb.phraseLabel", { n: phraseWords.length })} help={t("bnb.phraseHelp")}>
          <textarea
            className="field mono"
            style={{ height: 88, resize: "none", fontSize: 13 }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("bnb.phrasePlaceholder")}
            spellCheck={false}
            autoFocus
          />
        </Field>
      )}

      <button className="btn btn-block" disabled={!valid || busy} onClick={go}>
        {busy ? <Spinner /> : t("bnb.importAction")}
      </button>
      <button className="btn-ghost btn-block" disabled={busy} onClick={onBack}>
        {t("sheet.back")}
      </button>
    </div>
  );
}
