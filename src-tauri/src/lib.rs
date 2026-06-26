//! Tauri entrypoint + command surface.
//!
//! The frontend talks to walletd exclusively through these commands;
//! it never makes HTTPS calls itself. All TLS pinning and token
//! routing happens on the Rust side.

mod error;
mod export_key;
mod mcp_registry;
mod mcp_supervisor;
mod mnemonic;
mod rpc_client;
mod secrets;
mod walletd_supervisor;

use serde_json::Value;
use tauri::{Manager, State};

use mcp_supervisor::{
    mcp_call_tool, mcp_list_tools, mcp_start, McpCtx,
};

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

/// Unlock the biometric app-lock with the wallet PASSWORD the user set — the
/// fallback to fingerprint/face, NOT the device's lock-screen PIN.
///
/// Verification is the real cryptographic thing, not a stored-copy compare: we
/// seal the daemon first (so it can't be already-open) and then start it with
/// the entered password. Only the correct password opens the Argon2id-sealed
/// seed → `Ready`; anything else yields a non-Ready status and we reject. This
/// also closes the residual "daemon stayed unsealed" gap on OEM ROMs, since the
/// password path always re-seals before re-opening.
///
/// Unlike [`submit_password`], a WRONG attempt here never deletes the keychain
/// passphrase: the saved copy is known-good (the wallet was working before the
/// lock), and dropping it would silently kill silent-unlock on the next launch.
/// A wrong attempt leaves the daemon sealed — the user just retries, or falls
/// back to biometric (which silently restores from the untouched keychain).
#[tauri::command]
async fn unlock_with_password(
    app: tauri::AppHandle,
    ctx: State<'_, AppCtx>,
    password: String,
) -> Result<BootstrapStatus, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    // Seal first so the entered password must actually unseal the wallet.
    stop(&ctx).await;
    let status = start_with_app(&ctx, &password, Some(app)).await;
    match status {
        BootstrapStatus::Ready { .. } => {
            // Refresh the silent-unlock copy (a no-op when it already matches);
            // never delete it on the failure path below.
            if let Err(e) = secrets::set_passphrase(KEYRING_SERVICE, &datadir, &password) {
                tracing::warn!(error = %e, "could not persist passphrase after password unlock");
            }
            Ok(status)
        }
        _ => Err("incorrect password".into()),
    }
}

/// Validate a .vault blob + its backup password WITHOUT creating a wallet, so
/// onboarding can reject a wrong password / non-vault file BEFORE submit_password
/// (which would otherwise create a wallet the app immediately navigates into,
/// hiding the import failure). Returns the address count on success.
#[tauri::command]
async fn validate_vault(vault_hex: String, file_password: String) -> Result<usize, String> {
    let blob = hex::decode(&vault_hex).map_err(|_| "vault file not valid hex".to_string())?;
    exfer_walletd::store::validate_vault(&blob, file_password.as_bytes())
        .map_err(|e| e.to_string())
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

    // Accept an encrypted EXFK file, a raw 32-byte secret, or a 64-hex
    // dump (password optional — only the EXFK shape uses it). Shared with
    // the desktop import command so the same file imports on both.
    let mut secret = export_key::parse_key_file(&buf, file_password.as_bytes())?;

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

// ── exfer-vote (community governance) proxy ─────────────────────────────────
//
// The wallet talks to the `exfer-vote` community service exclusively through
// these two commands (the webview never makes the HTTPS call itself — same rule
// as the price / release fetchers above). `governance.ts` passes bare API paths
// (`/proposals`, `/votes`, …); we join them onto the configured vote base URL.
//
// The base URL is set at build time via the `EXFER_VOTE_BASE` env var (no
// trailing slash), e.g. `https://vote.exfer.dev`. Left unset, the commands
// return a clear error so the failure is legible rather than a silent 404.
//
// TLS: the design calls for the vote server's self-signed CA to be pinned the
// same way the swap pool's is (POOL_CA_PEM, pinned inside walletd). The CA is
// embedded at build time via `EXFER_VOTE_CA_PEM` (the PEM *content*, not a
// path — exactly like POOL_CA_PEM). When set, `vote_client()` trusts ONLY that
// CA; rotating the cert requires a new mobile build, like the pool cert. When
// unset, it falls back to the standard public-root client, so the same binary
// also works against an exfer-vote endpoint fronted by a publicly-trusted cert.
const VOTE_BASE: Option<&str> = Some("https://64.176.231.198:8443");
const VOTE_CA_PEM: Option<&str> = Some(SEOUL_VOTE_CA_PEM);

/// The exfer-vote server's self-signed TLS certificate (PEM), PINNED by
/// `vote_client()` (it trusts ONLY this cert for the governance connection).
/// The SAN includes the IP 64.176.231.198 so hostname verification passes
/// against the bare-IP base URL. Rotating the vote cert means shipping a new
/// build with the new PEM here — exactly like POOL_CA_PEM for the swap pool.
const SEOUL_VOTE_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUDH0Gp1hA5YuAsGUN4ioaS8kWHVEwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZXhmZXItdm90ZS1jYTAeFw0yNjA2MDgwNjUxMjNaFw00NjA2
MDMwNjUxMjNaMBgxFjAUBgNVBAMMDWV4ZmVyLXZvdGUtY2EwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAR8EYy2ZwK+YZx6nIiDHxcA9C57nuRKsd0bulMe001FLXQa
v6r87iCHKyz9qo2KnsYMz+CGZM+FCqgkR0gKTBrGo2MwYTAdBgNVHQ4EFgQUjRiQ
q+Mq09J+99XtqpGE9Dm40EwwHwYDVR0jBBgwFoAUjRiQq+Mq09J+99XtqpGE9Dm4
0EwwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwID
SAAwRQIgF67IXaoLzvKlUAoRvLEvBdUnKCdlGroCcZf350r+mQICIQCrZWqOZCQD
0w73SLCDH0jtTZLRHOoR1L5cJyqqXHfdPA==
-----END CERTIFICATE-----
";

/// Build the HTTPS client used for exfer-vote calls. If a CA PEM was embedded
/// at build time, trust ONLY that CA (self-signed pinning); otherwise fall back
/// to the public-root client. A malformed embedded PEM is a hard error rather
/// than a silent downgrade to public roots — a misconfigured build should fail
/// loudly, not quietly accept the wrong trust anchor.
fn vote_client() -> Result<reqwest::Client, String> {
    let pem = match VOTE_CA_PEM.map(str::trim).filter(|p| !p.is_empty()) {
        Some(pem) => pem,
        None => return public_https_client(),
    };
    let mut roots = rustls::RootCertStore::empty();
    let mut reader = std::io::BufReader::new(pem.as_bytes());
    let mut added = 0usize;
    for cert in rustls_pemfile::certs(&mut reader) {
        let cert = cert.map_err(|e| format!("reading vote CA PEM: {e}"))?;
        roots
            .add(cert)
            .map_err(|e| format!("adding vote CA to root store: {e}"))?;
        added += 1;
    }
    if added == 0 {
        return Err("EXFER_VOTE_CA_PEM contained no certificates".into());
    }
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building vote http client: {e}"))
}

fn vote_url(path: &str) -> Result<String, String> {
    let base = VOTE_BASE
        .map(|b| b.trim().trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .ok_or_else(|| {
            "Governance isn't configured in this build (EXFER_VOTE_BASE unset).".to_string()
        })?;
    if !path.starts_with('/') {
        return Err("vote api path must start with '/'".into());
    }
    Ok(format!("{base}{path}"))
}

/// Parse an exfer-vote HTTP response into JSON, mapping a non-2xx status to a
/// legible error (preferring the server's `{error|message}` if present).
async fn vote_finish(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("reading vote body: {e}"))?;
    let json: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).map_err(|e| format!("vote server sent invalid JSON: {e}"))?
    };
    if !status.is_success() {
        let msg = json
            .get("error")
            .or_else(|| json.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("vote server returned {status}"));
        return Err(msg);
    }
    Ok(json)
}

/// GET a path on the exfer-vote service (list / detail / my-vote / results).
/// Returns the parsed JSON body; `governance.ts` normalizes it.
#[tauri::command]
async fn vote_api_get(path: String) -> Result<Value, String> {
    let url = vote_url(&path)?;
    let resp = vote_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("vote request failed: {e}"))?;
    vote_finish(resp).await
}

/// POST a JSON body to a path on the exfer-vote service (`/votes`). `body` is a
/// pre-serialized JSON string (the `{ payload, signature, pubkey }` envelope);
/// the signed `payload` string is carried through verbatim, never re-serialized.
#[tauri::command]
async fn vote_api_post(path: String, body: String) -> Result<Value, String> {
    let url = vote_url(&path)?;
    let resp = vote_client()?
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("vote request failed: {e}"))?;
    vote_finish(resp).await
}

/// GET an attachment's raw bytes from the exfer-vote service (`/media/:id`),
/// routed through the SAME CA-pinned client as the JSON API so the pinned trust
/// anchor is preserved — the webview must never hit the host directly for media.
/// Returns `{ content_type, body_hex }`; the JS side hex-decodes the bytes and
/// either renders them as an inline blob (`image` kinds) or saves them to the
/// device (`file` kinds). The body is capped to guard against a hostile/oversized
/// response (uploads are already capped server-side; this is belt-and-suspenders).
#[tauri::command]
async fn vote_media_get(path: String) -> Result<Value, String> {
    // Hard ceiling on what we'll pull into memory + ferry across the IPC bridge.
    const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;
    let url = vote_url(&path)?;
    let resp = vote_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("media request failed: {e}"))?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading media body: {e}"))?;
    if !status.is_success() {
        return Err(format!("vote server returned {status}"));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("attachment exceeds the maximum download size".into());
    }
    Ok(serde_json::json!({
        "content_type": content_type,
        "body_hex": hex::encode(&bytes),
    }))
}

// ── in-wallet agent: LLM fetch (key injected host-side) + consent ─────────────
//
// Ported from the desktop backend so the mobile native app has the SAME real
// path: a real LLM call (key injected from the secure store, never in the
// webview) and the constant-time consent back-stop. The PRIMARY money-gate on
// mobile is biometric in the AgentConsentSheet UI; `agent_confirm_consent` here
// mirrors desktop's passphrase re-check so the `confirmConsent()` invoke has a
// backend and never fails.
//
// Mobile's `secrets` API takes a `data_dir` (the Android fallback path), unlike
// desktop's key-only signature, so these commands are async and pull the
// datadir from the managed `AppCtx`.

/// Per-provider secure-store service for the user's LLM API key. Distinct from
/// the walletd keystore passphrase service so the two never collide.
fn llm_key_service(provider: &str) -> String {
    format!("{KEYRING_SERVICE}-llm:{provider}")
}

#[derive(serde::Deserialize)]
struct LlmRequest {
    url: String,
    #[serde(default = "default_post")]
    method: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}
fn default_post() -> String {
    "POST".into()
}

#[derive(serde::Serialize)]
struct LlmResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
}

/// A webpki-rooted client with a long timeout for (buffered) LLM responses.
fn llm_https_client() -> Result<reqwest::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("building llm http client: {e}"))
}

/// Forward an LLM request, injecting the user's API key from the secure store so
/// the plaintext key never lives in the webview. `provider` selects the key;
/// `kind` ("openai" | "anthropic") selects the auth header. Buffered for now —
/// the whole response body is returned (streaming variant is a follow-up).
#[tauri::command]
async fn llm_fetch(
    ctx: State<'_, AppCtx>,
    req: LlmRequest,
    provider: String,
    kind: String,
) -> Result<LlmResponse, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

    let datadir = ctx.inner.lock().await.datadir.clone();
    let key = secrets::get_passphrase(&llm_key_service(&provider), &datadir)
        .map_err(|e| format!("reading llm key: {e}"))?
        .ok_or_else(|| format!("no API key set for provider {provider}"))?;

    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }
    // Inject the real key host-side (override any placeholder the webview sent).
    if kind == "anthropic" {
        headers.remove(AUTHORIZATION);
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(&key).map_err(|e| e.to_string())?,
        );
        if !headers.contains_key("anthropic-version") {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    } else {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {key}")).map_err(|e| e.to_string())?,
        );
    }
    if !headers.contains_key(CONTENT_TYPE) {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }

    let method =
        reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut builder = llm_https_client()?
        .request(method, &req.url)
        .headers(headers);
    if let Some(b) = req.body {
        builder = builder.body(b);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("llm request failed: {e}"))?;
    let status = resp.status().as_u16();
    let mut out_headers = std::collections::HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            out_headers.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading llm body: {e}"))?;
    Ok(LlmResponse {
        status,
        headers: out_headers,
        body,
    })
}

#[tauri::command]
async fn set_llm_api_key(
    ctx: State<'_, AppCtx>,
    provider: String,
    key: String,
) -> Result<(), String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    secrets::set_passphrase(&llm_key_service(&provider), &datadir, &key).map_err(|e| e.to_string())
}

#[tauri::command]
async fn has_llm_api_key(ctx: State<'_, AppCtx>, provider: String) -> Result<bool, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    Ok(secrets::get_passphrase(&llm_key_service(&provider), &datadir)
        .map_err(|e| e.to_string())?
        .is_some())
}

/// Confirm a money-moving agent action by re-checking the wallet passphrase
/// against the one in the secure store (constant-time). On mobile the PRIMARY
/// gate is the biometric prompt in the AgentConsentSheet; this is the parity
/// back-stop so the `confirmConsent()` invoke always has a backend.
#[tauri::command]
async fn agent_confirm_consent(
    ctx: State<'_, AppCtx>,
    passphrase: String,
) -> Result<bool, String> {
    let datadir = ctx.inner.lock().await.datadir.clone();
    let stored = secrets::get_passphrase(KEYRING_SERVICE, &datadir)
        .map_err(|e| e.to_string())?
        .ok_or("wallet is locked")?;
    let (a, b) = (passphrase.as_bytes(), stored.as_bytes());
    let eq = a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0;
    Ok(eq)
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
        .plugin(tauri_plugin_clipboard_manager::init())
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
            app.manage(McpCtx::new());

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
            unlock_with_password,
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
            validate_vault,
            get_market_price,
            get_market_klines,
            get_bnb_price,
            check_latest_release,
            vote_api_get,
            vote_api_post,
            vote_media_get,
            llm_fetch,
            set_llm_api_key,
            has_llm_api_key,
            agent_confirm_consent,
            mcp_start,
            mcp_list_tools,
            mcp_call_tool,
            mcp_registry::mcp_list_servers,
            mcp_registry::mcp_add_server,
            mcp_registry::mcp_remove_server,
            mcp_registry::mcp_set_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
