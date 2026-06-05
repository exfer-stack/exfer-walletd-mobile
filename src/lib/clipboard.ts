// Clipboard with fallbacks. The Android WebView runs in a non-secure context
// (tauri://) where `navigator.clipboard` is undefined, so the bare web API
// silently no-op'd every copy — including the recovery-phrase / private-key
// export. Order: native Tauri plugin (works on Android/iOS/desktop) → web
// Clipboard API → legacy execCommand. Returns whether the copy succeeded so the
// caller can show an honest toast instead of a fake "Copied".
import {
  writeText as tauriWriteText,
  readText as tauriReadText,
} from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<boolean> {
  // 1. Native (the reliable path inside the Tauri WebView).
  try {
    await tauriWriteText(text);
    return true;
  } catch {
    /* not in a Tauri context, or plugin error → try the web paths */
  }
  // 2. Web Clipboard API (secure-context browsers / desktop dev).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked → legacy fallback */
  }
  // 3. Legacy execCommand via a hidden textarea (older WebViews).
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function pasteText(): Promise<string | null> {
  try {
    return await tauriReadText();
  } catch {
    /* fall through */
  }
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    /* blocked */
  }
  return null;
}
