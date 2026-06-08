// Face ID / Touch ID / fingerprint unlock via the official Tauri
// biometric plugin (mobile-only). Dynamically imported so the plain
// browser / desktop build never pulls it; both helpers degrade to "not
// available" / "failed" rather than throwing, so callers can stay simple.

/** True only inside a Tauri webview. */
function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Whether device biometrics are available, and the biometry type code
 *  (plugin-defined; 0 = none). Never throws. */
export async function biometricStatus(): Promise<{
  available: boolean;
  type: number;
}> {
  if (!inTauri()) return { available: false, type: 0 };
  try {
    const mod = await import("@tauri-apps/plugin-biometric");
    const s = await mod.checkStatus();
    return { available: s.isAvailable, type: s.biometryType };
  } catch {
    return { available: false, type: 0 };
  }
}

/** Prompt for a biometric (fingerprint / Face ID / Touch ID) unlock. Resolves
 *  true on success, false on failure / cancel / unavailability. Never throws.
 *
 *  We deliberately do NOT pass `allowDeviceCredential` — with it, the OS prompt
 *  falls back to the phone's lock-screen PIN, which confused users (they expect
 *  the wallet password they set, not their device PIN). The fallback to the
 *  actual wallet password is handled by our own lock screen (unlockWithPassword)
 *  instead. */
export async function biometricUnlock(
  reason = "Unlock your wallet",
): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    const mod = await import("@tauri-apps/plugin-biometric");
    await mod.authenticate(reason, {
      title: "exfer wallet",
    });
    return true;
  } catch {
    return false;
  }
}
