// Root: bootstrap state machine, theme/accent/hide-balance, 3-tab nav,
// full-screen sheet overlay router. Wraps the booted app in WalletProvider,
// everything in ToastProvider.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { BootstrapStatus } from "./lib/types";
import { bootstrapStatus } from "./lib/rpc";
import { humanizeError } from "./lib/errors";
import { biometricStatus, biometricUnlock } from "./lib/biometric";
import {
  biometricLockEnabled,
  lockWallet,
  unlockWallet,
  unlockWithPassword,
} from "./lib/biolock";
import { PasswordField } from "./components/ui";
import { devmock } from "./lib/devmock";
import wordmark from "./assets/wordmark.png";
import { ToastProvider, ToastHost } from "./lib/toast";
import { checkForUpdate, dismissedVersion, type LatestRelease } from "./lib/update";
import { UpdateSheet } from "./components/sheets/UpdateSheet";
import { WalletProvider } from "./lib/wallet";
import { BalanceProvider } from "./lib/balance";
import { migrateLabels } from "./lib/labels";
import { migrateHidden } from "./lib/hidden";
import { resolveNetwork } from "./lib/addressDisplay";
import { I18nProvider, useT, readLang, persistLang, type Lang, type MsgKey } from "./lib/i18n";
import {
  ACCENTS,
  isAccentKey,
  isThemeMode,
  type AccentKey,
  type ThemeMode,
} from "./lib/theme";
import { Icon } from "./lib/icons";
import { Onboarding } from "./components/Onboarding";
import { Welcome } from "./components/Welcome";
import { Home } from "./components/Home";
import { Activity } from "./components/Activity";
import { Settings } from "./components/Settings";
import { ReceiveSheet } from "./components/sheets/ReceiveSheet";
import { SendSheet } from "./components/sheets/SendSheet";
import { SwapSheet } from "./components/sheets/SwapSheet";
import { LiquiditySheet } from "./components/sheets/LiquiditySheet";
import { SwapTab } from "./components/SwapTab";
import { AddressSheet } from "./components/sheets/AddressSheet";
import { SwapWatcher } from "./components/SwapWatcher";
import { Governance } from "./components/Governance";
import { AgentTab } from "./components/AgentTab";

type Tab = "wallet" | "agent" | "swap" | "activity" | "governance" | "settings";

type Overlay =
  | { type: "receive" }
  | { type: "send"; from?: string }
  | { type: "swap"; from?: string; resumeSwapId?: string }
  | { type: "liquidity"; resumeAddId?: string }
  | { type: "address"; address: string }
  | null;

const LS = {
  theme: "exfer-mobile-theme",
  accent: "exfer-mobile-accent",
  hideBalance: "exfer-mobile-hide-balance",
};

function readTheme(): ThemeMode {
  const v = localStorage.getItem(LS.theme);
  return v && isThemeMode(v) ? v : "dark";
}
function readAccent(): AccentKey {
  const v = localStorage.getItem(LS.accent);
  return v && isAccentKey(v) ? v : "cyan";
}
function readHide(): boolean {
  return localStorage.getItem(LS.hideBalance) === "true";
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const updateNotified = useRef(false);
  // A newer published release the user hasn't dismissed → launch prompt.
  const [updatePrompt, setUpdatePrompt] = useState<LatestRelease | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>(readTheme);
  const [accent, setAccentState] = useState<AccentKey>(readAccent);
  const [hideBalance, setHideState] = useState<boolean>(readHide);
  const [lang, setLangState] = useState<Lang>(readLang);

  const [boot, setBoot] = useState<BootstrapStatus | null>(null);
  const [tab, setTab] = useState<Tab>("wallet");
  // The tab we were on before opening Governance — Governance is no longer a
  // bottom tab, so its header ← returns here (defaults to wallet).
  const [prevTab, setPrevTab] = useState<Tab>("wallet");
  const [overlay, setOverlay] = useState<Overlay>(null);
  // Fresh-install intro: show the Welcome pitch before the onboarding form.
  // Only relevant pre-wallet (onboarding is the only place it gates); once a
  // wallet exists the app boots straight past it.
  const [started, setStarted] = useState(false);

  // Biometric app lock. `locked === null` means we haven't yet decided
  // whether a lock is needed (avoids a flash of the wallet on launch).
  const [locked, setLocked] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!biometricLockEnabled()) {
        if (!cancelled) setLocked(false);
        return;
      }
      const s = await biometricStatus();
      if (cancelled) return;
      // Flag on + biometrics present → lock; otherwise no lock.
      setLocked(s.available);
      // When we actually engage the lock, re-seal the embedded walletd so a
      // spend-scope RPC can't sign while the wallet sits behind the biometric
      // gate. Best-effort + self-guarded on the Rust side (only seals when it
      // can silently restore), so this can't strand a user behind the lock.
      if (s.available) void lockWallet();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    localStorage.setItem(LS.theme, t);
  }, []);
  const setAccent = useCallback((a: AccentKey) => {
    setAccentState(a);
    localStorage.setItem(LS.accent, a);
  }, []);
  const setHideBalance = useCallback((v: boolean) => {
    setHideState(v);
    localStorage.setItem(LS.hideBalance, String(v));
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    persistLang(l);
  }, []);
  const toggleHide = useCallback(() => {
    setHideState((prev) => {
      const next = !prev;
      localStorage.setItem(LS.hideBalance, String(next));
      return next;
    });
  }, []);

  // Bootstrap: poll while we need a password / haven't reached a terminal
  // state. Re-poll on a short interval until ready or failed.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await bootstrapStatus();
        if (cancelled) return;
        setBoot(s);
        if (s.status === "needs_password") {
          // keep polling so an external unlock (or submit) is reflected
          timer = window.setTimeout(tick, 1500);
        }
      } catch (e) {
        if (cancelled) return;
        setBoot({ status: "failed", message: humanizeError(e) });
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // After onboarding submits a password, re-read status to flip to ready.
  const reboot = useCallback(async () => {
    try {
      const s = await bootstrapStatus();
      setBoot(s);
    } catch (e) {
      setBoot({ status: "failed", message: humanizeError(e) });
    }
  }, []);

  // Ask for OS notification permission once the wallet is ready. On Android
  // 13+ (API 33) POST_NOTIFICATIONS is a runtime grant — without it the native
  // "Deposit received" notifications the walletd SSE bridge fires are silently
  // dropped and the user never even sees a permission prompt. Nothing else
  // requests it, so do it here. No-op in browser dev and if already granted.
  const walletReady = boot?.status === "ready";
  useEffect(() => {
    if (!walletReady || devmock.isActive()) return;
    void (async () => {
      try {
        const n = await import("@tauri-apps/plugin-notification");
        if (!(await n.isPermissionGranted())) await n.requestPermission();
      } catch {
        /* plugin unavailable (e.g. browser dev) — ignore */
      }
    })();
  }, [walletReady]);

  // One-time, idempotent re-key of client-side address metadata to the
  // canonical key, so labels/hidden survive the bech32m display rollout (#36).
  useEffect(() => {
    migrateLabels();
    migrateHidden();
  }, []);

  // Once walletd is up, learn the connected node's network so the bech32m
  // display form uses the right HRP (xf / xft / xfd). Best-effort; the mainnet
  // default stands if the node is old or unreachable.
  useEffect(() => {
    if (walletReady) void resolveNetwork();
  }, [walletReady]);

  // Auto-check for a newer release once the wallet is ready. A new version the
  // user hasn't dismissed opens the update sheet (version + changelog +
  // download); "Later" silences THAT version only, and Settings → About keeps
  // the manual path. Cached for an hour, so this rarely hits the network.
  useEffect(() => {
    if (!walletReady || updateNotified.current) return;
    void checkForUpdate(false).then((u) => {
      if (u.status === "available" && !updateNotified.current) {
        updateNotified.current = true;
        if (u.release.version !== dismissedVersion()) setUpdatePrompt(u.release);
      }
    });
  }, [walletReady]);

  const ac = ACCENTS[accent];
  const phoneStyle: CSSProperties = {
    ["--accent" as string]: ac.a,
    ["--accent-strong" as string]: ac.s,
    ["--accent-ink" as string]: ac.ink,
  };

  const ready = boot?.status === "ready";

  return (
    <div className="phone" data-theme={theme} style={phoneStyle}>
     <I18nProvider lang={lang}>
      <BalanceProvider value={{ hidden: hideBalance, toggle: toggleHide }}>
        {!ready ? (
          boot?.status === "failed" ? (
            <BootFailed message={boot.message} />
          ) : boot === null ? (
            <BootLoading />
          ) : started ? (
            <Onboarding onReady={reboot} />
          ) : (
            <Welcome onStart={() => setStarted(true)} lang={lang} setLang={setLang} />
          )
        ) : locked !== false ? (
          // Hold behind the biometric lock until unlocked (or until we've
          // confirmed no lock is needed). `locked === null` → still deciding.
          <LockScreen
            deciding={locked === null}
            onUnlocked={() => setLocked(false)}
          />
        ) : (
          <WalletProvider>
            {/* Always-mounted: announces a finished swap (toast + OS
                notification) regardless of tab or whether the sheet is open. */}
            <SwapWatcher />
            {tab === "wallet" && (
              <Home
                onReceive={() => setOverlay({ type: "receive" })}
                onSend={() => setOverlay({ type: "send" })}
                onOpenAddress={(address) => setOverlay({ type: "address", address })}
                onGoSwap={() => setTab("swap")}
                onGovernance={() => {
                  setPrevTab("wallet");
                  setTab("governance");
                }}
              />
            )}
            {tab === "swap" && (
              <SwapTab
                theme={theme}
                onSwap={() => setOverlay({ type: "swap" })}
                onResumeSwap={(swapId) => setOverlay({ type: "swap", resumeSwapId: swapId })}
                onLiquidity={(resumeAddId?: string) => setOverlay({ type: "liquidity", resumeAddId })}
              />
            )}
            {tab === "activity" && <Activity />}
            {/* Keep the agent MOUNTED across tab switches (hidden when inactive)
                so the conversation + LLM session survive leaving and coming back
                — unmounting it on every tab change wiped the chat. */}
            <div style={{ display: tab === "agent" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <AgentTab lang={lang} />
            </div>
            {tab === "governance" && <Governance onBack={() => setTab(prevTab)} />}
            {tab === "settings" && (
              <Settings
                theme={theme}
                setTheme={setTheme}
                accent={accent}
                setAccent={setAccent}
                hideBalance={hideBalance}
                setHideBalance={setHideBalance}
                lang={lang}
                setLang={setLang}
                onWiped={reboot}
                onGovernance={() => {
                  setPrevTab("settings");
                  setTab("governance");
                }}
              />
            )}

            {/* Governance is reached from the Home card / Settings row, not a
                bottom tab — keep the bar at four tabs. */}
            {tab !== "governance" && (
              <nav className="tabbar">
                <TabButton id="wallet" icon="wallet" labelKey="nav.wallet" active={tab} onClick={setTab} />
                <TabButton id="agent" icon="globe" labelKey="nav.agent" active={tab} onClick={setTab} />
                <TabButton id="swap" icon="refresh" labelKey="nav.swap" active={tab} onClick={setTab} />
                <TabButton id="activity" icon="activity" labelKey="nav.activity" active={tab} onClick={setTab} />
                <TabButton id="settings" icon="settings" labelKey="nav.settings" active={tab} onClick={setTab} />
              </nav>
            )}

            {overlay?.type === "receive" && (
              <ReceiveSheet onClose={() => setOverlay(null)} />
            )}
            {overlay?.type === "send" && (
              <SendSheet
                initialFrom={overlay.from}
                onClose={() => setOverlay(null)}
                onDone={(t) => {
                  if (t) setTab(t);
                }}
              />
            )}
            {overlay?.type === "swap" && (
              <SwapSheet
                initialFrom={overlay.from}
                resumeSwapId={overlay.resumeSwapId}
                onClose={() => setOverlay(null)}
                onReceive={() => setOverlay({ type: "receive" })}
                onDone={(t) => {
                  // Close the swap overlay too — without this, setting the tab
                  // left the sheet open on top (so "Receive EXFER" / "View in
                  // Activity" appeared to do nothing).
                  setOverlay(null);
                  if (t) setTab(t);
                }}
              />
            )}
            {overlay?.type === "liquidity" && (
              <LiquiditySheet onClose={() => setOverlay(null)} resumeAddId={overlay.resumeAddId} />
            )}
            {overlay?.type === "address" && (
              <AddressSheet
                address={overlay.address}
                onClose={() => setOverlay(null)}
                onSend={(address) => setOverlay({ type: "send", from: address })}
              />
            )}
            {/* Launch update prompt — only when no other sheet is up, so it
                never buries an in-progress flow the user just resumed. */}
            {updatePrompt && !overlay && (
              <UpdateSheet release={updatePrompt} onClose={() => setUpdatePrompt(null)} />
            )}
          </WalletProvider>
        )}

        <ToastHost />
      </BalanceProvider>
     </I18nProvider>
    </div>
  );
}

function TabButton({
  id,
  icon,
  labelKey,
  active,
  onClick,
}: {
  id: Tab;
  icon: string;
  labelKey: MsgKey;
  active: Tab;
  onClick: (t: Tab) => void;
}) {
  const { t } = useT();
  return (
    <button
      className={"tab" + (active === id ? " active" : "")}
      onClick={() => onClick(id)}
    >
      <Icon name={icon} size={24} stroke={active === id ? 2.2 : 1.9} />
      {t(labelKey)}
    </button>
  );
}

function LockScreen({
  deciding,
  onUnlocked,
}: {
  deciding: boolean;
  onUnlocked: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Password fallback: unlock with the wallet password the user SET — not the
  // device lock-screen PIN. Shown alongside biometric so users always have a
  // credential they control.
  const [pwMode, setPwMode] = useState(false);
  const [pw, setPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState(false);
  // Fire the auto-biometric-prompt at most once per biometric view. Without this
  // the effect below re-ran on every App re-render (its `unlock` dep changes
  // identity because `onUnlocked` is an inline arrow), re-opening the system
  // sheet mid-unlock — the "flashing" lock/password screen. Reset when the user
  // switches to password mode so switching back re-arms the prompt.
  const didPrompt = useRef(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    const ok = await biometricUnlock(t("lock.unlock"));
    if (ok) {
      // Bring the embedded walletd back if the lock sealed it (no-op when it's
      // still running). FIRE-AND-FORGET: on mobile the OS suspends the daemon in
      // the background, so this restarts it + reconnects to the node, which is
      // SLOW on a weak network. Do NOT `await` it — that hung the "Unlocking…"
      // screen for the whole restart. Per the design, a restore miss surfaces
      // through normal status polling as "connecting/offline" (recoverable),
      // never as a hard lockout. Enter the wallet immediately.
      void unlockWallet();
      setBusy(false);
      onUnlocked();
    } else {
      setBusy(false);
      setFailed(true);
    }
  }, [onUnlocked, t]);

  const submitPw = useCallback(async () => {
    if (!pw || pwBusy) return;
    setPwBusy(true);
    setPwErr(false);
    try {
      // unlock_with_password re-seals then unseals walletd with the entered
      // password; a wrong one rejects (and never drops the saved passphrase).
      const status = await unlockWithPassword(pw);
      if (status && status.status === "ready") {
        setPwBusy(false);
        onUnlocked();
        return;
      }
      setPwBusy(false);
      setPwErr(true);
    } catch {
      setPwBusy(false);
      setPwErr(true);
    }
  }, [pw, pwBusy, onUnlocked]);

  // Prompt biometric automatically on first mount once we know a lock is
  // needed — but never re-trigger it once the user has switched to the
  // password field (that would yank focus / reopen the system sheet).
  useEffect(() => {
    if (deciding || pwMode || didPrompt.current) return;
    didPrompt.current = true;
    void unlock();
  }, [deciding, pwMode, unlock]);

  return (
    <div
      className="screen"
      style={{ display: "grid", placeItems: "center", padding: 40 }}
    >
      <div style={{ textAlign: "center", maxWidth: 320, width: "100%" }}>
        <img
          src={wordmark}
          alt="EXFER"
          style={{
            width: "70%",
            maxWidth: 240,
            height: "auto",
            filter: "var(--wordmark-filter, none)",
            marginBottom: 22,
          }}
          draggable={false}
        />
        {pwMode ? (
          <>
            <div style={{ textAlign: "left", marginBottom: 14 }}>
              <label className="field-label">{t("lock.pwLabel")}</label>
              <PasswordField
                className="field"
                autoFocus
                value={pw}
                onChange={(e) => {
                  setPw(e.target.value);
                  setPwErr(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void submitPw()}
              />
              {pwErr && (
                <div style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>
                  {t("lock.pwWrong")}
                </div>
              )}
            </div>
            <button
              className="btn btn-block"
              style={{ padding: "14px" }}
              disabled={pwBusy || !pw}
              onClick={submitPw}
            >
              {pwBusy ? t("lock.unlocking") : t("lock.unlock")}
            </button>
            <button
              className="btn btn-secondary btn-block"
              style={{ marginTop: 10 }}
              disabled={pwBusy}
              onClick={() => {
                setPwMode(false);
                setPwErr(false);
              }}
            >
              {t("lock.useBiometric")}
            </button>
          </>
        ) : (
          <>
            <div className="dim" style={{ fontSize: 14, marginBottom: 18 }}>
              {deciding
                ? t("lock.checking")
                : failed
                  ? t("lock.failed")
                  : t("lock.locked")}
            </div>
            <button
              className="btn btn-block"
              style={{ padding: "14px" }}
              disabled={busy || deciding}
              onClick={unlock}
            >
              {busy ? t("lock.unlocking") : t("lock.unlock")}
            </button>
            <button
              className="btn btn-secondary btn-block"
              style={{ marginTop: 10 }}
              disabled={busy || deciding}
              onClick={() => {
                didPrompt.current = false; // re-arm auto-prompt if they switch back
                setPwMode(true);
                setFailed(false);
              }}
            >
              {t("lock.usePassword")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BootLoading() {
  return (
    <div
      className="screen"
      style={{ display: "grid", placeItems: "center", padding: 40 }}
    >
      <div className="dim" style={{ textAlign: "center" }}>
        <span
          className="spin"
          style={{
            display: "inline-block",
            width: 26,
            height: 26,
            border: "2px solid color-mix(in srgb,currentColor 30%,transparent)",
            borderTopColor: "currentColor",
            borderRadius: "50%",
          }}
        />
        <div style={{ marginTop: 14, fontSize: 14 }}>Starting wallet…</div>
      </div>
    </div>
  );
}

function BootFailed({ message }: { message: string }) {
  return (
    <div className="screen">
      <div className="screen-pad" style={{ paddingTop: 40 }}>
        <div className="title-lg" style={{ marginBottom: 12 }}>
          Couldn't start
        </div>
        <div className="banner banner-danger">{message}</div>
      </div>
    </div>
  );
}
