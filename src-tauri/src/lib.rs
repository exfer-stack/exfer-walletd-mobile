//! Tauri entrypoint + command surface.
//!
//! The frontend talks to walletd exclusively through these commands;
//! it never makes HTTPS calls itself. All TLS pinning and token
//! routing happens on the Rust side.

mod error;
mod export_key;
mod mnemonic;
mod rpc_client;
mod secrets;
mod walletd_supervisor;

use serde_json::Value;
use tauri::{Manager, State};

use walletd_supervisor::{
    read_desktop_config, restart, restore, start_with_app, stop, wallet_exists,
    write_desktop_config, AppCtx, BootstrapStatus, KEYRING_SERVICE,
};

#[tauri::command]
async fn bootstrap_status(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    Ok(ctx.inner.lock().await.status.clone())
}

/// Whether a wallet already exists on this device (needs unlocking) vs. a
/// fresh first run. The onboarding uses this to show "Unlock" instead of
/// "Create", so a failed silent unlock never looks like lost data.
#[tauri::command]
async fn wallet_exists_cmd(ctx: State<'_, AppCtx>) -> Result<bool, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    Ok(wallet_exists(&datadir))
}

#[tauri::command]
async fn submit_password(
    app: tauri::AppHandle,
    ctx: State<'_, AppCtx>,
    password: String,
) -> Result<BootstrapStatus, String> {
    // Enforce the SAME floor as the restore path (restore_from_mnemonic):
    // len >= 8. The Argon2id KEK that seals the seed is only as strong as this
    // passphrase, so the create/unlock path must not be drivable (by bypassing
    // the JS UI) into a 1-char KEK. Message mirrors the restore path.
    if password.len() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let datadir = ctx.inner.lock().await.datadir.clone();
    // Start FIRST, persist to the keychain only if it actually worked. The old
    // order (save, then start) meant a wrong password typed on the unlock /
    // create screen got saved to the keychain, so every relaunch auto-tried
    // the wrong password and dead-ended on "keystore locked" with no way back
    // in. The seed is Argon2id-sealed with the passphrase regardless, so the
    // keychain copy is pure silent-unlock convenience.
    let status = start_with_app(&ctx, &password, Some(app)).await;
    match status {
        BootstrapStatus::Ready { .. } => {
            if let Err(e) = secrets::set_passphrase(KEYRING_SERVICE, &datadir, &password) {
                tracing::warn!(error = %e, "could not persist passphrase; silent unlock disabled");
            }
        }
        _ => {
            // Don't leave a non-working password saved (it would auto-fail the
            // next launch). Clearing is safe: a valid saved password would have
            // unlocked at startup and never reached this prompt.
            let _ = secrets::delete_passphrase(KEYRING_SERVICE, &datadir);
        }
    }
    Ok(status)
}

/// Re-seal the in-memory wallet when the app's biometric lock engages.
///
/// The biometric app-lock is a frontend gate, but walletd is already unsealed
/// and running behind it (silent-unlock at boot), so a spend-scope RPC reaching
/// the loopback would still sign WITHOUT a biometric. Tearing down the daemon
/// here drops its conn/client so EVERY RPC (transfer, bsc_send_bnb, balance)
/// returns "walletd not ready" until [`unlock_wallet`] brings it back.
///
/// SAFETY — we only seal when we can prove we can silently restore it: the
/// keychain must already hold the passphrase. On a device where silent unlock
/// is unavailable (e.g. an OEM ROM that couldn't persist the passphrase),
/// sealing would strand the user behind the lock with no way back in, so we
/// leave the daemon running and report `false`. The frontend lock still hides
/// the wallet UI either way; the residual gap (daemon stays unsealed while
/// app-locked on those devices) needs the full Keystore-bound redesign.
///
/// Returns `true` if the daemon was actually sealed, `false` if it was left
/// running because no silent-restore passphrase is available.
#[tauri::command]
async fn lock_wallet(ctx: State<'_, AppCtx>) -> Result<bool, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    match secrets::get_passphrase(KEYRING_SERVICE, &datadir) {
        Ok(Some(_)) => {
            stop(&ctx).await;
            Ok(true)
        }
        // No silently-restorable passphrase (Ok(None)) or a keychain read error:
        // do NOT seal — keeping the daemon up is strictly safer than risking a
        // lockout, and matches the pre-existing behaviour exactly.
        _ => Ok(false),
    }
}

/// Bring walletd back after a biometric unlock, mirroring [`lock_wallet`].
///
/// If the daemon is already running (lock was a no-op on this device), this is
/// a cheap no-op that just returns the current status. Otherwise it restarts
/// walletd, silently re-fetching the passphrase from the keychain (no UI
/// re-prompt) — the same path used after a node-config change. The biometric
/// gate on the frontend is what authorizes invoking this.
#[tauri::command]
async fn unlock_wallet(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    // Already up (lock was a no-op) → nothing to restart; hand back the status.
    {
        let inner = ctx.inner.lock().await;
        if inner.handle.is_some() {
            return Ok(inner.status.clone());
        }
    }
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

#[tauri::command]
async fn restore_from_mnemonic(
    app: tauri::AppHandle,
    ctx: State<'_, AppCtx>,
    phrase: String,
    password: String,
) -> Result<BootstrapStatus, String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let words = phrase.split_whitespace().count();
    if words != 24 {
        return Err(format!("recovery phrase must be 24 words (got {words})"));
    }
    // Pass the AppHandle so the restored wallet boots WITH the SSE push
    // bridge — without it, a just-restored wallet ran poll-only until the
    // next app launch (where the keyring auto-start re-attaches it).
    restore(&ctx, phrase.trim(), &password, Some(app))
        .await
        .map_err(|e| e.to_user_string())
}

#[tauri::command]
async fn rpc(
    ctx: State<'_, AppCtx>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let params = params.unwrap_or(Value::Object(Default::default()));
    rpc_client::forward_rpc(&client, &conn, &method, params)
        .await
        .map_err(|e| e.to_user_string())
}

/// Best-effort on-chain balance (base units) for ANY address — used to show,
/// before importing, which candidate address actually holds the coins.
async fn address_balance(
    client: &reqwest::Client,
    conn: &rpc_client::ConnectionInfo,
    address: &str,
) -> Option<u64> {
    let params = serde_json::json!({ "address": address });
    let v = rpc_client::forward_rpc(client, conn, "get_balance", params)
        .await
        .ok()?;
    v.get("balance").and_then(|b| b.as_u64()).or_else(|| v.as_u64())
}

/// Preview the two addresses a 24-word phrase maps to (standard BIP39 vs the
/// legacy raw-key scheme) WITH each address's on-chain balance, so the user can
/// pick the one that holds their coins instead of guessing a scheme. Pure
/// derivation + a read-only balance query; mints no key, imports nothing.
#[tauri::command]
async fn preview_mnemonic_import(ctx: State<'_, AppCtx>, phrase: String) -> Result<Value, String> {
    let (standard, legacy) = mnemonic::preview(&phrase)?;
    let cc = {
        let inner = ctx.inner.lock().await;
        inner.client.clone().zip(inner.conn.clone())
    };
    let (std_bal, leg_bal) = if let Some((client, conn)) = cc {
        tokio::join!(
            address_balance(&client, &conn, &standard),
            address_balance(&client, &conn, &legacy),
        )
    } else {
        (None, None)
    };
    Ok(serde_json::json!({
        "standard": { "address": standard, "balance": std_bal },
        "legacy": { "address": legacy, "balance": leg_bal },
    }))
}

/// Import a 24-word phrase under the chosen scheme (`"standard"` | `"legacy"`).
/// Routes to walletd so the phrase is sealed and reveals back: standard →
/// `import_standard_mnemonic` (same address as exfer.dev / the apps), legacy →
/// `import_mnemonic` (raw-key encoding). Returns `{ address, imported }`.
#[tauri::command]
async fn import_mnemonic_scheme(
    ctx: State<'_, AppCtx>,
    phrase: String,
    scheme: String,
    label: Option<String>,
) -> Result<Value, String> {
    let method = match mnemonic::Scheme::parse(&scheme)? {
        mnemonic::Scheme::Standard => "import_standard_mnemonic",
        mnemonic::Scheme::Legacy => "import_mnemonic",
    };
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let params = serde_json::json!({ "mnemonic": phrase.trim(), "label": label });
    rpc_client::forward_rpc(&client, &conn, method, params)
        .await
        .map_err(|e| e.to_user_string())
}

/// Build a single address's key as an official Exfer `wallet.key`
/// (EXFK) blob, encrypted with `export_password`, and return it as a hex
/// string. The raw secret is fetched from walletd (authorized by
/// `wallet_password`), turned into the EXFK format, and hex-encoded — the
/// plaintext key never crosses into the webview. The JS side writes the
/// decoded bytes to disk (works on iOS + Android, where Rust has no path
/// to the user-chosen save location). The resulting file imports directly
/// into exfer.dev ("Import wallet.key") and the exfer CLI.
#[tauri::command]
async fn export_wallet_key(
    ctx: State<'_, AppCtx>,
    address: String,
    wallet_password: String,
    export_password: String,
) -> Result<String, String> {
    if export_password.len() < 6 {
        return Err("export password must be at least 6 characters".into());
    }
    // 1. Get the raw secret from walletd (spend-scope, passphrase-gated).
    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => return Err("walletd not ready".into()),
        }
    };
    let result = rpc_client::forward_rpc(
        &client,
        &conn,
        "reveal_private_key",
        serde_json::json!({ "address": address, "passphrase": wallet_password }),
    )
    .await
    .map_err(|e| e.to_user_string())?;

    let secret_hex = result
        .get("secret_hex")
        .and_then(|v| v.as_str())
        .ok_or("walletd response missing secret_hex")?;
    let mut secret = [0u8; 32];
    hex::decode_to_slice(secret_hex, &mut secret)
        .map_err(|_| "secret_hex not 32 bytes".to_string())?;

    // 2. Build the EXFK blob. Zeroize the secret after. Return hex; the JS
    //    side decodes + writes the file via the FS plugin.
    let exfk = export_key::build_exfk(&secret, export_password.as_bytes());
    secret.fill(0);
    let exfk = exfk?;

    Ok(hex::encode(exfk))
}

/// Import a wallet.key (EXFK) file as a non-derived address. The JS side
/// reads the file (via the FS plugin) and hands us its bytes hex-encoded
/// as `file_hex`; we decrypt with `file_password`, hand the raw secret to
/// walletd's `import_private_key` RPC, and return the resulting address.
/// The plaintext key never crosses into the webview.
///
/// Errors are surfaced as short user strings (wrong password, malformed
/// file, duplicate address, etc.). The in-memory secret buffer is zeroed
/// before the call returns.
#[tauri::command]
async fn import_wallet_key(
    ctx: State<'_, AppCtx>,
    file_hex: String,
    file_password: String,
    label: Option<String>,
) -> Result<String, String> {
    if file_hex.is_empty() {
        return Err("no wallet.key file selected".into());
    }
    let buf = hex::decode(&file_hex).map_err(|_| "wallet.key not valid hex".to_string())?;

    // Accept three shapes:
    //  - EXFK (our / exfer.dev encrypted wallet.key) → decrypt with the password
    //  - a raw 32-byte ed25519 secret (unencrypted key file)
    //  - a text file holding the 64-hex secret (with optional whitespace)
    // so an UNENCRYPTED key still imports (the password field is optional).
    let mut secret: [u8; 32] = if buf.len() >= 4 && &buf[0..4] == b"EXFK" {
        export_key::parse_exfk(&buf, file_password.as_bytes())?
    } else if buf.len() == 32 {
        let mut s = [0u8; 32];
        s.copy_from_slice(&buf);
        s
    } else {
        let txt = String::from_utf8_lossy(&buf);
        let h = txt.trim();
        if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut s = [0u8; 32];
            hex::decode_to_slice(h, &mut s).map_err(|_| "key file not valid hex".to_string())?;
            s
        } else {
            return Err(
                "unrecognized key file — expected an encrypted wallet.key (EXFK) or a raw \
                 32-byte / 64-hex private key"
                    .into(),
            );
        }
    };

    let (client, conn) = {
        let inner = ctx.inner.lock().await;
        match (inner.client.clone(), inner.conn.clone()) {
            (Some(c), Some(k)) => (c, k),
            _ => {
                secret.fill(0);
                return Err("walletd not ready".into());
            }
        }
    };
    let secret_hex = hex::encode(secret);
    secret.fill(0);

    let mut params = serde_json::json!({ "secret_hex": secret_hex });
    if let Some(l) = label.as_ref().filter(|l| !l.trim().is_empty()) {
        params["label"] = serde_json::Value::String(l.trim().to_string());
    }

    let result = rpc_client::forward_rpc(&client, &conn, "import_private_key", params)
        .await
        .map_err(|e| e.to_user_string())?;

    let address = result
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or("walletd response missing address")?
        .to_string();
    Ok(address)
}

#[tauri::command]
async fn get_node_rpc(ctx: State<'_, AppCtx>) -> Result<String, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    Ok(read_desktop_config(&datadir).node_rpc)
}

#[tauri::command]
async fn set_node_rpc(
    ctx: State<'_, AppCtx>,
    url: String,
) -> Result<BootstrapStatus, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("node_rpc URL must not be empty".into());
    }
    let datadir = ctx.inner.lock().await.datadir.clone();
    // Read-modify-write so changing the node preserves the indexer config.
    let mut cfg = read_desktop_config(&datadir);
    cfg.node_rpc = url;
    write_desktop_config(&datadir, &cfg).map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

/// The configured indexer endpoint. An empty string means "use the built-in
/// default" — the frontend shows the default as the field placeholder. The
/// indexer is anonymous (public read-only chain data), so there is no token.
#[derive(serde::Serialize)]
struct IndexerConfig {
    rpc: String,
}

#[tauri::command]
async fn get_indexer_config(ctx: State<'_, AppCtx>) -> Result<IndexerConfig, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let cfg = read_desktop_config(&datadir);
    Ok(IndexerConfig {
        rpc: cfg.indexer_rpc.unwrap_or_default(),
    })
}

#[tauri::command]
async fn set_indexer_config(
    ctx: State<'_, AppCtx>,
    rpc: String,
) -> Result<BootstrapStatus, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let mut cfg = read_desktop_config(&datadir);
    // Blank ⇒ store None so effective_indexer_rpc falls back to the default.
    let trimmed = rpc.trim().to_string();
    cfg.indexer_rpc = if trimmed.is_empty() { None } else { Some(trimmed) };
    write_desktop_config(&datadir, &cfg).map_err(|e| format!("persisting config: {e}"))?;
    restart(&ctx).await.map_err(|e| e.to_user_string())
}

/// Wipe everything on this device: stop the embedded walletd, delete the
/// entire app-data directory (sealed seed, tokens, TLS cert, desktop
/// config), and clear the keychain passphrase. Returns the app to the
/// first-run `NeedsPassword` state.
///
/// IRREVERSIBLE — the frontend gates this behind a typed confirmation.
#[tauri::command]
async fn reset_wallet(ctx: State<'_, AppCtx>) -> Result<BootstrapStatus, String> {
    // 1. Stop the running daemon (releases file handles on the datadir).
    stop(&ctx).await;

    // 2. Empty the datadir's *contents* — do NOT remove the datadir node
    //    itself. On Android the app can't unlink its own app_data_dir
    //    (its parent is owned by the system), so `remove_dir_all` on the
    //    root failed with EACCES — surfacing as "没有权限" on wipe. Deleting
    //    each entry achieves the same wipe and leaves the root in place.
    let datadir = ctx.inner.lock().await.datadir.clone();
    std::fs::create_dir_all(&datadir).map_err(|e| format!("recreating datadir: {e}"))?;
    let mut failures = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&datadir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let r = if is_dir {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
            if let Err(e) = r {
                tracing::warn!(path = %p.display(), error = %e, "reset: could not remove entry");
                failures.push(format!("{}: {e}", p.display()));
            }
        }
    }
    // Only fail the whole wipe if something we actually needed gone is still
    // there — a stray un-removable temp file shouldn't block a reset.
    if !failures.is_empty() {
        return Err(format!("could not fully wipe wallet data: {}", failures.join("; ")));
    }

    // 3. Clear the keychain passphrase (best-effort; missing entry is fine).
    let _ = secrets::delete_passphrase(KEYRING_SERVICE, &datadir);

    // 4. Reset in-memory state back to first-run.
    {
        let mut inner = ctx.inner.lock().await;
        inner.status = BootstrapStatus::NeedsPassword;
        inner.handle = None;
        inner.conn = None;
        inner.client = None;
    }
    Ok(BootstrapStatus::NeedsPassword)
}

/// A reqwest client trusting the standard webpki CA roots, for the few
/// outbound calls to PUBLIC hosts (price API, GitHub releases). Kept separate
/// from the walletd client, which is fingerprint-pinned and has no CA roots so
/// it can't talk to a public host. These calls run server-side (Rust) so the
/// webview never makes them itself (same rule as walletd) and remote CORS
/// headers don't apply.
fn public_https_client() -> Result<reqwest::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building http client: {e}"))
}

/// Fetch the EXFER spot market (daily klines) from the public OTC market.
/// Returns the raw JSON body; the frontend parses the latest close + 24h
/// change. Read-only, no secrets — a failure just means the UI hides the price.
#[tauri::command]
async fn get_market_price() -> Result<String, String> {
    let resp = public_https_client()?
        .get("https://archeotc.com/api/coins/klines?coinId=EXFER&interval=1d&limit=2")
        .send()
        .await
        .map_err(|e| format!("price request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("price endpoint returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("reading price body: {e}"))
}

/// Fetch OHLC candles for the EXFER market (price chart). Returns the raw JSON
/// (`{items:[{t,o,h,l,c,v}]}`); the frontend maps it to candlesticks. Read-only.
#[tauri::command]
async fn get_market_klines(interval: String, limit: u32) -> Result<String, String> {
    let limit = limit.clamp(1, 500);
    // Only allow simple interval tokens (e.g. 1d, 1h, 15m) into the URL.
    let interval = if !interval.is_empty()
        && interval.len() <= 4
        && interval.chars().all(|c| c.is_ascii_alphanumeric())
    {
        interval
    } else {
        "1d".to_string()
    };
    let url = format!(
        "https://archeotc.com/api/coins/klines?coinId=EXFER&interval={interval}&limit={limit}"
    );
    let resp = public_https_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("klines request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("klines endpoint returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("reading klines body: {e}"))
}

/// Fetch the BNB/USDT spot price from Binance's public API. Returns the raw
/// JSON (`{"symbol":"BNBUSDT","price":"612.30"}`); the frontend reads `price`.
/// This is the independent USD anchor for BNB, so the EXFER price can be derived
/// from the live pool ratio (EXFER/USD = pool BNB-per-EXFER × BNB/USD) instead
/// of a fixed OTC quote. Read-only — a failure just falls back to the OTC price.
#[tauri::command]
async fn get_bnb_price() -> Result<String, String> {
    let resp = public_https_client()?
        .get("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT")
        .send()
        .await
        .map_err(|e| format!("bnb price request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bnb price endpoint returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("reading bnb price body: {e}"))
}

/// Fetch the latest published GitHub release for the mobile wallet. Returns the
/// raw JSON; the frontend reads `tag_name` + the `.apk` asset and compares it
/// to the running version. GitHub's REST API requires a User-Agent header.
/// Read-only — a failure just means the update check is skipped.
#[tauri::command]
async fn check_latest_release() -> Result<String, String> {
    let resp = public_https_client()?
        .get("https://api.github.com/repos/exfer-stack/exfer-walletd-mobile/releases/latest")
        .header("User-Agent", "exfer-wallet")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("release request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("release endpoint returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("reading release body: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,exfer_walletd=info,exfer_walletd_desktop=debug".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init());
    // Camera QR scanner + biometric unlock are mobile-only plugins (no
    // desktop backends).
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
        builder = builder.plugin(tauri_plugin_biometric::init());
    }
    builder
        .setup(|app| {
            // Resolve the per-platform app-data dir and stash it in the
            // managed AppCtx; everything else (datadir creation, token
            // files, sealed seed) is handled inside walletd's
            // `run_embedded`.
            let datadir = app
                .path()
                .app_data_dir()
                .expect("resolving app_data_dir");
            std::fs::create_dir_all(&datadir).expect("creating app_data_dir");
            let ctx = AppCtx::new(datadir.clone());
            app.manage(ctx.clone());

            // Try silent passphrase recovery from the OS keychain. If
            // it's there, kick off walletd immediately; otherwise the
            // frontend will see `NeedsPassword` on its first
            // bootstrap_status poll and show the prompt.
            let ctx_for_spawn = ctx.clone();
            let app_for_spawn = app.handle().clone();
            let datadir_for_spawn = datadir.clone();
            tauri::async_runtime::spawn(async move {
                match secrets::get_passphrase(KEYRING_SERVICE, &datadir_for_spawn) {
                    Ok(Some(passphrase)) => {
                        let st =
                            start_with_app(&ctx_for_spawn, &passphrase, Some(app_for_spawn)).await;
                        // If the saved password is wrong (e.g. a bad one got
                        // persisted by an older build), drop it so we don't
                        // auto-fail every launch — the UI will prompt instead.
                        if matches!(st, BootstrapStatus::NeedsPassword) {
                            let _ = secrets::delete_passphrase(
                                KEYRING_SERVICE,
                                &datadir_for_spawn,
                            );
                        }
                    }
                    Ok(None) => {
                        // First launch — stay in NeedsPassword.
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "keyring lookup failed, will prompt user");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            wallet_exists_cmd,
            submit_password,
            lock_wallet,
            unlock_wallet,
            rpc,
            preview_mnemonic_import,
            import_mnemonic_scheme,
            get_node_rpc,
            set_node_rpc,
            get_indexer_config,
            set_indexer_config,
            reset_wallet,
            export_wallet_key,
            import_wallet_key,
            restore_from_mnemonic,
            get_market_price,
            get_market_klines,
            get_bnb_price,
            check_latest_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
