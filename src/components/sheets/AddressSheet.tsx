// Address detail — balance, QR, recovery phrase, export key, rename, hide,
// delete (with funds guard). Wired to walletd via rpc + exportWalletKey.

import { useEffect, useState } from "react";
import { Icon } from "../../lib/icons";
import { MnemonicHelp } from "../MnemonicHelp";
import { useWallet } from "../../lib/wallet";
import { useToast } from "../../lib/toast";
import { rpc, exportWalletKey, formatBalanceCompact, revealMnemonic } from "../../lib/rpc";
import { humanizeError } from "../../lib/errors";
import { shortAddress } from "../../lib/labels";
import { isHidden, hide, unhide } from "../../lib/hidden";
import { addrName } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
  Sheet,
  Modal,
  Field,
  CopyButton,
  ActionMenu,
  Spinner,
} from "../ui";
import { Qr } from "../Qr";
import { LabelModal } from "../modals/LabelModal";

export function AddressSheet({
  address,
  onClose,
  onSend,
}: {
  address: string;
  onClose: () => void;
  /** Start a Send prefilled with this address as the sender. */
  onSend: (address: string) => void;
}) {
  const { balance, refresh, utxos, refreshUtxos } = useWallet();
  const toast = useToast();
  const { t } = useT();
  const entry = (balance?.entries ?? []).find((a) => a.address === address);
  // Force re-render after label/hidden mutations (both live in localStorage).
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  const [menu, setMenu] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  useEffect(() => {
    void refreshUtxos();
  }, [refreshUtxos]);

  if (!entry) return null;
  const bal = entry.balance + (entry.pending_received ?? 0);
  const hidden = isHidden(address);
  const utxoCount = utxos[address]?.utxo_count ?? entry.utxo_count ?? 0;

  function doHide() {
    setMenu(false);
    if (hidden) {
      unhide(address);
      toast.info(t("adr.shown"));
      bump();
    } else {
      hide(address);
      toast.info(t("adr.hidden"));
      onClose();
    }
  }

  return (
    <Sheet
      title={addrName(entry)}
      subtitle={shortAddress(address, 8, 8)}
      onClose={onClose}
      right={
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Actions">
          <Icon name="more" size={20} />
        </button>
      }
      height="auto"
    >
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <div
          className="mono"
          style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.02em" }}
        >
          {formatBalanceCompact(bal).replace(" EXFER", "")}
          <span className="dim" style={{ fontSize: 15, fontWeight: 600 }}>
            {" "}
            EXFER
          </span>
        </div>
        <div
          className="eyebrow"
          style={{ marginTop: 5, letterSpacing: ".12em" }}
        >
          {t("adr.utxos", { n: utxoCount })}
          {(entry.pending_received ?? 0) > 0 &&
            ` · ${t("adr.confirming", { amt: formatBalanceCompact(entry.pending_received ?? 0).replace(" EXFER", "") })}`}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", margin: "0 0 18px" }}>
        <div style={{ background: "#fff", padding: 16, borderRadius: 20 }}>
          <Qr value={address} size={190} />
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
          {address}
        </code>
        <CopyButton text={address} label="Address copied" />
      </div>

      <button
        className="btn btn-block"
        style={{ marginBottom: 10 }}
        disabled={entry.balance <= 0}
        onClick={() => onSend(address)}
      >
        <Icon name="send" size={18} />{" "}
        {entry.balance > 0 ? t("adr.sendFrom") : t("adr.nothingToSend")}
      </button>

      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-secondary btn-block" onClick={() => setPhraseOpen(true)}>
          <Icon name="key" size={18} /> {t("adr.recoveryPhrase")}
        </button>
        <button className="btn btn-secondary btn-block" onClick={() => setExportOpen(true)}>
          <Icon name="export" size={18} /> {t("adr.exportKey")}
        </button>
      </div>

      {menu && (
        <ActionMenu
          title={addrName(entry)}
          onClose={() => setMenu(false)}
          items={[
            {
              icon: "key",
              label: t("adr.menuShowPhrase"),
              onClick: () => {
                setMenu(false);
                setPhraseOpen(true);
              },
            },
            {
              icon: "export",
              label: t("adr.menuExportKey"),
              onClick: () => {
                setMenu(false);
                setExportOpen(true);
              },
            },
            {
              icon: "tag",
              label: addrName(entry) ? t("adr.menuRename") : t("adr.menuAddLabel"),
              onClick: () => {
                setMenu(false);
                setLabelOpen(true);
              },
            },
            {
              icon: "copy",
              label: t("adr.menuCopy"),
              onClick: () => {
                navigator.clipboard?.writeText(address);
                toast.success(t("sheet.copied"));
                setMenu(false);
              },
            },
            {
              icon: hidden ? "eye" : "eye-slash-row",
              label: hidden ? t("adr.menuUnhide") : t("adr.menuHide"),
              onClick: doHide,
            },
            {
              icon: "trash",
              label: t("adr.menuDelete"),
              danger: true,
              onClick: () => {
                setMenu(false);
                setDelOpen(true);
              },
            },
          ]}
        />
      )}
      {labelOpen && (
        <LabelModal address={address} onClose={() => setLabelOpen(false)} onSaved={bump} />
      )}
      {exportOpen && (
        <ExportKeyModal address={address} onClose={() => setExportOpen(false)} />
      )}
      {phraseOpen && (
        <RecoveryPhraseModal address={address} onClose={() => setPhraseOpen(false)} />
      )}
      {delOpen && (
        <DeleteAddressModal
          address={address}
          balance={entry.balance}
          onClose={() => setDelOpen(false)}
          onDeleted={async () => {
            await refresh();
            onClose();
          }}
        />
      )}
    </Sheet>
  );
}

/* this address's own 24-word recovery phrase — password-gated, auto-hides */
function RecoveryPhraseModal({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [blurred, setBlurred] = useState(false);

  useEffect(() => {
    if (!words) return;
    const t = window.setTimeout(() => setBlurred(true), 30000);
    return () => window.clearTimeout(t);
  }, [words]);

  async function reveal() {
    if (pw.length < 4) {
      toast.error(t("adr.rpEnterPw"));
      return;
    }
    setBusy(true);
    try {
      const res = await revealMnemonic(address, pw);
      setWords(res.mnemonic);
    } catch (e) {
      toast.error(t("adr.rpFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("adr.recoveryPhrase")}
      danger
      onClose={onClose}
      footer={
        words ? (
          <button className="btn btn-block" onClick={onClose}>
            {t("sheet.done")}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary btn-block" onClick={onClose}>
              {t("sheet.cancel")}
            </button>
            <button className="btn btn-danger btn-block" disabled={busy} onClick={reveal}>
              {busy ? <Spinner /> : t("adr.rpReveal")}
            </button>
          </>
        )
      }
    >
      {!words ? (
        <>
          <div className="banner banner-warn" style={{ marginBottom: 14 }}>
            {t("adr.rpWarn")}
          </div>
          <Field label={t("sheet.walletPassword")}>
            <input
              className="field"
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && reveal()}
            />
          </Field>
        </>
      ) : (
        <>
          <div className="banner banner-danger" style={{ marginBottom: 14 }}>
            {t("adr.rpFor", { addr: shortAddress(address, 6, 6) })}
          </div>
          <div style={{ position: "relative" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                filter: blurred ? "blur(7px)" : "none",
                transition: "filter .2s",
              }}
            >
              {words.map((w, i) => (
                <div
                  key={i}
                  className="card card-2"
                  style={{ padding: "9px 11px", display: "flex", gap: 8, alignItems: "baseline" }}
                >
                  <span
                    className="faint mono"
                    style={{ fontSize: 11, width: 16, textAlign: "right" }}
                  >
                    {i + 1}
                  </span>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
                    {w}
                  </span>
                </div>
              ))}
            </div>
            {blurred && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setBlurred(false)}
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%,-50%)",
                }}
              >
                {t("adr.rpShowAgain")}
              </button>
            )}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="faint" style={{ fontSize: 12 }}>
                {t("mn.helpTitle")}
              </span>
              <MnemonicHelp size={18} />
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(words.join(" "));
                toast.success(t("adr.rpCopied"));
              }}
            >
              <Icon name="copy" size={15} /> {t("adr.rpCopyPhrase")}
            </button>
          </div>
          <p className="faint" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
            {t("adr.rpAutoHide")}
          </p>
        </>
      )}
    </Modal>
  );
}

/* permanently delete an address (erases its key) — password + funds guard */
function DeleteAddressModal({
  address,
  balance,
  onClose,
  onDeleted,
}: {
  address: string;
  balance: number;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const toast = useToast();
  const { t } = useT();
  const funded = balance > 0;
  const [pw, setPw] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go() {
    if (pw.length < 4) {
      toast.error(t("adr.rpEnterPw"));
      return;
    }
    setBusy(true);
    try {
      await rpc("delete_address", { address, passphrase: pw, force: funded && force });
      toast.success(t("adr.delDone"), t("adr.delDoneBody", { addr: shortAddress(address, 6, 6) }));
      await onDeleted();
      onClose();
    } catch (e) {
      toast.error(t("adr.delFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("adr.delTitle")}
      danger
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            {t("sheet.cancel")}
          </button>
          <button
            className="btn btn-danger btn-block"
            disabled={busy || pw.length < 4 || (funded && !force)}
            onClick={go}
          >
            {busy ? <Spinner /> : t("adr.delCta")}
          </button>
        </>
      }
    >
      <div className="banner banner-danger" style={{ marginBottom: 14 }}>
        {t("adr.delWarn")}
      </div>
      {funded && (
        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "color-mix(in srgb,#f87171 10%,transparent)",
            border: "1px solid color-mix(in srgb,#f87171 30%,transparent)",
            borderRadius: 12,
            padding: "12px 13px",
            marginBottom: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            style={{ marginTop: 2, width: 18, height: 18, accentColor: "#f87171" }}
          />
          <span style={{ fontSize: 13, color: "#fca5a5", lineHeight: 1.45 }}>
            {t("adr.delForce", {
              amt: formatBalanceCompact(balance).replace(" EXFER", ""),
            })}
          </span>
        </label>
      )}
      <Field label={t("sheet.walletPassword")}>
        <input
          className="field"
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !(funded && !force) && go()}
        />
      </Field>
    </Modal>
  );
}

/* export this address as an encrypted wallet.key file */
function ExportKeyModal({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const [walletPw, setWalletPw] = useState("");
  const [exportPw, setExportPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = walletPw.length >= 4 && exportPw.length >= 6 && exportPw === confirm;

  async function doExport() {
    if (!valid) return;
    setBusy(true);
    try {
      const location = await exportWalletKey({
        address,
        walletPassword: walletPw,
        exportPassword: exportPw,
      });
      toast.success(t("adr.exDone"), t("adr.exDoneBody", { loc: location }));
      onClose();
    } catch (e) {
      toast.error(t("adr.exFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("adr.exTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            {t("sheet.cancel")}
          </button>
          <button className="btn btn-block" disabled={!valid || busy} onClick={doExport}>
            {busy ? <Spinner /> : t("adr.exCta")}
          </button>
        </>
      }
    >
      <div className="banner banner-warn" style={{ marginBottom: 14 }}>
        {t("adr.exWarn")}
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label={t("sheet.walletPassword")} help={t("adr.exWalletPwHelp")}>
          <input
            className="field"
            type="password"
            value={walletPw}
            onChange={(e) => setWalletPw(e.target.value)}
          />
        </Field>
        <Field label={t("adr.exExportPw")}>
          <input
            className="field"
            type="password"
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            placeholder={t("adr.exExportPwPh")}
          />
        </Field>
        <Field label={t("adr.exConfirmPw")}>
          <input
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
