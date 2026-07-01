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
    //! One file PER `service`, so distinct secrets never clobber each
    //! other — the wallet keystore passphrase (`crate::KEYRING_SERVICE`)
    //! and the per-provider LLM API keys (`{KEYRING_SERVICE}-llm:{provider}`)
    //! each get their own file. (Before this, every service shared one
    //! `.exfer-keystore-passphrase` file, so saving an LLM key wiped the
    //! wallet passphrase and vice-versa.) The path is resolved from the
    //! data dir Tauri hands the app — NOT from `$HOME`, which is unset or
    //! non-writable on some OEM ROMs (Huawei EMUI / HarmonyOS), where the
    //! old `$HOME`-based path made `set_passphrase` fail and blocked
    //! wallet creation entirely.
    use anyhow::Context;
    use std::path::{Path, PathBuf};

    /// The filename every secret shared before the per-service split. Now
    /// only the wallet keystore service reads it, as a migration source.
    const LEGACY_KEYSTORE_FILE: &str = ".exfer-keystore-passphrase";

    /// Filesystem-safe per-service filename component: every char that is
    /// not `[A-Za-z0-9]` becomes `-`. e.g. `com.exfer.wallet-llm:deepseek`
    /// → `com-exfer-wallet-llm-deepseek`.
    fn slug(service: &str) -> String {
        service
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect()
    }

    fn path(service: &str, data_dir: &Path) -> PathBuf {
        data_dir.join(format!(".exfer-secret-{}", slug(service)))
    }

    /// Where versions <= 0.5.4 wrote the (single, shared) keystore
    /// passphrase: `$HOME` if set, else the temp dir. These are checked on
    /// read for the keystore service ONLY so an upgrade doesn't lose silent
    /// unlock. Other services must not read them — after the pre-split
    /// clobbering bug they may hold a different secret's value.
    fn legacy_paths() -> Vec<PathBuf> {
        let mut v = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join(LEGACY_KEYSTORE_FILE));
        }
        v.push(std::env::temp_dir().join(LEGACY_KEYSTORE_FILE));
        v
    }

    pub fn get_passphrase(service: &str, data_dir: &Path) -> anyhow::Result<Option<String>> {
        let p = path(service, data_dir);
        match std::fs::read_to_string(&p) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow::Error::new(e).context("reading secret file")),
        }
        // No per-service file yet. Only the wallet keystore passphrase has
        // legacy locations worth migrating — and only IT may read them,
        // since the pre-split shared files could now hold a different
        // secret's value (e.g. a clobbered LLM key). Every other service
        // simply reports "not stored" so it never adopts a stray value.
        if service != crate::KEYRING_SERVICE {
            return Ok(None);
        }
        // Keystore service: fall back to the shared per-data-dir file
        // (pre-split), then the pre-0.5.5 $HOME/temp paths. Moving this
        // without a fallback made upgrades drop to the Create/Restore
        // screen as if the wallet were gone, even though the keystore
        // itself was always safe in data_dir. Migrate whatever we find
        // forward to the new per-service path so it stays put from here on.
        let mut candidates = vec![data_dir.join(LEGACY_KEYSTORE_FILE)];
        candidates.extend(legacy_paths());
        for legacy in candidates {
            match std::fs::read_to_string(&legacy) {
                Ok(s) => {
                    let _ = set_passphrase(service, data_dir, &s);
                    return Ok(Some(s));
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    pub fn set_passphrase(service: &str, data_dir: &Path, value: &str) -> anyhow::Result<()> {
        // The data dir is created at startup, but be defensive: a missing
        // parent here would otherwise surface as a confusing "password"
        // error through the frontend humanizer.
        let _ = std::fs::create_dir_all(data_dir);
        let p = path(service, data_dir);
        std::fs::write(&p, value).context("writing secret file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete_passphrase(service: &str, data_dir: &Path) -> anyhow::Result<()> {
        match std::fs::remove_file(path(service, data_dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::Error::new(e).context("deleting secret file")),
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
