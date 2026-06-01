// Root: bootstrap state machine, theme/accent/hide-balance, 3-tab nav,
// full-screen sheet overlay router. Wraps the booted app in WalletProvider,
// everything in ToastProvider.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { BootstrapStatus } from "./lib/types";
import { bootstrapStatus } from "./lib/rpc";
import { humanizeError } from "./lib/errors";
import { biometricStatus, biometricUnlock } from "./lib/biometric";
import { biometricLockEnabled } from "./lib/biolock";
import { devmock } from "./lib/devmock";
import wordmark from "./assets/wordmark.png";
import { ToastProvider, ToastHost } from "./lib/toast";
import { WalletProvider } from "./lib/wallet";
import { BalanceProvider } from "./lib/balance";
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
import { AddressSheet } from "./components/sheets/AddressSheet";

type Tab = "wallet" | "activity" | "settings";

type Overlay =
  | { type: "receive" }
  | { type: "send"; from?: string }
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
  const [theme, setThemeState] = useState<ThemeMode>(readTheme);
  const [accent, setAccentState] = useState<AccentKey>(readAccent);
  const [hideBalance, setHideState] = useState<boolean>(readHide);
  const [lang, setLangState] = useState<Lang>(readLang);

  const [boot, setBoot] = useState<BootstrapStatus | null>(null);
  const [tab, setTab] = useState<Tab>("wallet");
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
            {tab === "wallet" && (
              <Home
                onReceive={() => setOverlay({ type: "receive" })}
                onSend={() => setOverlay({ type: "send" })}
                onOpenAddress={(address) => setOverlay({ type: "address", address })}
              />
            )}
            {tab === "activity" && <Activity />}
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
              />
            )}

            <nav className="tabbar">
              <TabButton id="wallet" icon="wallet" labelKey="nav.wallet" active={tab} onClick={setTab} />
              <TabButton id="activity" icon="activity" labelKey="nav.activity" active={tab} onClick={setTab} />
              <TabButton id="settings" icon="settings" labelKey="nav.settings" active={tab} onClick={setTab} />
            </nav>

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
            {overlay?.type === "address" && (
              <AddressSheet
                address={overlay.address}
                onClose={() => setOverlay(null)}
                onSend={(address) => setOverlay({ type: "send", from: address })}
              />
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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    const ok = await biometricUnlock("Unlock your wallet");
    setBusy(false);
    if (ok) onUnlocked();
    else setFailed(true);
  }, [onUnlocked]);

  // Prompt automatically on first mount once we know a lock is needed.
  useEffect(() => {
    if (!deciding) void unlock();
  }, [deciding, unlock]);

  return (
    <div
      className="screen"
      style={{ display: "grid", placeItems: "center", padding: 40 }}
    >
      <div style={{ textAlign: "center", maxWidth: 320 }}>
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
        <div className="dim" style={{ fontSize: 14, marginBottom: 18 }}>
          {deciding
            ? "Checking…"
            : failed
              ? "Unlock cancelled or failed. Try again."
              : "Locked. Unlock to continue."}
        </div>
        <button
          className="btn btn-block"
          style={{ padding: "14px" }}
          disabled={busy || deciding}
          onClick={unlock}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
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
