import { invoke } from "@tauri-apps/api/core";
import type { BootstrapStatus } from "./types";
import { devmock } from "./devmock";
import { bytesToHex, hexToBytes, readPickedFile, saveBytes } from "./fsfile";

/// Forward a JSON-RPC call through the Rust shell to the embedded
/// walletd. The shell picks the right scoped token + handles TLS
/// pinning; we just hand it method + params.
///
/// Falls back to an in-browser mock when we're not running inside a
/// Tauri webview — lets us iterate UI in `npm run dev` without the
/// Tauri Linux prereqs. Real Tauri builds never hit the mock branch.
export function rpc<T = unknown>(
  method: string,
  params?: unknown,
): Promise<T> {
  if (devmock.isActive()) {
    return devmock.rpc(method, params ?? {}) as Promise<T>;
  }
  return invoke<T>("rpc", {
    method,
    params: params ?? {},
  });
}

export function bootstrapStatus(): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.bootstrap_status();
  return invoke<BootstrapStatus>("bootstrap_status");
}

export function submitPassword(password: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.submit_password(password);
  return invoke<BootstrapStatus>("submit_password", { password });
}

export function restoreFromMnemonic(
  phrase: string,
  password: string,
): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.restore_from_mnemonic(phrase, password);
  return invoke<BootstrapStatus>("restore_from_mnemonic", { phrase, password });
}

export function getNodeRpc(): Promise<string> {
  if (devmock.isActive()) return devmock.get_node_rpc();
  return invoke<string>("get_node_rpc");
}

export function setNodeRpc(url: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_node_rpc(url);
  return invoke<BootstrapStatus>("set_node_rpc", { url });
}

export interface IndexerConfig {
  /** Configured indexer URL; empty string ⇒ the app uses its built-in default. */
  rpc: string;
  /** Configured bearer token; empty string ⇒ built-in default. */
  token: string;
}

export function getIndexerConfig(): Promise<IndexerConfig> {
  if (devmock.isActive()) return devmock.get_indexer_config();
  return invoke<IndexerConfig>("get_indexer_config");
}

export function setIndexerConfig(
  rpc: string,
  token: string,
): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_indexer_config(rpc, token);
  return invoke<BootstrapStatus>("set_indexer_config", { rpc, token });
}

export function resetWallet(): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.reset_wallet();
  return invoke<BootstrapStatus>("reset_wallet");
}

/// Export one address as an official Exfer `wallet.key` (EXFK) file,
/// encrypted with `exportPassword`. `walletPassword` authorizes pulling
/// the secret from walletd; Rust builds + hex-encodes the EXFK blob and we
/// write the bytes to a user-chosen / platform location here in JS (works
/// on iOS + Android). Importable on exfer.dev. Returns the save location.
export async function exportWalletKey(args: {
  address: string;
  walletPassword: string;
  exportPassword: string;
}): Promise<string> {
  if (devmock.isActive()) {
    const hex = await devmock.export_wallet_key(args);
    return saveBytes(args.address.slice(0, 8) + ".key", hexToBytes(hex));
  }
  const hex = await invoke<string>("export_wallet_key", {
    address: args.address,
    walletPassword: args.walletPassword,
    exportPassword: args.exportPassword,
  });
  return saveBytes(args.address.slice(0, 8) + ".key", hexToBytes(hex));
}

/// Import a `wallet.key` (EXFK) file as a non-derived address. The file is
/// picked + read here in JS (works on mobile); its bytes are hex-encoded
/// and handed to Rust, which parses them, hands the raw secret to walletd's
/// `import_private_key` RPC, and returns the resulting address.
export async function importWalletKey(args: {
  filePassword: string;
  label?: string;
}): Promise<string> {
  const bytes = await readPickedFile([{ name: "wallet.key", extensions: ["key"] }]);
  if (!bytes) throw new Error("No file selected");
  if (devmock.isActive()) {
    return devmock.import_wallet_key({
      fileHex: bytesToHex(bytes),
      filePassword: args.filePassword,
      label: args.label,
    });
  }
  return invoke<string>("import_wallet_key", {
    fileHex: bytesToHex(bytes),
    filePassword: args.filePassword,
    label: args.label ?? null,
  });
}

/// Export the WHOLE keyring as one passphrase-sealed vault file. The
/// keyring-model backup: a single encrypted file, no seed phrase to copy.
/// walletd seals it (authorized by `walletPassword`) via the `export_vault`
/// RPC; we write the bytes to a user-chosen / platform location here in JS.
/// Restore with `importVaultFile` using that same password. Returns the
/// save location.
export async function exportVaultFile(args: {
  walletPassword: string;
}): Promise<string> {
  if (devmock.isActive()) return devmock.export_vault_file(args);
  const { vault_hex } = await rpc<{ vault_hex: string }>("export_vault", {
    passphrase: args.walletPassword,
  });
  return saveBytes("exfer-backup.vault", hexToBytes(vault_hex));
}

/// Restore keys from a vault file written by `exportVaultFile`. The file is
/// picked + read here in JS, hex-encoded, and handed to walletd's
/// `import_vault` RPC. `filePassword` is the password the backup was
/// created with.
///
/// Returns the count of addresses newly restored — which may legitimately be
/// 0 when every address in the backup was already present. Returns `null`
/// (distinct from 0) when the picker was cancelled / no file was chosen, so
/// callers don't report a phantom "restored" on a cancel.
export async function importVaultFile(args: {
  filePassword: string;
}): Promise<number | null> {
  if (devmock.isActive()) return devmock.import_vault_file(args);
  const bytes = await readPickedFile([{ name: "Vault", extensions: ["vault"] }]);
  if (!bytes) return null;
  const r = await rpc<{ imported: string[] }>("import_vault", {
    vault_hex: bytesToHex(bytes),
    passphrase: args.filePassword,
  });
  return r.imported.length;
}

/// Desktop UX cap on managed addresses. walletd itself supports ~4B
/// HD indices, but a personal desktop wallet stays legible (and the
/// per-address balance fan-out stays light on the public node's
/// rate limit) when kept small. Raise if a power-user build needs more.
export const MAX_ADDRESSES = 6;

const EXFER_UNIT = 100_000_000; // 1 EXFER = 1e8 exfers

export function formatExfer(exfers: number): string {
  const { whole, frac } = splitExfer(exfers);
  return frac ? `${whole}.${frac} EXFER` : `${whole} EXFER`;
}

/** Split a balance into grouped integer + fraction (no unit), so the hero
 *  can lead with the whole number and let the fraction recede. Trailing
 *  zeros are dropped — "0.10000000" reads as "0.1"; a whole number returns
 *  an empty `frac`. */
export function splitExfer(exfers: number): { whole: string; frac: string } {
  const whole = Math.floor(exfers / EXFER_UNIT).toLocaleString("en-US");
  const frac = (exfers % EXFER_UNIT)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return { whole, frac };
}

/** How many fractional digits the *compact* headline shows before it stops.
 *  Full precision still lives in tooltips and on the Send / receipt screens. */
const COMPACT_DECIMALS = 4;

/** Compact display split for the dashboard headline + rows: integer in full,
 *  fraction capped so an 8-decimal balance like 0.79999862 reads as "0.7999"
 *  instead of a long tail. Truncated toward zero (never rounded up) so it can
 *  never *overstate* funds. Sub-0.0001 amounts keep going to the first few
 *  significant digits so tiny balances don't collapse to "0". `truncated` is
 *  true when real digits were dropped (caller can offer the full value on
 *  hover): a short balance up top, the exact figure on the detail view. */
export function splitBalanceCompact(exfers: number): {
  whole: string;
  frac: string;
  truncated: boolean;
} {
  const wholeNum = Math.floor(exfers / EXFER_UNIT);
  const whole = wholeNum.toLocaleString("en-US");
  const fracFull = (exfers % EXFER_UNIT).toString().padStart(8, "0");
  let cut = COMPACT_DECIMALS;
  if (wholeNum === 0) {
    const firstSig = fracFull.search(/[1-9]/);
    if (firstSig >= COMPACT_DECIMALS) cut = Math.min(8, firstSig + 3);
  }
  const frac = fracFull.slice(0, cut).replace(/0+$/, "");
  const truncated = fracFull.slice(cut).replace(/0+$/, "") !== "";
  return { whole, frac, truncated };
}

/** Compact one-line balance, e.g. "1,234.5 EXFER". */
export function formatBalanceCompact(exfers: number): string {
  const { whole, frac } = splitBalanceCompact(exfers);
  return frac ? `${whole}.${frac} EXFER` : `${whole} EXFER`;
}

export function parseExferAmount(input: string): number {
  // Accepts "1.234" → 123_400_000 exfers. Throws on garbage.
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw new Error("amount must be a decimal with up to 8 fractional digits");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.padEnd(8, "0");
  return Number(whole) * EXFER_UNIT + Number(fracPadded);
}
