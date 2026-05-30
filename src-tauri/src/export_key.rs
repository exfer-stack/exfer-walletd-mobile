//! Build the official Exfer "wallet.key" (EXFK) file for a single
//! address, so it imports cleanly into exfer.dev ("Import wallet.key")
//! and the `exfer wallet` CLI.
//!
//! Byte-for-byte identical to the exfer crate's `Wallet::save_encrypted`
//! (81 bytes):
//!   "EXFK" magic (4) + version u8 (1) + Argon2id salt (16)
//!   + AES-256-GCM nonce (12) + ciphertext (48 = 32-byte ed25519 secret
//!   + 16-byte GCM tag)
//!
//! KDF: Argon2id, V0x13, m=262144 KiB (256 MiB), t=3, p=1, 32-byte out —
//! matching the official wallet's at-rest hardening so the same
//! passphrase decrypts on the other side.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;

const MAGIC: &[u8; 4] = b"EXFK";
const VERSION: u8 = 1;
/// 4 magic + 1 version + 16 salt + 12 nonce + 48 ciphertext (32 secret + 16 GCM tag).
const EXFK_LEN: usize = 4 + 1 + 16 + 12 + 48;

fn derive_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(262_144, 3, 1, Some(32)).map_err(|e| format!("argon2 params: {e}"))?,
    );
    let mut out = [0u8; 32];
    argon2
        .hash_password_into(passphrase, salt, &mut out)
        .map_err(|e| format!("argon2 derive: {e}"))?;
    Ok(out)
}

/// Encode a raw 32-byte ed25519 secret into an EXFK file buffer,
/// encrypted with `passphrase`.
pub fn build_exfk(secret: &[u8; 32], passphrase: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let aes_key = derive_key(passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("aes init: {e}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), secret.as_slice())
        .map_err(|e| format!("aes encrypt: {e}"))?;

    let mut buf = Vec::with_capacity(EXFK_LEN);
    buf.extend_from_slice(MAGIC);
    buf.push(VERSION);
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ciphertext);
    Ok(buf)
}

/// Decode an EXFK file buffer back into its raw 32-byte secret. Inverse
/// of [`build_exfk`]; used when importing a `wallet.key` exported from
/// this app, the exfer CLI, or exfer.dev. Errors surface as short user
/// strings so the Tauri layer can show them as-is.
pub fn parse_exfk(buf: &[u8], passphrase: &[u8]) -> Result<[u8; 32], String> {
    if buf.len() != EXFK_LEN {
        return Err(format!(
            "wallet.key has wrong length ({} bytes; expected {EXFK_LEN})",
            buf.len()
        ));
    }
    if &buf[0..4] != MAGIC {
        return Err("not an Exfer wallet.key file (bad magic)".into());
    }
    if buf[4] != VERSION {
        return Err(format!(
            "unsupported wallet.key version (got {}, expected {VERSION})",
            buf[4]
        ));
    }
    let salt = &buf[5..21];
    let nonce_bytes = &buf[21..33];
    let ciphertext = &buf[33..81];

    let aes_key = derive_key(passphrase, salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("aes init: {e}"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "wrong password or corrupt wallet.key".to_string())?;
    if plaintext.len() != 32 {
        return Err(format!(
            "decrypted secret has wrong length ({} bytes; expected 32)",
            plaintext.len()
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&plaintext);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_then_parse_roundtrips() {
        let secret = [42u8; 32];
        let blob = build_exfk(&secret, b"correct horse battery staple").unwrap();
        assert_eq!(blob.len(), EXFK_LEN);
        let recovered = parse_exfk(&blob, b"correct horse battery staple").unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn wrong_password_fails() {
        let blob = build_exfk(&[7u8; 32], b"pw").unwrap();
        let err = parse_exfk(&blob, b"wrong").unwrap_err();
        assert!(err.contains("wrong password"), "got: {err}");
    }

    #[test]
    fn bad_magic_fails() {
        let mut blob = build_exfk(&[0u8; 32], b"pw").unwrap();
        blob[0] = b'X';
        let err = parse_exfk(&blob, b"pw").unwrap_err();
        assert!(err.contains("bad magic"), "got: {err}");
    }

    #[test]
    fn truncated_fails() {
        let blob = build_exfk(&[0u8; 32], b"pw").unwrap();
        let err = parse_exfk(&blob[..blob.len() - 1], b"pw").unwrap_err();
        assert!(err.contains("wrong length"), "got: {err}");
    }
}
