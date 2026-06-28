// A small "?" affordance next to the swap ETA. Tapping it explains, calmly and
// briefly, why a cross-chain swap takes ~a minute (unlike a same-chain token
// swap) and that funds are protected — the same reassuring pattern as
// MnemonicHelp. Kept visual: three numbered points, not a wall of text.

import { useState } from "react";
import { Modal } from "./ui";
import { useT } from "../lib/i18n";

export function SwapTimingHelp({
  size = 16,
  isV2 = false,
  inUnit,
  outUnit,
}: {
  size?: number;
  /** v2 (reversed) flow: lock once and leave — the explanation changes. */
  isV2?: boolean;
  /** Asset unit labels for the {in}/{out} slots in the v2 copy. */
  inUnit?: string;
  outUnit?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const units = { in: inUnit ?? "", out: outUnit ?? "" };
  const points = [
    t("swap.why1"),
    isV2 ? t("swap.why2V2", units) : t("swap.why2"),
    isV2 ? t("swap.why3V2", units) : t("swap.why3"),
  ];
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={t("swap.whyTitle")}
        style={{
          width: size, height: size, borderRadius: "50%",
          border: "1px solid var(--border)", background: "var(--surface-2)",
          color: "var(--text-dim)", fontSize: size * 0.62, fontWeight: 700, lineHeight: 1,
          cursor: "pointer", display: "inline-grid", placeItems: "center", flex: "0 0 auto",
        }}
      >
        ?
      </button>
      {open && (
        <Modal
          title={t("swap.whyTitle")}
          onClose={() => setOpen(false)}
          footer={<button className="btn btn-block" onClick={() => setOpen(false)}>{t("swap.whyOk")}</button>}
        >
          <div style={{ display: "grid", gap: 14, textAlign: "left" }}>
            {points.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                <span style={{ flex: "0 0 auto", width: 22, height: 22, borderRadius: 999, background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)", fontSize: 12, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: 13.5, lineHeight: 1.55, color: "var(--text)" }}>{p}</span>
              </div>
            ))}
            <div className="banner banner-info" style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.55, textAlign: "left" }}>
              {t("swap.whySafe")}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
