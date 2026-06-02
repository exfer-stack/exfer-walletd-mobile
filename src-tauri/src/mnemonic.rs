//! Mnemonic import derivation.
//!
//! The same 24 words mean different things to different Exfer wallets, so a
//! mnemonic import can land on TWO different addresses. We derive both and let
//! the UI preview them, defaulting to the standard scheme:
//!
//! - **Standard (BIP39)** — what exfer.dev (the web wallet) and the Flutter
//!   wallet produce. Reverse-engineered from exfer.dev's bundle and pinned by
//!   a test vector below:
//!       seed   = BIP39 mnemonic-to-seed, empty passphrase  (PBKDF2-HMAC-SHA512)
//!       secret = SHA-256("EXFER-MNEMONIC-ED25519-V1" || seed)
//!
//! - **Legacy** — what walletd's own `import_mnemonic` does (a per-address
//!   "private-key backup phrase"): the 24 words ARE the raw key.
//!       secret = the phrase's raw BIP-39 entropy (32 bytes)
//!
//! Both map secret -> ed25519 -> address through walletd's own `Signer`, so the
//! previewed address is byte-for-byte what the keystore will hold after import.

use exfer_walletd::store::Signer;
use sha2::{Digest, Sha256};

/// Domain tag exfer.dev / the Flutter wallet prepend to the BIP39 seed before
/// hashing to the ed25519 secret. Must match their bundle exactly.
const STD_DOMAIN: &[u8] = b"EXFER-MNEMONIC-ED25519-V1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// exfer.dev / Flutter wallet — a real BIP39 HD seed phrase.
    Standard,
    /// walletd legacy — the words encode a raw private key.
    Legacy,
}

impl Scheme {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "standard" => Ok(Scheme::Standard),
            "legacy" => Ok(Scheme::Legacy),
            other => Err(format!("unknown mnemonic scheme: {other}")),
        }
    }
}

/// Parse + validate a 24-word English BIP-39 phrase. 24 words ⇔ 256-bit
/// entropy, which is exactly one ed25519 secret; reject anything shorter so a
/// 12-word phrase can't silently import a zero-padded key.
fn parse_mnemonic(phrase: &str) -> Result<bip39::Mnemonic, String> {
    let m = bip39::Mnemonic::parse_in(bip39::Language::English, phrase.trim())
        .map_err(|e| format!("invalid recovery phrase: {e}"))?;
    if m.to_entropy().len() != 32 {
        return Err("recovery phrase must be 24 words".to_string());
    }
    Ok(m)
}

/// Derive the raw 32-byte ed25519 secret for `scheme`.
pub fn derive_secret(phrase: &str, scheme: Scheme) -> Result<[u8; 32], String> {
    let m = parse_mnemonic(phrase)?;
    match scheme {
        Scheme::Standard => {
            let seed = m.to_seed(""); // [u8; 64] — BIP39 with empty passphrase
            let mut h = Sha256::new();
            h.update(STD_DOMAIN);
            h.update(seed);
            Ok(h.finalize().into())
        }
        Scheme::Legacy => {
            let entropy = m.to_entropy(); // 32 bytes for a 24-word phrase
            let mut secret = [0u8; 32];
            secret.copy_from_slice(&entropy);
            Ok(secret)
        }
    }
}

/// The hex address `secret` controls — computed with walletd's own `Signer`
/// so it is identical to what the keystore reports after import.
pub fn address_for_secret(secret: &[u8; 32]) -> String {
    Signer::from_secret_bytes(secret).address_hex()
}

/// Both candidate addresses for a phrase: `(standard, legacy)`.
pub fn preview(phrase: &str) -> Result<(String, String), String> {
    let standard = address_for_secret(&derive_secret(phrase, Scheme::Standard)?);
    let legacy = address_for_secret(&derive_secret(phrase, Scheme::Legacy)?);
    Ok((standard, legacy))
}

/// Generate a fresh standard wallet. Returns the 24-word phrase, its 32-byte
/// BIP-39 entropy (what we seal so the phrase is revealable later), the derived
/// ed25519 secret (what gets imported), and the address.
pub fn generate_standard() -> Result<(String, [u8; 32], [u8; 32], String), String> {
    let m = bip39::Mnemonic::generate_in(bip39::Language::English, 24)
        .map_err(|e| format!("mnemonic generation failed: {e}"))?;
    let phrase = m.words().collect::<Vec<&str>>().join(" ");
    let ent = m.to_entropy();
    if ent.len() != 32 {
        return Err("expected 32-byte entropy".to_string());
    }
    let mut entropy = [0u8; 32];
    entropy.copy_from_slice(&ent);
    let secret = derive_secret(&phrase, Scheme::Standard)?;
    let address = address_for_secret(&secret);
    Ok((phrase, entropy, secret, address))
}

/// Reconstruct the 24-word phrase from its stored 32-byte entropy.
pub fn phrase_from_entropy(entropy: &[u8; 32]) -> Result<Vec<String>, String> {
    let m = bip39::Mnemonic::from_entropy(entropy)
        .map_err(|e| format!("mnemonic from entropy: {e}"))?;
    Ok(m.words().map(|w| w.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ground truth captured from exfer.dev (the web wallet): importing this
    // public BIP-39 test mnemonic under the standard scheme yields this exact
    // address (also confirmed against the Flutter wallet's core lib). If the
    // standard derivation ever drifts from exfer.dev, this fails loudly.
    const ABANDON_ART_ADDR: &str =
        "f74919726a8c38fff716258f85e0a569abaf9add9717d5ac8106eaca51ff3073";

    fn abandon_art() -> String {
        format!("{}art", "abandon ".repeat(23))
    }

    #[test]
    fn standard_matches_exfer_dev_vector() {
        let secret = derive_secret(&abandon_art(), Scheme::Standard).unwrap();
        assert_eq!(address_for_secret(&secret), ABANDON_ART_ADDR);
    }

    #[test]
    fn legacy_differs_from_standard() {
        // The whole reason for the picker: same words, different address.
        let (std_addr, legacy_addr) = preview(&abandon_art()).unwrap();
        assert_eq!(std_addr, ABANDON_ART_ADDR);
        assert_ne!(std_addr, legacy_addr);
    }

    #[test]
    fn rejects_non_24_word() {
        let twelve = format!("{}about", "abandon ".repeat(11));
        assert!(derive_secret(&twelve, Scheme::Standard).is_err());
    }

    #[test]
    fn generate_is_standard_and_entropy_round_trips() {
        let (phrase, entropy, secret, address) = generate_standard().unwrap();
        // The address must be the STANDARD derivation of its own phrase, so it
        // matches what an external standard wallet computes for that phrase.
        assert_eq!(secret, derive_secret(&phrase, Scheme::Standard).unwrap());
        assert_eq!(address, address_for_secret(&secret));
        // The sealed entropy reconstructs the exact phrase (what reveal does).
        assert_eq!(phrase_from_entropy(&entropy).unwrap().join(" "), phrase);
    }
}
