// Per-address display-form toggle (#36): a small pill that flips ONE address
// between legacy hex and the checksummed bech32m "xf1…" form. Default is hex;
// display-only — same bytes, same funds (see lib/addressDisplay.ts).

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
