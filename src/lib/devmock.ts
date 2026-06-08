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
    method === "reveal_evm_private_key" ||
    method === "reveal_address_mnemonic" ||
    method === "export_vault" ||
    method === "export_address" ||
    method === "import_vault" ||
    method === "delete_address" ||
    // Cross-chain swap + BNB withdrawal move funds — Spend.
    method === "swap_get_quote" ||
    method === "swap_execute" ||
    method === "swap_refund" ||
    method === "bsc_send_bnb" ||
    // BNB-wallet key material: reveal exposes the mnemonic, delete destroys it.
    method === "bsc_reveal_mnemonic" ||
    method === "bsc_delete_key" ||
    method === "lp_withdraw_self" ||
    method === "htlc_lock" ||
    method === "htlc_claim" ||
    method === "htlc_reclaim"
  )
    return "spend";
  if (
    method === "generate_address" ||
    method === "generate_independent_address" ||
    method === "generate_standard_address" ||
    method === "import_private_key" ||
    method === "import_mnemonic" ||
    method === "import_standard_mnemonic" ||
    // BNB wallet: create generates the independent EVM key; import_* add one.
    method === "bsc_create_address" ||
    method === "bsc_import_mnemonic" ||
    method === "bsc_import_key" ||
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

// ── vote server (exfer-vote) dev transport + in-memory mock ─────────────────
// Mirrors the walletd dual mode: when VITE_VOTE_PROXY_TARGET points the Vite
// `/__vote` proxy at a real exfer-vote service, hit it; otherwise synthesise
// realistic proposals/results so `npm run dev` works fully in-browser.

const VOTE_BASE = "/__vote";

function useRealVote(): boolean {
  return !!import.meta.env.VITE_VOTE_PROXY_TARGET;
}

// One open + one upcoming + one finalized proposal, with a live tally on the
// open one. min_power = 50,000 EXFER. Persisted votes live in MOCK_VOTES so
// re-vote / latest-nonce / live-bar behaviour is exercisable in the browser.
const MOCK_MIN_POWER = 5_000_000_000_000; // 50,000 EXFER
const _now = Math.floor(Date.now() / 1000);

const MOCK_PROPOSALS = [
  {
    id: "xfer-501-buyback",
    title: { en: "Treasury buyback & burn", zh: "国库回购销毁" },
    description: {
      en: "Use 30% of monthly fee revenue to buy EXFER on the open market and burn it permanently, tightening circulating supply.",
      zh: "把每月手续费收入的 30% 用来在公开市场回购 EXFER 并永久销毁,收紧流通供应、利好持币者。",
    },
    options: [
      { id: "opt_a", label: { en: "Yes — buyback & burn", zh: "赞成 —— 回购并销毁" } },
      { id: "opt_b", label: { en: "No — keep in treasury", zh: "反对 —— 留在国库" } },
      { id: "opt_c", label: { en: "Abstain", zh: "弃权" } },
    ],
    voting_window: { open_time: _now - 86_400, close_time: _now + 5 * 86_400 },
    status: "open" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    // One inline image + one download-only file, so `npm run dev` exercises
    // both attachment kinds. `kind` is server-decided; we mirror the contract
    // (raster → "image", everything else → "file"). The bytes themselves are
    // served by exfer-vote at GET /media/<id>; with no VITE_VOTE_PROXY_TARGET
    // the URLs are inert placeholders (same caveat as the rest of mock vote
    // data), but the attachment UI still renders from this metadata.
    attachments: [
      {
        id: "9f3c1a2b4d5e6f708192a3b4c5d6e7f8",
        filename: "buyback-flow.png",
        content_type: "image/png",
        size: 48_213,
        kind: "image" as const,
      },
      {
        id: "1a2b3c4d5e6f70819a0b1c2d3e4f5a6b",
        filename: "treasury-policy.pdf",
        content_type: "application/pdf",
        size: 192_044,
        kind: "file" as const,
      },
    ],
    results: {
      finalized_at_height: null,
      spot_check_heights: [] as number[],
      total_voters: 137,
      total_power: "1284000000000000", // 12,840,000 EXFER
      by_option: {
        opt_a: "812000000000000",
        opt_b: "402000000000000",
        opt_c: "70000000000000",
      } as Record<string, string>,
    },
  },
  {
    id: "xfer-402-name",
    title: { en: "Name the next testnet", zh: "为下一个测试网命名" },
    description: {
      en: "Pick the codename for the upcoming testnet release.",
      zh: "为即将到来的测试网版本选定代号。",
    },
    options: [
      { id: "opt_a", label: { en: "Aurora", zh: "极光" } },
      { id: "opt_b", label: { en: "Borealis", zh: "北境" } },
    ],
    voting_window: { open_time: _now + 2 * 86_400, close_time: _now + 9 * 86_400 },
    status: "upcoming" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: null,
  },
  {
    id: "xfer-309-feecut",
    title: { en: "Reduce swap fee to 0.2%", zh: "将兑换手续费下调至 0.2%" },
    description: {
      en: "Lower the pool swap fee from 0.3% to 0.2% to stay competitive.",
      zh: "将资金池兑换手续费由 0.3% 下调至 0.2% 以保持竞争力。",
    },
    options: [
      { id: "opt_a", label: { en: "Approve", zh: "通过" } },
      { id: "opt_b", label: { en: "Reject", zh: "否决" } },
    ],
    voting_window: { open_time: _now - 20 * 86_400, close_time: _now - 10 * 86_400 },
    status: "finalized" as const,
    min_power: MOCK_MIN_POWER,
    spot_check: { window_days: 7 },
    results: {
      finalized_at_height: 690_120,
      spot_check_heights: [688_400, 689_700],
      total_voters: 489,
      total_power: "5120000000000000", // 51,200,000 EXFER
      by_option: {
        opt_a: "3980000000000000",
        opt_b: "1140000000000000",
      } as Record<string, string>,
    },
  },
];

// address -> { proposalId -> { option_id, nonce, power } }
interface MockVote { option_id: string; nonce: number; power: number }
const MOCK_VOTES: Record<string, Record<string, MockVote>> = {};

function mockProposalById(id: string) {
  return MOCK_PROPOSALS.find((p) => p.id === id);
}

async function realVoteFetch(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(VOTE_BASE + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const msg = (json && (json.error || json.message)) || `vote server ${resp.status}`;
    throw new Error(String(msg));
  }
  return json;
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

  // The standard/legacy mnemonic derivation lives in the Rust command
  // (BIP39 + SHA-256 + ed25519); there's no Rust in browser dev, so these
  // are device-only. The UI degrades to a note when preview throws.
  async wallet_exists(): Promise<boolean> {
    // Dev mode: treat a previously-seeded mock state as an existing wallet.
    return (loadState().addresses?.length ?? 0) > 0;
  },

  async preview_mnemonic_import(_phrase: string): Promise<{
    standard: { address: string; balance: number | null };
    legacy: { address: string; balance: number | null };
  }> {
    throw new Error("mnemonic preview is only available in the installed app");
  },
  async import_mnemonic_scheme(
    _phrase: string,
    _scheme: "standard" | "legacy",
    _label?: string,
  ): Promise<{ address: string }> {
    throw new Error("mnemonic import is only available in the installed app");
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

  async get_indexer_config(): Promise<{ rpc: string }> {
    // Dev mode talks to walletd over the proxy; the indexer endpoint is the
    // daemon's own config, not the webapp's. Report blank (= "use default").
    return { rpc: "" };
  },

  async set_indexer_config(_rpc: string): Promise<BootstrapStatus> {
    if (useRealWalletd()) {
      throw new Error(
        "Changing the indexer requires restarting the daemon in real-walletd dev mode.",
      );
    }
    return loadState().bootstrap as BootstrapStatus;
  },

  async reset_wallet(): Promise<BootstrapStatus> {
    // Dev mode: wipe local mock state back to first-run.
    localStorage.removeItem(DEV_STATE_KEY);
    return { status: "needs_password" };
  },

  async export_wallet_key(args: {
    address: string;
    exportPassword: string;
  }): Promise<string> {
    // Dev mode can't build a real EXFK; validate inputs and return a fake
    // hex blob so the wrapper's saveBytes() download flow is exercisable.
    if (args.exportPassword.length < 6) {
      throw new Error("export password must be at least 6 characters");
    }
    // 81-byte EXFK length → 162 hex chars; content is deterministic noise.
    return fakeHex(`exfk-${args.address}`, 162);
  },

  async import_wallet_key(args: {
    fileHex: string;
    filePassword: string;
    label?: string;
  }): Promise<string> {
    // Dev mode can't decrypt EXFK; fabricate a fake "imported" address so
    // the modal flow is exercisable end-to-end in the browser.
    if (!args.fileHex) throw new Error("no wallet.key file selected");
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
  }): Promise<string> {
    // Dev mode can't seal a real vault; validate + return a fake location.
    if (!args.walletPassword) throw new Error("wallet password required");
    return "Download/exfer-backup.vault";
  },

  async import_vault_file(args: {
    filePassword: string;
  }): Promise<number> {
    // Dev mode can't read files; fabricate a couple of restored addresses
    // so the restore flow is exercisable end-to-end in the browser.
    if (!args.filePassword) throw new Error("file password required");
    const s = loadState();
    let added = 0;
    for (let i = 0; i < 2; i++) {
      const address = fakeHex(`vault-${args.filePassword}-${i}`, 64);
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

  // ── vote server (exfer-vote) ─────────────────────────────────────────────
  // GET helper: list / detail / my-vote / results. Real mode hits the proxy;
  // otherwise serves MOCK_PROPOSALS + the in-memory MOCK_VOTES tally.
  async vote_api_get(path: string): Promise<unknown> {
    if (useRealVote()) return realVoteFetch("GET", path);

    const [rawPath, query = ""] = path.split("?");
    const qs = new URLSearchParams(query);

    if (rawPath === "/proposals") {
      return { proposals: MOCK_PROPOSALS };
    }

    // /proposals/:id  |  /proposals/:id/my-vote  |  /proposals/:id/results
    const m = rawPath.match(/^\/proposals\/([^/]+)(\/my-vote|\/results)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];
      const p = mockProposalById(id);
      if (!p) throw new Error(`proposal not found: ${id}`);

      if (sub === "/my-vote") {
        const addr = qs.get("address") ?? "";
        const v = MOCK_VOTES[addr]?.[id];
        return v ? { option_id: v.option_id } : { option_id: null };
      }

      if (sub === "/results") {
        return this._voteTally(id);
      }

      // detail — merge any live mock votes into the published tally so the
      // detail sheet shows movement after voting in-browser.
      return { ...p, results: this._voteTally(id) };
    }

    throw new Error(`dev-mock vote_api_get: ${path} not implemented`);
  },

  // POST helper: /votes. Verifies the request shape, snapshots a mock power,
  // records latest-nonce-wins, and returns the credited power.
  async vote_api_post(path: string, body: unknown): Promise<unknown> {
    if (useRealVote()) return realVoteFetch("POST", path, body);

    if (path === "/votes") {
      const b = (body ?? {}) as { payload?: string; signature?: string; pubkey?: string };
      if (!b.payload || !b.signature || !b.pubkey) {
        throw new Error("vote request must carry { payload, signature, pubkey }");
      }
      let parsed: { proposal_id?: string; option_id?: string; address?: string; nonce?: number };
      try {
        parsed = JSON.parse(b.payload);
      } catch {
        throw new Error("payload is not valid JSON");
      }
      const id = parsed.proposal_id ?? "";
      const p = mockProposalById(id);
      if (!p) throw new Error(`proposal not found: ${id}`);
      if (p.status !== "open") throw new Error("proposal is not open for voting");
      if (!p.options.some((o) => o.id === parsed.option_id)) {
        throw new Error(`unknown option: ${parsed.option_id}`);
      }
      const addr = parsed.address ?? "";
      const nonce = Number(parsed.nonce ?? 0);

      // latest-nonce-wins
      const prior = MOCK_VOTES[addr]?.[id];
      if (prior && nonce <= prior.nonce) {
        // Stale / replay — ignore, keep the existing vote, echo its power.
        return { power: prior.power };
      }

      // Snapshot "current balance" from the in-memory wallet state, falling
      // back to a plausible eligible power so a non-walletd dev browser still
      // shows a vote landing.
      const a = loadState().addresses.find((x) => x.address === addr);
      const power = a && a.balance > 0 ? a.balance : 12_840_000_000_000; // 128,400 EXFER
      (MOCK_VOTES[addr] ||= {})[id] = { option_id: parsed.option_id!, nonce, power };
      return { power };
    }

    throw new Error(`dev-mock vote_api_post: ${path} not implemented`);
  },

  // Compose the published mock tally with any in-browser votes layered on top.
  _voteTally(id: string): unknown {
    const p = mockProposalById(id);
    if (!p) throw new Error(`proposal not found: ${id}`);
    const base = p.results;
    const byOption: Record<string, string> = {};
    const seedByOption = (base?.by_option ?? {}) as Record<string, string>;
    for (const opt of p.options) byOption[opt.id] = seedByOption[opt.id] ?? "0";
    let totalPower = BigInt(base?.total_power ?? "0");
    let totalVoters = base?.total_voters ?? 0;

    for (const addr of Object.keys(MOCK_VOTES)) {
      const v = MOCK_VOTES[addr][id];
      if (!v) continue;
      byOption[v.option_id] = (BigInt(byOption[v.option_id] ?? "0") + BigInt(v.power)).toString();
      totalPower += BigInt(v.power);
      totalVoters += 1;
    }
    return {
      finalized_at_height: base?.finalized_at_height ?? null,
      spot_check_heights: base?.spot_check_heights ?? [],
      total_voters: totalVoters,
      total_power: totalPower.toString(),
      by_option: byOption,
    };
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

      case "generate_standard_address": {
        // Standard BIP39 address (walletd v1.12+). Dev mock: a fresh fake key.
        const n = s.addresses.length;
        const address = fakeHex(`std-${n}-${Date.now()}`, 64);
        const pubkey = fakeHex(`stdpk-${n}`, 64);
        s.addresses.push({
          address,
          index: n,
          pubkey,
          balance: 0,
          utxoCount: 0,
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
          version: "1.10.0",
          uptime_secs: 0,
          wallet_count: s.addresses.length,
          in_flight_transfers: 0,
          in_flight_utxos: 0,
          // New field shape (upstream_ok / upstream_nodes / tip) the Settings
          // screen reads. A healthy, synced dev daemon.
          upstream_ok: true,
          upstream_nodes: [s.nodeRpc],
          tip: { height: 690_414, block_id: fakeHex("tip", 64) },
          // Legacy nested shape kept for any older caller.
          upstream: { url: s.nodeRpc, mode: "dev-mock" },
        };

      case "get_address_history": {
        // Curated confirmed history for the FIRST address so the Activity feed
        // renders a realistic received/sent mix with From/To counterparties in
        // dev mode (the real indexer isn't reachable here). Other addresses
        // return empty so the aggregate isn't double-counted.
        const p = params as { address: string };
        const first = s.addresses[0]?.address;
        if (!first || p.address !== first) return { history: [] };
        const peer = (seed: string) => fakeHex(`peer-${seed}`, 64);
        const tx = (seed: string) => fakeHex(`tx-${seed}`, 64);
        const amt = (exfer: number) => Math.round(exfer * EXFER_UNIT);
        return {
          history: [
            { block_height: 690_201, tx_id: tx("a"), amount: amt(0.45), direction: "output", is_coinbase: false, counterparties: [peer("alice")] },
            { block_height: 689_998, tx_id: tx("b"), amount: amt(0.12), direction: "input", is_coinbase: false, counterparties: [peer("bob")] },
            { block_height: 689_540, tx_id: tx("c"), amount: amt(1.80), direction: "output", is_coinbase: false, counterparties: [peer("carol"), peer("dave")] },
            { block_height: 688_870, tx_id: tx("d"), amount: amt(0.30), direction: "input", is_coinbase: false, counterparties: [peer("erin")] },
            { block_height: 687_233, tx_id: tx("e"), amount: amt(2.50), direction: "output", is_coinbase: false, counterparties: [peer("frank")] },
          ],
        };
      }

      case "get_address_mempool": {
        // One live incoming pending tx on the first address — exercises the
        // "in mempool" pill in the feed.
        const p = params as { address: string };
        const first = s.addresses[0]?.address;
        const base = { address: p.address, tip_height: 690_414 };
        if (!first || p.address !== first) return { ...base, mempool: [] };
        return {
          ...base,
          mempool: [
            { tx_id: fakeHex("tx-pending", 64), received: [{ output_index: 0, value: Math.round(0.2 * EXFER_UNIT) }] },
          ],
        };
      }

      case "get_transaction": {
        // The pending tx reads as in-mempool; every other tx as confirmed.
        const p = params as { tx_id: string };
        if (p.tx_id === fakeHex("tx-pending", 64)) return { in_mempool: true };
        return { in_mempool: false, block_height: 690_000 };
      }

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

      case "sign_message": {
        // Dev mock: no real Ed25519 key material in the browser. Return a
        // deterministic fake signature/pubkey so the voting flow completes
        // end-to-end; real signatures only happen via real walletd / Tauri.
        const p = params as { address: string; message: string };
        if (!p.address) throw new Error("sign_message requires an address");
        const known = s.addresses.find((a) => a.address === p.address);
        return {
          address: p.address,
          pubkey: known?.pubkey ?? fakeHex(`pk-${p.address}`, 64),
          signature: fakeHex(`sig-${p.address}-${p.message}`, 128),
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
