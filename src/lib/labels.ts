// Client-side address labels. walletd doesn't yet have a set_label RPC,
// so we keep a labels map in localStorage keyed by address. The
// labels are purely cosmetic — backend has no awareness.

const LABELS_KEY = "exfer-walletd-desktop-labels-v1";

type LabelMap = Record<string, string>;

function loadAll(): LabelMap {
  try {
    const raw = localStorage.getItem(LABELS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as LabelMap) : {};
  } catch {
    return {};
  }
}

function saveAll(m: LabelMap) {
  localStorage.setItem(LABELS_KEY, JSON.stringify(m));
}

export function getLabel(address: string): string | undefined {
  return loadAll()[address];
}

export function setLabel(address: string, label: string) {
  const m = loadAll();
  const trimmed = label.trim();
  if (trimmed === "") delete m[address];
  else m[address] = trimmed;
  saveAll(m);
}

export function listLabels(): LabelMap {
  return loadAll();
}

export function shortAddress(addr: string, head = 8, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
