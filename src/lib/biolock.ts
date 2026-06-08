// Shared persisted flag for the biometric (Face ID / Touch ID /
// fingerprint) app lock. Lives here so both Settings (the toggle) and App
// (the lock screen gate) agree on the localStorage key.

import { invoke } from "@tauri-apps/api/core";
import type { BootstrapStatus } from "./types";

export const BIOMETRIC_LOCK_KEY = "exfer-biometric-lock";

/** True only inside a Tauri webview (so the plain browser dev build, which
 *  has no walletd to seal, never tries to invoke these commands). */
function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Re-seal the embedded walletd when the biometric app-lock engages, so a
 *  spend-scope RPC can't sign while the wallet is locked. Best-effort: the
 *  Rust side only seals when it can silently restore (keychain passphrase
 *  present), and resolves false otherwise; we never throw — failing to seal
 *  must not break the lock UI. Resolves true iff the daemon was sealed. */
export async function lockWallet(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("lock_wallet");
  } catch {
    return false;
  }
}

/** Bring walletd back after a successful biometric unlock (mirrors
 *  {@link lockWallet}). A no-op when the daemon is still running. Never
 *  throws — a restore failure surfaces through the normal status polling,
 *  it must not block re-entry to the wallet. Resolves the resulting status,
 *  or null when not in Tauri / on error. */
export async function unlockWallet(): Promise<BootstrapStatus | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<BootstrapStatus>("unlock_wallet");
  } catch {
    return null;
  }
}

/** Unlock the app-lock with the wallet PASSWORD the user set (the fallback to
 *  fingerprint/face — never the device lock-screen PIN). The Rust side verifies
 *  it by actually unsealing walletd; a wrong password leaves the saved
 *  passphrase intact. Resolves the resulting status on success; REJECTS on a
 *  wrong password so the caller can show an error. Returns null outside Tauri. */
export async function unlockWithPassword(
  password: string,
): Promise<BootstrapStatus | null> {
  if (!inTauri()) return null;
  return await invoke<BootstrapStatus>("unlock_with_password", { password });
}

/** Whether the user has enabled biometric unlock. */
export function biometricLockEnabled(): boolean {
  return localStorage.getItem(BIOMETRIC_LOCK_KEY) === "true";
}

/** Persist the biometric-lock preference. */
export function setBiometricLock(on: boolean): void {
  localStorage.setItem(BIOMETRIC_LOCK_KEY, String(on));
}
