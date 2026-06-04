// Small display helpers shared across screens, built on the real lib.

import type { WalletEntry } from "./types";
import { getLabel } from "./labels";

export const EXFER_UNIT = 100_000_000;
export const EXPLORER = "https://explorer.exfer.dev";
// BSC block explorer for the BNB leg of a swap. Testnet (Chapel) while the HTLC
// contract is on testnet; switch to https://bscscan.com on mainnet.
export const BSC_EXPLORER = "https://testnet.bscscan.com";

/** Explorer URL for a tx, routed by chain: a 0x-prefixed hash is a BSC tx
 *  (BscScan); anything else is an EXFER tx id (the EXFER explorer). */
export function txExplorerUrl(txid: string): string {
  return txid.startsWith("0x")
    ? `${BSC_EXPLORER}/tx/${txid}`
    : `${EXPLORER}/tx/${txid}`;
}

/** Human name for an address row: a local label if set, else "Imported"
 *  (independent/imported keys) or "Address N" (HD-indexed). */
export function addrName(entry: WalletEntry): string {
  const label = entry.label ?? getLabel(entry.address);
  if (label) return label;
  if (entry.index != null) return `Address ${entry.index}`;
  return "Imported";
}

/** Generative symmetric-identicon avatar: a foreground glyph painted on a
 *  5×5 grid (mirrored left↔right) over a dark brand-hued tile. `cells` are
 *  grid coordinates 0–4; the renderer scales them into a 0–100 viewBox. */
export const AVATAR_GRID = 5;

export interface AvatarCell {
  x: number;
  y: number;
}

export interface AvatarData {
  /** Cell (foreground) hue and tile (background) hue, in degrees. The actual
   *  lightness/chroma is chosen in CSS per theme (dark tile + light cells in
   *  dark mode; light tile + darker cells in light mode), so identicons read
   *  well on both canvases while keeping each address's colour identity. */
  hue: number;
  bgHue: number;
  cells: AvatarCell[];
}

/** FNV-1a fold of the address seeding a small xorshift32 stream, so the
 *  whole avatar is deterministic per address (same address → same art). */
function seededRng(address: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Hue picker biased toward the cool cyan→violet brand range, with the
 *  occasional warm pop so the address list never reads as one color. */
function brandHue(r: () => number): number {
  const cool = [170, 185, 195, 200, 215, 230, 250, 265, 280];
  const warm = [320, 30, 12];
  return r() < 0.82
    ? cool[Math.floor(r() * cool.length)]
    : warm[Math.floor(r() * warm.length)];
}

/** Deterministic symmetric identicon from an address: a bright brand-hued
 *  glyph on a dark tile, mirrored across the vertical axis so it reads as a
 *  unique mark. Same address → same art. */
export function avatarData(address: string): AvatarData {
  const r = seededRng(address);
  const hue = brandHue(r);
  const bgHue = (hue + 20) % 360;
  const cells: AvatarCell[] = [];
  const half = Math.ceil(AVATAR_GRID / 2); // columns 0..2 drive the mirror
  for (let x = 0; x < half; x++) {
    for (let y = 0; y < AVATAR_GRID; y++) {
      if (r() > 0.5) {
        cells.push({ x, y });
        const mx = AVATAR_GRID - 1 - x;
        if (mx !== x) cells.push({ x: mx, y });
      }
    }
  }
  return { hue, bgHue, cells };
}
