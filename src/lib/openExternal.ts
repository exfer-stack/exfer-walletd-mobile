import { devmock } from "./devmock";

/** Open a URL in the user's default browser. In the Tauri shell a bare
 *  `target="_blank"` is a no-op, so route through the opener plugin; under
 *  browser-dev (no Tauri) fall back to a new tab. Any failure also falls back to
 *  window.open so a link is never a dead end. */
export async function openExternal(url: string): Promise<void> {
  if (devmock.isActive()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
