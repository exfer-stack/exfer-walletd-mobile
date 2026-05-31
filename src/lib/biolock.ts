// Shared persisted flag for the biometric (Face ID / Touch ID /
// fingerprint) app lock. Lives here so both Settings (the toggle) and App
// (the lock screen gate) agree on the localStorage key.

export const BIOMETRIC_LOCK_KEY = "exfer-biometric-lock";

/** Whether the user has enabled biometric unlock. */
export function biometricLockEnabled(): boolean {
  return localStorage.getItem(BIOMETRIC_LOCK_KEY) === "true";
}

/** Persist the biometric-lock preference. */
export function setBiometricLock(on: boolean): void {
  localStorage.setItem(BIOMETRIC_LOCK_KEY, String(on));
}
