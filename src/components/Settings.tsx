// Settings — appearance, node RPC, export/import data, vault backup/restore,
// sensitive export, daemon status, danger-zone WIPE.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "../lib/icons";
import { useToast } from "../lib/toast";
import { useWallet } from "../lib/wallet";
import {
  rpc,
  getNodeRpc,
  setNodeRpc,
  getIndexerConfig,
  setIndexerConfig,
  resetWallet,
  exportVaultFile,
  importVaultFile,
  formatExfer,
} from "../lib/rpc";
import { humanizeError } from "../lib/errors";
import { useT, LANGS, type Lang } from "../lib/i18n";
import { useUpdateCheck, openDownload, APP_VERSION } from "../lib/update";
import { listLabels } from "../lib/labels";
import { isHidden } from "../lib/hidden";
import { biometricStatus } from "../lib/biometric";
import { biometricLockEnabled, setBiometricLock } from "../lib/biolock";
import type { ThemeMode, AccentKey } from "../lib/theme";
import { ACCENTS } from "../lib/theme";
import { AppBar, Modal, Field, SettingRow, CopyButton, Spinner } from "./ui";
import { ImportKeyFileModal } from "./modals/ImportModals";

interface StatusResp {
  version?: string;
  wallet_count?: number;
  in_flight_transfers?: number;
  // walletd reports upstream reachability + the synced tip directly. These
  // are the daemon's real field names (the old `upstream: {url}` shape never
  // matched the wire format, so the URL silently fell back to the local
  // nodeUrl and `upstream_ok` was never read anywhere).
  upstream_ok?: boolean;
  upstream_nodes?: string[];
  tip?: { height?: number; block_id?: string };
}

export function Settings({
  theme,
  setTheme,
  accent,
  setAccent,
  hideBalance,
  setHideBalance,
  lang,
  setLang,
  onWiped,
}: {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  accent: AccentKey;
  setAccent: (a: AccentKey) => void;
  hideBalance: boolean;
  setHideBalance: (v: boolean) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  onWiped: () => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const update = useUpdateCheck();
  const { balance, refresh } = useWallet();
  const entries = balance?.entries ?? [];

  const [nodeUrl, setNodeUrl] = useState<string>("");
  const [status, setStatus] = useState<StatusResp | null>(null);
  // Whether the first get_status has settled — until then the node pill
  // reads "Checking…" instead of flashing "Offline".
  const [statusTried, setStatusTried] = useState(false);
  // Biometric unlock: only render the toggle where the device supports it.
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLock, setBioLock] = useState<boolean>(biometricLockEnabled);

  const [nodeOpen, setNodeOpen] = useState(false);
  // Configured indexer URL ("" = using built-in default).
  const [indexerUrl, setIndexerUrl] = useState<string>("");
  const [indexerOpen, setIndexerOpen] = useState(false);
  const [impOpen, setImpOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  // One-time reads: configured node URL + biometric availability.
  useEffect(() => {
    getNodeRpc()
      .then(setNodeUrl)
      .catch(() => setNodeUrl("(unknown)"));
    getIndexerConfig()
      .then((c) => setIndexerUrl(c.rpc))
      .catch(() => setIndexerUrl(""));
    biometricStatus()
      .then((s) => setBioAvailable(s.available))
      .catch(() => setBioAvailable(false));
  }, []);

  // Live daemon status. Re-poll while Settings is open so the node pill
  // reflects reachability now, not just at mount. One cheap get_status
  // call; the same data backs the pill, block height, and upstream list.
  const loadStatus = useCallback(() => {
    rpc<StatusResp>("get_status")
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setStatusTried(true));
  }, []);
  useEffect(() => {
    loadStatus();
    const id = window.setInterval(loadStatus, 8000);
    return () => window.clearInterval(id);
  }, [loadStatus]);

  // undefined → unknown (Checking / older daemon); true → Online; false →
  // Offline. status == null after a settled try means walletd itself is
  // unreachable, which is also "offline" from the user's seat.
  const nodeOk: boolean | undefined = !statusTried
    ? undefined
    : status == null
      ? false
      : status.upstream_ok;

  function toggleBioLock(v: boolean) {
    setBioLock(v);
    setBiometricLock(v);
  }

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
    toast.success(t("set.exported"), t("set.exportedCsv"));
  }
  function exportLabels() {
    const map = listLabels();
    download(
      JSON.stringify(map, null, 2),
      `exfer-labels-${today()}.json`,
      "application/json",
    );
    toast.success(t("set.exported"), t("set.exportedJson"));
  }

  return (
    <div className="screen">
      <div className="screen-pad">
        <AppBar large title={t("set.title")} subtitle={t("set.subtitle")} />

        {/* Appearance */}
        <Section label={t("set.secAppearance")} />
        <div className="list" style={{ marginBottom: 10 }}>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="globe" size={20} />
            </span>
            <span style={{ flex: 1, fontSize: 15.5, fontWeight: 500 }}>{t("set.language")}</span>
            <Segmented
              value={lang}
              options={LANGS.map((l) => [l.key, l.label] as [string, string])}
              onChange={(v) => setLang(v as Lang)}
            />
          </div>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="spark" size={20} />
            </span>
            <span style={{ flex: 1, fontSize: 15.5, fontWeight: 500 }}>{t("set.theme")}</span>
            <Segmented
              value={theme}
              options={[
                ["dark", t("set.dark")],
                ["light", t("set.light")],
              ]}
              onChange={(v) => setTheme(v as ThemeMode)}
            />
          </div>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="spark" size={20} />
            </span>
            <span style={{ flex: 1, fontSize: 15.5, fontWeight: 500 }}>{t("set.accent")}</span>
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
                {t("set.hideBalances")}
              </span>
              <span className="faint" style={{ fontSize: 12.5 }}>
                {t("set.hideBalancesSub")}
              </span>
            </span>
            <Toggle value={hideBalance} onChange={setHideBalance} />
          </div>
        </div>

        {/* Security — only where the device exposes biometrics. */}
        {bioAvailable && (
          <>
            <Section label={t("set.secSecurity")} />
            <div className="list" style={{ marginBottom: 10 }}>
              <div className="list-row" style={{ cursor: "default" }}>
                <span style={iconBox}>
                  <Icon name="shield" size={20} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{ display: "block", fontSize: 15.5, fontWeight: 500 }}
                  >
                    {t("set.bioUnlock")}
                  </span>
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    {t("set.bioUnlockSub")}
                  </span>
                </span>
                <Toggle value={bioLock} onChange={toggleBioLock} />
              </div>
            </div>
          </>
        )}

        {/* Network */}
        <Section label={t("set.secNetwork")} />
        <div className="list" style={{ marginBottom: 10 }}>
          <SettingRow
            icon="node"
            label={t("set.upstreamNode")}
            sub={nodeUrl}
            onClick={() => setNodeOpen(true)}
            right={
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusPill ok={nodeOk} />
                <Icon name="chevron" size={18} stroke={2} />
              </span>
            }
          />
          <SettingRow
            icon="activity"
            label={t("set.indexer")}
            sub={indexerUrl || t("set.indexerDefault")}
            onClick={() => setIndexerOpen(true)}
            right={<Icon name="chevron" size={18} stroke={2} />}
          />
        </div>

        {/* Back up & restore */}
        <Section label={t("set.secBackup")} />
        <div className="list" style={{ marginBottom: 10 }}>
          <SettingRow
            icon="shield"
            label={t("set.backupWallet")}
            sub={t("set.backupWalletSub")}
            onClick={() => setBackupOpen(true)}
          />
          <SettingRow
            icon="download"
            label={t("set.restoreBackup")}
            sub={t("set.restoreBackupSub")}
            onClick={() => setRestoreOpen(true)}
          />
        </div>

        {/* Export & import data */}
        <Section label={t("set.secData")} />
        <div className="list" style={{ marginBottom: 10 }}>
          <SettingRow icon="download" label={t("set.exportCsv")} onClick={exportCsv} />
          <SettingRow icon="download" label={t("set.exportLabels")} onClick={exportLabels} />
          <SettingRow
            icon="key"
            label={t("set.importKey")}
            sub={t("set.importKeySub")}
            onClick={() => setImpOpen(true)}
          />
        </div>

        {/* Daemon */}
        <Section label={t("set.secDaemon")} />
        <div className="card" style={{ overflow: "hidden", marginBottom: 10 }}>
          <DRow label={t("set.dVersion")} value={status?.version ?? "—"} />
          <DRow label={t("set.dNode")} plain value={<StatusPill ok={nodeOk} online={t("set.dReachable")} />} />
          <DRow
            label={t("set.dBlockHeight")}
            value={status?.tip?.height != null ? status.tip.height.toLocaleString() : "—"}
          />
          <DRow label={t("set.dUpstream")} value={status?.upstream_nodes?.join(", ") ?? nodeUrl} copy />
          <DRow label={t("set.dWallets")} value={String(status?.wallet_count ?? entries.length)} />
          <DRow
            label={t("set.dInflight")}
            value={String(status?.in_flight_transfers ?? 0)}
            last
          />
        </div>

        {/* Danger */}
        <Section label={t("set.secDanger")} />
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
            {t("set.resetWallet")}
          </div>
          <div className="dim" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 13 }}>
            {t("set.resetWalletBody")}
          </div>
          <button className="btn btn-danger btn-block" onClick={() => setResetOpen(true)}>
            {t("set.resetWalletCta")}
          </button>
        </div>

        {/* About / update */}
        <Section label={t("set.secAbout")} />
        <div className="list" style={{ marginBottom: 10 }}>
          <div className="list-row" style={{ cursor: "default" }}>
            <span style={iconBox}>
              <Icon name="spark" size={20} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 15.5, fontWeight: 500 }}>
                {t("upd.appVersion")}
              </span>
              <span
                className="faint mono"
                style={{ fontSize: 12.5 }}
              >
                v{APP_VERSION}
                {update.state.status === "checking" && ` · ${t("upd.checking")}`}
                {update.state.status === "current" && ` · ${t("upd.upToDate")}`}
                {update.state.status === "error" && ` · ${t("upd.error")}`}
                {update.state.status === "available" &&
                  ` · ${t("upd.available", { v: update.state.release.version })}`}
              </span>
            </span>
            {update.state.status === "available" ? (
              <button
                className="btn btn-sm"
                onClick={() => {
                  const r = update.state.status === "available" ? update.state.release : null;
                  if (r && openDownload(r)) {
                    toast.info(t("upd.linkCopied"), r.apkUrl || r.releaseUrl);
                  }
                }}
              >
                {t("upd.download")}
              </button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                disabled={update.state.status === "checking"}
                onClick={update.recheck}
              >
                {update.state.status === "checking" ? <Spinner /> : t("upd.checkNow")}
              </button>
            )}
          </div>
        </div>

        <div className="faint" style={{ textAlign: "center", fontSize: 11.5, padding: "18px 0 4px" }}>
          {t("set.footer")}
        </div>
      </div>

      {nodeOpen && (
        <ChangeNodeModal
          current={nodeUrl}
          onClose={() => setNodeOpen(false)}
          onSaved={(url) => setNodeUrl(url)}
        />
      )}
      {indexerOpen && (
        <ChangeIndexerModal
          current={indexerUrl}
          onClose={() => setIndexerOpen(false)}
          onSaved={(url) => setIndexerUrl(url)}
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
    <div className="eyebrow" style={{ margin: "22px 4px 9px" }}>
      {label}
    </div>
  );
}

function DRow({
  label,
  value,
  copy,
  last,
  plain,
}: {
  label: string;
  value: ReactNode;
  copy?: boolean;
  last?: boolean;
  // `plain` renders the value as-is (e.g. a pill) instead of wrapping it in
  // the mono code style the metric rows use.
  plain?: boolean;
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
        {plain ? (
          value
        ) : (
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
        )}
        {copy && typeof value === "string" && (
          <CopyButton text={value} className="icon-btn" size={15} />
        )}
      </span>
    </div>
  );
}

// Node reachability pill. Reuses the app's existing `.pill` palette
// (success/danger/muted) with a small currentColor dot — no new component
// or colour introduced. `ok` undefined = unknown/checking.
function StatusPill({
  ok,
  online,
  offline,
}: {
  ok?: boolean;
  online?: string;
  offline?: string;
}) {
  const { t } = useT();
  const cls = ok === undefined ? "pill-muted" : ok ? "pill-success" : "pill-danger";
  const text =
    ok === undefined
      ? t("set.checking")
      : ok
        ? (online ?? t("set.online"))
        : (offline ?? t("set.offline"));
  return (
    <span className={"pill " + cls}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "currentColor",
          flex: "0 0 auto",
        }}
      />
      {text}
    </span>
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
  const { t } = useT();
  const [val, setVal] = useState(current);
  const [busy, setBusy] = useState(false);
  // After saving we probe the new endpoint so the user learns its
  // reachability right away. null = not probed; { ok:false } = saved but
  // not responding (we keep the modal open and warn instead of a misleading
  // success toast).
  const [probe, setProbe] = useState<{ ok: boolean } | null>(null);
  async function save() {
    setBusy(true);
    setProbe(null);
    try {
      await setNodeRpc(val.trim());
      onSaved(val.trim());
      // Probe the freshly-set node. walletd reconnects on set_node_rpc, so
      // get_status now reflects the new endpoint.
      let st: StatusResp | null = null;
      try {
        st = await rpc<StatusResp>("get_status");
      } catch {
        st = null;
      }
      if (st?.upstream_ok) {
        toast.success(
          t("nd.connected"),
          st.tip?.height != null
            ? t("nd.connectedHeight", { n: st.tip.height.toLocaleString() })
            : t("nd.connectedOk"),
        );
        onClose();
      } else {
        // Saved, but not reachable (yet). Stay open and say so.
        setProbe({ ok: false });
      }
    } catch (e) {
      toast.error(t("nd.updateFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("set.upstreamNode")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose}>
            {t("sheet.cancel")}
          </button>
          <button
            className="btn btn-block"
            disabled={busy || val.trim() === current}
            onClick={save}
          >
            {busy ? <Spinner /> : t("lbl.save")}
          </button>
        </>
      }
    >
      {probe && !probe.ok && (
        <div className="banner banner-warn" style={{ marginBottom: 14 }}>
          {t("nd.probeWarn")}
        </div>
      )}
      <Field
        label={t("nd.endpoint")}
        help={t("nd.endpointHelp")}
      >
        <input
          className="field mono"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setProbe(null);
          }}
          placeholder="http://80.78.31.82:9334"
        />
      </Field>
    </Modal>
  );
}

function ChangeIndexerModal({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const [url, setUrl] = useState(current);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  // Prefill both fields from the stored config (blank = using the default).
  useEffect(() => {
    getIndexerConfig()
      .then((c) => {
        setUrl(c.rpc);
        setToken(c.token);
      })
      .catch(() => {});
  }, []);
  async function save() {
    setBusy(true);
    try {
      await setIndexerConfig(url.trim(), token.trim());
      onSaved(url.trim());
      toast.success(
        t("ix.updated"),
        url.trim() ? t("ix.updatedNew") : t("ix.updatedDefault"),
      );
      onClose();
    } catch (e) {
      toast.error(t("ix.updateFail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("set.indexer")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose}>
            {t("sheet.cancel")}
          </button>
          <button className="btn btn-block" disabled={busy} onClick={save}>
            {busy ? <Spinner /> : t("lbl.save")}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        {t("ix.info")}
      </div>
      <Field label={t("ix.urlLabel")} help={t("ix.urlHelp")}>
        <input
          className="field mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://198.13.38.245:9335"
        />
      </Field>
      <Field label={t("ix.tokenLabel")}>
        <input
          className="field mono"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("ix.tokenPlaceholder")}
        />
      </Field>
    </Modal>
  );
}

function VaultBackupModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (pw.length < 4) {
      toast.error(t("adr.rpEnterPw"));
      return;
    }
    setBusy(true);
    try {
      const location = await exportVaultFile({ walletPassword: pw });
      toast.success(t("vb.saved"), t("vb.savedBody", { loc: location }));
      onClose();
    } catch (e) {
      toast.error(t("vb.fail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("set.backupWallet")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            {t("sheet.cancel")}
          </button>
          <button className="btn btn-block" disabled={busy || pw.length < 4} onClick={go}>
            {busy ? <Spinner /> : t("vb.save")}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        {t("vb.info")}
      </div>
      <Field
        label={t("sheet.walletPassword")}
        help={t("vb.pwHelp")}
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
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  // The .vault file is picked inside importVaultFile() (a document picker
  // that works on iOS + Android); the user taps Restore, then chooses it.
  async function go() {
    if (pw.length < 4) return;
    setBusy(true);
    try {
      const n = await importVaultFile({ filePassword: pw });
      // null = picker cancelled — say nothing happened, stay on the modal.
      if (n === null) {
        toast.info(t("vr.cancelled"), t("vr.cancelledBody"));
        return;
      }
      await onRestored();
      toast.success(
        t("vr.restored"),
        n === 0 ? t("vr.restoredNone") : t("ob.toastRestoredN", { n }),
      );
      onClose();
    } catch (e) {
      toast.error(t("vr.fail"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("set.restoreBackup")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            {t("sheet.cancel")}
          </button>
          <button
            className="btn btn-block"
            disabled={pw.length < 4 || busy}
            onClick={go}
          >
            {busy ? <Spinner /> : t("ob.chooseRestore")}
          </button>
        </>
      }
    >
      <div className="banner banner-info" style={{ marginBottom: 14 }}>
        {t("vr.info")}
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label={t("ob.backupPassword")}>
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
  const { t } = useT();
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  async function wipe() {
    setBusy(true);
    try {
      await resetWallet();
      toast.info(t("rs.done"));
      onClose();
      onWiped();
    } catch (e) {
      toast.error(t("set.resetWallet"), humanizeError(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("set.resetWallet")}
      danger
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose} disabled={busy}>
            {t("sheet.cancel")}
          </button>
          <button
            className="btn btn-danger btn-block"
            disabled={val !== "WIPE" || busy}
            onClick={wipe}
          >
            {busy ? <Spinner /> : t("rs.reset")}
          </button>
        </>
      }
    >
      <div className="banner banner-danger" style={{ marginBottom: 14 }}>
        {t("rs.warn")}
      </div>
      <Field
        label={
          <span>
            {t("rs.typeWipe1")}{" "}
            <span className="mono" style={{ color: "#f87171" }}>
              WIPE
            </span>{" "}
            {t("rs.typeWipe2")}
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
