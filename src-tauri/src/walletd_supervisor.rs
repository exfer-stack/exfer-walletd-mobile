//! Lifecycle for the embedded walletd: start, stop, restart-on-config-change.
//!
//! State machine (held in [`BootstrapState`]):
//!
//! ```text
//!  NeedsPassword ─── submit_password ──► (start) ──► Ready
//!                                                 │
//!                                                 ├── set_node_rpc ──► (restart) ──► Ready
//!                                                 │
//!                                                 └── (any fatal) ──► Failed
//! ```
//!
//! Frontend polls [`crate::commands::bootstrap_status`] and reacts to the
//! variant it gets back.

use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use exfer_walletd::config::Config;
use exfer_walletd::sse_client::WalletNudge;
use exfer_walletd::{run_embedded, EmbeddedTokens, ServerHandle};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::rpc_client::ConnectionInfo;

pub const KEYRING_SERVICE: &str = "com.exfer.wallet";
// Public upstream node. Runs v1.12.0-phase2 — Tier-1 mempool RPCs
// (get_address_mempool, get_balances, get_address_utxos_batch,
// get_output_spent_by) AND Tier-2 SSE push at GET /sse, so the
// wallet observes incoming pending balance within ~RTT instead of
// the 2 s poll interval. Region chosen for better mainland-China
// reachability; gossips with the other seed node over the shared network.
pub const DEFAULT_NODE_RPC: &str = "http://64.176.231.198:9334";

/// The swap pool's self-signed TLS certificate (PEM), PINNED by walletd's pool
/// client (it trusts ONLY this cert for the pool connection). Lets the pool run
/// self-signed HTTPS while a MITM still can't impersonate it. Rotating the pool
/// cert means shipping a new build with the new PEM here.
pub const POOL_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBljCCATugAwIBAgIUTJepaegKfI5VDoZAGcBp0v8YT34wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZXhmZXItc3dhcC1jYTAeFw0yNjA2MDQyMjEzMzdaFw0zNjA2
MDEyMjEzMzdaMBgxFjAUBgNVBAMMDWV4ZmVyLXN3YXAtY2EwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARpZbH/f2lNoDecMdRrJtLP7ROwI2CcH65wkQ9C3s/GKnBP
2x8m+nq7f5msXbVsUx/SCE79XqKY3GN8bcaLOcl0o2MwYTAdBgNVHQ4EFgQUqLAw
xVVcFJN2vvY83lUd+fpozBkwHwYDVR0jBBgwFoAUqLAwxVVcFJN2vvY83lUd+fpo
zBkwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwID
SQAwRgIhAJWea9ZtxE/nWo7Jn+MVweU0q4chF/TCs3p7KPbujgLgAiEAv2MVABW2
TiAd+cw7MH3pK+bxkCf4I038dROruAaFLw0=
-----END CERTIFICATE-----
";
// Upstream exfer-indexer, co-located with the default node on the same host
// (systemd `exfer-indexer.service`, public on :9335). Lets walletd answer
// `get_address_history` — the authoritative per-address confirmed credit/debit
// timeline that powers Activity, including deposits that landed while the app
// was closed (which the local mempool/poll capture can never see). The indexer
// is anonymous: it's read-only (holds no keys) and serves only public chain
// data, so no bearer token is needed — matching the node's open posture.
pub const DEFAULT_INDEXER_RPC: &str = "http://64.176.231.198:9335";
pub const DESKTOP_CONFIG_FILE: &str = "desktop-config.json";

/// Cap on the captured-log ring buffer (lines). ~500 is enough to hold a stuck
/// swap's whole trail while staying small in memory.
const LOG_RING_CAP: usize = 500;

/// A bounded ring buffer of formatted log lines, shared between the tracing
/// writer (producer) and the `get_debug_logs` command (consumer). Held in Tauri
/// app state.
///
/// NB: the embedded walletd is NOT a child process — it runs in-process via
/// `exfer_walletd::run_embedded`, so there is no child stdout/stderr to pipe.
/// walletd (and this supervisor) log through `tracing`, so the in-process
/// equivalent of "capture the subprocess's stdio" is to tee the shared tracing
/// stream into this buffer (see [`LogTee`] / [`LogTeeMaker`], wired up in
/// `lib.rs::run`). A std `Mutex` (not tokio) is used because the tracing writer
/// is synchronous and the lock is never held across an `.await`.
#[derive(Clone)]
pub struct LogBuffer {
    lines: Arc<StdMutex<VecDeque<String>>>,
}

impl LogBuffer {
    pub fn new() -> Self {
        Self {
            lines: Arc::new(StdMutex::new(VecDeque::with_capacity(LOG_RING_CAP))),
        }
    }

    /// Append one line, evicting the oldest once the cap is reached. A poisoned
    /// lock is swallowed — log capture must never panic the app.
    pub fn push_line(&self, line: String) {
        if let Ok(mut q) = self.lines.lock() {
            while q.len() >= LOG_RING_CAP {
                q.pop_front();
            }
            q.push_back(line);
        }
    }

    /// Snapshot the buffer oldest-first, joined by newlines.
    pub fn snapshot(&self) -> String {
        self.lines
            .lock()
            .map(|q| q.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// A `std::io::Write` that tees every formatted tracing line into a
/// [`LogBuffer`] AND to stderr (so `adb logcat` / a terminal still see them,
/// preserving the prior `with_writer(stderr)` behaviour).
pub struct LogTee {
    buf: LogBuffer,
}

impl std::io::Write for LogTee {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        // Keep printing to stderr exactly as before.
        let _ = std::io::stderr().write_all(data);
        // The fmt formatter writes one formatted event (terminated by '\n') per
        // call; split defensively so a multi-line message still lands as
        // separate buffer entries.
        if let Ok(s) = std::str::from_utf8(data) {
            for line in s.split('\n') {
                let line = line.trim_end_matches('\r');
                if !line.is_empty() {
                    self.buf.push_line(line.to_string());
                }
            }
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stderr().flush()
    }
}

/// `MakeWriter` adapter so a [`LogBuffer`] can back `tracing_subscriber::fmt`'s
/// `.with_writer(..)`. Each event gets a fresh [`LogTee`] over the shared buffer.
#[derive(Clone)]
pub struct LogTeeMaker {
    pub buf: LogBuffer,
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogTeeMaker {
    type Writer = LogTee;
    fn make_writer(&'a self) -> Self::Writer {
        LogTee {
            buf: self.buf.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BootstrapStatus {
    /// First launch on this machine, or the keychain entry was wiped.
    /// Frontend should render the password prompt.
    NeedsPassword,
    /// Walletd is up and reachable. Frontend can render the dashboard.
    Ready {
        local_addr: String,
        fingerprint: String,
    },
    /// Walletd failed to start; the message is human-readable.
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DesktopConfig {
    /// Upstream Exfer node URL(s). Comma-separated for multi-node
    /// round-robin (walletd's native format).
    pub node_rpc: String,
    /// Upstream exfer-indexer URL. `None`/empty ⇒ use [`DEFAULT_INDEXER_RPC`].
    /// `serde(default)` so configs written before this field existed still
    /// parse (they just fall back to the default).
    #[serde(default)]
    pub indexer_rpc: Option<String>,
    /// exfer-swap pool base URL. `None`/empty ⇒ the swap engine stays OFF and
    /// `swap_*`/`bsc_*` RPCs return -32602. Set it to turn cross-chain swap on.
    #[serde(default)]
    pub swap_pool_url: Option<String>,
    /// BSC JSON-RPC for the swap engine's USDT leg. `None` ⇒ mainnet default.
    #[serde(default)]
    pub bsc_rpc_url: Option<String>,
    /// BSC chain id (56 mainnet, 97 Chapel testnet). `None` ⇒ 56.
    #[serde(default)]
    pub bsc_chain_id: Option<u64>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            node_rpc: DEFAULT_NODE_RPC.to_string(),
            indexer_rpc: None,
            // Cross-chain swap + self-serve LP point at the live mainnet pool by
            // default (the pool runs on BSC mainnet). HTTPS with a pinned
            // self-signed cert (POOL_CA_PEM) so a MITM can't tamper with quotes
            // / deposit addresses. Empty/None would keep swap_*/bsc_*/lp_* OFF.
            swap_pool_url: Some("https://64.176.231.198:8080".to_string()),
            bsc_rpc_url: None,
            bsc_chain_id: None,
        }
    }
}

impl DesktopConfig {
    /// Effective indexer URL: the configured one, or the built-in default when
    /// unset/blank.
    pub fn effective_indexer_rpc(&self) -> String {
        match self.indexer_rpc.as_deref() {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => DEFAULT_INDEXER_RPC.to_string(),
        }
    }
}

/// Inner state held behind a `Mutex` inside the Tauri-managed `AppCtx`.
pub struct Inner {
    pub datadir: PathBuf,
    pub status: BootstrapStatus,
    /// `Some` iff `status == Ready`. Owning the handle here means
    /// dropping the supervisor (or shutting down the app) cancels the
    /// walletd task.
    pub handle: Option<ServerHandle>,
    /// Connection info derived from `handle`. Held alongside the
    /// handle for cheap access from the RPC forwarder.
    pub conn: Option<Arc<ConnectionInfo>>,
    /// Cached pinned reqwest client. Re-built when `handle` rotates.
    pub client: Option<reqwest::Client>,
}

#[derive(Clone)]
pub struct AppCtx {
    pub inner: Arc<Mutex<Inner>>,
}

impl AppCtx {
    pub fn new(datadir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                datadir,
                status: BootstrapStatus::NeedsPassword,
                handle: None,
                conn: None,
                client: None,
            })),
        }
    }
}

/// Read the desktop-side config (currently just `node_rpc`) from
/// `<datadir>/desktop-config.json`. Returns defaults if the file is
/// missing or unreadable.
pub fn read_desktop_config(datadir: &std::path::Path) -> DesktopConfig {
    let path = datadir.join(DESKTOP_CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => DesktopConfig::default(),
    }
}

/// Persist `cfg` to `<datadir>/desktop-config.json` atomically
/// (write to `.tmp`, then rename).
pub fn write_desktop_config(datadir: &std::path::Path, cfg: &DesktopConfig) -> anyhow::Result<()> {
    let path = datadir.join(DESKTOP_CONFIG_FILE);
    let tmp = datadir.join(format!("{DESKTOP_CONFIG_FILE}.tmp"));
    let json = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&tmp, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort: a filesystem that rejects chmod must not abort the
        // config write (the datadir is already app-private).
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Build a walletd `Config` with desktop-appropriate defaults: TLS on,
/// bind 127.0.0.1:0 (let the OS pick a free port), tokens
/// auto-generated to disk, retry tuned slightly tighter than daemon
/// defaults (desktop user is waiting in front of the screen).
fn build_walletd_config(datadir: &std::path::Path, desktop_cfg: &DesktopConfig) -> Config {
    use std::net::{Ipv4Addr, SocketAddr};
    Config {
        datadir: Some(datadir.to_path_buf()),
        bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        allow_public_bind: false,
        tls: true,
        tls_cert: None,
        tls_key: None,
        tls_san: vec![],
        node_rpc: desktop_cfg.node_rpc.clone(),
        wallet_dir: None,
        auth_token_read: None,
        auth_token_manage: None,
        auth_token_spend: None,
        upstream_timeout_secs: 15,
        upstream_attempts: 6,
        upstream_retry_backoff_ms: 250,
        // Upstream indexer delegation: walletd proxies `get_address_history`
        // (and the other non-owned-data methods) to the co-located
        // exfer-indexer. This is what lets Activity show a complete, real
        // per-address confirmed history with true tx ids — including deposits
        // that confirmed while the app was closed. Without it these methods
        // return -32007 IndexerNotConfigured.
        indexer_rpc: Some(desktop_cfg.effective_indexer_rpc()),
        // The indexer is anonymous (public read-only chain data); no token.
        indexer_token: None,
        indexer_timeout_secs: Some(15),
        // Cross-chain swap engine: only lights up when a pool URL is set.
        // bsc_* default to mainnet; set them (with swap_pool_url) for testnet.
        swap_pool_url: desktop_cfg
            .swap_pool_url
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        // Pin the pool's self-signed TLS cert: walletd trusts ONLY this cert for
        // the pool connection, so a self-signed HTTPS pool is still MITM-proof.
        swap_pool_ca: Some(POOL_CA_PEM.to_string()),
        // NOT bsc-dataseed: it rejects eth_getLogs (-32005) which the swap engine
        // needs to detect on-chain HTLC locks/claims. publicnode handles getLogs.
        bsc_rpc_url: desktop_cfg
            .bsc_rpc_url
            .clone()
            .unwrap_or_else(|| "https://bsc-rpc.publicnode.com".to_string()),
        bsc_chain_id: desktop_cfg.bsc_chain_id.unwrap_or(56),
        // New Config fields in walletd v1.14/v1.15 (pulled in with the bech32m
        // keystone bump from v1.13.3). Behavior-preserving defaults matching
        // walletd's own Config::default: no genesis pin and no spend-allowance
        // caps, exactly as v1.13.3 ran. (expect_genesis is a future hardening
        // knob — pin the node's genesis to bind the signature domain.)
        expect_genesis: None,
        spend_cap_per_tx: None,
        spend_cap_per_period: None,
        spend_cap_period_secs: 86_400,
        // New in the swap-pool-hardening walletd (b84af8a). Reconcile on
        // restart so the embedded walletd never re-spends a UTXO it already
        // locked before an app restart (mempool-seeded InFlightUtxos) — a real
        // robustness win for the user's own swap locks. The lock watchdog
        // (rebroadcast evicted locks) is a pool-operator concern, off here.
        inflight_reconcile: true,
        lock_watchdog: false,
    }
}

/// True if a keystore already lives in `datadir` — i.e. a wallet was set up
/// here and just needs unlocking, vs. a genuine first run. Lets the UI show
/// an Unlock prompt instead of Create/Restore (which reads as "your wallet is
/// gone" when silent unlock fails). Checks the keystore's own files: a seeded
/// wallet's `seed.enc`, the keyring `state.json`, or any imported key.
pub fn wallet_exists(datadir: &std::path::Path) -> bool {
    let desktop_cfg = read_desktop_config(datadir);
    let cfg = build_walletd_config(datadir, &desktop_cfg);
    let wdir = cfg.resolved_wallet_dir();
    wdir.join("seed.enc").exists()
        || wdir.join("state.json").exists()
        || std::fs::read_dir(wdir.join("imported"))
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
}

/// Boot walletd in-process. On success, mutates `inner` to `Ready`. On
/// failure, mutates to `Failed`. Either way the call returns the
/// resulting status so the caller can pass it back to the frontend.
///
/// `app` is optional: when present (production), we also spawn the
/// Phase 2 push bridge that turns walletd SseClient nudges into Tauri
/// events the frontend listens for (`wallet-nudge`). When `None`,
/// walletd still runs; the frontend just won't get push and falls
/// back to its existing polling.
pub async fn start(ctx: &AppCtx, passphrase: &str) -> BootstrapStatus {
    start_with_app(ctx, passphrase, None).await
}

pub async fn start_with_app(
    ctx: &AppCtx,
    passphrase: &str,
    app: Option<AppHandle>,
) -> BootstrapStatus {
    let mut inner = ctx.inner.lock().await;
    // Guard on the live handle, not `status`: `stop()` tears down the handle
    // but leaves `status` at its last value, so keying off `status == Ready`
    // made a restart (stop → start, e.g. after switching the upstream node)
    // see the stale Ready and early-return WITHOUT booting a new walletd —
    // leaving the app talking to a dead loopback ("offline"). The handle is
    // the only honest "is walletd actually running?" signal.
    if inner.handle.is_some() {
        // Already running; let the caller see the existing state.
        return inner.status.clone();
    }

    let datadir = inner.datadir.clone();
    let desktop_cfg = read_desktop_config(&datadir);
    let walletd_cfg = build_walletd_config(&datadir, &desktop_cfg);

    let shutdown = CancellationToken::new();
    let handle = match run_embedded(walletd_cfg, passphrase, shutdown).await {
        Ok(h) => h,
        Err(e) => {
            let msg = format!("{e:#}");
            // A wrong password is RECOVERABLE — the keystore is intact, it just
            // wasn't unlocked. Route back to NeedsPassword so the UI shows the
            // (re-enterable) unlock prompt instead of a dead-end "Couldn't
            // start" the user can't get past. Only genuine boot errors (IO,
            // node, etc.) stay Failed.
            let lower = msg.to_lowercase();
            let s = if lower.contains("wrong passphrase")
                || lower.contains("keystore locked")
                || lower.contains("decryption failed")
            {
                BootstrapStatus::NeedsPassword
            } else {
                BootstrapStatus::Failed { message: msg }
            };
            inner.status = s.clone();
            return s;
        }
    };

    // The Phase 2 push bridge is spawned below, after the rpc client is
    // built — the bridge needs the client to read balances for native
    // deposit notifications. Subscribe now while `handle` is still owned.
    let events_rx = app.as_ref().map(|_| handle.events.subscribe());

    let fingerprint = handle
        .fingerprint
        .clone()
        .unwrap_or_else(|| "(missing)".into());
    let base_url = format!("https://{}", handle.local_addr);
    let EmbeddedTokens {
        read,
        manage,
        spend,
    } = handle.tokens.clone();
    let conn = Arc::new(ConnectionInfo {
        base_url: base_url.clone(),
        fingerprint: fingerprint.clone(),
        token_read: read,
        token_manage: manage,
        token_spend: spend,
    });
    let client = match crate::rpc_client::build_client_for(&conn) {
        Ok(c) => c,
        Err(e) => {
            // Tear down the partially-started walletd; we can't talk to
            // it without a client.
            let _ = handle.shutdown().await;
            let s = BootstrapStatus::Failed {
                message: format!("building pinned client: {e}"),
            };
            inner.status = s.clone();
            return s;
        }
    };

    // Phase 2 push bridge: forward walletd's WalletEvents to the frontend as
    // `wallet-nudge` events AND fire a native OS notification on an incoming
    // deposit. The native path matters because the JS deposit toast only runs
    // while the webview is awake; emitting from here means the user is told
    // even when the app is backgrounded (as long as the process is alive —
    // surviving a full OS kill / long lock additionally needs a foreground
    // service on Android or push on iOS). The task ends when the SseClient
    // task ends (shutdown cancels both).
    if let (Some(app), Some(mut rx)) = (app, events_rx) {
        let client = client.clone();
        let conn = conn.clone();
        tokio::spawn(async move {
            // Seed the baseline from the current projected balance so funds
            // already present at startup don't trigger a phantom notification.
            let mut last_total: Option<u64> = current_projected(&client, &conn).await;
            // Crediting tx ids we've already notified for — makes notifications
            // idempotent so a mempool→confirmed double-count never re-fires.
            let mut seen: HashSet<String> = HashSet::new();
            loop {
                match rx.recv().await {
                    Ok(WalletNudge::Script(script)) => {
                        tracing::info!(script = %hex::encode(&script), "nudge-bridge: forwarding script_changed → wallet-nudge");
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({ "kind": "script", "script": hex::encode(script) }),
                        );
                    }
                    Ok(WalletNudge::Tip(height)) => {
                        tracing::info!(height, "nudge-bridge: forwarding tip → wallet-nudge");
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({ "kind": "tip", "height": height }),
                        );
                    }
                    Ok(WalletNudge::Resync) => {
                        tracing::info!("nudge-bridge: forwarding resync → wallet-nudge");
                        let _ = app.emit("wallet-nudge", serde_json::json!({ "kind": "resync" }));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(dropped = n, "wallet-nudge bridge: lagged; emitting resync");
                        let _ = app.emit("wallet-nudge", serde_json::json!({ "kind": "resync" }));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("wallet-nudge bridge: walletd shut down");
                        break;
                    }
                }
                // Any nudge can mean funds moved — re-read the projected balance
                // and notify if it rose. Own-sends lower it, confirmations leave
                // it flat; only genuine inbound credit raises it (mirrors the JS
                // deposit detector), and per-tx-id dedup blocks double-fires.
                notify_if_deposited(&app, &client, &conn, &mut last_total, &mut seen).await;
            }
        });
    }

    let status = BootstrapStatus::Ready {
        local_addr: handle.local_addr.to_string(),
        fingerprint,
    };
    inner.status = status.clone();
    inner.handle = Some(handle);
    inner.conn = Some(conn);
    inner.client = Some(client);
    status
}

/// Read walletd's projected total — confirmed balance + pending credit −
/// pending debit, in exfers (1e8 = 1 EXFER). `None` on any transport/parse
/// failure (treated as "no reading", never as zero).
async fn current_projected(client: &reqwest::Client, conn: &ConnectionInfo) -> Option<u64> {
    let result = crate::rpc_client::forward_rpc(
        client,
        conn,
        "get_wallet_balance",
        serde_json::json!({ "utxos": false, "pending": true }),
    )
    .await
    .ok()?;
    result.get("projected_total").and_then(|v| v.as_u64())
}

/// Fire a native "Deposit received" notification on an incoming deposit.
///
/// Two-stage, mirroring the JS detector:
///  1. Cheap gate — only act when `projected_total` ROSE since the last read
///     (confirmations leave it flat, own-sends lower it).
///  2. On a rise, resolve the real crediting tx id(s) from each address's
///     mempool and notify once per NEW id (deduped against `seen`). Keying on
///     tx id makes this idempotent: a transient mempool→confirmed double-count
///     re-sees the same id and is skipped — no duplicate notification.
///
/// Falls back to one synthetic notification when a rise can't be attributed to
/// any mempool tx (deposit confirmed between reads, or node too old for
/// `get_address_mempool`). All notifications are logged with `source = "sse"`
/// since this bridge only runs off SSE nudges.
async fn notify_if_deposited(
    app: &AppHandle,
    client: &reqwest::Client,
    conn: &ConnectionInfo,
    last_total: &mut Option<u64>,
    seen: &mut HashSet<String>,
) {
    let balance = match crate::rpc_client::forward_rpc(
        client,
        conn,
        "get_wallet_balance",
        serde_json::json!({ "utxos": false, "pending": true }),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return,
    };
    let now = match balance.get("projected_total").and_then(|v| v.as_u64()) {
        Some(v) => v,
        None => return,
    };
    // Confirmed-only total — gates the synthetic fallback below.
    let confirmed = balance.get("total").and_then(|v| v.as_u64()).unwrap_or(now);
    let prev = *last_total;
    *last_total = Some(now);
    // Only a genuine increase is worth resolving; bail otherwise.
    if !matches!(prev, Some(p) if now > p) {
        return;
    }

    let addrs: Vec<String> = balance
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    e.get("address")
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();

    let mut saw_credit = false;
    for addr in &addrs {
        let m = match crate::rpc_client::forward_rpc(
            client,
            conn,
            "get_address_mempool",
            serde_json::json!({ "address": addr }),
        )
        .await
        {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(txs) = m.get("mempool").and_then(|v| v.as_array()) else {
            continue;
        };
        for tx in txs {
            let credit: u64 = tx
                .get("received")
                .and_then(|v| v.as_array())
                .map(|outs| {
                    outs.iter()
                        .filter_map(|o| o.get("value").and_then(|v| v.as_u64()))
                        .sum()
                })
                .unwrap_or(0);
            if credit == 0 {
                continue; // a tx that only spends from us
            }
            saw_credit = true;
            let Some(tx_id) = tx.get("tx_id").and_then(|v| v.as_str()) else {
                continue;
            };
            if seen.insert(tx_id.to_string()) {
                let amount = format_exfer(credit);
                tracing::info!(amount = %amount, tx_id = %tx_id, source = "sse", "deposit: native notification");
                let _ = app
                    .notification()
                    .builder()
                    .title("Deposit received")
                    .body(format!("+{amount} EXFER"))
                    .show();
            }
        }
    }

    // Synthetic fallback ONLY when the rise is genuinely new CONFIRMED money
    // (confirmed total rose above the previous projected) — never a confirmation
    // double-count of pending funds we'd already resolved by tx id.
    if !saw_credit {
        if let Some(p) = prev {
            if confirmed > p {
                let amount = format_exfer(now - p);
                tracing::info!(amount = %amount, source = "sse", "deposit: native notification (synthetic)");
                let _ = app
                    .notification()
                    .builder()
                    .title("Deposit received")
                    .body(format!("+{amount} EXFER"))
                    .show();
            }
        }
    }
}

/// exfers (1e8 = 1 EXFER) → trimmed decimal string. Mirrors JS `formatExfer`:
/// "10000000" → "0.1", "100000000" → "1", trailing fractional zeros dropped.
fn format_exfer(exfers: u64) -> String {
    const UNIT: u64 = 100_000_000;
    let whole = exfers / UNIT;
    let frac = exfers % UNIT;
    if frac == 0 {
        whole.to_string()
    } else {
        let mut f = format!("{frac:08}");
        while f.ends_with('0') {
            f.pop();
        }
        format!("{whole}.{f}")
    }
}

/// Stop the embedded walletd (if any) and reset state to
/// `NeedsPassword`. Used internally by [`restart`]; the frontend
/// doesn't expose a bare "stop" — closing the window does it via the
/// Tauri shutdown hook.
pub async fn stop(ctx: &AppCtx) {
    let mut inner = ctx.inner.lock().await;
    if let Some(h) = inner.handle.take() {
        let _ = h.shutdown().await;
    }
    inner.conn = None;
    inner.client = None;
}

/// Restore a wallet from a 24-word recovery phrase into a clean datadir,
/// then start it. Seals the phrase's entropy to seed.enc under
/// `password`, persists the password to the keychain, boots walletd, and
/// re-derives the first `MAX_ADDRESSES` addresses so the restored set
/// reappears immediately (HD derivation is deterministic, so these are
/// the original addresses).
pub async fn restore(
    ctx: &AppCtx,
    phrase: &str,
    password: &str,
    app: Option<AppHandle>,
) -> Result<BootstrapStatus, AppError> {
    use exfer_walletd::store::HdSeedStore;

    // Re-derive this many indices after restore so the original address
    // set reappears (matches the desktop's 6-address cap).
    const RESTORE_ADDRESSES: usize = 6;

    let datadir = { ctx.inner.lock().await.datadir.clone() };
    let desktop_cfg = read_desktop_config(&datadir);
    let cfg = build_walletd_config(&datadir, &desktop_cfg);
    let wallet_dir = cfg.resolved_wallet_dir();

    // Seal the phrase to a clean seed.enc (refuses if one exists).
    HdSeedStore::init_from_mnemonic(&wallet_dir, password.as_bytes(), phrase)
        .map_err(|e| AppError::Other(anyhow::anyhow!(e.to_string())))?;

    // Persist the password + boot walletd against the restored seed.
    // Boot WITH the app handle (when present) so the SSE push bridge spawns
    // for the restored wallet, not just on the next launch.
    // Best-effort: the keychain only powers silent unlock — a write failure
    // (some Huawei/HarmonyOS ROMs) must not abort an otherwise-good restore.
    if let Err(e) = crate::secrets::set_passphrase(KEYRING_SERVICE, &datadir, password) {
        tracing::warn!(error = %e, "could not persist passphrase; silent unlock disabled");
    }
    let status = start_with_app(ctx, password, app).await;
    if !matches!(status, BootstrapStatus::Ready { .. }) {
        return Ok(status);
    }

    // Deterministically re-derive the address set so balances reappear
    // without the user minting each index by hand. generate_address on a
    // fresh state.json produces index 0,1,… = the original addresses.
    if let (Some(client), Some(conn)) = {
        let inner = ctx.inner.lock().await;
        (inner.client.clone(), inner.conn.clone())
    } {
        for _ in 0..RESTORE_ADDRESSES {
            let _ = crate::rpc_client::forward_rpc(
                &client,
                &conn,
                "generate_address",
                serde_json::json!({}),
            )
            .await;
        }
    }
    Ok(status)
}

/// Restart the embedded walletd with the current desktop config. The
/// passphrase is fetched from the keychain (no UI re-prompt) since the
/// user already authenticated this session.
pub async fn restart(ctx: &AppCtx) -> Result<BootstrapStatus, AppError> {
    let datadir = { ctx.inner.lock().await.datadir.clone() };
    let passphrase = crate::secrets::get_passphrase(KEYRING_SERVICE, &datadir)?
        .ok_or_else(|| AppError::Other(anyhow::anyhow!("no passphrase in keychain")))?;
    stop(ctx).await;
    Ok(start(ctx, &passphrase).await)
}
