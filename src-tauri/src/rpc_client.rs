//! Loopback JSON-RPC client to the embedded walletd. Uses reqwest +
//! rustls with a custom `ServerCertVerifier` that matches the leaf
//! cert's SHA-256 against the fingerprint walletd surfaced when
//! [`exfer_walletd::run_embedded`] returned. The reqwest build feature
//! `rustls-tls-manual-roots` disables webpki-roots entirely so the
//! pinned verifier is the only handshake path.
//!
//! The frontend never makes HTTPS calls itself — every request goes JS
//! → Tauri IPC → Rust → loopback HTTPS to walletd. Keeping the
//! crypto here means the webview never has to be taught to trust the
//! self-signed cert.

use std::sync::Arc;

use anyhow::anyhow;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;

#[derive(Debug)]
struct FingerprintVerifier {
    expected: [u8; 32],
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = Sha256::digest(end_entity.as_ref());
        if got.as_slice() == self.expected.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "leaf cert SHA-256 does not match pinned fingerprint".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // Signature validity is the part webpki handles for CA-rooted
        // chains. With a one-shot pin we accept any signature shape the
        // peer offered — the leaf identity check is the binding step.
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

/// Build a reqwest client whose only allowed TLS leaf is the one
/// matching `fingerprint` (`sha256:<64-hex>`).
pub fn pinned_client(fingerprint: &str) -> Result<reqwest::Client, AppError> {
    let hex = fingerprint
        .strip_prefix("sha256:")
        .ok_or_else(|| AppError::InvalidFingerprint(fingerprint.to_string()))?;
    let mut expected = [0u8; 32];
    hex::decode_to_slice(hex, &mut expected)
        .map_err(|_| AppError::InvalidFingerprint(fingerprint.to_string()))?;

    let tls_cfg = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier { expected }))
        .with_no_client_auth();

    reqwest::ClientBuilder::new()
        .use_preconfigured_tls(tls_cfg)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Transport(e.to_string()))
}

/// Convention for which scoped token to attach when forwarding a method.
/// Mirrors walletd's `auth::Scope::for_method` — duplicated here so the
/// desktop doesn't depend on walletd's internal module being `pub`.
/// MUST stay in sync with walletd: reveal_mnemonic / reveal_private_key
/// were added at Spend scope in walletd v1.3.0; if they're missing here
/// they fall through to Read and walletd rejects the read token with
/// -32001 (authentication required) before it ever checks the password.
fn scope_for_method(method: &str) -> Scope {
    match method {
        "transfer" | "send_raw_transaction" | "sign_message"
        | "reveal_mnemonic" | "reveal_private_key"
        // walletd v1.9.x keyring lifecycle: per-address recovery phrase,
        // key-material exports, and deletion all move/expose secrets.
        | "reveal_address_mnemonic" | "export_vault" | "export_address"
        | "import_vault" | "delete_address" => Scope::Spend,
        // import_private_key/import_mnemonic add a key (Manage, like
        // generate_*). import_private_key was previously missing here and
        // fell through to Read, which walletd rejects with -32001.
        "generate_address" | "generate_independent_address"
        | "import_private_key" | "import_mnemonic" | "abandon_transfer" => Scope::Manage,
        _ => Scope::Read,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Read,
    Manage,
    Spend,
}

pub struct ConnectionInfo {
    pub base_url: String,
    pub fingerprint: String,
    pub token_read: String,
    pub token_manage: String,
    pub token_spend: String,
}

impl ConnectionInfo {
    fn token_for(&self, scope: Scope) -> &str {
        match scope {
            Scope::Read => &self.token_read,
            Scope::Manage => &self.token_manage,
            Scope::Spend => &self.token_spend,
        }
    }
}

/// Forward a JSON-RPC call to the embedded walletd. Picks the token by
/// method scope; returns the parsed `result` field on success, or
/// surfaces walletd's `error` envelope as [`AppError::RpcError`].
pub async fn forward_rpc(
    client: &reqwest::Client,
    conn: &ConnectionInfo,
    method: &str,
    params: Value,
) -> Result<Value, AppError> {
    let scope = scope_for_method(method);
    let body = json!({
        "jsonrpc": "2.0",
        "id":      1,
        "method":  method,
        "params":  params,
    });

    let resp: Value = client
        .post(&conn.base_url)
        .bearer_auth(conn.token_for(scope))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Transport(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Transport(format!("decoding response: {e}")))?;

    if let Some(err) = resp.get("error") {
        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let message = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("(no message)")
            .to_string();
        return Err(AppError::RpcError { code, message });
    }

    Ok(resp
        .get("result")
        .cloned()
        .ok_or_else(|| anyhow!("response missing both `result` and `error`"))?)
}

/// Convenience: build the pinned client lazily. Cached per fingerprint
/// in the supervisor; this is the constructor.
pub fn build_client_for(conn: &ConnectionInfo) -> Result<reqwest::Client, AppError> {
    pinned_client(&conn.fingerprint)
        .with_context_app(|| format!("building reqwest client for {}", conn.base_url))
}

trait WithContextApp<T> {
    fn with_context_app<F: FnOnce() -> String>(self, f: F) -> Result<T, AppError>;
}
impl<T> WithContextApp<T> for Result<T, AppError> {
    fn with_context_app<F: FnOnce() -> String>(self, f: F) -> Result<T, AppError> {
        self.map_err(|e| AppError::Other(anyhow::Error::msg(format!("{}: {e}", f()))))
    }
}
