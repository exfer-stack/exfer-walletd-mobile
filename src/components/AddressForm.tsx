// Address-format sheet (#36): the same account has two textual spellings —
// legacy hex and the checksummed bech32m "xf…". Rather than cramming a toggle
// into the address row, tapping the address opens this sheet, which lists both
// forms with a copy on each and a one-line explainer. Display-only: same bytes,
// same funds, walletd accepts either (see lib/addressDisplay.ts). Reuses the
// app's shared Modal — no bespoke popover.

import { addressKey } from "../lib/address";
import { encodeBech32mAddr } from "../lib/addressDisplay";
import { useT } from "../lib/i18n";
import { Modal, CopyButton } from "./ui";

function FormatRow({ label, value }: { label: string; value: string }) {
  const { t } = useT();
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 6, letterSpacing: ".1em" }}>
        {label}
      </div>
      <div
        className="card card-2"
        style={{
          padding: "11px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <code
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            wordBreak: "break-all",
            lineHeight: 1.5,
            color: "var(--text-dim)",
          }}
        >
          {value}
        </code>
        <CopyButton text={value} label={t("sheet.addrCopied")} />
      </div>
    </div>
  );
}

/** The "two ways to write the same address" sheet for one address. */
export function AddressFormatsModal({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const hex = addressKey(address);
  const bech = encodeBech32mAddr(address) ?? hex;
  return (
    <Modal
      title={t("addr.formInfoTitle")}
      onClose={onClose}
      footer={
        <button className="btn btn-block" onClick={onClose}>
          {t("sheet.done")}
        </button>
      }
    >
      <div
        className="dim"
        style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16, textAlign: "left" }}
      >
        {t("addr.formInfoBody")}
      </div>
      <div style={{ display: "grid", gap: 14 }}>
        <FormatRow label={t("addr.formatHex")} value={hex} />
        <FormatRow label={t("addr.formatBech32m")} value={bech} />
      </div>
    </Modal>
  );
}
