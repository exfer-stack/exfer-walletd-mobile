// Small display helpers shared across screens, built on the real lib.

import type { WalletEntry } from "./types";
import { getLabel } from "./labels";

export const EXFER_UNIT = 100_000_000;
export const EXPLORER = "https://explorer.exfer.dev";

/** Human name for an address row: a local label if set, else "Imported"
 *  (independent/imported keys) or "Address N" (HD-indexed). */
export function addrName(entry: WalletEntry): string {
  const label = entry.label ?? getLabel(entry.address);
  if (label) return label;
  if (entry.index != null) return `Address ${entry.index}`;
  return "Imported";
}

/** Deterministic, low-chroma gradient from an address — keeps avatars
 *  inside the monochrome brand instead of shouting. */
export function avatarStyle(address: string): { background: string } {
  let h = 0;
  for (let i = 0; i < address.length; i += 4) {
    h = (h * 31 + address.charCodeAt(i)) % 360;
  }
  const a = `oklch(0.72 0.12 ${h})`;
  const b = `oklch(0.62 0.13 ${(h + 38) % 360})`;
  return { background: `linear-gradient(135deg, ${a}, ${b})` };
}
