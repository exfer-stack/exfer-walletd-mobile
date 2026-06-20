// Client-side "hidden addresses" set. "Hiding" just removes an address
// from the lists — reversible, and no key material is touched. It's the
// soft counterpart to "Delete address" (which erases the key via walletd);
// use hide to declutter, delete to actually remove.
//
// Entries are CANONICAL (addressKey()) so a hidden address stays hidden no
// matter which textual form (hex or bech32m) is on screen. migrateHidden()
// re-keys any legacy raw entries.

import { addressKey } from "./address";

const HIDDEN_KEY = "exfer-walletd-desktop-hidden-v1";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  } catch {
    return new Set();
  }
}

function save(s: Set<string>) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
}

export function isHidden(address: string): boolean {
  return load().has(addressKey(address));
}

export function hide(address: string) {
  const s = load();
  s.add(addressKey(address));
  save(s);
}

export function unhide(address: string) {
  const s = load();
  s.delete(addressKey(address));
  save(s);
}

export function hiddenCount(): number {
  return load().size;
}

/** One-time re-key of any legacy raw-keyed entries to addressKey(). Idempotent
 *  — safe to run on every boot. */
export function migrateHidden() {
  const s = load();
  let changed = false;
  const out = new Set<string>();
  for (const a of s) {
    const ck = addressKey(a);
    if (ck !== a) changed = true;
    out.add(ck);
  }
  if (changed) save(out);
}

export function clearHidden() {
  localStorage.removeItem(HIDDEN_KEY);
}
