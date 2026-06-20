// Per-address display-form toggle (#36): a small pill that flips ONE address
// between legacy hex and the checksummed bech32m "xf1…" form. Default is hex;
// display-only — same bytes, same funds (see lib/addressDisplay.ts).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAddressDisplay } from "../lib/addressDisplay";
import { useT } from "../lib/i18n";

/** Small pill that flips one address between hex and the bech32m "xf" form.
 *  Label shows the form you'd switch TO, so the action reads clearly. */
export function FormToggle({ address }: { address: string }) {
  const { isBech32m, toggle } = useAddressDisplay(address);
  const { t } = useT();
  const title = isBech32m ? t("addr.toHexTitle") : t("addr.toBech32mTitle");
  return (
    <button
      className="tap"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      title={title}
      aria-label={title}
      style={{
        flex: "0 0 auto",
        // Match the 36px icon-btn it sits beside (copy button) so the row reads
        // level, and clear a comfortable touch target.
        minHeight: 36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 12px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        color: "var(--text-dim)",
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {isBech32m ? t("addr.hexLabel") : t("addr.bech32mLabel")}
    </button>
  );
}

/** A round "?" next to the toggle. Tapping it opens a small centered card
 *  explaining the two address forms, what the toggle does, and why one address
 *  has two spellings. Rendered via a portal to <body> so the sheet's
 *  overflow:hidden can't clip it. Backdrop-tap, the OK button, or Escape close. */
export function FormInfo() {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Portal into the themed `.phone` root (NOT document.body): the surface CSS
  // variables (--elevated, --border, --shadow) are scoped under the data-theme
  // element, so a body-level portal would render with a transparent card.
  const portalTarget =
    (typeof document !== "undefined" &&
      document.querySelector<HTMLElement>(".phone")) ||
    (typeof document !== "undefined" ? document.body : null);

  return (
    <>
      <button
        className="tap"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("addr.formInfoAria")}
        style={{
          flex: "0 0 auto",
          width: 36,
          height: 36,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-dim)",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        ?
      </button>
      {open &&
        portalTarget &&
        createPortal(
          <div
            role="dialog"
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              background: "rgba(0,0,0,0.5)",
            }}
          >
            <div
              className="card fade-up"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 320,
                textAlign: "left",
                background: "var(--elevated)",
                border: "1px solid var(--border)",
                borderRadius: 16,
                padding: "18px 18px 14px",
                boxShadow: "var(--shadow)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>
                {t("addr.formInfoTitle")}
              </div>
              <div className="dim" style={{ fontSize: 13, lineHeight: 1.55 }}>
                {t("addr.formInfoBody")}
              </div>
              <button
                className="btn btn-block"
                onClick={() => setOpen(false)}
                style={{ marginTop: 14 }}
              >
                {t("sheet.done")}
              </button>
            </div>
          </div>,
          portalTarget,
        )}
    </>
  );
}
