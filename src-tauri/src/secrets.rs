//! Thin wrapper around the platform secure store for the walletd
//! keystore passphrase ("remember me" / silent unlock on relaunch).
//!
//! - iOS / macOS → Keychain (Security.framework, `keyring` apple-native)
//! - Windows → Credential Manager
//! - Linux → libsecret (secret-service)
//! - Android → app-private file (the per-app sandbox is unreadable by
//!   other apps). The `keyring` crate has no Android backend; a
//!   hardware-backed Android Keystore path (tauri-plugin-keystore) is a
//!   hardening follow-up. Note the walletd seed itself is always sealed
//!   with the user's Argon2id passphrase regardless of this convenience.
//!
//! Service id is the Tauri application identifier so a single user can
//! have multiple installs without collisions; the account field is a
//! fixed `"keystore-passphrase"` string.

#[allow(dead_code)]
const ACCOUNT: &str = "keystore-passphrase";

#[cfg(not(target_os = "android"))]
mod imp {
    use super::ACCOUNT;
    use anyhow::Context;
    use keyring::Entry;

    fn entry(service: &str) -> anyhow::Result<Entry> {
        Entry::new(service, ACCOUNT).context("opening keyring entry")
    }

    pub fn get_passphrase(service: &str) -> anyhow::Result<Option<String>> {
        match entry(service)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(anyhow::Error::new(e).context("reading keyring entry")),
        }
    }

    pub fn set_passphrase(service: &str, value: &str) -> anyhow::Result<()> {
        entry(service)?
            .set_password(value)
            .context("writing keyring entry")
    }

    pub fn delete_passphrase(service: &str) -> anyhow::Result<()> {
        match entry(service)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow::Error::new(e).context("deleting keyring entry")),
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    //! Android fallback: a 0600 file inside the app-private data dir.
    //! `service` is ignored (the dir is already per-install). The path is
    //! resolved relative to the process data dir Tauri hands walletd.
    use anyhow::Context;
    use std::path::PathBuf;

    fn path() -> PathBuf {
        // App-private files dir; Tauri/Android guarantee this is the
        // app sandbox. Falls back to a temp path only if HOME is unset
        // (never in practice on Android).
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join(".exfer-keystore-passphrase")
    }

    pub fn get_passphrase(_service: &str) -> anyhow::Result<Option<String>> {
        let p = path();
        match std::fs::read_to_string(&p) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow::Error::new(e).context("reading passphrase file")),
        }
    }

    pub fn set_passphrase(_service: &str, value: &str) -> anyhow::Result<()> {
        let p = path();
        std::fs::write(&p, value).context("writing passphrase file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete_passphrase(_service: &str) -> anyhow::Result<()> {
        match std::fs::remove_file(path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::Error::new(e).context("deleting passphrase file")),
        }
    }
}

/// Fetch the saved passphrase, returning `Ok(None)` if none has been
/// stored yet on this device.
pub fn get_passphrase(service: &str) -> anyhow::Result<Option<String>> {
    imp::get_passphrase(service)
}

/// Persist the passphrase. Overwrites any prior value.
pub fn set_passphrase(service: &str, value: &str) -> anyhow::Result<()> {
    imp::set_passphrase(service, value)
}

/// Remove the stored passphrase. A missing entry is success.
pub fn delete_passphrase(service: &str) -> anyhow::Result<()> {
    imp::delete_passphrase(service)
}
