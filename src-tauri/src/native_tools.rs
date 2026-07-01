//! Native Rust implementation of the built-in `exfer` MCP tool layer.
//!
//! This replaces the `uvx exfer-mcp` sidecar (which can't run on Android/iOS —
//! there is no Python/uvx, so spawning it failed with "No such file or
//! directory"). Every tool here is a thin translation of an MCP tool-call into
//! a walletd JSON-RPC call via [`crate::rpc_client::forward_rpc`] (the same
//! fingerprint-pinned loopback client + per-scope bearer tokens the rest of the
//! app uses), with one exception: `exfer_earn_pool_stats`, which is a plain
//! HTTPS GET to the mining pool's public stats API.
//!
//! The wire contract matches what `exfer-mcp` exposed so the TS agent host
//! (`agentHost.ts`) needs no changes:
//!   * [`list`] returns the implemented tool defs (`{name, description,
//!     inputSchema, server:"exfer"}`), filtered from the bundled manifest.
//!   * [`call`] returns `{content:[{type:"text", text}], isError}` — the
//!     JSON-stringified walletd `result` on success, an error string on failure.
//!
//! Mirrors `exfer-mcp`'s `tools/*.py` handlers and `exfer-py`'s
//! `async_client.py` / `_params.py` for the exact RPC method + param shapes.
//! When you change a mapping here, re-check those two sources.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::rpc_client::{forward_rpc, forward_rpc_with_timeout, ConnectionInfo};

/// The bundled tool manifest (all 40 `exfer-mcp` tool defs). [`list`] filters it
/// down to [`IMPLEMENTED`]; the omitted ones (node-RPC explorers, the
/// subprocess miner, and the MCP-package update check) are not surfaced.
const MANIFEST_JSON: &str = include_str!("native_tools_manifest.json");

/// The tools this native layer implements. listTools returns ONLY these; a call
/// to anything outside this set is treated as "not a native exfer tool".
///
/// Omitted on purpose: `exfer_network_status`, `exfer_network_hashrate`,
/// `exfer_get_block`, `exfer_get_transaction` (need the node's JSON-RPC, a later
/// phase); `exfer_earn` / `exfer_earn_probe` / `exfer_earn_status` /
/// `exfer_earn_stop` (subprocess miner — mobile uses the native `exfer_mine_*`
/// tools injected by agentHost.ts); `exfer_check_update` (MCP-package-specific).
pub const IMPLEMENTED: &[&str] = &[
    "exfer_generate_address",
    "exfer_list_addresses",
    "exfer_get_balance",
    "exfer_get_block_height",
    "exfer_simulate_transfer",
    "exfer_transfer",
    "exfer_quote_issue",
    "exfer_quote_verify",
    "exfer_wait_for_tx",
    "exfer_wait_for_payment",
    "exfer_payment_uri_encode",
    "exfer_payment_uri_decode",
    "exfer_sign_message",
    "exfer_verify_message",
    "exfer_htlc_lock",
    "exfer_htlc_claim",
    "exfer_htlc_reclaim",
    "exfer_htlc_status",
    "exfer_htlc_list",
    "exfer_get_address_history",
    "exfer_get_output_datum",
    "exfer_find_settlements_by_quote_id",
    "exfer_bsc_get_address",
    "exfer_bsc_get_balance",
    "exfer_swap_pool_info",
    "exfer_swap_get_quote",
    "exfer_swap_status",
    "exfer_swap_list",
    "exfer_swap_execute",
    "exfer_swap_refund",
    "exfer_earn_pool_stats",
];

/// The default mining-pool stats API host (paired with the default stratum pool
/// `ssl://ninjaraider.com:44913`). Matches `exfer-mcp`'s `pool_stats.py` default.
const POOL_STATS_API_BASE: &str = "https://api.ninjaraider.com";
/// The default pool id when the caller omits `pool` (matches `exfer-mcp`).
const POOL_STATS_DEFAULT_ID: &str = "exfer-pplns";

/// Is `name` a tool this native layer owns? Used by the supervisor to decide
/// whether to dispatch in-process (here) or route to a user-added MCP server.
pub fn is_native(name: &str) -> bool {
    IMPLEMENTED.contains(&name)
}

/// The implemented tool defs, each tagged `server:"exfer"`, for `tool_list`.
/// Parses the bundled manifest and keeps only [`IMPLEMENTED`] entries, preserving
/// each def's `name` / `description` / `inputSchema` verbatim.
pub fn list() -> Vec<Value> {
    let all: Vec<Value> = serde_json::from_str(MANIFEST_JSON)
        .expect("native_tools_manifest.json is a valid tool-def array");
    all.into_iter()
        .filter(|t| {
            t.get("name")
                .and_then(|n| n.as_str())
                .map(is_native)
                .unwrap_or(false)
        })
        .map(|t| {
            json!({
                "name": t.get("name").cloned().unwrap_or(Value::Null),
                "description": t.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": t.get("inputSchema").cloned().unwrap_or(json!({
                    "type": "object", "properties": {}, "additionalProperties": false
                })),
                "server": "exfer",
            })
        })
        .collect()
}

/// Dispatch a native `exfer` tool call. Always returns the MCP
/// `{content:[{type:"text", text}], isError}` envelope — never an `Err` — so the
/// agent host gets a uniform shape (errors become `isError:true` text).
pub async fn call(
    name: &str,
    args: Value,
    conn: &ConnectionInfo,
    client: &reqwest::Client,
) -> Value {
    // earn_pool_stats is the one tool that doesn't touch walletd.
    if name == "exfer_earn_pool_stats" {
        return match earn_pool_stats(&args).await {
            Ok(v) => ok_text(&v),
            Err(msg) => err_text(&msg),
        };
    }

    match dispatch(name, &args, conn, client).await {
        Ok(result) => ok_text(&result),
        Err(msg) => err_text(&msg),
    }
}

/// Translate one tool call into a walletd RPC and return the raw `result`.
/// `Err(String)` carries a human-readable message (unknown tool, missing arg,
/// or the upstream RPC error) for the `isError` envelope.
async fn dispatch(
    name: &str,
    args: &Value,
    conn: &ConnectionInfo,
    client: &reqwest::Client,
) -> Result<Value, String> {
    match name {
        // ── no-param reads ────────────────────────────────────────────────
        "exfer_list_addresses" => rpc(client, conn, "list_addresses", json!({})).await,
        "exfer_get_block_height" => rpc(client, conn, "get_block_height", json!({})).await,
        "exfer_bsc_get_address" => rpc(client, conn, "bsc_get_address", json!({})).await,
        "exfer_bsc_get_balance" => rpc(client, conn, "bsc_get_balances", json!({})).await,
        "exfer_swap_pool_info" => rpc(client, conn, "swap_pool_info", json!({})).await,
        "exfer_swap_list" => rpc(client, conn, "swap_list", json!({})).await,

        // ── generate (Manage scope) ───────────────────────────────────────
        "exfer_generate_address" => rpc(client, conn, "generate_address", json!({})).await,

        // ── direct pass-throughs (arg names == RPC param names) ───────────
        "exfer_get_balance" => {
            rpc(client, conn, "get_balance", pick(args, &["address"])).await
        }
        "exfer_quote_verify" => {
            rpc(client, conn, "quote_verify", pick(args, &["quote"])).await
        }
        "exfer_verify_message" => {
            rpc(
                client,
                conn,
                "verify_message",
                pick(args, &["pubkey", "signature", "message", "address"]),
            )
            .await
        }
        "exfer_sign_message" => {
            rpc(client, conn, "sign_message", pick(args, &["address", "message"])).await
        }
        "exfer_payment_uri_encode" => {
            rpc(
                client,
                conn,
                "payment_uri_encode",
                pick(args, &["address", "amount", "memo", "label"]),
            )
            .await
        }
        "exfer_payment_uri_decode" => {
            rpc(client, conn, "payment_uri_decode", pick(args, &["uri"])).await
        }
        "exfer_quote_issue" => {
            rpc(
                client,
                conn,
                "quote_issue",
                pick(
                    args,
                    &[
                        "address",
                        "payee_pubkey",
                        "currency",
                        "amount_minor",
                        "rate_exfers_per_unit",
                        "exfer_amount",
                        "ttl_secs",
                        "payer_pubkey",
                        "memo",
                        "quote_id",
                    ],
                ),
            )
            .await
        }
        "exfer_htlc_lock" => {
            // arg names already match the RPC; `fee` and `fee_rate` are mutually
            // exclusive (walletd validates that), so we forward whatever is set.
            rpc(
                client,
                conn,
                "htlc_lock",
                pick(
                    args,
                    &["from", "receiver", "hash_lock", "timeout", "amount", "fee", "fee_rate"],
                ),
            )
            .await
        }
        "exfer_htlc_status" => {
            // walletd's htlc_status always wants output_index; default it to 0.
            let mut p = pick(args, &["lock_tx_id", "output_index"]);
            with_default_u64(&mut p, "output_index", 0);
            rpc(client, conn, "htlc_status", p).await
        }
        "exfer_htlc_list" => {
            rpc(
                client,
                conn,
                "htlc_list",
                pick(args, &["role", "state", "since_height", "address", "limit", "cursor"]),
            )
            .await
        }
        "exfer_get_address_history" => {
            rpc(
                client,
                conn,
                "get_address_history",
                pick(args, &["address", "since_height", "limit", "cursor"]),
            )
            .await
        }
        "exfer_get_output_datum" => {
            rpc(client, conn, "get_output_datum", pick(args, &["tx_id", "output_index"])).await
        }
        "exfer_find_settlements_by_quote_id" => {
            rpc(
                client,
                conn,
                "find_settlements_by_quote_id",
                pick(args, &["quote_id"]),
            )
            .await
        }
        "exfer_swap_status" => {
            rpc(client, conn, "swap_status", pick(args, &["swap_id"])).await
        }
        "exfer_swap_execute" => {
            rpc(client, conn, "swap_execute", pick(args, &["swap_id"])).await
        }
        "exfer_swap_refund" => {
            rpc(client, conn, "swap_refund", pick(args, &["swap_id"])).await
        }

        // ── transforms: {from_address,to_address,amount} -> {from,outputs[]} ─
        "exfer_simulate_transfer" => {
            let mut p = transfer_params(args)?;
            // simulate accepts fee_rate; the real transfer does not.
            if let Some(fr) = args.get("fee_rate") {
                if !fr.is_null() {
                    p.insert("fee_rate".into(), fr.clone());
                }
            }
            rpc(client, conn, "simulate_transfer", Value::Object(p)).await
        }
        "exfer_transfer" => {
            let p = transfer_params(args)?;
            rpc(client, conn, "transfer", Value::Object(p)).await
        }

        // ── HTLC claim/reclaim: inject default output_index=0 ─────────────
        "exfer_htlc_claim" => {
            let mut p = pick(
                args,
                &["from", "lock_tx_id", "preimage", "sender", "timeout", "output_index", "fee"],
            );
            with_default_u64(&mut p, "output_index", 0);
            rpc(client, conn, "htlc_claim", p).await
        }
        "exfer_htlc_reclaim" => {
            let mut p = pick(
                args,
                &["from", "lock_tx_id", "receiver", "hash_lock", "timeout", "output_index", "fee"],
            );
            with_default_u64(&mut p, "output_index", 0);
            rpc(client, conn, "htlc_reclaim", p).await
        }

        // ── swap quote: default flow to "v2" (matches exfer-mcp 0.7.1) ─────
        "exfer_swap_get_quote" => {
            let mut p = pick(args, &["direction", "amount_in", "from", "flow"]);
            // `flow=arguments.get("flow") or "v2"` — empty/missing -> v2.
            let flow_ok = p.get("flow").and_then(|v| v.as_str()).map(|s| !s.is_empty());
            if flow_ok != Some(true) {
                if let Some(obj) = p.as_object_mut() {
                    obj.insert("flow".into(), json!("v2"));
                }
            }
            rpc(client, conn, "swap_get_quote", p).await
        }

        // ── long-poll waits: HTTP timeout must outlive the server-side wait ─
        "exfer_wait_for_tx" => {
            let mut p = pick(args, &["tx_id", "min_confirmations", "timeout_secs"]);
            with_default_u64(&mut p, "min_confirmations", 1);
            let secs = with_default_u64(&mut p, "timeout_secs", 60).clamp(1, 600);
            rpc_timeout(client, conn, "wait_for_tx", p, secs + 20).await
        }
        "exfer_wait_for_payment" => {
            let mut p = pick(args, &["address", "min_amount", "timeout_secs"]);
            with_default_u64(&mut p, "min_amount", 1);
            let secs = with_default_u64(&mut p, "timeout_secs", 60).clamp(1, 600);
            rpc_timeout(client, conn, "wait_for_payment", p, secs + 20).await
        }

        other => Err(format!("unknown tool {other}")),
    }
}

/// Build `transfer` / `simulate_transfer` params from the MCP arg shape:
/// `{from_address, to_address, amount, fee?, datum?}` ->
/// `{from, outputs:[{to, amount}], fee?, datum?}` (the recipients-array shape
/// walletd's transfer RPC expects).
fn transfer_params(args: &Value) -> Result<Map<String, Value>, String> {
    let from = require_str(args, "from_address")?;
    let to = require_str(args, "to_address")?;
    let amount = args
        .get("amount")
        .filter(|v| !v.is_null())
        .ok_or_else(|| "missing required arg `amount`".to_string())?
        .clone();
    let mut p = Map::new();
    p.insert("from".into(), json!(from));
    p.insert("outputs".into(), json!([{ "to": to, "amount": amount }]));
    if let Some(fee) = args.get("fee") {
        if !fee.is_null() {
            p.insert("fee".into(), fee.clone());
        }
    }
    if let Some(datum) = args.get("datum") {
        if !datum.is_null() {
            p.insert("datum".into(), datum.clone());
        }
    }
    Ok(p)
}

/// Copy the listed keys (when present and non-null) from `args` into a fresh
/// params object — the "omit unset fields" rule `exfer-py`'s `_params.py` uses,
/// so walletd's `Option<T>` deserializers see absent rather than null.
fn pick(args: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(obj) = args.as_object() {
        for k in keys {
            if let Some(v) = obj.get(*k) {
                if !v.is_null() {
                    out.insert((*k).to_string(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

/// Ensure `key` is present, defaulting to `default`; returns the effective value
/// (as u64 when the caller passed a number, else the default) so wait tools can
/// derive their HTTP timeout from the effective `timeout_secs`.
fn with_default_u64(p: &mut Value, key: &str, default: u64) -> u64 {
    let obj = match p.as_object_mut() {
        Some(o) => o,
        None => return default,
    };
    match obj.get(key).and_then(|v| v.as_u64()) {
        Some(n) => n,
        None => {
            obj.insert(key.to_string(), json!(default));
            default
        }
    }
}

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing required arg `{key}`"))
}

/// Forward to walletd and map the error to a string for the `isError` envelope.
async fn rpc(
    client: &reqwest::Client,
    conn: &ConnectionInfo,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    forward_rpc(client, conn, method, params)
        .await
        .map_err(|e| e.to_user_string())
}

/// Like [`rpc`] but with a longer HTTP read timeout (for the long-poll waits).
async fn rpc_timeout(
    client: &reqwest::Client,
    conn: &ConnectionInfo,
    method: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    forward_rpc_with_timeout(
        client,
        conn,
        method,
        params,
        Some(Duration::from_secs(timeout_secs)),
    )
    .await
    .map_err(|e| e.to_user_string())
}

/// `exfer_earn_pool_stats` — a plain HTTPS GET to the mining pool's public stats
/// API (no walletd). Returns the raw account JSON; the agent's LLM reads it
/// directly. Matches `exfer-mcp`'s `pool_stats.py` URL shape
/// (`{base}/{pool}/account/{address}`) but returns the raw payload rather than
/// the curated dict (the LLM parses JSON fine).
async fn earn_pool_stats(args: &Value) -> Result<Value, String> {
    let address = require_str(args, "address")?;
    let pool = args
        .get("pool")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(POOL_STATS_DEFAULT_ID);
    let url = format!("{POOL_STATS_API_BASE}/{pool}/account/{address}");

    // The walletd client is fingerprint-pinned with no CA roots, so it can't
    // talk to a public host; build a throwaway CA-rooted client for this GET.
    let http = crate::public_https_client()?;
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("pool stats request failed: {e} (pool API: {url})"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err(format!(
            "pool '{pool}' has no account for this address yet (start mining, then retry). pool API: {url}"
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "pool stats API returned HTTP {status} for '{pool}' — check the pool id ('exfer-pplns' or 'exfer-solo'). pool API: {url}"
        ));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("decoding pool stats response: {e} (pool API: {url})"))
}

/// Success envelope: the result JSON-stringified into a single text block.
fn ok_text(result: &Value) -> Value {
    let text = serde_json::to_string(result).unwrap_or_else(|_| result.to_string());
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": false,
    })
}

/// Error envelope: the message in a single text block, `isError:true`.
fn err_text(message: &str) -> Value {
    json!({
        "content": [ { "type": "text", "text": message } ],
        "isError": true,
    })
}
