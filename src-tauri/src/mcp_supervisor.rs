//! Multi-server MCP supervisor.
//!
//! The built-in `exfer` server is the `exfer-mcp` sidecar, run in EXTERNAL mode
//! pointed at THIS app's in-process embedded walletd (URL + scope tokens + TLS
//! fingerprint from `ConnectionInfo`), so the agent's 35 tools operate on the
//! user's real wallet — no second walletd, no second keystore. It is implicit,
//! always enabled, and not user-removable.
//!
//! On top of that, the user can register extra MCP servers (Claude-Code style):
//! other stdio child processes or streamable-http endpoints (see
//! `mcp_registry`). All connected servers are multiplexed into one
//! `HashMap<serverId, RunningService>`; tool calls route to the owning server by
//! tool name. On a name collision across servers the built-in `exfer` server
//! wins and the duplicate is dropped (with a `tracing::warn`).
//!
//! The rmcp stdio-client pattern here is verified end-to-end against a real
//! exfer-mcp + real chain (see the standalone rmcp probe).

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::{
    model::CallToolRequestParams, service::RoleClient, service::RunningService,
    transport::StreamableHttpClientTransport, transport::TokioChildProcess, ServiceExt,
};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

use crate::mcp_registry::{load_registry, McpServerConfig};
use crate::rpc_client::ConnectionInfo;
use crate::walletd_supervisor::AppCtx;

/// The reserved id of the built-in wallet server.
pub const EXFER_SERVER_ID: &str = "exfer";

/// Managed Tauri state: the set of running MCP clients, keyed by server id. The
/// built-in `exfer` client lives under `EXFER_SERVER_ID`; user servers under
/// their own ids. Lazily populated — a server is connected the first time its
/// tools are needed.
pub struct McpCtx {
    inner: Arc<Mutex<HashMap<String, RunningService<RoleClient, ()>>>>,
}

impl McpCtx {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Drop a server's live connection (best-effort cancel). Called when a user
    /// server is removed, disabled, or re-added with new wiring, so the next
    /// `mcp_list_tools` reconnects it fresh. The built-in `exfer` id is never
    /// dropped through here in normal flow, but is permitted (it just re-spawns).
    pub async fn drop_server(&self, id: &str) {
        if let Some(svc) = self.inner.lock().await.remove(id) {
            let _ = svc.cancel().await;
        }
    }
}

impl Default for McpCtx {
    fn default() -> Self {
        Self::new()
    }
}

/// exfer-mcp EXTERNAL-mode env pointed at the embedded walletd.
fn external_env(conn: &ConnectionInfo) -> HashMap<String, String> {
    let mut e = HashMap::new();
    e.insert("WALLETD_URL".into(), conn.base_url.clone());
    // exfer-mcp speaks to walletd with a SINGLE bearer token (WALLETD_AUTH_TOKEN),
    // not the desktop's per-scope read/manage/spend triple. The spend-scope token
    // is the most privileged, so it covers the agent's reads AND writes
    // (transfer / swap / sign). Sending the wrong env makes exfer-mcp exit on
    // startup ("WALLETD_AUTH_TOKEN is unset") and the agent hangs awaiting tools.
    e.insert("WALLETD_AUTH_TOKEN".into(), conn.token_spend.clone());
    if !conn.fingerprint.is_empty() {
        e.insert("WALLETD_FINGERPRINT".into(), conn.fingerprint.clone());
    }
    // The on-ramp tools use the community pool + its pinned CA by default.
    e.insert("EXFER_ENABLE_SWAP".into(), "1".into());
    e
}

/// Build the exfer-mcp child command (the same pinned package as before).
fn exfer_command(env: HashMap<String, String>) -> tokio::process::Command {
    let bin = std::env::var("EXFER_MCP_CMD").unwrap_or_else(|_| "uvx".into());
    let pin = std::env::var("EXFER_MCP_PIN").unwrap_or_else(|_| "exfer-mcp==0.6.0".into());
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg(pin);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

/// Spawn + MCP-handshake a stdio child server.
async fn connect_stdio(
    cmd: tokio::process::Command,
) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = TokioChildProcess::new(cmd).map_err(|e| format!("spawn server: {e}"))?;
    ().serve(transport)
        .await
        .map_err(|e| format!("mcp handshake failed: {e}"))
}

/// Connect + MCP-handshake a streamable-http server.
async fn connect_http(url: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_uri(url);
    ().serve(transport)
        .await
        .map_err(|e| format!("mcp http handshake failed: {e}"))
}

/// Ensure the built-in exfer server is connected, returning early if it already
/// is. Held separately from user servers because it needs live walletd conn.
async fn ensure_exfer(mcp: &McpCtx, env: HashMap<String, String>) -> Result<(), String> {
    {
        let guard = mcp.inner.lock().await;
        if guard.contains_key(EXFER_SERVER_ID) {
            return Ok(());
        }
    }
    let client = connect_stdio(exfer_command(env)).await?;
    mcp.inner
        .lock()
        .await
        .entry(EXFER_SERVER_ID.to_string())
        .or_insert(client);
    Ok(())
}

/// Ensure a user server (stdio or http) is connected. A connect failure is
/// returned to the caller, which logs + skips that server (one bad server must
/// not take the whole agent down).
async fn ensure_user_server(mcp: &McpCtx, cfg: &McpServerConfig) -> Result<(), String> {
    {
        let guard = mcp.inner.lock().await;
        if guard.contains_key(&cfg.id) {
            return Ok(());
        }
    }
    let client = match cfg.transport.as_str() {
        "stdio" => {
            let command = cfg
                .command
                .as_ref()
                .filter(|c| !c.trim().is_empty())
                .ok_or("stdio server is missing a command")?;
            let mut cmd = tokio::process::Command::new(command);
            if let Some(args) = &cfg.args {
                cmd.args(args);
            }
            if let Some(env) = &cfg.env {
                for (k, v) in env {
                    cmd.env(k, v);
                }
            }
            connect_stdio(cmd).await?
        }
        "http" => {
            let url = cfg
                .url
                .as_ref()
                .filter(|u| !u.trim().is_empty())
                .ok_or("http server is missing a url")?;
            connect_http(url).await?
        }
        other => return Err(format!("unknown transport \"{other}\"")),
    };
    mcp.inner
        .lock()
        .await
        .entry(cfg.id.clone())
        .or_insert(client);
    Ok(())
}

/// Read the embedded walletd connection (url + tokens + fingerprint) from the
/// app context, erroring if walletd isn't ready yet.
async fn conn_of(app: &AppCtx) -> Result<Arc<ConnectionInfo>, String> {
    let inner = app.inner.lock().await;
    inner
        .conn
        .clone()
        .ok_or_else(|| "walletd not ready".to_string())
}

/// Kept for back-compat with the existing call site (the Agent page pre-warms
/// the sidecar). Connects the built-in exfer server eagerly.
#[tauri::command]
pub async fn mcp_start(app: State<'_, AppCtx>, mcp: State<'_, McpCtx>) -> Result<(), String> {
    let conn = conn_of(&app).await?;
    ensure_exfer(&mcp, external_env(&conn)).await
}

/// One server's metadata in the `mcp_list_tools` response (id + the consent
/// class the TS host should apply to its tools). The built-in exfer server is
/// reported as `auto` here; its real per-tool policy lives in core EXFER_POLICY,
/// which the host layers on top by server id.
#[derive(serde::Serialize)]
struct ServerMeta {
    id: String,
    #[serde(rename = "defaultConsent")]
    default_consent: String,
}

/// Merge the tools of every enabled server (built-in exfer + user servers) into
/// one list. Raw tool names; each entry tagged with its owning `server` id. On a
/// name collision the exfer server wins and the duplicate is dropped + warned.
/// Returns `{ tools, servers }` (servers carries each server's defaultConsent).
#[tauri::command]
pub async fn mcp_list_tools(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
) -> Result<Value, String> {
    let conn = conn_of(&app).await?;
    ensure_exfer(&mcp, external_env(&conn)).await?;

    let datadir = app.inner.lock().await.datadir.clone();
    let registry = load_registry(&datadir);

    // Connect each enabled user server lazily; a failure is logged + skipped so
    // one broken server doesn't break the agent.
    let mut server_meta: Vec<ServerMeta> = vec![ServerMeta {
        id: EXFER_SERVER_ID.to_string(),
        default_consent: "auto".into(),
    }];
    for cfg in registry.iter().filter(|c| c.enabled) {
        if let Err(e) = ensure_user_server(&mcp, cfg).await {
            tracing::warn!(server = %cfg.id, error = %e, "skipping MCP server that failed to connect");
            continue;
        }
        server_meta.push(ServerMeta {
            id: cfg.id.clone(),
            default_consent: cfg.default_consent.clone(),
        });
    }

    // Gather tools per connected+enabled server. Order matters for collisions:
    // exfer first so it wins.
    let mut order: Vec<String> = vec![EXFER_SERVER_ID.to_string()];
    order.extend(server_meta.iter().map(|m| m.id.clone()).filter(|id| id != EXFER_SERVER_ID));

    let mut merged: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let guard = mcp.inner.lock().await;
        for server_id in &order {
            let Some(client) = guard.get(server_id) else {
                continue;
            };
            let tools = client
                .list_all_tools()
                .await
                .map_err(|e| format!("list_tools {server_id}: {e}"))?;
            for t in tools {
                let name = t.name.to_string();
                if !seen.insert(name.clone()) {
                    tracing::warn!(
                        tool = %name,
                        server = %server_id,
                        "duplicate tool name; exfer server wins, dropping this one"
                    );
                    continue;
                }
                merged.push(json!({
                    "name": name,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                    "server": server_id,
                }));
            }
        }
    }

    let servers_json = serde_json::to_value(&server_meta).map_err(|e| e.to_string())?;
    Ok(json!({ "tools": merged, "servers": servers_json }))
}

/// Build the name -> serverId routing map across the built-in exfer server and
/// every enabled user server, honoring the same collision rule (exfer wins).
async fn route_map(app: &AppCtx, mcp: &McpCtx) -> HashMap<String, String> {
    let datadir = app.inner.lock().await.datadir.clone();
    let registry = load_registry(&datadir);
    let mut order: Vec<String> = vec![EXFER_SERVER_ID.to_string()];
    order.extend(registry.iter().filter(|c| c.enabled).map(|c| c.id.clone()));

    let mut map: HashMap<String, String> = HashMap::new();
    let guard = mcp.inner.lock().await;
    for server_id in &order {
        let Some(client) = guard.get(server_id) else {
            continue;
        };
        if let Ok(tools) = client.list_all_tools().await {
            for t in tools {
                map.entry(t.name.to_string())
                    .or_insert_with(|| server_id.clone());
            }
        }
    }
    map
}

#[tauri::command]
pub async fn mcp_call_tool(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    let conn = conn_of(&app).await?;
    ensure_exfer(&mcp, external_env(&conn)).await?;

    // Make sure enabled user servers are connected so their tools are routable.
    let datadir = app.inner.lock().await.datadir.clone();
    for cfg in load_registry(&datadir).iter().filter(|c| c.enabled) {
        if let Err(e) = ensure_user_server(&mcp, cfg).await {
            tracing::warn!(server = %cfg.id, error = %e, "user MCP server unavailable for call");
        }
    }

    let server_id = route_map(&app, &mcp)
        .await
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("no server provides tool {name}"))?;

    let arguments = args.as_object().cloned();
    let guard = mcp.inner.lock().await;
    let client = guard
        .get(&server_id)
        .ok_or_else(|| format!("server {server_id} not connected"))?;
    let res = client
        .call_tool(CallToolRequestParams {
            name: name.clone().into(),
            arguments,
            meta: None,
            task: None,
        })
        .await
        .map_err(|e| format!("call_tool {name}: {e}"))?;
    serde_json::to_value(res).map_err(|e| e.to_string())
}
