//! The user-added MCP server registry.
//!
//! The built-in `exfer` server (the wallet's own 35 tools) is implicit and
//! lives entirely in `mcp_supervisor`; it is NEVER stored here and is NOT
//! returned by `mcp_list_servers`. This file owns ONLY the extra servers the
//! user adds (other stdio/http MCP servers, Claude-Code style), persisted as a
//! JSON array in `<datadir>/mcp-servers.json` (0600, atomic write).

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::mcp_supervisor::McpCtx;
use crate::walletd_supervisor::AppCtx;

/// One user-added MCP server. The field set is identical across Rust + both UIs
/// (see the shared interface contract): the desktop-UI agent and the mobile
/// agent build the same shape and round-trip it through these commands.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub label: String,
    /// `"httptool"` (plain HTTP tool: one URL, `{op:list|call}`) or `"http"`
    /// (remote MCP over streamable-http). `"stdio"` (local uvx/child process) is
    /// no longer accepted — every tool is a remote URL so nothing depends on the
    /// user's environment.
    pub transport: String,
    /// Legacy stdio field, retained only so old registry files deserialize; never
    /// spawned (see `mcp_supervisor::ensure_user_server`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Legacy stdio field (unused).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Legacy stdio field (unused).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    /// The endpoint URL (required for both `httptool` and `http`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub enabled: bool,
    /// Consent class applied to EVERY tool this server exposes ("auto" | "gated").
    /// The TS host turns this into a per-server `ToolPolicy` and merges it.
    pub default_consent: String,
    /// Optional keychain service id for a bearer secret injected host-side on
    /// `httptool` calls (mirrors `llm_fetch`). Absent => a public tool (the
    /// Phase-1 default: search, prices, explorers, forums).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_ref: Option<String>,
}

const REGISTRY_FILE: &str = "mcp-servers.json";

/// Load the user's server list from `<datadir>/mcp-servers.json`. A missing or
/// unreadable/corrupt file is treated as an empty registry (fail-soft: a bad
/// file never bricks the agent, it just shows no extra servers).
pub fn load_registry(datadir: &Path) -> Vec<McpServerConfig> {
    let path = datadir.join(REGISTRY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Persist the server list atomically (write `.tmp`, then rename), 0600.
fn save_registry(datadir: &Path, servers: &[McpServerConfig]) -> Result<(), String> {
    let path = datadir.join(REGISTRY_FILE);
    let tmp = datadir.join(format!("{REGISTRY_FILE}.tmp"));
    let json = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| format!("writing {REGISTRY_FILE}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("persisting {REGISTRY_FILE}: {e}"))?;
    Ok(())
}

async fn datadir_of(app: &AppCtx) -> std::path::PathBuf {
    app.inner.lock().await.datadir.clone()
}

/// List the user-added servers (the built-in `exfer` server is excluded — it is
/// implicit and not stored here).
#[tauri::command]
pub async fn mcp_list_servers(app: State<'_, AppCtx>) -> Result<Vec<McpServerConfig>, String> {
    Ok(load_registry(&datadir_of(&app).await))
}

/// Validate a user server config before it is persisted. Pure (no I/O) so the
/// security rules are unit-testable: the reserved id `exfer` is rejected so a
/// user server can never shadow the built-in wallet tools; the old uvx/stdio
/// transport is rejected so nothing can depend on the user's machine having a
/// toolchain; and a URL is required (a tool is always a remote endpoint).
pub(crate) fn validate_server_config(cfg: &McpServerConfig) -> Result<(), String> {
    if cfg.id.trim().is_empty() {
        return Err("server id must not be empty".into());
    }
    if cfg.id == "exfer" {
        return Err("\"exfer\" is reserved for the built-in wallet server".into());
    }
    match cfg.transport.as_str() {
        "httptool" | "http" => {}
        "stdio" => {
            return Err(
                "stdio/uvx tools are no longer supported — add an HTTP tool URL instead".into(),
            )
        }
        other => return Err(format!("unknown transport \"{other}\"")),
    }
    if cfg.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("an HTTP tool needs a url".into());
    }
    Ok(())
}

/// Add (or replace, by id) a user server. See [`validate_server_config`] for the
/// rejection rules.
#[tauri::command]
pub async fn mcp_add_server(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    cfg: McpServerConfig,
) -> Result<(), String> {
    validate_server_config(&cfg)?;
    let datadir = datadir_of(&app).await;
    let mut servers = load_registry(&datadir);
    servers.retain(|s| s.id != cfg.id);
    servers.push(cfg.clone());
    save_registry(&datadir, &servers)?;
    // Drop any stale connection for this id so the next list_tools reconnects
    // with the new command/url/env.
    mcp.drop_server(&cfg.id).await;
    Ok(())
}

/// Remove a user server by id and disconnect it.
#[tauri::command]
pub async fn mcp_remove_server(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    id: String,
) -> Result<(), String> {
    let datadir = datadir_of(&app).await;
    let mut servers = load_registry(&datadir);
    servers.retain(|s| s.id != id);
    save_registry(&datadir, &servers)?;
    mcp.drop_server(&id).await;
    Ok(())
}

/// Enable/disable a user server. Disabling also tears down its live connection
/// (and its tools vanish from `mcp_list_tools`); enabling lets the next
/// `mcp_list_tools` connect it lazily.
#[tauri::command]
pub async fn mcp_set_enabled(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let datadir = datadir_of(&app).await;
    let mut servers = load_registry(&datadir);
    let mut found = false;
    for s in servers.iter_mut() {
        if s.id == id {
            s.enabled = enabled;
            found = true;
        }
    }
    if !found {
        return Err(format!("no such server: {id}"));
    }
    save_registry(&datadir, &servers)?;
    if !enabled {
        mcp.drop_server(&id).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, transport: &str, url: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            label: "x".into(),
            transport: transport.into(),
            command: None,
            args: None,
            env: None,
            url: url.map(|u| u.into()),
            enabled: true,
            default_consent: "auto".into(),
            auth_ref: None,
        }
    }

    #[test]
    fn accepts_httptool_and_http_with_a_url() {
        assert!(
            validate_server_config(&cfg("web", "httptool", Some("https://tools.example/x")))
                .is_ok()
        );
        assert!(
            validate_server_config(&cfg("mcp", "http", Some("https://mcp.example/sse"))).is_ok()
        );
    }

    #[test]
    fn rejects_stdio_uvx_transport() {
        let e = validate_server_config(&cfg("x", "stdio", Some("https://x"))).unwrap_err();
        assert!(e.contains("no longer supported"), "{e}");
    }

    #[test]
    fn rejects_reserved_exfer_id() {
        assert!(validate_server_config(&cfg("exfer", "httptool", Some("https://x"))).is_err());
    }

    #[test]
    fn requires_a_url() {
        assert!(validate_server_config(&cfg("x", "httptool", None)).is_err());
        assert!(validate_server_config(&cfg("x", "httptool", Some("  "))).is_err());
    }

    #[test]
    fn rejects_empty_id_and_unknown_transport() {
        assert!(validate_server_config(&cfg("  ", "httptool", Some("https://x"))).is_err());
        assert!(validate_server_config(&cfg("x", "carrier-pigeon", Some("https://x"))).is_err());
    }
}
