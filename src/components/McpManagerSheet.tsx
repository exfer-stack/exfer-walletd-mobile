import { useEffect, useState } from "react";
import { useT, type MsgKey } from "../lib/i18n";
import { Sheet, Field } from "./ui";
import { Icon } from "../lib/icons";
import {
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpSetEnabled,
  type McpServerConfig,
} from "../lib/mcpRegistry";

// MCP / skill manager (mobile) as a bottom sheet. Lists the built-in exfer
// server (read-only, always on) plus any user-added servers, with add / remove /
// enable. Config round-trips through the Rust `mcp_registry` commands (persisted
// to `<datadir>/mcp-servers.json`), which is the SAME file the native tool router
// reads — so an added tool is live in chat immediately, no on-device MCP host
// required. New servers are remote-only `httptool` URLs (one endpoint that speaks
// `{op:list|call}`); the old uvx/stdio path is gone.

type T = ReturnType<typeof useT>["t"];

// Curated one-tap catalog. A plain data array so presets can be added later; each
// row maps to an httptool McpServerConfig the registry + native router understand
// (labelKey/subKey are i18n keys so the catalog stays localized).
//
// The former websearch/time/coinprice/explorer presets were removed: web search,
// time, coin price and the block explorer are now FIRST-PARTY capability tools
// baked into the app (via exfer-agent's capability layer), so there's nothing to
// "add". The Add form below still takes real third-party httptool URLs.
interface CatalogEntry {
  id: string;
  labelKey: MsgKey;
  subKey: MsgKey;
  url: string;
  defaultConsent: "auto" | "gated";
}

const RECOMMENDED_CATALOG: CatalogEntry[] = [];

export function McpManagerSheet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  // Registry mirror, loaded from (and re-read after every mutation on) the Rust
  // side so the list and the add form stay in sync without a global store.
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    mcpListServers()
      .then(setServers)
      .catch(() => setServers([]));

  useEffect(() => {
    void refresh();
  }, []);

  // Already-added ids, so a catalog row disappears once added instead of letting
  // the user stack a duplicate.
  const addedIds = new Set(servers.map((s) => s.id));
  const catalog = RECOMMENDED_CATALOG.filter((c) => !addedIds.has(c.id));

  // One-tap add: build an httptool McpServerConfig from the catalog entry and
  // persist it via the same registry path the manual add form uses.
  const addFromCatalog = async (c: CatalogEntry) => {
    if (busy || addedIds.has(c.id)) return;
    setBusy(true);
    try {
      const cfg: McpServerConfig = {
        id: c.id,
        label: t(c.labelKey),
        transport: "httptool",
        url: c.url,
        enabled: true,
        defaultConsent: c.defaultConsent,
      };
      await mcpAddServer(cfg);
      await refresh();
    } catch {
      /* best-effort; a failed add just leaves the row available to retry */
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    try {
      await mcpSetEnabled(id, enabled);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string) => {
    setBusy(true);
    try {
      await mcpRemoveServer(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (adding) {
    return (
      <McpAddSheet
        t={t}
        onClose={(saved) => {
          setAdding(false);
          if (saved) void refresh();
        }}
      />
    );
  }

  // Add is now live: httptool tools run through the native router immediately.
  const footer = (
    <button type="button" className="btn btn-block" onClick={() => setAdding(true)} data-testid="mcp-add-open">
      {t("mcp.add")}
    </button>
  );

  return (
    <Sheet title={t("mcp.title")} subtitle={t("mcp.subtitle")} onClose={onClose} footer={footer}>
      <div data-testid="mcp-manager" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <p className="dim" style={{ fontSize: 13.5, lineHeight: 1.5, margin: "0 2px" }}>{t("mcp.builtinNote")}</p>

        {/* Built-in exfer server — always on, not removable. */}
        <div className="card card-2" style={{ padding: "12px" }} data-testid="mcp-builtin">
          <div className="h-row" style={{ gap: "10px", alignItems: "center" }}>
            <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10, background: "var(--surface-2)", color: "var(--accent)", flex: "0 0 auto" }}>
              <Icon name="node" size={18} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t("mcp.builtin.label")}</div>
              <div className="faint" style={{ fontSize: 12.5 }}>{t("mcp.builtin.sub")}</div>
            </div>
            <span className="pill pill-success" style={{ fontSize: "0.72rem" }}>{t("mcp.builtin.badge")}</span>
          </div>
        </div>

        {/* Recommended catalog: curated one-tap presets. Hidden rows are the
            ones already added (so no duplicates). The whole section disappears
            once everything is added. */}
        {catalog.length > 0 && (
          <div data-testid="mcp-recommended" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ marginTop: "2px" }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t("mcp.recommended")}</div>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 1 }}>{t("mcp.recommended.note")}</div>
            </div>
            {catalog.map((c) => (
              <div key={c.id} className="card card-2" style={{ padding: "12px" }} data-testid="mcp-catalog-row">
                <div className="h-row" style={{ gap: "10px", alignItems: "center" }}>
                  <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10, background: "var(--surface-2)", color: "var(--accent)", flex: "0 0 auto" }}>
                    <Icon name="globe" size={18} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(c.labelKey)}</div>
                    <div className="faint" style={{ fontSize: 12.5 }}>{t(c.subKey)}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ flex: "0 0 auto" }}
                    disabled={busy}
                    onClick={() => void addFromCatalog(c)}
                    data-testid="mcp-catalog-add"
                  >
                    <span className="h-row" style={{ gap: "4px", alignItems: "center" }}>
                      <Icon name="plus" size={14} />
                      {t("mcp.recommended.add")}
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Advanced disclosure: user-added servers. */}
        <button
          type="button"
          className="btn-ghost btn-sm"
          style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: "5px" }}
          onClick={() => setShowAdvanced((v) => !v)}
          data-testid="mcp-advanced-toggle"
        >
          <Icon name={showAdvanced ? "chevron-down" : "chevron"} size={15} />
          {t("mcp.advanced")}
        </button>

        {showAdvanced && (servers.length === 0 ? (
          <p className="dim" style={{ fontSize: 13.5, textAlign: "center", padding: "8px 0" }}>{t("mcp.empty")}</p>
        ) : (
          servers.map((s) => (
            <div key={s.id} className="card card-2" style={{ padding: "12px" }} data-testid="mcp-server">
              <div className="h-row" style={{ gap: "10px", alignItems: "flex-start" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</div>
                  <div className="faint mono" style={{ fontSize: 12, wordBreak: "break-all", marginTop: 2 }}>
                    {s.url ?? [s.command, ...(s.args ?? [])].join(" ")}
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>
                    {t(`mcp.consent.${s.defaultConsent}` as MsgKey)}
                  </div>
                </div>
                <div className="h-row" style={{ gap: "4px", alignItems: "center", flex: "0 0 auto" }}>
                  {/* Toggle as a labelled button — no native switch in the kit. */}
                  <button
                    type="button"
                    className={s.enabled ? "pill pill-accent" : "pill"}
                    style={{ cursor: "pointer", fontSize: "0.72rem", padding: "4px 9px" }}
                    disabled={busy}
                    onClick={() => void onToggle(s.id, !s.enabled)}
                    data-testid="mcp-toggle"
                  >
                    {s.enabled ? t("mcp.enabled") : t("mcp.disabled")}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("mcp.remove")}
                    disabled={busy}
                    onClick={() => void onRemove(s.id)}
                    data-testid="mcp-remove"
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </div>
            </div>
          ))
        ))}

        {showAdvanced && (
          <p className="faint" style={{ fontSize: 12, lineHeight: 1.5, marginTop: "2px" }}>{t("mcp.deferredNote")}</p>
        )}
      </div>
    </Sheet>
  );
}

// Add-server form. New servers are remote httptool URLs: one endpoint that
// answers `{op:list}` / `{op:call}`. Collect a name + url; the native router
// picks the tools up on the next list.
function McpAddSheet({ t, onClose }: { t: T; onClose: (saved: boolean) => void }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [defaultConsent, setDefaultConsent] = useState<"auto" | "gated">("gated");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = label.trim().length > 0 && url.trim().length > 0;

  const onSave = async () => {
    if (!valid || busy) return;
    const id = `${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${Date.now().toString(36)}`;
    const cfg: McpServerConfig = {
      id,
      label: label.trim(),
      transport: "httptool",
      url: url.trim(),
      enabled: true,
      defaultConsent,
    };
    setBusy(true);
    setError(null);
    try {
      await mcpAddServer(cfg);
      onClose(true);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const footer = (
    <div className="h-row" style={{ gap: "10px" }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => onClose(false)}>{t("mcp.cancel")}</button>
      <button type="button" className="btn btn-block" disabled={!valid || busy} onClick={() => void onSave()} data-testid="mcp-add-save">{t("mcp.save")}</button>
    </div>
  );

  return (
    <Sheet title={t("mcp.add")} onBack={() => onClose(false)} onClose={() => onClose(false)} footer={footer}>
      <div data-testid="mcp-add-form" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <Field label={t("mcp.field.label")}>
          <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("mcp.field.labelPh")} data-testid="mcp-label" />
        </Field>
        <Field label={t("mcp.field.url")} help={t("mcp.field.urlHelp")}>
          <input className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tools.exfer.dev/…" data-testid="mcp-url" />
        </Field>
        <Field label={t("mcp.field.consent")} help={t("mcp.field.consentHelp")}>
          <select className="field" value={defaultConsent} onChange={(e) => setDefaultConsent(e.target.value as "auto" | "gated")} data-testid="mcp-consent">
            <option value="gated">{t("mcp.consent.gated")}</option>
            <option value="auto">{t("mcp.consent.auto")}</option>
          </select>
        </Field>
        {error && (
          <p role="alert" className="text-red" style={{ fontSize: 12.5 }} data-testid="mcp-add-error">{error}</p>
        )}
      </div>
    </Sheet>
  );
}
