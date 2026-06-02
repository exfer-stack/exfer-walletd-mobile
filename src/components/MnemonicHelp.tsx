// A small "?" affordance shown next to recovery-phrase UI. Tapping it explains,
// in plain language, why a phrase can map to two addresses (standard vs legacy)
// and — most importantly — that funds are always safe. This is the calm
// counter to the "my address/phrase changed!" panic.

import { useState } from "react";
import { Modal } from "./ui";
import { useT } from "../lib/i18n";

export function MnemonicHelp({ size = 20 }: { size?: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("mn.helpTitle")}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-dim)",
          fontSize: size * 0.6,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "pointer",
          display: "inline-grid",
          placeItems: "center",
          flex: "0 0 auto",
        }}
      >
        ?
      </button>
      {open && (
        <Modal
          title={t("mn.helpTitle")}
          onClose={() => setOpen(false)}
          footer={
            <button className="btn btn-block" onClick={() => setOpen(false)}>
              {t("mn.helpOk")}
            </button>
          }
        >
          <div style={{ display: "grid", gap: 11, fontSize: 13.5, lineHeight: 1.65 }}>
            <p style={{ margin: 0 }}>{t("mn.help1")}</p>
            <p style={{ margin: 0 }}>{t("mn.help2")}</p>
            <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>{t("mn.help3")}</p>
            <div className="banner banner-info" style={{ fontSize: 13, fontWeight: 600 }}>
              {t("mn.helpSafe")}
            </div>
            <div
              style={{
                marginTop: 2,
                paddingTop: 11,
                borderTop: "1px solid var(--border-soft)",
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-faint)", textTransform: "uppercase" }}>
                {t("mn.techTitle")}
              </div>
              {[t("mn.tech1"), t("mn.tech2"), t("mn.tech3"), t("mn.tech4")].map((line, i) => (
                <p key={i} style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
