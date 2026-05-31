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

use std::path::PathBuf;
use std::sync::Arc;

use exfer_walletd::config::Config;
use exfer_walletd::sse_client::WalletNudge;
use exfer_walletd::{run_embedded, EmbeddedTokens, ServerHandle};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::rpc_client::ConnectionInfo;

pub const KEYRING_SERVICE: &str = "com.exfer.wallet";
// Public upstream node. Runs v1.12.0-phase2 — Tier-1 mempool RPCs
// (get_address_mempool, get_balances, get_address_utxos_batch,
// get_output_spent_by) AND Tier-2 SSE push at POST /sse, so the
// wallet observes incoming pending balance within ~RTT instead of
// the 2 s poll interval. Tokyo region.
pub const DEFAULT_NODE_RPC: &str = "http://198.13.38.245:9334";
pub const DESKTOP_CONFIG_FILE: &str = "desktop-config.json";

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
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            node_rpc: DEFAULT_NODE_RPC.to_string(),
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
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
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
        upstream_attempts: 3,
        upstream_retry_backoff_ms: 250,
        // No upstream indexer: the desktop only queries its own wallet's
        // addresses, which the node answers directly. The indexer-delegated
        // methods (get_address_history, contract_stats, …) return
        // -32041 IndexerNotConfigured, which the desktop never calls.
        indexer_rpc: None,
        indexer_token: None,
        indexer_timeout_secs: None,
    }
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
    if matches!(inner.status, BootstrapStatus::Ready { .. }) {
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
            let s = BootstrapStatus::Failed {
                message: format!("{e:#}"),
            };
            inner.status = s.clone();
            return s;
        }
    };

    // Phase 2 push bridge: subscribe to walletd's WalletEvents and emit
    // a Tauri event the React frontend listens for. The bridge task
    // ends when the SseClient task ends (shutdown cancels both).
    if let Some(app) = app {
        let mut rx = handle.events.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(WalletNudge::Script(script)) => {
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({
                                "kind": "script",
                                "script": hex::encode(script),
                            }),
                        );
                    }
                    Ok(WalletNudge::Tip(height)) => {
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({
                                "kind": "tip",
                                "height": height,
                            }),
                        );
                    }
                    Ok(WalletNudge::Resync) => {
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({ "kind": "resync" }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            dropped = n,
                            "wallet-nudge bridge: lagged; emitting resync"
                        );
                        let _ = app.emit(
                            "wallet-nudge",
                            serde_json::json!({ "kind": "resync" }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("wallet-nudge bridge: walletd shut down");
                        break;
                    }
                }
            }
        });
    }

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
    crate::secrets::set_passphrase(KEYRING_SERVICE, password).map_err(AppError::Other)?;
    let status = start(ctx, password).await;
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
    let passphrase = crate::secrets::get_passphrase(KEYRING_SERVICE)?
        .ok_or_else(|| AppError::Other(anyhow::anyhow!("no passphrase in keychain")))?;
    stop(ctx).await;
    Ok(start(ctx, &passphrase).await)
}
