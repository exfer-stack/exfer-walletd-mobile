// The wallet's BNB (BSC/EVM) key as a first-class, independent identity.
//
// Seedless wallets — every in-app create + every vault import — start with NO
// BSC key. `bsc_get_address` no longer errors in that case; it returns
// `{created:false}` so the UI can route the user to set one up BEFORE they fill
// any form. This hook is the single source of truth for "do we have a BNB
// wallet yet" across Home / Swap / Liquidity.

import { useCallback, useEffect, useState } from "react";
import { rpc } from "./rpc";

/** Raw `bsc_get_address` shape: address is null until a BNB key exists. */
export interface BscAddressInfo {
  address: string | null;
  created: boolean;
}

/** Reactive view of the wallet's BNB key. Re-fetches on mount; call `refresh()`
 *  after creating / importing / deleting so every entry point updates at once. */
export interface BscWallet {
  address: string | null;
  created: boolean;
  /** True only during the very first fetch (no answer yet) — lets callers show
   *  a skeleton instead of flashing the "set up" CTA before we know. */
  loading: boolean;
  refresh: () => Promise<void>;
}

// Module-level cache of the last-known BNB-key state. The hook re-mounts on
// every tab switch (Home/Swap/Liquidity unmount when you leave them); without a
// cache each mount restarts from {created:false, loading:true}, so the BNB card
// blanks out and the "Set up" CTA flashes for a beat before the re-fetch lands —
// the "it disappears / I have to leave and come back" bug. Seeding from the
// cache makes a re-mount render the real state immediately while it revalidates.
// Cleared on wallet reset/switch via clearBscWalletCache().
let bscCache: BscAddressInfo | null = null;

export function clearBscWalletCache(): void {
  bscCache = null;
}

export function useBscWallet(): BscWallet {
  const [address, setAddress] = useState<string | null>(bscCache?.address ?? null);
  const [created, setCreated] = useState<boolean>(bscCache?.created ?? false);
  // "loading" only before the very first answer ever — a re-mount with a cached
  // answer renders it immediately (no skeleton, no CTA flash).
  const [loading, setLoading] = useState<boolean>(bscCache === null);

  const apply = useCallback((r: BscAddressInfo) => {
    bscCache = r;
    setAddress(r.address);
    setCreated(r.created);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await getBscAddress());
    } catch {
      // Transient read: keep the last-known state rather than blanking the card
      // / flashing the setup CTA. Only the very first load (no cache) falls back.
      if (!bscCache) {
        setAddress(null);
        setCreated(false);
      }
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getBscAddress();
        if (!cancelled) apply(r);
      } catch {
        if (!cancelled && !bscCache) {
          setAddress(null);
          setCreated(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  return { address, created, loading, refresh };
}

// ── typed RPC wrappers for the BNB key lifecycle ──────────────────────────

/** Whether a BNB key exists, and its EIP-55 address. Never errors on "none". */
export function getBscAddress(): Promise<BscAddressInfo> {
  return rpc<BscAddressInfo>("bsc_get_address");
}

/** Generate a brand-new BNB wallet (fresh 24-word mnemonic → secp256k1).
 *  Returns the address plus the words to back up. `force` overwrites an existing
 *  seed-derived address on a seeded wallet (normally unneeded — seedless wallets
 *  have no key, so create is the default). */
export function createBscWallet(force?: boolean): Promise<{ address: string; mnemonic: string[] }> {
  return rpc("bsc_create_address", force ? { force: true } : {});
}

/** Import a MetaMask-style raw private key (0x + 64 hex) as the BNB wallet. */
export function importBscKey(
  privateKeyHex: string,
  overwrite?: boolean,
): Promise<{ address: string }> {
  return rpc("bsc_import_key", {
    private_key_hex: privateKeyHex,
    overwrite: overwrite ?? false,
  });
}

/** Import a MetaMask-style BIP-39 phrase (12 or 24 words) as the BNB wallet. */
export function importBscMnemonic(
  mnemonic: string,
  overwrite?: boolean,
): Promise<{ address: string }> {
  return rpc("bsc_import_mnemonic", {
    mnemonic,
    overwrite: overwrite ?? false,
  });
}

/** Reveal the BNB wallet's recovery phrase (passphrase- + Spend-gated). */
export function revealBscMnemonic(passphrase: string): Promise<{ mnemonic: string[] }> {
  return rpc("bsc_reveal_mnemonic", { passphrase });
}
