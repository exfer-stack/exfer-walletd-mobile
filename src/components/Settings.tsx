// Settings — appearance, node RPC, export/import data, vault backup/restore,
// sensitive export, daemon status, danger-zone WIPE.

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import {
  rpc,
  getNodeRpc,
  setNodeRpc,
  resetWallet,
  exportVaultFile,
  importVaultFile,
  formatExfer,
} from "../lib/rpc";
import { listLabels } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import type { ThemeMode, AccentKey } from "../lib/theme";
import { ACCENTS } from "../lib/theme";
import { AppBar, Modal, Field, SettingRow, CopyButton, Spinner } from "./ui";
import { ImportKeyFileModal } from "./modals/ImportModals";
import { pickFile, pickSavePath } from "../lib/dialog";

interface StatusResp {
  version?: string;
  wallet_count?: number;
  in_flight_transfers?: number;
  upstream?: { url?: string; mode?: string };
}

export function Settings({
  theme,
  setTheme,
  accent,
  setAccent,
  hideBalance,
  setHideBalance,
  onWiped,
}: {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  accent: AccentKey;
  setAccent: (a: AccentKey) => void;
  hideBalance: boolean;
  setHideBalance: (v: boolean) => void;
  onWiped: () => void;
}) {
  const toast = useToast();
  const { balance, refresh } = useWallet();
  const entries = balance?.entries ?? [];

  const [nodeUrl, setNodeUrl] = useState<string>("");
  const [status, setStatus] = useState<StatusResp | null>(null);

  const [nodeOpen, setNodeOpen] = useState(false);
  const [impOpen, setImpOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  useEffect(() => {
    getNodeRpc()
      .then(setNodeUrl)
      .catch(() => setNodeUrl("(unknown)"));
    rpc<StatusResp>("get_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  function exportCsv() {
    const labels = listLabels();
    const rows = [
      ["index", "address", "label", "balance_exfer", "hidden"],
      ...entries.map((a) => [
        a.index != null ? String(a.index) : "imported",
        a.address,
        labels[a.address] ?? a.label ?? "",
        formatExfer(a.balance).replace(" EXFER", ""),
        isHidden(a.address) ? "yes" : "no",
      ]),
    ];
    download(rows.map((r) => r.join(",")).join("\n"), `exfer-addresses-${today()}.csv`, "text/csv");
    toast.success("Exported", "addresses CSV downloaded");
  }
  function exportLabels() {
    const map = listLabels();
    download(
      JSON.stringify(map, null, 2),
      `exfer-labels-${today()}.json`,
      "application/json",
    );
    toast.success("Exported", "labels JSON downloaded");
  }

  return (
    <div className="screen">
      <div className="screen-pad">
        <AppBar large title="Settings" subtitle="Node, backup & local data" />

        {/* Appearance */}
        <Section label="Appearance" />
        <div className="list" style={{ marginBottom: 22 }}>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="spark" size={20} />
            </span>
            <span style={{ flex: 1, fontSize: 15.5, fontWeight: 500 }}>Theme</span>
            <Segmented
              value={theme}
              options={[
                ["dark", "Dark"],
                ["light", "Light"],
              ]}
              onChange={(v) => setTheme(v as ThemeMode)}
            />
          </div>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="spark" size={20} />
            </span>
            <span style={{ flex: 1, fontSize: 15.5, fontWeight: 500 }}>Accent</span>
            <div style={{ display: "flex", gap: 8 }}>
              {(Object.keys(ACCENTS) as AccentKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setAccent(k)}
                  aria-label={`accent ${k}`}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    cursor: "pointer",
                    background: ACCENTS[k].a,
                    border:
                      accent === k
                        ? "2px solid var(--text)"
                        : "2px solid transparent",
                    boxShadow: "0 0 0 1px var(--border)",
                  }}
                />
              ))}
            </div>
          </div>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="eye-off" size={20} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 15.5, fontWeight: 500 }}>
                Hide balances
              </span>
              <span className="faint" style={{ fontSize: 12.5 }}>
                Mask amounts with ••••
              </span>
            </span>
            <Toggle value={hideBalance} onChange={setHideBalance} />
          </div>
        </div>

        {/* Network */}
        <Section label="Network" />
        <div className="list" style={{ marginBottom: 22 }}>
          <SettingRow
            icon="node"
            label="Upstream node"
            sub={nodeUrl}
            onClick={() => setNodeOpen(true)}
          />
          <SettingRow
            icon="refresh"
            label="App updates"
            sub="Delivered through the App Store / Google Play"
            right={<></>}
          />
        </div>

        {/* Back up & restore */}
        <Section label="Back up & restore" />
        <div className="banner banner-info" style={{ marginBottom: 12 }}>
          Every address is its own key. One encrypted <b>.vault</b> file backs them
          all up at once — no seed phrase to copy. It's encrypted with your wallet
          password; keep both safe.
        </div>
        <div className="list" style={{ marginBottom: 22 }}>
          <SettingRow
            icon="shield"
            label="Back up wallet"
            sub="Save all keys to one encrypted .vault"
            onClick={() => setBackupOpen(true)}
          />
          <SettingRow
            icon="download"
            label="Restore from backup"
            sub="Load addresses from a .vault file"
            onClick={() => setRestoreOpen(true)}
          />
        </div>

        {/* Export & import data */}
        <Section label="Export & import data" />
        <div className="list" style={{ marginBottom: 22 }}>
          <SettingRow icon="download" label="Export addresses (CSV)" onClick={exportCsv} />
          <SettingRow icon="download" label="Export labels (JSON)" onClick={exportLabels} />
          <SettingRow
            icon="key"
            label="Import wallet.key…"
            sub="Add an externally-held address"
            onClick={() => setImpOpen(true)}
          />
        </div>

        {/* Daemon */}
        <Section label="Daemon status" />
        <div className="card" style={{ overflow: "hidden", marginBottom: 22 }}>
          <DRow label="Version" value={status?.version ?? "—"} />
          <DRow label="Upstream" value={status?.upstream?.url ?? nodeUrl} copy />
          <DRow label="Wallets" value={String(status?.wallet_count ?? entries.length)} />
          <DRow
            label="In-flight transfers"
            value={String(status?.in_flight_transfers ?? 0)}
            last
          />
        </div>

        {/* Danger */}
        <Section label="Danger zone" />
        <div
          className="card"
          style={{
            border: "1px solid color-mix(in srgb,#f87171 40%,transparent)",
            background: "color-mix(in srgb,#f87171 6%,transparent)",
            padding: 16,
            marginBottom: 8,
          }}
        >
          <div style={{ fontWeight: 600, color: "#f87171", marginBottom: 5 }}>
            Reset wallet
          </div>
          <div className="dim" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 13 }}>
            Erases the encrypted keys, tokens & cert from this device and clears the
            saved password. On-chain coins are untouched, but without a backup (vault
            file, or each address's recovery phrase / private key) you can't get back
            in.
          </div>
          <button className="btn btn-danger btn-block" onClick={() => setResetOpen(true)}>
            Reset wallet…
          </button>
        </div>

        <div className="faint" style={{ textAlign: "center", fontSize: 11.5, padding: "18px 0 4px" }}>
          exfer wallet · mobile
        </div>
      </div>

      {nodeOpen && (
        <ChangeNodeModal
          current={nodeUrl}
          onClose={() => setNodeOpen(false)}
          onSaved={(url) => setNodeUrl(url)}
        />
      )}
      {impOpen && (
        <ImportKeyFileModal onClose={() => setImpOpen(false)} onImported={refresh} />
      )}
      {backupOpen && <VaultBackupModal onClose={() => setBackupOpen(false)} />}
      {restoreOpen && (
        <VaultRestoreModal onClose={() => setRestoreOpen(false)} onRestored={refresh} />
      )}
      {resetOpen && <ResetModal onClose={() => setResetOpen(false)} onWiped={onWiped} />}
    </div>
  );
}

const iconBox = {
  width: 38,
  height: 38,
  borderRadius: 11,
  display: "grid",
  placeItems: "center",
  background: "var(--surface-2)",
  color: "var(--text-dim)",
  flex: "0 0 auto",
} as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}
function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Section({ label }: { label: string }) {
  return (
    <div className="eyebrow" style={{ margin: "4px 4px 11px" }}>
      {label}
    </div>
  );
}

function DRow({
  label,
  value,
  copy,
  last,
}: {
  label: string;
  value: string;
  copy?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 15px",
        gap: 12,
        borderBottom: last ? "0" : "1px solid var(--border-soft)",
      }}
    >
      <span className="dim" style={{ fontSize: 13.5 }}>
        {label}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <code
          className="mono"
          style={{
            fontSize: 12.5,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </code>
        {copy && <CopyButton text={value} className="icon-btn" size={15} />}
      </span>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--surface-2)",
        borderRadius: 10,
        padding: 3,
        border: "1px solid var(--border-soft)",
      }}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            border: 0,
            cursor: "pointer",
            padding: "6px 12px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            font: "inherit",
            background: value === v ? "var(--accent)" : "transparent",
            color: value === v ? "var(--accent-ink)" : "var(--text-dim)",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      aria-label="toggle"
      style={{
        width: 46,
        height: 28,
        borderRadius: 999,
        border: 0,
        cursor: "pointer",
        padding: 3,
        flex: "0 0 auto",
        background: value ? "var(--accent)" : "var(--border)",
        transition: "background .18s",
      }}
    >
      <span
        style={{
          display: "block",
          width: 22,
          height: 22,
          borderRadius: 999,
          background: "#fff",
          transform: value ? "translateX(18px)" : "translateX(0)",
          transition: "transform .2s var(--ease)",
          boxShadow: "0 1px 3px rgba(0,0,0,.3)",
        }}
      />
    </button>
  );
}

/* ── modals ─────────────────────────────────────────────────────── */
function ChangeNodeModal({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const toast = useToast();
  const [val, setVal] = useState(current);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await setNodeRpc(val.trim());
      onSaved(val.trim());
      toast.success("Node updated", "Reconnected to the new endpoint.");
      onClose();
    } catch (e) {
      toast.error("Could not update node", String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Upstream node"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-block"
            disabled={busy || val.trim() === current}
            onClick={save}
          >
            {busy ? <Spinner /> : "Save"}
          </button>
        </>
      }
    >
      <Field
        label="JSON-RPC endpoint"
        help="walletd reconnects on save. Comma-separated for round-robin + failover."
      >
        <input
          className="field mono"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="http://80.78.31.82:9334"
        />
      </Field>
    </Modal>
  );
}

function VaultBackupModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (pw.length < 4) {
      toast.error("Enter your wallet password");
      return;
    }
    setBusy(true);
    try {
      const dest = await pickSavePath({
        defaultPath: `exfer-wallet-backup-${today()}.vault`,
        filters: [{ name: "Wallet vault", extensions: ["vault"] }],
        title: "Save wallet backup",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      await exportVaultFile({ walletPassword: pw, dest });
      toast.success("Backup saved", "One encrypted file holds every address.");
      onClose();
    } catch (e) {
      toast.error("Backup failed", String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Back up wallet"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-block" disabled={busy || pw.length < 4} onClick={go}>
            {busy ? <Spinner /> : "Save backup"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Saves every address to one encrypted <b>.vault</b> file — no seed phrase to
        copy. Encrypted with your wallet password; you'll need it to restore.
      </div>
      <Field
        label="Wallet password"
        help="New addresses created later aren't in an old backup — re-export after adding keys."
      >
        <input
          className="field"
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </Field>
    </Modal>
  );
}

function VaultRestoreModal({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function choose() {
    try {
      const p = await pickFile({
        title: "Choose backup file",
        filters: [{ name: "Wallet vault", extensions: ["vault"] }],
      });
      if (p) setPath(p);
    } catch (e) {
      toast.error("Could not open file picker", String(e));
    }
  }
  async function go() {
    if (!path || pw.length < 4) return;
    setBusy(true);
    try {
      const n = await importVaultFile({ path, filePassword: pw });
      await onRestored();
      toast.success(
        "Backup restored",
        n === 0
          ? "Every address was already in this wallet."
          : `${n} address${n === 1 ? "" : "es"} restored.`,
      );
      onClose();
    } catch (e) {
      toast.error("Restore failed", String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Restore from backup"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-block"
            disabled={!path || pw.length < 4 || busy}
            onClick={go}
          >
            {busy ? <Spinner /> : "Restore"}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        Load addresses from a <b>.vault</b> file. Addresses already in this wallet
        are skipped.
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
          <Icon name="shield" size={22} />
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>
              {path ? ".vault file selected" : "Choose backup file"}
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
        <Field label="Backup password">
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function ResetModal({
  onClose,
  onWiped,
}: {
  onClose: () => void;
  onWiped: () => void;
}) {
  const toast = useToast();
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  async function wipe() {
    setBusy(true);
    try {
      await resetWallet();
      toast.info("Wallet reset");
      onClose();
      onWiped();
    } catch (e) {
      toast.error("Reset failed", String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Reset wallet"
      danger
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-danger btn-block"
            disabled={val !== "WIPE" || busy}
            onClick={wipe}
          >
            {busy ? <Spinner /> : "Reset"}
          </button>
        </>
      }
    >
      <div className="banner banner-danger" style={{ marginBottom: 14 }}>
        This permanently erases the wallet from this device. Export a backup first
        if you might need it again.
      </div>
      <Field
        label={
          <span>
            Type{" "}
            <span className="mono" style={{ color: "#f87171" }}>
              WIPE
            </span>{" "}
            to confirm
          </span>
        }
      >
        <input
          className="field mono"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="WIPE"
          autoFocus
        />
      </Field>
    </Modal>
  );
}
