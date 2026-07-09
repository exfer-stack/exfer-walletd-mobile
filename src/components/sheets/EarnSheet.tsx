// Earn (mining) panel — the wallet UI for the native in-process CPU miner.
//
// The miner itself already exists as native Tauri commands (mine_start /
// mine_stop / mine_status in src-tauri/src/miner.rs); this sheet is the only
// place a user can drive it from the wallet (previously it was reachable ONLY
// through the agent chat). It lets them pick solo vs pool, a mine-to address,
// and a thread count, start/stop with a brief CPU/battery confirm, and watch
// live status (hashrate, shares, uptime, pool authorization) polled every ~2.5s.
//
// In the browser dev preview there is no native host, so mineCommand resolves
// with an app-only note (never rejects) — we detect that and render a calm
// "runs in the installed app" banner while still showing the full controls.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletEntry } from "../../lib/types";
import { Sheet, Field, Spinner } from "../ui";
import { Icon } from "../../lib/icons";
import { useT } from "../../lib/i18n";
import { formatHashrate, addrName } from "../../lib/format";
import { shortAddress } from "../../lib/labels";
import { mineCommand, inTauri, type MineStatus } from "../../lib/agentHost";
import { useToast } from "../../lib/toast";
import { humanizeError } from "../../lib/errors";

// Mirrors miner.rs: Argon2id is ~64 MiB/hash so the native miner caps CPU
// workers at MAX_THREADS, and the solo/pplns pools are the already-public
// ninjaraider EXFER pools (solo :44915, pplns :44913).
const MAX_THREADS = 4;
const SOLO_POOL = "ssl://ninjaraider.com:44915";
const DEFAULT_POOL = "ssl://ninjaraider.com:44913";

type Mode = "solo" | "pool";

/** Seconds → a compact "1h 2m" / "3m 12s" / "8s" uptime string. */
function fmtUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

export function EarnSheet({
  entries,
  onClose,
}: {
  entries: WalletEntry[];
  onClose: () => void;
}) {
  const { t } = useT();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>("solo");
  const [poolUrl, setPoolUrl] = useState(DEFAULT_POOL);
  const [address, setAddress] = useState<string>(() => entries[0]?.address ?? "");
  const [threads, setThreads] = useState(1);
  const [status, setStatus] = useState<MineStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // No native host (browser preview) → the miner is app-only; show a calm
  // banner and disable the start/stop actions, but keep the full panel visible.
  const appOnly = !inTauri() || !!status?.note;
  const running = status?.running === true;

  // Keep a chosen address valid as the wallet's address set changes.
  useEffect(() => {
    if (entries.length === 0) {
      if (address) setAddress("");
      return;
    }
    if (!entries.some((e) => e.address === address)) setAddress(entries[0].address);
  }, [entries, address]);

  const refresh = useCallback(async () => {
    try {
      const s = await mineCommand("mine_status");
      setStatus(s);
    } catch {
      // Transient — keep the last snapshot; the next poll tick recovers.
    }
  }, []);

  // Poll live status while the panel is open. ~2.5s is responsive without
  // hammering the (very cheap) status snapshot.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Reflect the live run's config in the controls so a stop/restart re-uses it,
  // and so a run started elsewhere (e.g. via the agent) shows its real settings.
  const syncedFromRun = useRef(false);
  useEffect(() => {
    if (running && !syncedFromRun.current) {
      syncedFromRun.current = true;
      if (status?.pool) {
        setMode(status.pool === SOLO_POOL ? "solo" : "pool");
        if (status.pool !== SOLO_POOL) setPoolUrl(status.pool);
      }
      if (status?.address) setAddress(status.address);
      if (status?.threads) setThreads(status.threads);
    }
    if (!running) syncedFromRun.current = false;
  }, [running, status]);

  const doStart = useCallback(async () => {
    setConfirming(false);
    if (!address) {
      toast.error(t("earn.noAddr"), "");
      return;
    }
    setBusy(true);
    try {
      // Solo omits `pool` so the native default (the solo pool) applies; pool
      // mode sends the explicit stratum URL. threads is clamped native-side too.
      const args: Record<string, unknown> = { address, threads };
      if (mode === "pool") args.pool = poolUrl.trim() || DEFAULT_POOL;
      const s = await mineCommand("mine_start", args);
      setStatus(s);
      void refresh();
    } catch (e) {
      toast.error(t("earn.startFailed"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }, [address, threads, mode, poolUrl, refresh, toast, t]);

  const doStop = useCallback(async () => {
    setBusy(true);
    try {
      const s = await mineCommand("mine_stop");
      setStatus(s);
      void refresh();
    } catch (e) {
      toast.error(t("earn.stopFailed"), humanizeError(e));
    } finally {
      setBusy(false);
    }
  }, [refresh, toast, t]);

  const resolvedPool = running
    ? status?.pool ?? ""
    : mode === "solo"
      ? SOLO_POOL
      : poolUrl.trim() || DEFAULT_POOL;

  const footer = running ? (
    <button type="button" className="btn btn-secondary btn-block" disabled={busy || appOnly} onClick={doStop} data-testid="earn-stop">
      {busy ? <Spinner /> : t("earn.stop")}
    </button>
  ) : confirming ? (
    <div className="h-row" style={{ gap: 10 }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => setConfirming(false)}>
        {t("earn.cancel")}
      </button>
      <button type="button" className="btn btn-block" disabled={busy} onClick={doStart} data-testid="earn-confirm-start">
        {busy ? <Spinner /> : t("earn.confirmStart")}
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="btn btn-block"
      disabled={busy || appOnly || !address}
      onClick={() => setConfirming(true)}
      data-testid="earn-start"
    >
      {t("earn.start")}
    </button>
  );

  return (
    <Sheet title={t("earn.title")} subtitle={t("earn.subtitle")} onClose={onClose} footer={footer}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }} data-testid="earn-panel">
        {appOnly && (
          <div className="banner banner-info" data-testid="earn-app-only">
            <b>{t("earn.appOnly")}</b>
            <div style={{ marginTop: 4 }}>{t("earn.appOnlyBody")}</div>
          </div>
        )}

        {confirming && (
          <div className="banner banner-warn" data-testid="earn-confirm">
            {t("earn.confirmBody")}
          </div>
        )}

        {/* Live status — a compact stat grid once mining, else a calm hint. */}
        <div className="card" style={{ padding: 14 }}>
          <div className="h-row" style={{ marginBottom: running ? 12 : 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  flex: "0 0 auto",
                  background: running ? "#34d399" : "var(--text-faint)",
                }}
              />
              <span style={{ fontWeight: 600, fontSize: 15 }}>
                {running ? t("earn.statusRunning") : t("earn.statusStopped")}
              </span>
            </div>
            {running && (
              <span className={"pill " + (status?.authorized ? "pill-success" : "pill-warn")}>
                {status?.authorized ? t("earn.connected") : t("earn.connecting")}
              </span>
            )}
          </div>

          {running ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px" }} data-testid="earn-stats">
              <Stat label={t("earn.statHashrate")} value={formatHashrate(Number(status?.hashrate_hs ?? 0))} />
              <Stat label={t("earn.statUptime")} value={fmtUptime(Number(status?.uptime_seconds ?? 0))} />
              <Stat label={t("earn.statAccepted")} value={String(status?.accepted ?? 0)} good />
              <Stat label={t("earn.statRejected")} value={String(status?.rejected ?? 0)} bad={Number(status?.rejected ?? 0) > 0} />
              <Stat label={t("earn.statSubmitted")} value={String(status?.submitted ?? 0)} />
              <Stat label={t("earn.statJobs")} value={String(status?.jobs ?? 0)} />
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              {t("earn.idleHint")}
            </div>
          )}
        </div>

        {/* Config — locked while a run is live (stop to change it). */}
        <Field label={t("earn.mode")}>
          <Seg
            value={mode}
            disabled={running}
            options={[
              ["solo", t("earn.modeSolo")],
              ["pool", t("earn.modePool")],
            ]}
            onChange={(v) => setMode(v as Mode)}
          />
          <div className="field-help">{mode === "solo" ? t("earn.soloDesc") : t("earn.poolDesc")}</div>
        </Field>

        {mode === "pool" && !running && (
          <Field label={t("earn.poolUrl")} help={t("earn.poolUrlHelp")}>
            <input
              className="field mono"
              value={poolUrl}
              onChange={(e) => setPoolUrl(e.target.value)}
              placeholder={DEFAULT_POOL}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="earn-pool-url"
            />
          </Field>
        )}

        <Field label={t("earn.mineTo")} help={t("earn.mineToHelp")}>
          {entries.length === 0 ? (
            <div className="banner banner-warn" style={{ fontSize: 12.5 }}>{t("earn.noAddr")}</div>
          ) : entries.length === 1 || running ? (
            <div
              className="card-2"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 12 }}
            >
              <Icon name="wallet" size={16} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entries.find((e) => e.address === address) ? addrName(entries.find((e) => e.address === address)!) : t("earn.activeAddr")}
                </span>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{shortAddress(address, 8, 8)}</span>
              </span>
            </div>
          ) : (
            <select
              className="field mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="earn-address"
            >
              {entries.map((e) => (
                <option key={e.address} value={e.address}>
                  {addrName(e)} · {shortAddress(e.address, 6, 6)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={t("earn.threads")} help={t("earn.threadsHelp")}>
          <Seg
            value={String(threads)}
            disabled={running}
            options={Array.from({ length: MAX_THREADS }, (_, i) => [String(i + 1), String(i + 1)] as [string, string])}
            onChange={(v) => setThreads(Number(v))}
          />
          {(running ? Number(status?.threads ?? 1) : threads) > 1 && (
            <div className="field-help" style={{ color: "#fcd34d" }}>{t("earn.threadsWarn")}</div>
          )}
        </Field>

        {/* Resolved pool the run targets — reassures the user before they start. */}
        <div className="h-row" style={{ fontSize: 12.5 }}>
          <span className="faint">{t("earn.statPool")}</span>
          <span className="mono dim" style={{ wordBreak: "break-all", textAlign: "right" }}>{resolvedPool}</span>
        </div>
      </div>
    </Sheet>
  );
}

/** One stat tile in the live-status grid. */
function Stat({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 11.5, marginBottom: 3 }}>{label}</div>
      <div
        className="mono"
        style={{ fontSize: 16, fontWeight: 600, color: bad ? "#f87171" : good ? "#34d399" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

/** Inline segmented control (mode / thread count) — mirrors Settings' Segmented
 *  but supports a disabled state so it locks while a run is live. */
function Seg({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--surface-2)",
        borderRadius: 10,
        padding: 3,
        border: "1px solid var(--border-soft)",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          style={{
            border: 0,
            cursor: disabled ? "not-allowed" : "pointer",
            padding: "7px 16px",
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
