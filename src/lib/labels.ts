// Client-side address labels. walletd doesn't yet have a set_label RPC,
// so we keep a labels map in localStorage keyed by address. The
// labels are purely cosmetic — backend has no awareness.
//
// Keys are CANONICAL (addressKey() = lowercase 64-hex of the decoded bytes),
// not the raw string the user typed. That way a label set while an address was
// shown as hex still resolves when the same address is later shown as bech32m
// (and vice-versa) — the bech32m display rollout (#36) must never make a named
// address look unnamed. migrateLabels() re-keys any legacy raw-keyed entries.

import { addressKey } from "./address";

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
  return loadAll()[addressKey(address)];
}

export function setLabel(address: string, label: string) {
  const m = loadAll();
  const key = addressKey(address);
  const trimmed = label.trim();
  if (trimmed === "") delete m[key];
  else m[key] = trimmed;
  saveAll(m);
}

export function listLabels(): LabelMap {
  return loadAll();
}

/** One-time re-key of any legacy entries stored under a raw (non-canonical)
 *  address string. Idempotent: a key already equal to addressKey(key) is left
 *  as-is, so it's safe to run on every boot. */
export function migrateLabels() {
  const m = loadAll();
  let changed = false;
  const out: LabelMap = {};
  for (const [k, v] of Object.entries(m)) {
    const ck = addressKey(k);
    if (ck !== k) changed = true;
    if (out[ck] === undefined) out[ck] = v;
  }
  if (changed) saveAll(out);
}

export function shortAddress(addr: string, head = 8, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
