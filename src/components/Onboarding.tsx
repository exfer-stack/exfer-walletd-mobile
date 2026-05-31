// Onboarding — create (password) or restore (.vault file + new password).
// Mirrors onboarding.jsx copy; no 24-word phrase path (the design removed it).

import { useState } from "react";
import { Icon } from "../lib/icons";
import { Field, Spinner } from "./ui";
import { useToast } from "../lib/toast";
import { submitPassword, importVaultFile } from "../lib/rpc";

type Mode = "create" | "restore";

export function Onboarding({ onReady }: { onReady: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("create");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [vaultPw, setVaultPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (mode === "restore") {
      if (pw.length < 8) return setErr("Password must be at least 8 characters.");
      if (pw !== confirm) return setErr("Passwords do not match.");
      if (vaultPw.length < 4) return setErr("Enter the backup password.");
      setBusy(true);
      try {
        // The .vault file is chosen via the document picker inside
        // importVaultFile() — works on iOS + Android. n === 0 means either
        // nothing new to restore or the picker was cancelled.
        await submitPassword(pw);
        const n = await importVaultFile({ filePassword: vaultPw });
        // null = the file picker was cancelled. The local password is already
        // set, but nothing was restored — don't claim success or drop the user
        // into an empty wallet. Let them tap Restore again and pick the file.
        if (n === null) {
          setErr(
            "No .vault file selected. Tap “Choose file & restore” and pick your backup.",
          );
          return;
        }
        toast.success(
          "Wallet restored",
          n === 0
            ? "Backup restored — welcome back."
            : `${n} address${n === 1 ? "" : "es"} restored.`,
        );
        onReady();
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
      return;
    }
    // create
    if (pw.length < 8) return setErr("Password must be at least 8 characters.");
    if (pw !== confirm) return setErr("Passwords do not match.");
    setBusy(true);
    try {
      await submitPassword(pw);
      toast.success("Wallet ready", "Welcome to exfer.");
      onReady();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const cta = busy
    ? mode === "create"
      ? "Creating…"
      : "Restoring…"
    : mode === "create"
      ? "Create wallet"
      : "Choose file & restore";

  return (
    <div className="screen">
      <div
        className="screen-pad"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          paddingTop: 32,
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
              ["create", "New wallet"],
              ["restore", "Restore"],
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
          {mode === "create" ? "Set up your wallet" : "Restore your wallet"}
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
          {mode === "create"
            ? "Choose a password to encrypt your keys at rest. It's saved in your device keychain — you enter it once."
            : "Restore every address from an encrypted .vault backup file and a new local password."}
        </p>

        <div style={{ display: "grid", gap: 14, flex: 1 }}>
          {mode === "restore" && (
            <div className="banner banner-info" style={{ fontSize: 12.5 }}>
              Set a new local password and your backup's password below, then tap
              Restore to choose your <b>.vault</b> file.
            </div>
          )}

          <Field
            label={mode === "create" ? "Password" : "New local password"}
            help="At least 8 characters. Mix letters, numbers & symbols."
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
          <Field label="Confirm password">
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
              label="Backup password"
              help="The password the .vault backup was created with."
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

          <div className="banner banner-warn" style={{ fontSize: 12.5 }}>
            <b>Back this up.</b> Your password unlocks and encrypts every key.
            Forget it and there's no way back in — after setup, save an encrypted
            backup from Settings → Back up wallet.
          </div>
        </div>

        <button
          className="btn btn-block"
          style={{ marginTop: 18, padding: "16px" }}
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
