// File I/O that works on iOS + Android + desktop + browser dev.
//
// The Rust side only does crypto now (build/parse EXFK, seal/open vaults
// via walletd RPC); the actual reading/writing of the user-chosen file
// lives here in JS, because on mobile dialog.save() is unavailable and
// Rust has no path to the user's storage. We use the official Tauri FS +
// Dialog plugins, dynamically imported so the plain-browser dev build
// (no __TAURI_INTERNALS__) never pulls them and instead degrades to an
// anchor download / null.

interface OpenFilter {
  name: string;
  extensions: string[];
}

/** True only inside a Tauri webview. */
function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Lowercase hex (no prefix) for a byte buffer. */
export function bytesToHex(u8: Uint8Array): string {
  let out = "";
  for (let i = 0; i < u8.length; i++) {
    out += u8[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Decode a lowercase/uppercase hex string into bytes. Throws on odd
 *  length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const s = hex.trim();
  if (s.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

/**
 * Open the document picker, let the user choose a file, and return its
 * bytes. Returns null if cancelled. In a plain browser (dev preview) there
 * is no real filesystem, so we return null and the caller's devmock branch
 * handles the flow instead.
 */
export async function readPickedFile(
  filters: OpenFilter[],
): Promise<Uint8Array | null> {
  if (!inTauri()) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const fs = await import("@tauri-apps/plugin-fs");
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    filters,
    // iOS document picker mode; copy the file in so we can read it even if
    // it lives outside our sandbox.
    pickerMode: "document",
    fileAccessMode: "copy",
  });
  if (typeof selected !== "string") return null;
  return fs.readFile(selected);
}

/**
 * Write `bytes` to a file the user can find, and return a human-readable
 * location string.
 *
 * - Desktop: a Save dialog (dialog.save) lets the user pick the path.
 * - Mobile: dialog.save is not implemented, so we fall back to the
 *   platform Download (then Documents) directory via the FS plugin.
 * - Browser dev: trigger a normal anchor blob download.
 */
export async function saveBytes(
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  if (!inTauri()) {
    // Plain browser: ordinary download.
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return filename;
  }

  const fs = await import("@tauri-apps/plugin-fs");
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1)
    : "bin";
  const filters = [{ name: filename, extensions: [ext] }];

  // Desktop: try the native Save dialog first.
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const dest = await dialog.save({ defaultPath: filename, filters });
    if (dest) {
      await fs.writeFile(dest, bytes);
      return dest;
    }
    // dest === null on desktop means the user cancelled — fall through to
    // the directory write only when save() is genuinely unavailable
    // (mobile, where the call throws below).
    if (dest === null) {
      // Treat an explicit desktop cancel as a cancel.
      return filename;
    }
  } catch {
    // dialog.save unavailable (mobile) — fall back to a known directory.
  }

  // Mobile (or save() unavailable): write into Download, then Documents.
  try {
    await fs.writeFile(filename, bytes, { baseDir: fs.BaseDirectory.Download });
    return "Download/" + filename;
  } catch {
    await fs.writeFile(filename, bytes, { baseDir: fs.BaseDirectory.Document });
    return "Documents/" + filename;
  }
}
