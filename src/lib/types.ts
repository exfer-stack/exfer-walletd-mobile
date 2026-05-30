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
