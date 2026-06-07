// Launch update prompt — shown once per new version when the app comes up and
// a newer release is published. Pure typography (no icons): version headline,
// the changelog for the user's language, then Download / Later. "Later" is
// remembered per version (dismissUpdate), so the same release never nags twice;
// Settings → About keeps its manual check + download path regardless.

import { useState } from "react";
import { Sheet } from "../ui";
import { useT } from "../../lib/i18n";
import { useToast } from "../../lib/toast";
import {
  APP_VERSION,
  changelogLines,
  dismissUpdate,
  openDownload,
  type LatestRelease,
} from "../../lib/update";

export function UpdateSheet({ release, onClose }: { release: LatestRelease; onClose: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lines = changelogLines(release.notes);

  function later() {
    dismissUpdate(release.version);
    onClose();
  }
  async function download() {
    setBusy(true);
    try {
      const copied = await openDownload(release);
      if (copied) toast.info(t("upd.linkCopied"), "");
    } finally {
      setBusy(false);
    }
    // Keep the per-version memory either way — the user acted on this release.
    dismissUpdate(release.version);
    onClose();
  }

  return (
    <Sheet
      title={t("upd.sheetTitle", { v: release.version })}
      subtitle={t("upd.sheetSub", { v: APP_VERSION })}
      onClose={later}
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-block" style={{ flex: 1.4 }} disabled={busy} onClick={download}>
            {t("upd.download")}
          </button>
          <button className="btn btn-secondary btn-block" style={{ flex: 1 }} onClick={later}>
            {t("upd.later")}
          </button>
        </div>
      }
    >
      {lines.length > 0 && (
        <div style={{ padding: "2px 2px 6px" }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{t("upd.whatsNew")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 260, overflowY: "auto" }}>
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 9, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
                <span style={{ color: "var(--text-faint)", flex: "0 0 auto" }}>—</span>
                <span>{l}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}
