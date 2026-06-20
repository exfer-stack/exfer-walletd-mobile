// Per-address display form: legacy 64-hex (the default) vs the checksummed
// bech32m "xf1…" form (issue #36 rollout).
//
// WHY THIS IS DISPLAY-ONLY: hex and bech32m are two textual spellings of the
// SAME 32 payload bytes — the funds, the QR target, and walletd's accepted
// input are identical either way (walletd's parse_address accepts both). The
// machine `address` field stays hex forever (agents pin its semantics); this
// module only changes what a HUMAN sees, per address, when they opt in by
// tapping the form toggle. Default stays hex so nobody's address appears to
// "change" out from under them.
//
// State model:
//   - The HRP (xf / xft / xfd) is the connected node's network, learned once
//     from get_node_info and cached. Default mainnet — the only network real
//     users touch and the safe fallback if the call fails.
//   - The per-address preference (show this address as bech32m?) lives in
//     localStorage keyed by addressKey() — the canonical lowercase-hex — so the
//     choice is stable no matter which textual form seeded it.
//   - A tiny pub/sub lets every on-screen copy of an address re-render the
//     instant the user toggles one.

import { useSyncExternalStore } from "react";
import { bech32m } from "bech32";
import { addressKey } from "./address";
import { rpc } from "./rpc";

export type Network = "mainnet" | "testnet" | "devnet";

/** Network → bech32m HRP, mirroring the node's `Network::hrp()`. */
const HRP: Record<Network, string> = {
  mainnet: "xf",
  testnet: "xft",
  devnet: "xfd",
};

/** bech32m code length cap — our addresses are ~62 chars, well under. */
const BECH32M_LIMIT = 90;

/** Exactly 64 hex chars (case-insensitive). */
const HEX64 = /^[0-9a-fA-F]{64}$/;

// ── network resolution ─────────────────────────────────────────────────────

// Default to mainnet: it's the wallet's default node and the right HRP for
// every real user. Overwritten once resolveNetwork() hears back from the node.
let resolvedNetwork: Network = "mainnet";

/** Ask walletd which network it is bound to, once, and cache the HRP choice.
 *  Reads `network` off the already-routed `get_status` (walletd is genesis-
 *  bound to one network and reports it). Best-effort: an older walletd without
 *  the field, an offline daemon, or devmock leaves the mainnet default in
 *  place — and mainnet is the only network real users touch. Safe to call
 *  repeatedly. (Note: the node's get_node_info also carries `network`, but the
 *  wallet's rpc() targets walletd, which doesn't forward that method.) */
export async function resolveNetwork(): Promise<Network> {
  try {
    const info = await rpc<{ network?: string }>("get_status", {});
    const n = info?.network;
    if (n === "mainnet" || n === "testnet" || n === "devnet") {
      if (n !== resolvedNetwork) {
        resolvedNetwork = n;
        emit(); // any addresses already shown as bech32m re-encode under the new HRP
      }
    }
  } catch {
    /* keep the mainnet default */
  }
  return resolvedNetwork;
}

/** The network whose HRP we encode with (for tests / callers that need it). */
export function currentNetwork(): Network {
  return resolvedNetwork;
}

// ── codec ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array | null {
  if (!HEX64.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode a 64-hex (or any-form) address as bech32m under `net` (default: the
 *  resolved network). Returns null if the input isn't a 32-byte address — the
 *  caller then falls back to showing the original string, never an empty box. */
export function encodeBech32mAddr(
  address: string,
  net: Network = resolvedNetwork,
): string | null {
  // Canonicalize first so a bech32m input (or mixed-case hex) still encodes.
  const hex = addressKey(address.trim());
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  try {
    return bech32m.encode(HRP[net], bech32m.toWords(bytes), BECH32M_LIMIT);
  } catch {
    return null;
  }
}

// ── per-address preference store ────────────────────────────────────────────

const PREF_KEY = "exfer-walletd-desktop-addrform-v1";

function loadPrefs(): Set<string> {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return new Set();
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  } catch {
    return new Set();
  }
}

function savePrefs(s: Set<string>) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** True if the user has opted this address into the bech32m display form. */
export function isBech32mPreferred(address: string): boolean {
  return loadPrefs().has(addressKey(address));
}

/** Flip this address between hex and bech32m display, persist, and notify. */
export function toggleAddressForm(address: string) {
  const key = addressKey(address);
  const s = loadPrefs();
  if (s.has(key)) s.delete(key);
  else s.add(key);
  savePrefs(s);
  emit();
}

/** The string to SHOW for `address`: bech32m when opted in (and encodable),
 *  otherwise the address unchanged. Copy/QR should use this so what the user
 *  copies matches what they see. */
export function displayAddress(address: string): string {
  if (!isBech32mPreferred(address)) return address;
  return encodeBech32mAddr(address) ?? address;
}

// ── reactivity ──────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React binding for one address. `display` is what to render/copy/QR-encode,
 *  `isBech32m` drives the toggle button's state, `toggle` flips it. All
 *  on-screen copies stay in sync because they share one store. */
export function useAddressDisplay(address: string): {
  display: string;
  isBech32m: boolean;
  toggle: () => void;
} {
  const display = useSyncExternalStore(
    subscribe,
    () => displayAddress(address),
  );
  const isBech32m = useSyncExternalStore(
    subscribe,
    () => isBech32mPreferred(address),
  );
  return { display, isBech32m, toggle: () => toggleAddressForm(address) };
}
