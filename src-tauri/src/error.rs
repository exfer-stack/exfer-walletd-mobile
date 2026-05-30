//! `Result` and error types shared by the Tauri shell. Tauri commands
//! surface `Result<T, String>` to the frontend — this enum exists so
//! internal callers keep richer typing and the conversion to a
//! user-facing string happens in one place
//! ([`AppError::to_user_string`]).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid fingerprint: {0}")]
    InvalidFingerprint(String),
    #[error("upstream JSON-RPC error (code {code}): {message}")]
    RpcError { code: i64, message: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl AppError {
    /// Stringify into a frontend-friendly message. Tauri commands
    /// surface `Err(String)` to the JS side, so we collapse here.
    pub fn to_user_string(&self) -> String {
        self.to_string()
    }
}
