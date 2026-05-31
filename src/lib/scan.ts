// QR / barcode scanning for recipient addresses. Uses the Tauri
// barcode-scanner plugin (device camera on iOS/Android). In a plain
// browser (dev preview) the plugin import/scan throws and we return
// `null` so the caller can fall back to paste/type.

/** Strip an `exfer:` URI prefix and any query string, leaving the raw address. */
function parseScanned(content: string | null | undefined): string | null {
  if (!content) return null;
  let s = content.trim();
  s = s.replace(/^exfer:/i, "");
  s = s.split("?")[0].trim();
  return s || null;
}

/**
 * Open the camera scanner and return the decoded address, or `null` if it
 * was cancelled / unavailable / permission denied. Never throws.
 */
export async function scanAddress(): Promise<string | null> {
  try {
    const mod = await import("@tauri-apps/plugin-barcode-scanner");
    let perm = await mod.checkPermissions();
    if (perm !== "granted") perm = await mod.requestPermissions();
    if (perm !== "granted") return null;
    const res = await mod.scan({
      windowed: false,
      formats: [mod.Format.QRCode],
    });
    return parseScanned(res?.content);
  } catch {
    return null;
  }
}

/** True only inside a Tauri webview, where the camera scanner exists. */
export function scanSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
