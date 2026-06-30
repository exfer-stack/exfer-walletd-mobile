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

/** True when a wallet already exists on this device (needs unlocking) vs. a
 *  genuine first run. Drives the onboarding's unlock-vs-create choice. */
export function walletExists(): Promise<boolean> {
  if (devmock.isActive()) return devmock.wallet_exists();
  return invoke<boolean>("wallet_exists_cmd");
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

export type MnemonicScheme = "standard" | "legacy";

/** One candidate address for an imported phrase, with its on-chain balance
 *  (base units; null if the chain couldn't be reached). */
export type MnemonicCandidate = { address: string; balance: number | null };

/** The two addresses a 24-word phrase maps to — `standard` (BIP39, matches
 *  exfer.dev / the apps) and `legacy` (raw-key words) — each with its balance
 *  so the user can pick the one that holds their coins. Imports nothing. */
export function previewMnemonicImport(
  phrase: string,
): Promise<{ standard: MnemonicCandidate; legacy: MnemonicCandidate }> {
  if (devmock.isActive()) return devmock.preview_mnemonic_import(phrase);
  return invoke("preview_mnemonic_import", { phrase });
}

/** Import a 24-word phrase under the chosen scheme. Returns the address. */
export function importMnemonicScheme(
  phrase: string,
  scheme: MnemonicScheme,
  label?: string,
): Promise<{ address: string }> {
  if (devmock.isActive()) return devmock.import_mnemonic_scheme(phrase, scheme, label);
  return invoke("import_mnemonic_scheme", { phrase, scheme, label: label ?? null });
}

/** Create a new address using walletd's standard BIP39 scheme — the same
 *  phrase reproduces this address in any Exfer wallet. */
export function generateStandardAddress(label?: string): Promise<{ address: string }> {
  return rpc("generate_standard_address", { label: label ?? null });
}

/** Reveal an address's recovery phrase. walletd returns the standard phrase
 *  for standard addresses and the legacy raw-key phrase for older/imported
 *  ones. */
export function revealMnemonic(
  address: string,
  passphrase: string,
): Promise<{ mnemonic: string[] }> {
  return rpc("reveal_address_mnemonic", { address, passphrase });
}

/** Reveal the BSC/EVM (secp256k1) private key for the wallet's BNB address, so
 *  it can be imported into MetaMask-style wallets. Returns the 0x-prefixed hex
 *  plus the address it controls. Passphrase- and Spend-gated. */
export function revealEvmPrivateKey(
  passphrase: string,
): Promise<{ address: string; private_key_hex: string }> {
  return rpc("reveal_evm_private_key", { passphrase });
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
  /** Configured indexer URL; empty string ⇒ the app uses its built-in default.
   *  The indexer is anonymous (public read-only chain data) — no token. */
  rpc: string;
}

export function getIndexerConfig(): Promise<IndexerConfig> {
  if (devmock.isActive()) return devmock.get_indexer_config();
  return invoke<IndexerConfig>("get_indexer_config");
}

export function setIndexerConfig(rpc: string): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.set_indexer_config(rpc);
  return invoke<BootstrapStatus>("set_indexer_config", { rpc });
}

export function resetWallet(): Promise<BootstrapStatus> {
  if (devmock.isActive()) return devmock.reset_wallet();
  return invoke<BootstrapStatus>("reset_wallet");
}

/** The walletd-side debug report: app version + platform + the embedded
 *  walletd's captured log ring buffer. Tauri-only — in browser-dev there is no
 *  embedded walletd, so return a short note instead of crashing on the missing
 *  command. The frontend pairs this with its own console buffer (getDebugLog). */
export function getDebugLogs(): Promise<string> {
  if (devmock.isActive()) {
    return Promise.resolve("(browser dev — no embedded walletd log captured)");
  }
  return invoke<string>("get_debug_logs");
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
/** Pick a .vault file from the device. null = the picker was cancelled. Android
 *  can't filter by extension (no MIME for .vault), so the chosen file may be
 *  anything — it's validated by attempting the import (importVaultBytes). */
export async function pickVaultFile(): Promise<Uint8Array | null> {
  return readPickedFile([{ name: "Vault", extensions: ["vault"] }]);
}

/** Restore from already-read vault bytes. Throws on an obviously-invalid file
 *  (so a stray photo/empty pick fails fast) or the walletd error when the file
 *  isn't a vault / the backup password is wrong. Returns # of new addresses. */
export async function importVaultBytes(
  bytes: Uint8Array,
  filePassword: string,
): Promise<number> {
  // A real sealed vault is well over this; reject obvious non-vault picks up
  // front with a clear message instead of a cryptic AEAD failure.
  if (bytes.length < 32) throw new Error("not a valid .vault backup file");
  const r = await rpc<{ imported: string[] }>("import_vault", {
    vault_hex: bytesToHex(bytes),
    passphrase: filePassword,
  });
  return r.imported.length;
}

export async function importVaultFile(args: {
  filePassword: string;
}): Promise<number | null> {
  if (devmock.isActive()) return devmock.import_vault_file(args);
  const bytes = await pickVaultFile();
  if (!bytes) return null;
  return importVaultBytes(bytes, args.filePassword);
}

/** Validate a .vault + its backup password WITHOUT creating a wallet. Throws on
 *  a wrong password / non-vault file. Used by onboarding to reject a bad restore
 *  BEFORE submit_password — otherwise the app auto-enters the just-created wallet
 *  the instant walletd reports ready, hiding the import failure. */
export async function validateVaultBytes(
  bytes: Uint8Array,
  filePassword: string,
): Promise<void> {
  if (bytes.length < 32) throw new Error("not a valid .vault backup file");
  // Tauri-only Rust check (no walletd/keystore needed). Browser dev has no Tauri
  // layer and doesn't exercise onboarding-restore, so it's a no-op there.
  if (devmock.isActive()) return;
  await invoke("validate_vault", { vaultHex: bytesToHex(bytes), filePassword });
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
