// bech32m presentation helpers (issue #36). An EXFER address has two textual
// spellings of the SAME 32 bytes: legacy 64-hex, and checksummed bech32m
// "xf…/xft…/xfd…". This module encodes the bech32m form for the address-format
// sheet; the machine `address` field stays hex everywhere (agents pin it), and
// rows display hex — bech32m is only shown alongside it on demand.

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

// Default to mainnet: the wallet's default node and the right HRP for every
// real user. Overwritten once resolveNetwork() hears back from walletd.
let resolvedNetwork: Network = "mainnet";

/** Ask walletd which network it is bound to, once, and cache the HRP choice.
 *  Reads `network` off the already-routed `get_status`. Best-effort: an older
 *  walletd without the field, an offline daemon, or devmock leaves the mainnet
 *  default in place. Safe to call repeatedly. */
export async function resolveNetwork(): Promise<Network> {
  try {
    const info = await rpc<{ network?: string }>("get_status", {});
    const n = info?.network;
    if (n === "mainnet" || n === "testnet" || n === "devnet") {
      resolvedNetwork = n;
    }
  } catch {
    /* keep the mainnet default */
  }
  return resolvedNetwork;
}

/** The network whose HRP we encode with. */
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
 *  caller then falls back to showing the original string. */
export function encodeBech32mAddr(
  address: string,
  net: Network = resolvedNetwork,
): string | null {
  const hex = addressKey(address.trim());
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  try {
    return bech32m.encode(HRP[net], bech32m.toWords(bytes), BECH32M_LIMIT);
  } catch {
    return null;
  }
}
