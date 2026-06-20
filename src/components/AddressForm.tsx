// Per-address display-form toggle (#36): a small pill that flips ONE address
// between legacy hex and the checksummed bech32m "xf1…" form. Default is hex;
// display-only — same bytes, same funds (see lib/addressDisplay.ts).

import { useState } from "react";
import { useAddressDisplay } from "../lib/addressDisplay";
import { useT } from "../lib/i18n";
import { Modal } from "./ui";

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

/** A small "?" next to the toggle, matching MnemonicHelp / SwapTimingHelp.
 *  Tapping it opens the shared Modal explaining the two address forms, what the
 *  toggle does, and why one address has two spellings. */
export function FormInfo({ size = 18 }: { size?: number }) {
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
        aria-label={t("addr.formInfoTitle")}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-dim)",
          fontSize: size * 0.62,
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
          title={t("addr.formInfoTitle")}
          onClose={() => setOpen(false)}
          footer={
            <button className="btn btn-block" onClick={() => setOpen(false)}>
              {t("sheet.done")}
            </button>
          }
        >
          <div
            className="dim"
            style={{ fontSize: 13.5, lineHeight: 1.65, textAlign: "left" }}
          >
            {t("addr.formInfoBody")}
          </div>
        </Modal>
      )}
    </>
  );
}
