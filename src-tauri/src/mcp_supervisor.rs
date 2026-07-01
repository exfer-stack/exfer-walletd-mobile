//! Multi-server tool supervisor.
//!
//! The built-in `exfer` server is implemented NATIVELY in Rust (see
//! `native_tools`): each tool call is translated in-process into a walletd
//! JSON-RPC call on THIS app's embedded walletd (URL + scope tokens + TLS
//! fingerprint from `ConnectionInfo`). No uvx, no Python, no subprocess — the
//! agent's wallet tools have zero environment dependency (which matters doubly
//! on iOS/Android, where the old `uvx exfer-mcp` sidecar could not run). The
//! `exfer` server is implicit, always enabled, and not user-removable, and the
//! `exfer_` name prefix is RESERVED for it (see [`is_reserved_tool_name`]).
//!
//! On top of that, the user registers extra tools as REMOTE HTTP endpoints —
//! never local processes (the `uvx`/stdio path is gone, so nothing depends on
//! the user's machine having Python/Node):
//!   - `transport = "httptool"` — the BASE wire format. A tool is a single URL
//!     that answers `POST {url}` with `{"op":"list"}` -> `{ tools: [...] }` and
//!     `{"op":"call","name","args"}` -> `{ content, isError }`. Authorable as one
//!     serverless function; no MCP protocol to implement.
//!   - `transport = "http"` — a remote MCP server over streamable-http (rmcp),
//!     kept as an OPTIONAL adapter for the existing hosted-MCP ecosystem.
//!
//! Security (strict): third-party tools are read/compute only. They reach their
//! own endpoint, never walletd; they may not use the reserved `exfer_` prefix;
//! and the native consent gate (money moves) is never delegable to them. A
//! "pay" tool returns a payment request that the native (consent-gated)
//! `exfer_transfer` executes.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use rmcp::{
    model::CallToolRequestParams, service::RoleClient, service::RunningService,
    transport::StreamableHttpClientTransport, ServiceExt,
};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

use crate::mcp_registry::{load_registry, McpServerConfig};
use crate::native_tools;
use crate::rpc_client::ConnectionInfo;
use crate::walletd_supervisor::AppCtx;

/// The reserved id of the built-in wallet server.
pub const EXFER_SERVER_ID: &str = "exfer";

/// The reserved name prefix for the built-in wallet server. A third-party tool
/// may not claim any name under it, so it can never impersonate a wallet tool
/// (anti-spoofing) nor reach native dispatch. Native wallet tools are
/// `exfer_generate_address`, `exfer_transfer`, `exfer_mine_start`, and so on —
/// all `exfer_`. External tools use the `ext__<provider>__<tool>` convention.
pub fn is_reserved_tool_name(name: &str) -> bool {
    name.starts_with("exfer_")
}

/// Managed Tauri state: live rmcp clients for `transport="http"` servers, keyed
/// by server id. `httptool` servers are stateless (one URL, no handshake) and
/// are NOT stored here.
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
    /// server is removed, disabled, or re-added, so the next `tool_list`
    /// reconnects it fresh. A no-op for `httptool` (nothing to drop).
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

// ── remote HTTP tool ("httptool") — the base wire format ──────────────────────

/// The shared HTTPS client for remote tool calls (webpki roots, sane timeout).
fn tool_http_client() -> Result<reqwest::Client, String> {
    crate::public_https_client()
}

/// Read a tool's bearer secret from the secure store (host-side injection — the
/// key never enters the webview or the tool-selection LLM), mirroring
/// `llm_fetch`. `None`/empty `auth_ref` => an unauthenticated (public) tool,
/// which is the Phase-1 default (search, prices, explorers, forums).
///
/// Mobile divergence from desktop: this repo's `secrets::get_passphrase` is
/// `(service, data_dir)` (the secret is a per-install file on Android), so the
/// datadir is threaded down from the command layer.
fn tool_auth(auth_ref: &Option<String>, datadir: &Path) -> Option<String> {
    let r = auth_ref.as_ref()?;
    if r.trim().is_empty() {
        return None;
    }
    crate::secrets::get_passphrase(r, datadir).ok().flatten()
}

/// POST one op to a plain-HTTP tool endpoint, injecting the bearer secret
/// host-side. Returns the parsed JSON body.
async fn httptool_post(
    url: &str,
    auth: &Option<String>,
    datadir: &Path,
    body: Value,
) -> Result<Value, String> {
    let client = tool_http_client()?;
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string());
    if let Some(tok) = tool_auth(auth, datadir) {
        req = req.bearer_auth(tok);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("tool request failed: {e}"))?;
    resp.json::<Value>()
        .await
        .map_err(|e| format!("tool response was not JSON: {e}"))
}

/// List a plain-HTTP tool endpoint's tools. Reserved-prefix (`exfer_`) names are
/// dropped so a remote endpoint can never advertise a wallet-looking tool.
async fn httptool_list(
    url: &str,
    auth: &Option<String>,
    datadir: &Path,
) -> Result<Vec<Value>, String> {
    let v = httptool_post(url, auth, datadir, json!({ "op": "list" })).await?;
    let tools = v
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(tools
        .into_iter()
        .filter(|t| {
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.is_empty() {
                return false;
            }
            if is_reserved_tool_name(name) {
                tracing::warn!(tool = %name, %url, "dropping remote tool using the reserved exfer_ prefix");
                return false;
            }
            true
        })
        .collect())
}

/// Call a plain-HTTP tool. The endpoint returns the same `{content,isError}`
/// envelope `tool_call` yields, so the TS host handles it unchanged.
async fn httptool_call(
    url: &str,
    auth: &Option<String>,
    datadir: &Path,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    httptool_post(
        url,
        auth,
        datadir,
        json!({ "op": "call", "name": name, "args": args }),
    )
    .await
}

// ── remote MCP over streamable-http (optional ecosystem adapter) ──────────────

/// Connect + MCP-handshake a streamable-http server.
async fn connect_http(url: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_uri(url);
    ().serve(transport)
        .await
        .map_err(|e| format!("mcp http handshake failed: {e}"))
}

/// Ensure an `http` (MCP) user server is connected. `httptool` is stateless (no
/// persistent connection). `stdio` is refused: local-process/uvx tools are gone,
/// so nothing can depend on the user's machine having a toolchain.
async fn ensure_user_server(mcp: &McpCtx, cfg: &McpServerConfig) -> Result<(), String> {
    match cfg.transport.as_str() {
        "httptool" => Ok(()),
        "http" => {
            {
                let guard = mcp.inner.lock().await;
                if guard.contains_key(&cfg.id) {
                    return Ok(());
                }
            }
            let url = cfg
                .url
                .as_ref()
                .filter(|u| !u.trim().is_empty())
                .ok_or("http server is missing a url")?;
            let client = connect_http(url).await?;
            mcp.inner
                .lock()
                .await
                .entry(cfg.id.clone())
                .or_insert(client);
            Ok(())
        }
        "stdio" => {
            Err("stdio/uvx tools are no longer supported — add an HTTP tool URL instead".into())
        }
        other => Err(format!("unknown transport \"{other}\"")),
    }
}

/// Read the embedded walletd connection (url + tokens + fingerprint).
async fn conn_of(app: &AppCtx) -> Result<Arc<ConnectionInfo>, String> {
    let inner = app.inner.lock().await;
    inner
        .conn
        .clone()
        .ok_or_else(|| "walletd not ready".to_string())
}

/// Read the cached fingerprint-pinned reqwest client (loopback to walletd).
async fn client_of(app: &AppCtx) -> Result<reqwest::Client, String> {
    let inner = app.inner.lock().await;
    inner
        .client
        .clone()
        .ok_or_else(|| "walletd not ready".to_string())
}

/// Back-compat with the Agent page's pre-warm call. The built-in `exfer` server
/// is native + stateless, so there is nothing to spawn — a no-op.
#[tauri::command]
pub async fn mcp_start(_app: State<'_, AppCtx>, _mcp: State<'_, McpCtx>) -> Result<(), String> {
    Ok(())
}

/// One server's metadata in the `tool_list` response (id + the consent
/// class the TS host applies to its tools). The built-in exfer server reports
/// `auto`; its real per-tool policy lives in core EXFER_POLICY.
#[derive(serde::Serialize)]
struct ServerMeta {
    id: String,
    #[serde(rename = "defaultConsent")]
    default_consent: String,
}

/// Merge the tools of every enabled server (built-in exfer + remote user tools)
/// into one list. Each entry is tagged with its owning `server` id. The built-in
/// exfer tools are added FIRST and win any name collision; any remote tool using
/// the reserved `exfer_` prefix is dropped. Returns `{ tools, servers }`.
#[tauri::command]
pub async fn tool_list(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
) -> Result<Value, String> {
    let mut merged: Vec<Value> = native_tools::list();
    let mut seen: HashSet<String> = merged
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect();

    let mut server_meta: Vec<ServerMeta> = vec![ServerMeta {
        id: EXFER_SERVER_ID.to_string(),
        default_consent: "auto".into(),
    }];

    let datadir = app.inner.lock().await.datadir.clone();
    let registry = load_registry(&datadir);

    // `httptool` servers are listed inline (stateless HTTP). `http` (MCP) servers
    // are connected here, then their tools are read from the live clients below.
    let mut http_order: Vec<String> = Vec::new();
    for cfg in registry.iter().filter(|c| c.enabled) {
        match cfg.transport.as_str() {
            "httptool" => {
                let Some(url) = cfg.url.as_deref().filter(|u| !u.trim().is_empty()) else {
                    tracing::warn!(server = %cfg.id, "httptool server is missing a url; skipping");
                    continue;
                };
                match httptool_list(url, &cfg.auth_ref, &datadir).await {
                    Ok(tools) => {
                        for t in tools {
                            let name = match t.get("name").and_then(|n| n.as_str()) {
                                Some(n) => n.to_string(),
                                None => continue,
                            };
                            if !seen.insert(name.clone()) {
                                tracing::warn!(tool = %name, server = %cfg.id, "duplicate tool name; dropping");
                                continue;
                            }
                            let schema = t
                                .get("parameters")
                                .or_else(|| t.get("inputSchema"))
                                .cloned()
                                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                            merged.push(json!({
                                "name": name,
                                "description": t.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                                "inputSchema": schema,
                                "server": cfg.id,
                            }));
                        }
                        server_meta.push(ServerMeta {
                            id: cfg.id.clone(),
                            default_consent: cfg.default_consent.clone(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!(server = %cfg.id, error = %e, "skipping httptool server that failed to list");
                    }
                }
            }
            "http" => {
                if let Err(e) = ensure_user_server(&mcp, cfg).await {
                    tracing::warn!(server = %cfg.id, error = %e, "skipping MCP server that failed to connect");
                    continue;
                }
                server_meta.push(ServerMeta {
                    id: cfg.id.clone(),
                    default_consent: cfg.default_consent.clone(),
                });
                http_order.push(cfg.id.clone());
            }
            other => {
                tracing::warn!(server = %cfg.id, transport = %other, "skipping unsupported transport (stdio/uvx removed)");
            }
        }
    }

    // Read tools from each connected rmcp (http) server, dropping reserved-prefix
    // names and any that collide with an earlier tool.
    {
        let guard = mcp.inner.lock().await;
        for server_id in &http_order {
            let Some(client) = guard.get(server_id) else {
                continue;
            };
            let tools = client
                .list_all_tools()
                .await
                .map_err(|e| format!("list_tools {server_id}: {e}"))?;
            for t in tools {
                let name = t.name.to_string();
                if is_reserved_tool_name(&name) {
                    tracing::warn!(tool = %name, server = %server_id, "dropping MCP tool using the reserved exfer_ prefix");
                    continue;
                }
                if !seen.insert(name.clone()) {
                    tracing::warn!(tool = %name, server = %server_id, "duplicate tool name; exfer server wins, dropping this one");
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

/// Build the name -> serverId routing map across every enabled remote server
/// (`httptool` + `http`). Native `exfer_*` tools are NOT in this map — they are
/// dispatched natively before routing is consulted.
async fn route_map(app: &AppCtx, mcp: &McpCtx) -> HashMap<String, String> {
    let datadir = app.inner.lock().await.datadir.clone();
    let registry = load_registry(&datadir);
    let mut map: HashMap<String, String> = HashMap::new();

    // httptool: fetch /list (stateless). First writer wins.
    for cfg in registry
        .iter()
        .filter(|c| c.enabled && c.transport == "httptool")
    {
        if let Some(url) = cfg.url.as_deref().filter(|u| !u.trim().is_empty()) {
            if let Ok(tools) = httptool_list(url, &cfg.auth_ref, &datadir).await {
                for t in tools {
                    if let Some(name) = t.get("name").and_then(|n| n.as_str()) {
                        map.entry(name.to_string())
                            .or_insert_with(|| cfg.id.clone());
                    }
                }
            }
        }
    }

    // http (rmcp): from the connected clients.
    let guard = mcp.inner.lock().await;
    for cfg in registry
        .iter()
        .filter(|c| c.enabled && c.transport == "http")
    {
        if let Some(client) = guard.get(&cfg.id) {
            if let Ok(tools) = client.list_all_tools().await {
                for t in tools {
                    map.entry(t.name.to_string())
                        .or_insert_with(|| cfg.id.clone());
                }
            }
        }
    }
    map
}

#[tauri::command]
pub async fn tool_call(
    app: State<'_, AppCtx>,
    mcp: State<'_, McpCtx>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    // 1. Built-in exfer tools are native: dispatch in-process against the
    //    embedded walletd. native_tools::call always returns the MCP envelope.
    if native_tools::is_native(&name) {
        let conn = conn_of(&app).await?;
        let client = client_of(&app).await?;
        return Ok(native_tools::call(&name, args, &conn, &client).await);
    }

    // 2. Belt-and-suspenders: a non-native `exfer_` name must never route to a
    //    remote source. `tool_list` already drops such names, so the model
    //    should never call one — refuse loudly if it somehow does.
    if is_reserved_tool_name(&name) {
        return Err(format!(
            "\"{name}\" uses the reserved exfer_ prefix but is not a built-in wallet tool"
        ));
    }

    // 3. Remote tool. Connect any enabled http (MCP) servers so routing sees them.
    let datadir = app.inner.lock().await.datadir.clone();
    let registry = load_registry(&datadir);
    for cfg in registry
        .iter()
        .filter(|c| c.enabled && c.transport == "http")
    {
        if let Err(e) = ensure_user_server(&mcp, cfg).await {
            tracing::warn!(server = %cfg.id, error = %e, "user MCP server unavailable for call");
        }
    }

    let server_id = route_map(&app, &mcp)
        .await
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("no server provides tool {name}"))?;

    let cfg = registry
        .iter()
        .find(|c| c.id == server_id)
        .ok_or_else(|| format!("server {server_id} not registered"))?;

    match cfg.transport.as_str() {
        "httptool" => {
            let url = cfg
                .url
                .as_deref()
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| format!("httptool server {server_id} is missing a url"))?;
            httptool_call(url, &cfg.auth_ref, &datadir, &name, args).await
        }
        "http" => {
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
        other => Err(format!(
            "server {server_id} has unsupported transport \"{other}\""
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_the_exfer_prefix_for_native_wallet_tools() {
        assert!(is_reserved_tool_name("exfer_transfer"));
        assert!(is_reserved_tool_name("exfer_mine_start"));
        assert!(is_reserved_tool_name("exfer_generate_address"));
    }

    #[test]
    fn does_not_reserve_third_party_or_capability_names() {
        assert!(!is_reserved_tool_name("ext__acme__search"));
        assert!(!is_reserved_tool_name("web_fetch"));
        assert!(!is_reserved_tool_name("web_search"));
        assert!(!is_reserved_tool_name("time"));
        // a name that only starts with "exfer" (no underscore) is NOT reserved —
        // every native wallet tool is `exfer_...`.
        assert!(!is_reserved_tool_name("exfercoin_price"));
    }
}
