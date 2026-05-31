// Mirrors the BootstrapStatus enum on the Rust side
// (src-tauri/src/walletd_supervisor.rs).
export type BootstrapStatus =
  | { status: "needs_password" }
  | { status: "ready"; local_addr: string; fingerprint: string }
  | { status: "failed"; message: string };

// Wire shape from walletd's `get_wallet_balance` — see
// exfer-walletd's docs/src/rpc-reference.md.
export interface WalletEntry {
  address: string;
  index: number | null;
  label: string | null;
  imported: boolean;
  balance: number;
  // Unconfirmed (mempool) view, present when balance is polled with
  // { pending: true }. `pending_received` is incoming value sitting in
  // the mempool — visible seconds after a sender broadcasts, ahead of
  // confirmation. `pending_spent` is this address's outputs being spent
  // by an unconfirmed tx. Both omitted against a node too old to answer
  // get_address_mempool.
  pending_received?: number;
  pending_spent?: number;
  // Omitted when balance is polled with { utxos: false }; populated on
  // demand via the wallet provider's refreshUtxos().
  utxo_count?: number;
  truncated?: boolean;
}

export interface WalletBalance {
  entries: WalletEntry[];
  total: number;
  // Confirmed + unconfirmed credit − unconfirmed debit, summed over the
  // entries here. Equals `total` when there's nothing pending.
  projected: number;
  // False when the upstream node predates get_address_mempool, so no
  // pending signal is available and `projected` falls back to `total`.
  pending_supported: boolean;
}

// walletd `get_address_mempool` — the node's unconfirmed (mempool) view of
// one address: the txs crediting (`received`) or debiting (`spent`) it, with
// the real tx ids. This is how a deposit watcher gets a TRUE inbound tx id
// the moment funds hit the mempool, ahead of confirmation. `received`/`spent`
// default to empty server-side, so treat them as optional.
export interface AddressMempoolResponse {
  address: string;
  tip_height: number;
  mempool?: MempoolTx[];
}

export interface MempoolTx {
  tx_id: string;
  received?: { output_index: number; value: number }[];
  spent?: { tx_id: string; output_index: number; value: number }[];
}

// walletd `get_address_history` (delegated to the upstream exfer-indexer) —
// the authoritative CONFIRMED per-address timeline: every on-chain credit
// (`direction: "output"`, an output paying this address) and debit
// (`direction: "input"`, one of this address's outputs being spent), each with
// a real on-chain `tx_id` and the `block_height` it confirmed at. Unlike the
// mempool/poll capture, this surfaces deposits that landed while the app was
// closed — the indexer scanned the whole chain, so nothing is missed.
export interface AddressHistoryRow {
  block_height: number;
  tx_id: string;
  amount: number;
  direction: "input" | "output";
  is_coinbase: boolean;
  // Addresses on the other side of this tx (senders for an "output"/received
  // row, recipients for an "input"/spent row), self excluded. Lets Activity
  // show From/To natively. Absent on older indexers.
  counterparties?: string[];
}

export interface AddressHistoryResponse {
  history: AddressHistoryRow[];
  // Opaque pagination token; present when more rows exist past this page.
  next_cursor?: string;
}

export interface GeneratedAddress {
  address: string;
  /// HD derivation index — present only for legacy seeded `generate_address`.
  /// Independent (1:1) keys from `generate_independent_address` have none.
  index?: number;
  pubkey: string;
  /// True for an independent 1:1 key (the keyring-model default).
  imported?: boolean;
}

export interface TransferReceipt {
  tx_id: string;
  size: number;
  fee: number;
  fee_rate: number;
  inputs: { tx_id: string; output_index: number; value: number }[];
  outputs: { to: string; amount: number; is_change: boolean }[];
  built_at_height: number;
}
