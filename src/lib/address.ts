// Shared address helpers for the EXFER bech32m accept-both rollout.
//
// An EXFER address is a 32-byte script hash with two textual forms:
//   - legacy 64-hex (case-insensitive), and
//   - bech32m (BIP-350) "xf1…/xft1…/xfd1…" for mainnet/testnet/devnet.
// Both decode to the SAME 32 bytes; bech32m just adds a checksum.
//
// IMPORTANT — single source of truth: the AUTHORITATIVE accept/reject (and
// wrong-network detection) is walletd's `parse_address`, which delegates to
// the node's one codec. The functions here are a LOCAL shape check for
// instant UX only — they must never be what decides which bytes get signed.
// They err toward ACCEPTING plausibly-valid input so the user is never
// wrongly blocked; walletd makes the final, strict call (including
// wrong-network rejection) at simulate/transfer time.

import { bech32m } from "bech32";

/** Exactly 64 hex chars (case-insensitive). */
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Whitelisted HRPs: mainnet / testnet / devnet. We accept any of the three
 *  locally; walletd enforces that the HRP matches THIS node's network and
 *  rejects the others with a specific "… not valid on this … node" message. */
const HRPS = ["xf", "xft", "xfd"];

/** bech32m decode limit — our addresses are ~62 chars, well under. */
const BECH32M_LIMIT = 90;

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Decode a bech32m EXFER address to its 32 payload bytes, or null if it is
 *  not a well-formed bech32m address under one of our HRPs. Never throws —
 *  mixed case, bad checksum, wrong charset and non-32-byte payloads all
 *  return null. */
function decodeBech32mAddr(s: string): Uint8Array | null {
  try {
    const dec = bech32m.decode(s, BECH32M_LIMIT);
    if (!HRPS.includes(dec.prefix)) return null;
    const bytes = bech32m.fromWords(dec.words);
    if (bytes.length !== 32) return null;
    return Uint8Array.from(bytes);
  } catch {
    return null;
  }
}

/** True if `s` is a syntactically valid EXFER address in EITHER form. Local
 *  shape check for UX gating only — see the module note. */
export function isValidAddress(s: string): boolean {
  const t = s.trim();
  if (HEX64.test(t)) return true;
  return decodeBech32mAddr(t) !== null;
}

/** True specifically for the bech32m form, so callers can offer
 *  checksum-aware feedback distinct from legacy hex. */
export function isBech32mAddress(s: string): boolean {
  return decodeBech32mAddr(s.trim()) !== null;
}

/** Canonical key for an address, independent of which form the user typed:
 *  the lowercase 64-hex of its decoded bytes. Use this for EVERY internal
 *  comparison and seed — own/recent membership, dedup, avatar identity — so
 *  the same address compares equal across hex and bech32m, and its visual
 *  identity stays stable if the displayed form ever changes. For input that
 *  doesn't decode (shouldn't happen post-validation) it falls back to the
 *  lowercased trimmed string so callers never get an empty key. */
export function addressKey(s: string): string {
  const t = s.trim();
  if (HEX64.test(t)) return t.toLowerCase();
  const bytes = decodeBech32mAddr(t);
  return bytes ? bytesToHex(bytes) : t.toLowerCase();
}
