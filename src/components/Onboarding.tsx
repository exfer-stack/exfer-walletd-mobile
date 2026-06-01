// Onboarding — create (password) or restore (.vault file + new password).
// Mirrors onboarding.jsx copy; no 24-word phrase path (the design removed it).

import { useState } from "react";
import { Icon } from "../lib/icons";
import { Field, Spinner } from "./ui";
import { useToast } from "../lib/toast";
import { submitPassword, importVaultFile } from "../lib/rpc";
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

  async function submit() {
    setErr(null);
    if (mode === "restore") {
      if (pw.length < 8) return setErr(t("ob.errMin"));
      if (pw !== confirm) return setErr(t("ob.errMismatch"));
      if (vaultPw.length < 4) return setErr(t("ob.errBackupPw"));
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
          setErr(t("ob.errNoFile"));
          return;
        }
        toast.success(
          t("ob.toastRestored"),
          n === 0 ? t("ob.toastRestoredBack") : t("ob.toastRestoredN", { n }),
        );
        onReady();
      } catch (e) {
        setErr(humanizeError(e));
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
      await submitPassword(pw);
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

        {/* Spacer: keep the fields grouped at the top with the caution + CTA
            anchored to the bottom, instead of stretching the gaps between
            fields to fill the screen. */}
        <div style={{ flex: 1, minHeight: 24 }} />

        <div className="banner banner-warn" style={{ fontSize: 12.5, marginBottom: 14 }}>
          <b>{t("ob.warnTitle")}</b> {t("ob.warnBody")}
        </div>

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
