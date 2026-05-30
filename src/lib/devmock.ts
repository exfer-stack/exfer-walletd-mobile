// Browser-side fallback when we're not running inside a Tauri webview.
//
// Two modes, selected by Vite env vars set in `.env.local`:
//
// 1. Real walletd dev (preferred for end-to-end testing). Set
//    VITE_USE_REAL_WALLETD=true and the three VITE_WALLETD_TOKEN_*
//    vars; we route `rpc()` through `fetch('/__walletd', …)` which
//    Vite's dev-server proxy forwards to the actual daemon. CORS is a
//    non-issue because the browser sees same-origin.
//
// 2. In-memory mock (default). Synthesises responses locally so the UI
//    layout can be exercised without any backend at all. Persisted in
//    localStorage under DEV_STATE_KEY so refreshes don't wipe state.

import type {
  BootstrapStatus,
  GeneratedAddress,
  TransferReceipt,
  WalletBalance,
  WalletEntry,
} from "./types";

const DEV_STATE_KEY = "exfer-walletd-desktop-dev-state-v1";

const EXFER_UNIT = 100_000_000;

interface DevState {
  bootstrap:
    | { status: "needs_password" }
    | { status: "ready"; local_addr: string; fingerprint: string };
  nodeRpc: string;
  addresses: Array<{
    address: string;
    index: number;
    pubkey: string;
    balance: number;
    utxoCount: number;
    // True for an independent 1:1 key (the keyring-model default) — vs a
    // legacy HD-derived address. Drives nothing visual anymore but kept so
    // dev mode mirrors the daemon's list shape.
    imported?: boolean;
    // Optional mocked unconfirmed credit, surfaced when get_wallet_balance
    // is called with { pending: true } — lets dev mode exercise the
    // pending/incoming UI without a live mempool.
    pendingIn?: number;
  }>;
}

function defaultState(): DevState {
  return {
    bootstrap: { status: "needs_password" },
    nodeRpc: "http://80.78.31.82:9334",
    addresses: [],
  };
}

function loadState(): DevState {
  try {
    const raw = localStorage.getItem(DEV_STATE_KEY);
    if (!raw) return defaultState();
    return JSON.parse(raw) as DevState;
  } catch {
    return defaultState();
  }
}

function saveState(s: DevState) {
  localStorage.setItem(DEV_STATE_KEY, JSON.stringify(s));
}

// Deterministic-ish hex from index for predictable dev visuals.
function fakeHex(seed: string, length: number): string {
  // FNV-1a, expanded to length chars.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < length) {
    h = Math.imul(h ^ 0x9e3779b9, 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

const REAL_BASE = "/__walletd";

function useRealWalletd(): boolean {
  return import.meta.env.VITE_USE_REAL_WALLETD === "true";
}

function realToken(scope: "read" | "manage" | "spend"): string {
  const key = `VITE_WALLETD_TOKEN_${scope.toUpperCase()}` as
    | "VITE_WALLETD_TOKEN_READ"
    | "VITE_WALLETD_TOKEN_MANAGE"
    | "VITE_WALLETD_TOKEN_SPEND";
  const v = import.meta.env[key];
  if (!v) {
    throw new Error(
      `Real-walletd mode: env var ${key} is missing from .env.local`,
    );
  }
  return v as string;
}

function scopeFor(method: string): "read" | "manage" | "spend" {
  if (
    method === "transfer" ||
    method === "send_raw_transaction" ||
    method === "sign_message" ||
    method === "reveal_mnemonic" ||
    method === "reveal_private_key" ||
    method === "reveal_address_mnemonic" ||
    method === "export_vault" ||
    method === "export_address" ||
    method === "import_vault" ||
    method === "delete_address"
  )
    return "spend";
  if (
    method === "generate_address" ||
    method === "generate_independent_address" ||
    method === "import_private_key" ||
    method === "import_mnemonic" ||
    method === "abandon_transfer"
  )
    return "manage";
  return "read";
}

// A deterministic 24-word phrase from a seed, for dev display only (NOT a
// real BIP-39 mnemonic). Lets the recovery-phrase UI render without a
// backend.
const MOCK_WORDS = [
  "ball", "panel", "web", "field", "blossom", "hire", "sketch", "viable",
  "fragile", "museum", "cherry", "talent", "today", "sentence", "truth",
  "camp", "dose", "essence", "crime", "patrol", "guard", "lunar", "manage",
  "supply", "ocean", "ladder", "velvet", "puzzle", "garden", "rocket",
];
function mockMnemonic(seed: string): string[] {
  const hex = fakeHex(seed, 48);
  return Array.from({ length: 24 }, (_, i) => {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return MOCK_WORDS[byte % MOCK_WORDS.length];
  });
}

async function realRpc(method: string, params: unknown): Promise<unknown> {
  const resp = await fetch(REAL_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${realToken(scopeFor(method))}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params ?? {},
    }),
  });
  const body = await resp.json();
  if (body.error) {
    throw new Error(`${body.error.message ?? "rpc error"} (code ${body.error.code})`);
  }
  return body.result;
}

export const devmock = {
  isActive(): boolean {
    // Tauri injects this on window. If absent, we're in a plain browser.
    return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ === "undefined";
  },

  async bootstrap_status(): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // Real walletd is already running outside the desktop process.
      // The "bootstrap" concept (password prompt → spawn walletd) is
      // bypassed in this mode; we report Ready immediately so the UI
      // skips the modal.
      try {
        await realRpc("ping", {});
        return {
          status: "ready",
          local_addr: "127.0.0.1:7448 (via vite proxy)",
          fingerprint: "(plain HTTP — proxy)",
        };
      } catch (e) {
        return {
          status: "failed",
          message: `cannot reach real walletd via ${REAL_BASE}: ${String(e)}`,
        };
      }
    }
    return loadState().bootstrap as BootstrapStatus;
  },

  async submit_password(password: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // No-op in real mode; bootstrap_status already returned Ready.
      return this.bootstrap_status();
    }
    if (!password) throw new Error("password must not be empty");
    const s = loadState();
    s.bootstrap = {
      status: "ready",
      local_addr: "127.0.0.1:54321",
      fingerprint: "sha256:dev-mock-fingerprint",
    };
    saveState(s);
    return s.bootstrap;
  },

  async restore_from_mnemonic(
    phrase: string,
    password: string,
  ): Promise<BootstrapStatus> {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    if (phrase.trim().split(/\s+/).length !== 24) {
      throw new Error("recovery phrase must be 24 words");
    }
    // Dev mode: pretend the restore worked and seed a couple addresses.
    const s = loadState();
    s.bootstrap = {
      status: "ready",
      local_addr: "127.0.0.1:54321",
      fingerprint: "sha256:dev-mock-fingerprint",
    };
    s.addresses = [0, 1, 2].map((index) => ({
      address: fakeHex(`restored-${index}`, 64),
      index,
      pubkey: fakeHex(`rpk-${index}`, 64),
      balance: 0,
      utxoCount: 0,
    }));
    saveState(s);
    return s.bootstrap;
  },

  async get_node_rpc(): Promise<string> {
    if (useRealWalletd()) {
      const st = (await realRpc("get_status", {})) as {
        upstream?: { url?: string };
      };
      return st.upstream?.url ?? "(unknown)";
    }
    return loadState().nodeRpc;
  },

  async set_node_rpc(url: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      // walletd has no runtime-mutable node_rpc — would need a restart
      // with new env. Surface a friendly failure.
      throw new Error(
        "Changing the upstream node requires restarting the daemon in real-walletd dev mode.",
      );
    }
    const s = loadState();
    s.nodeRpc = url;
    saveState(s);
    return s.bootstrap as BootstrapStatus;
  },

  async reset_wallet(): Promise<BootstrapStatus> {
    // Dev mode: wipe local mock state back to first-run.
    localStorage.removeItem(DEV_STATE_KEY);
    return { status: "needs_password" };
  },

  async export_wallet_key(args: {
    address: string;
    exportPassword: string;
  }): Promise<void> {
    // Dev mode can't write files / build EXFK; just validate inputs so
    // the modal flow is exercisable.
    if (args.exportPassword.length < 6) {
      throw new Error("export password must be at least 6 characters");
    }
    // no-op: a real Tauri build writes the .key file.
  },

  async import_wallet_key(args: {
    path: string;
    filePassword: string;
    label?: string;
  }): Promise<string> {
    // Dev mode can't read EXFK files; fabricate a fake "imported" address
    // so the modal flow is exercisable end-to-end in the browser.
    if (!args.path) throw new Error("no wallet.key file selected");
    if (!args.filePassword) throw new Error("file password required");
    const s = loadState();
    const address = fakeHex(`imported-${Date.now()}`, 64);
    s.addresses.push({
      address,
      index: s.addresses.length,
      pubkey: fakeHex(`pk-imp-${address.slice(0, 8)}`, 64),
      balance: 0,
      utxoCount: 0,
    });
    saveState(s);
    return address;
  },

  async export_vault_file(args: {
    walletPassword: string;
    dest: string;
  }): Promise<void> {
    // Dev mode can't write files; just validate so the flow is exercisable.
    if (!args.walletPassword) throw new Error("wallet password required");
    // no-op: a real Tauri build writes the sealed .vault file.
  },

  async import_vault_file(args: {
    path: string;
    filePassword: string;
  }): Promise<number> {
    // Dev mode can't read files; fabricate a couple of restored addresses
    // so the restore flow is exercisable end-to-end in the browser.
    if (!args.path) throw new Error("no backup file selected");
    if (!args.filePassword) throw new Error("file password required");
    const s = loadState();
    let added = 0;
    for (let i = 0; i < 2; i++) {
      const address = fakeHex(`vault-${args.path}-${i}`, 64);
      if (s.addresses.find((a) => a.address === address)) continue;
      s.addresses.push({
        address,
        index: s.addresses.length,
        pubkey: fakeHex(`vpk-${address.slice(0, 8)}`, 64),
        balance: 0,
        utxoCount: 0,
        imported: true,
      });
      added++;
    }
    saveState(s);
    return added;
  },

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (useRealWalletd()) {
      return realRpc(method, params);
    }
    const s = loadState();
    if (s.bootstrap.status !== "ready") throw new Error("walletd not ready");

    switch (method) {
      case "ping":
        return { ok: true };

      case "list_addresses":
        return {
          addresses: s.addresses.map((a) => ({
            address: a.address,
            // Imported addresses have no HD index — surface that so the
            // UI's "Imported" pill works in dev mode too.
            ...(a.pubkey.startsWith("pk-imp-")
              ? { imported: true }
              : { index: a.index, imported: false }),
            label: null,
          })),
        };

      case "get_wallet_balance": {
        // Mirror the daemon: utxo_count/truncated only when utxos !== false,
        // and pending_received/pending_spent only when pending === true.
        const p = params as { utxos?: boolean; pending?: boolean };
        const withUtxos = p?.utxos !== false;
        const withPending = p?.pending === true;
        const entries: WalletEntry[] = s.addresses.map((a) => ({
          address: a.address,
          index: a.index,
          label: null,
          imported: false,
          balance: a.balance,
          ...(withUtxos
            ? { utxo_count: a.utxoCount, truncated: false }
            : {}),
          ...(withPending
            ? { pending_received: a.pendingIn ?? 0, pending_spent: 0 }
            : {}),
        }));
        const total = entries.reduce((acc, e) => acc + e.balance, 0);
        const projected = entries.reduce(
          (acc, e) =>
            acc + e.balance + (e.pending_received ?? 0) - (e.pending_spent ?? 0),
          0,
        );
        const out: WalletBalance = {
          entries,
          total,
          projected,
          pending_supported: withPending,
        };
        return out;
      }

      case "generate_address": {
        const index = s.addresses.length;
        const address = fakeHex(`addr-${index}`, 64);
        const pubkey = fakeHex(`pk-${index}`, 64);
        // Seed the first address with a small visible balance to make
        // the dashboard non-empty in dev.
        const balance = index === 0 ? Math.floor(0.1 * EXFER_UNIT) : 0;
        const utxoCount = balance > 0 ? 1 : 0;
        s.addresses.push({ address, index, pubkey, balance, utxoCount });
        saveState(s);
        const out: GeneratedAddress = { address, index, pubkey };
        return out;
      }

      case "generate_independent_address": {
        // Keyring-model default: a fresh independent 1:1 key (no HD index).
        const n = s.addresses.length;
        const address = fakeHex(`ind-${n}-${Date.now()}`, 64);
        const pubkey = fakeHex(`indpk-${n}`, 64);
        const balance = n === 0 ? Math.floor(0.1 * EXFER_UNIT) : 0;
        s.addresses.push({
          address,
          index: n,
          pubkey,
          balance,
          utxoCount: balance > 0 ? 1 : 0,
          imported: true,
        });
        saveState(s);
        return { address, pubkey, imported: true };
      }

      case "reveal_address_mnemonic": {
        const p = params as { address: string; passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        if (!s.addresses.find((a) => a.address === p.address)) {
          throw new Error(`Wallet not found: ${p.address}`);
        }
        return { address: p.address, mnemonic: mockMnemonic(`am-${p.address}`) };
      }

      case "import_mnemonic": {
        const p = params as { mnemonic: string; label?: string };
        if (!p.mnemonic || p.mnemonic.trim().split(/\s+/).length !== 24) {
          throw new Error("recovery phrase must be 24 words");
        }
        const address = fakeHex(`frommn-${p.mnemonic.trim()}`, 64);
        if (!s.addresses.find((a) => a.address === address)) {
          s.addresses.push({
            address,
            index: s.addresses.length,
            pubkey: fakeHex(`mnpk-${address.slice(0, 8)}`, 64),
            balance: 0,
            utxoCount: 0,
            imported: true,
          });
          saveState(s);
        }
        return { address, imported: true };
      }

      case "delete_address": {
        const p = params as { address: string; passphrase: string; force?: boolean };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        const target = s.addresses.find((a) => a.address === p.address);
        if (!target) throw new Error(`Wallet not found: ${p.address}`);
        if (!p.force && target.balance > 0) {
          throw new Error(
            `address ${p.address} still holds ${target.balance} exfers — sweep it first, or force the deletion`,
          );
        }
        s.addresses = s.addresses.filter((a) => a.address !== p.address);
        saveState(s);
        return { deleted: p.address };
      }

      case "simulate_transfer": {
        // No broadcast: just return the exact fee for the template so the
        // Send page can show a live per-tier estimate.
        const p = params as {
          from: string;
          outputs: { to: string; amount: number }[];
          fee_rate?: number;
        };
        const sender = s.addresses.find((a) => a.address === p.from);
        if (!sender) throw new Error("from address not in wallet");
        const total = p.outputs.reduce((a, o) => a + o.amount, 0);
        const cost = 70 + 45 * Math.max(1, p.outputs.length);
        const fee = (p.fee_rate ?? 1) * cost;
        if (sender.balance < total + fee) throw new Error("insufficient balance");
        return {
          size: 180 + 34 * p.outputs.length,
          fee,
          fee_rate: p.fee_rate ?? 1,
        };
      }

      case "transfer": {
        const p = params as {
          from: string;
          outputs: { to: string; amount: number }[];
          fee_rate?: number;
        };
        const sender = s.addresses.find((a) => a.address === p.from);
        if (!sender) throw new Error("from address not in wallet");
        const total = p.outputs.reduce((a, o) => a + o.amount, 0);
        const fee = (p.fee_rate ?? 1) * 70; // rough placeholder
        if (sender.balance < total + fee) throw new Error("insufficient balance");
        sender.balance -= total + fee;
        sender.utxoCount = sender.balance > 0 ? 1 : 0;
        for (const o of p.outputs) {
          const recip = s.addresses.find((a) => a.address === o.to);
          if (recip) {
            recip.balance += o.amount;
            recip.utxoCount += 1;
          }
        }
        saveState(s);
        const out: TransferReceipt = {
          tx_id: fakeHex(`tx-${Date.now()}`, 64),
          size: 227,
          fee,
          fee_rate: p.fee_rate ?? 1,
          inputs: [
            {
              tx_id: fakeHex(`prev-${sender.address.slice(0, 8)}`, 64),
              output_index: 0,
              value: total + fee,
            },
          ],
          outputs: p.outputs
            .map((o) => ({ to: o.to, amount: o.amount, is_change: false }))
            .concat({
              to: sender.address,
              amount: sender.balance,
              is_change: true,
            }),
          built_at_height: 631000 + Math.floor(Math.random() * 1000),
        };
        return out;
      }

      case "get_status":
        return {
          version: "dev-mock",
          uptime_secs: 0,
          wallet_count: s.addresses.length,
          in_flight_transfers: 0,
          in_flight_utxos: 0,
          upstream: { url: s.nodeRpc, mode: "dev-mock" },
        };

      case "get_balance": {
        const p = params as { address: string };
        const a = s.addresses.find((x) => x.address === p.address);
        return { address: p.address, balance: a?.balance ?? 0 };
      }

      case "reveal_mnemonic": {
        const p = params as { passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        return {
          mnemonic: [
            "abandon", "ability", "able", "about", "above", "absent",
            "absorb", "abstract", "absurd", "abuse", "access", "accident",
            "account", "accuse", "achieve", "acid", "acoustic", "acquire",
            "across", "act", "action", "actor", "actress", "actual",
          ],
        };
      }

      case "reveal_private_key": {
        const p = params as { address: string; passphrase: string };
        if (!p.passphrase || p.passphrase.length < 4) {
          throw new Error("Keystore locked: wrong passphrase");
        }
        if (!s.addresses.find((a) => a.address === p.address)) {
          throw new Error(`Wallet not found: ${p.address}`);
        }
        return {
          address: p.address,
          secret_hex: fakeHex(`sk-${p.address}`, 64),
        };
      }

      default:
        throw new Error(`dev-mock: method ${method} not implemented`);
    }
  },

  /// Wipe local dev state. Exposed on `window.__exferDevReset` so
  /// devs can `__exferDevReset()` from the browser console.
  reset() {
    localStorage.removeItem(DEV_STATE_KEY);
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { __exferDevReset?: () => void }).__exferDevReset =
    devmock.reset;
}
