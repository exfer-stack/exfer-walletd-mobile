// QR scanning for recipient addresses via the Tauri barcode-scanner plugin
// (device camera on iOS/Android). We use WINDOWED mode: the camera renders
// behind a transparent webview so the app draws its own scan UI on top (see
// ScannerOverlay). In a plain browser the plugin import throws and these
// resolve to null so the caller falls back to paste/type.

/** Strip an `exfer:` URI prefix and any query string, leaving the raw address. */
export function parseScannedAddress(content: string | null | undefined): string | null {
  if (!content) return null;
  let s = content.trim();
  s = s.replace(/^exfer:/i, "");
  s = s.split("?")[0].trim();
  return s || null;
}

/**
 * Start a windowed camera scan. The webview must be made transparent by the
 * caller (ScannerOverlay adds the `scanning` class) so the live camera shows
 * behind the overlay. Resolves with the decoded address, or null if
 * cancelled / unavailable / denied. Never throws.
 */
export async function startWindowedScan(): Promise<string | null> {
  try {
    const mod = await import("@tauri-apps/plugin-barcode-scanner");
    let perm = await mod.checkPermissions();
    if (perm !== "granted") perm = await mod.requestPermissions();
    if (perm !== "granted") return null;
    const res = await mod.scan({ windowed: true, formats: [mod.Format.QRCode] });
    return parseScannedAddress(res?.content);
  } catch {
    return null;
  }
}

/** Stop an in-progress windowed scan (e.g. user tapped Cancel). */
export async function cancelScan(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-barcode-scanner");
    await mod.cancel();
  } catch {
    /* not scanning / plugin unavailable */
  }
}

/** True only inside a Tauri webview, where the camera scanner exists. */
export function scanSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
