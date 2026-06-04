// Onboarding — create (password) or restore (.vault file + new password).
// Mirrors onboarding.jsx copy; no 24-word phrase path (the design removed it).

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { Field, Spinner } from "./ui";
import { useToast } from "../lib/toast";
import { submitPassword, pickVaultFile, importVaultBytes, walletExists } from "../lib/rpc";
import { humanizeError } from "../lib/errors";
import { useT } from "../lib/i18n";

type Mode = "create" | "restore";

export function Onboarding({ onReady }: { onReady: () => void }) {
  const toast = useToast();
  const { t } = useT();
  const [mode, setMode] = useState<Mode>("create");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [vaultPw, setVaultPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null = still checking. true = a wallet is already on this device and just
  // needs unlocking (e.g. silent unlock didn't fire after an upgrade) — show
  // an Unlock prompt, never "Create", so existing data never looks gone.
  const [existing, setExisting] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    walletExists()
      .then((e) => !cancelled && setExisting(e))
      .catch(() => !cancelled && setExisting(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Unlock an existing keystore: submitPassword opens it when the password is
  // right. The keystore was never deleted — only the silent-unlock hint was
  // missing — so the right password brings the whole wallet back.
  async function unlock() {
    setErr(null);
    if (!pw) return;
    setBusy(true);
    try {
      const st = await submitPassword(pw);
      // Anything but Ready means it didn't open. A wrong password now comes
      // back as needs_password (recoverable) rather than a dead-end failure —
      // show the error and let them try again.
      if (st.status !== "ready") {
        setErr(st.status === "failed" ? humanizeError(st.message) : t("err.password"));
        return;
      }
      onReady();
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setErr(null);
    if (mode === "restore") {
      if (pw.length < 8) return setErr(t("ob.errMin"));
      if (pw !== confirm) return setErr(t("ob.errMismatch"));
      if (vaultPw.length < 4) return setErr(t("ob.errBackupPw"));
      // Pick (and read) the .vault FIRST — before creating the wallet — so a
      // cancelled picker or a wrong/garbage file never leaves a half-created
      // empty wallet behind. Android can't filter by extension, so any file is
      // selectable; importVaultBytes validates it.
      let bytes: Uint8Array | null;
      try {
        bytes = await pickVaultFile();
      } catch (e) {
        setErr(humanizeError(e));
        return;
      }
      if (!bytes) {
        // Picker cancelled — no wallet was created, let them tap Restore again.
        setErr(t("ob.errNoFile"));
        return;
      }
      setBusy(true);
      try {
        await submitPassword(pw);
        const n = await importVaultBytes(bytes, vaultPw);
        toast.success(
          t("ob.toastRestored"),
          n === 0 ? t("ob.toastRestoredBack") : t("ob.toastRestoredN", { n }),
        );
        onReady();
      } catch (e) {
        // A non-vault file and a wrong backup password both fail the AEAD
        // unseal indistinguishably — give one clear, honest message rather than
        // the generic "wrong password".
        console.warn("[restore] vault import failed:", e);
        setErr(t("ob.errVaultBad"));
      } finally {
        setBusy(false);
      }
      return;
    }
    // create
    if (pw.length < 8) return setErr(t("ob.errMin"));
    if (pw !== confirm) return setErr(t("ob.errMismatch"));
    setBusy(true);
    try {
      const st = await submitPassword(pw);
      // Don't claim success if walletd didn't actually come up. If a keystore
      // with a different password already exists, opening it comes back as
      // needs_password — tell them it's an existing wallet with another
      // password, rather than silently "succeeding".
      if (st.status !== "ready") {
        setErr(st.status === "failed" ? humanizeError(st.message) : t("err.password"));
        return;
      }
      toast.success(t("ob.toastReady"), t("ob.toastReadyBody"));
      onReady();
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const cta = busy
    ? mode === "create"
      ? t("ob.creating")
      : t("ob.restoring")
    : mode === "create"
      ? t("ob.create")
      : t("ob.chooseRestore");

  // Still deciding create-vs-unlock: render nothing for the brief check so we
  // never flash "Create your wallet" at someone who actually has one.
  if (existing === null) {
    return <div className="screen" />;
  }

  // A wallet already exists here — unlock it, don't offer to create.
  if (existing) {
    return (
      <div className="screen">
        <div
          className="screen-pad"
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: "100%",
            paddingTop: "calc(env(safe-area-inset-top) + 48px)",
          }}
        >
          <div className="title-xl" style={{ textAlign: "center", marginBottom: 8 }}>
            {t("ob.unlockTitle")}
          </div>
          <p
            className="dim"
            style={{ textAlign: "center", fontSize: 14, lineHeight: 1.6, margin: "0 6px 24px" }}
          >
            {t("ob.unlockSub")}
          </p>
          <Field label={t("ob.password")}>
            <div style={{ position: "relative" }}>
              <input
                className="field"
                type={show ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
                style={{ paddingRight: 46 }}
                autoFocus
              />
              <button
                className="icon-btn"
                onClick={() => setShow((s) => !s)}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none" }}
                aria-label="toggle visibility"
              >
                <Icon name={show ? "eye-off" : "eye"} size={18} />
              </button>
            </div>
          </Field>
          {err && <div className="banner banner-danger" style={{ marginTop: 14 }}>{err}</div>}
          <div style={{ flex: 1, minHeight: 24 }} />
          <button
            className="btn btn-block"
            style={{ padding: "16px" }}
            disabled={busy || !pw}
            onClick={unlock}
          >
            {busy ? (
              <>
                <Spinner /> {t("ob.unlocking")}
              </>
            ) : (
              t("ob.unlock")
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div
        className="screen-pad"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          // Clear the status bar: include the safe-area inset (a flat
          // paddingTop overrode .screen-pad's env() and crammed the
          // segmented control under the clock/signal icons).
          paddingTop: "calc(env(safe-area-inset-top) + 24px)",
        }}
      >
        <div
          style={{
            display: "flex",
            background: "var(--surface-2)",
            borderRadius: 13,
            padding: 4,
            marginBottom: 20,
            border: "1px solid var(--border-soft)",
          }}
        >
          {(
            [
              ["create", t("ob.new")],
              ["restore", t("ob.restore")],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setErr(null);
              }}
              style={{
                flex: 1,
                border: 0,
                cursor: "pointer",
                padding: "11px 0",
                borderRadius: 10,
                font: "inherit",
                fontSize: 14.5,
                fontWeight: 600,
                background: mode === m ? "var(--accent)" : "transparent",
                color: mode === m ? "var(--accent-ink)" : "var(--text-dim)",
                transition: "background .16s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="title-xl" style={{ textAlign: "center", marginBottom: 8 }}>
          {mode === "create" ? t("ob.createTitle") : t("ob.restoreTitle")}
        </div>
        <p
          className="dim"
          style={{
            textAlign: "center",
            fontSize: 14,
            lineHeight: 1.6,
            margin: "0 6px 20px",
          }}
        >
          {mode === "create" ? t("ob.createSub") : t("ob.restoreSub")}
        </p>

        <div style={{ display: "grid", gap: 14 }}>
          {mode === "restore" && (
            <div className="banner banner-info" style={{ fontSize: 12.5 }}>
              {t("ob.restoreBanner")}
            </div>
          )}

          {/* The BNB wallet is an independent key, not part of the EXFER vault
              backup — restoring this file won't bring a BNB wallet back. Say so
              up front so it isn't a surprise; setting one up (create or import a
              MetaMask account) is a lazy, first-need step after unlocking, never
              forced here. */}
          {mode === "restore" && (
            <div className="banner banner-info" style={{ fontSize: 12.5 }}>
              {t("bnb.setupBody")}
            </div>
          )}

          <Field
            label={mode === "create" ? t("ob.password") : t("ob.newLocalPassword")}
            help={t("ob.passwordHelp")}
          >
            <div style={{ position: "relative" }}>
              <input
                className="field"
                type={show ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                style={{ paddingRight: 46 }}
              />
              <button
                className="icon-btn"
                onClick={() => setShow((s) => !s)}
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                }}
                aria-label="toggle visibility"
              >
                <Icon name={show ? "eye-off" : "eye"} size={18} />
              </button>
            </div>
          </Field>
          <Field label={t("ob.confirm")}>
            <input
              className="field"
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && mode === "create" && submit()}
            />
          </Field>

          {mode === "restore" && (
            <Field
              label={t("ob.backupPassword")}
              help={t("ob.backupPasswordHelp")}
            >
              <input
                className="field"
                type="password"
                value={vaultPw}
                onChange={(e) => setVaultPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </Field>
          )}

          {err && <div className="banner banner-danger">{err}</div>}
        </div>

        {/* Spacer: keep the fields grouped at the top with the CTA anchored
            to the bottom, instead of stretching the gaps between fields to
            fill the screen. */}
        <div style={{ flex: 1, minHeight: 24 }} />

        <button
          className="btn btn-block"
          style={{ padding: "16px" }}
          disabled={busy}
          onClick={submit}
        >
          {busy ? (
            <>
              <Spinner /> {cta}
            </>
          ) : (
            cta
          )}
        </button>
      </div>
    </div>
  );
}
