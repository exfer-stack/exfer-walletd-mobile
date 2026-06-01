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
  // Addresses are case-insensitive hex and the Receive QR encodes them
  // uppercase (compact QR mode); normalise to lowercase so the recipient
  // field matches how addresses appear everywhere else.
  return s ? s.toLowerCase() : null;
}

/**
 * Decode a QR from a still image (gallery photo / screenshot) and return the
 * recipient address. Pure-JS (jsQR over a canvas) so it works in any webview,
 * including a plain browser — and it's far more forgiving than a live camera
 * scan of another screen (no glare/focus/motion). Resolves null if the image
 * has no readable QR. Never throws.
 */
export async function decodeQrFromImageFile(file: File): Promise<string | null> {
  try {
    const jsQR = (await import("jsqr")).default;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = jsQR(img.data, img.width, img.height, {
      inversionAttempts: "attemptBoth",
    });
    return parseScannedAddress(res?.data);
  } catch {
    return null;
  }
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
