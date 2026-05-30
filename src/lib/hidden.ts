// Client-side "hidden addresses" set. "Hiding" just removes an address
// from the lists — reversible, and no key material is touched. It's the
// soft counterpart to "Delete address" (which erases the key via walletd);
// use hide to declutter, delete to actually remove.

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
  return load().has(address);
}

export function hide(address: string) {
  const s = load();
  s.add(address);
  save(s);
}

export function unhide(address: string) {
  const s = load();
  s.delete(address);
  save(s);
}

export function hiddenCount(): number {
  return load().size;
}

export function clearHidden() {
  localStorage.removeItem(HIDDEN_KEY);
}
