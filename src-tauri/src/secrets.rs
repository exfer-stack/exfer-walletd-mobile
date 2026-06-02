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
    use std::path::Path;

    fn entry(service: &str) -> anyhow::Result<Entry> {
        Entry::new(service, ACCOUNT).context("opening keyring entry")
    }

    pub fn get_passphrase(service: &str, _data_dir: &Path) -> anyhow::Result<Option<String>> {
        match entry(service)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(anyhow::Error::new(e).context("reading keyring entry")),
        }
    }

    pub fn set_passphrase(service: &str, _data_dir: &Path, value: &str) -> anyhow::Result<()> {
        entry(service)?
            .set_password(value)
            .context("writing keyring entry")
    }

    pub fn delete_passphrase(service: &str, _data_dir: &Path) -> anyhow::Result<()> {
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
    //! resolved from the data dir Tauri hands the app — NOT from `$HOME`,
    //! which is unset or non-writable on some OEM ROMs (Huawei EMUI /
    //! HarmonyOS), where the old `$HOME`-based path made `set_passphrase`
    //! fail and blocked wallet creation entirely.
    use anyhow::Context;
    use std::path::{Path, PathBuf};

    fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(".exfer-keystore-passphrase")
    }

    /// Where versions <= 0.5.4 wrote the passphrase: `$HOME` if set, else the
    /// temp dir. We moved it into `data_dir` in 0.5.5; these are checked on
    /// read so an upgrade doesn't lose silent unlock.
    fn legacy_paths() -> Vec<PathBuf> {
        let mut v = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join(".exfer-keystore-passphrase"));
        }
        v.push(std::env::temp_dir().join(".exfer-keystore-passphrase"));
        v
    }

    pub fn get_passphrase(_service: &str, data_dir: &Path) -> anyhow::Result<Option<String>> {
        let p = path(data_dir);
        match std::fs::read_to_string(&p) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow::Error::new(e).context("reading passphrase file")),
        }
        // Not in the new location — fall back to the pre-0.5.5 paths. Moving
        // this file (without a fallback) made upgrades drop to the
        // Create/Restore screen as if the wallet were gone, even though the
        // keystore itself was always safe in data_dir. Migrate it forward so
        // it stays put from here on.
        for legacy in legacy_paths() {
            match std::fs::read_to_string(&legacy) {
                Ok(s) => {
                    let _ = set_passphrase(_service, data_dir, &s);
                    return Ok(Some(s));
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    pub fn set_passphrase(_service: &str, data_dir: &Path, value: &str) -> anyhow::Result<()> {
        // The data dir is created at startup, but be defensive: a missing
        // parent here would otherwise surface as a confusing "password"
        // error through the frontend humanizer.
        let _ = std::fs::create_dir_all(data_dir);
        let p = path(data_dir);
        std::fs::write(&p, value).context("writing passphrase file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete_passphrase(_service: &str, data_dir: &Path) -> anyhow::Result<()> {
        match std::fs::remove_file(path(data_dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::Error::new(e).context("deleting passphrase file")),
        }
    }
}

use std::path::Path;

/// Fetch the saved passphrase, returning `Ok(None)` if none has been
/// stored yet on this device. `data_dir` locates the per-install file on
/// Android (ignored on platforms with a real OS keyring).
pub fn get_passphrase(service: &str, data_dir: &Path) -> anyhow::Result<Option<String>> {
    imp::get_passphrase(service, data_dir)
}

/// Persist the passphrase. Overwrites any prior value.
pub fn set_passphrase(service: &str, data_dir: &Path, value: &str) -> anyhow::Result<()> {
    imp::set_passphrase(service, data_dir, value)
}

/// Remove the stored passphrase. A missing entry is success.
pub fn delete_passphrase(service: &str, data_dir: &Path) -> anyhow::Result<()> {
    imp::delete_passphrase(service, data_dir)
}
