import { useState } from "react";
import { useT, type MsgKey } from "../lib/i18n";
import { Sheet, Field } from "./ui";
import { Icon } from "../lib/icons";
import { listServers, addServer, removeServer, setEnabled, type McpServerConfig } from "../lib/mcpRegistry";

// MCP / skill manager (mobile) as a bottom sheet. Lists the built-in exfer
// server (read-only, always on) plus any user-added servers, with add / remove /
// enable. Config is persisted to localStorage via mcpRegistry — the same
// McpServerConfig shape the desktop Rust host uses, so these entries plug into a
// native multi-MCP host when mobile Rust lands. Execution of user servers is
// deferred (no on-device MCP host yet); this is the config surface.

type T = ReturnType<typeof useT>["t"];

export function McpManagerSheet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  // Local mirror of the registry; re-read after every mutation so the list and
  // the add form stay in sync without a global store.
  const [servers, setServers] = useState<McpServerConfig[]>(() => listServers());
  const [adding, setAdding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const refresh = () => setServers(listServers());

  if (adding) {
    return (
      <McpAddSheet
        t={t}
        onClose={(saved) => {
          setAdding(false);
          if (saved) refresh();
        }}
      />
    );
  }

  // Add-server is disabled up front: there's no on-device MCP host yet, so the
  // form would only persist config that can't run. Lead with "built-in already
  // works"; tuck the form behind Advanced.
  const footer = (
    <button type="button" className="btn btn-block" disabled aria-disabled="true" title={t("mcp.deferredNote")} data-testid="mcp-add-open">
      {t("mcp.addDisabled")}
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

        {/* Advanced disclosure: user-added servers (config-only until native host). */}
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
                    {s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ")}
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
                    onClick={() => {
                      setEnabled(s.id, !s.enabled);
                      refresh();
                    }}
                    data-testid="mcp-toggle"
                  >
                    {s.enabled ? t("mcp.enabled") : t("mcp.disabled")}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("mcp.remove")}
                    onClick={() => {
                      removeServer(s.id);
                      refresh();
                    }}
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
          <>
            <button type="button" className="btn btn-secondary btn-block" onClick={() => setAdding(true)} data-testid="mcp-add-advanced">
              {t("mcp.add")}
            </button>
            <p className="faint" style={{ fontSize: 12, lineHeight: 1.5, marginTop: "2px" }}>{t("mcp.deferredNote")}</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

// Add-server form. Mirrors the McpServerConfig fields; transport switches between
// a stdio command line and an http url.
function McpAddSheet({ t, onClose }: { t: T; onClose: (saved: boolean) => void }) {
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [argsLine, setArgsLine] = useState("");
  const [url, setUrl] = useState("");
  const [defaultConsent, setDefaultConsent] = useState<"auto" | "gated">("gated");

  const valid = label.trim().length > 0 && (transport === "http" ? url.trim().length > 0 : command.trim().length > 0);

  const onSave = () => {
    if (!valid) return;
    const id = `${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${Date.now().toString(36)}`;
    const cfg: McpServerConfig = {
      id,
      label: label.trim(),
      transport,
      enabled: true,
      defaultConsent,
      ...(transport === "http"
        ? { url: url.trim() }
        : { command: command.trim(), args: argsLine.trim() ? argsLine.trim().split(/\s+/) : [] }),
    };
    addServer(cfg);
    onClose(true);
  };

  const footer = (
    <div className="h-row" style={{ gap: "10px" }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => onClose(false)}>{t("mcp.cancel")}</button>
      <button type="button" className="btn btn-block" disabled={!valid} onClick={onSave} data-testid="mcp-add-save">{t("mcp.save")}</button>
    </div>
  );

  return (
    <Sheet title={t("mcp.add")} onBack={() => onClose(false)} onClose={() => onClose(false)} footer={footer}>
      <div data-testid="mcp-add-form" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <Field label={t("mcp.field.label")}>
          <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("mcp.field.labelPh")} data-testid="mcp-label" />
        </Field>
        <Field label={t("mcp.field.transport")}>
          <select className="field" value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")} data-testid="mcp-transport">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </Field>
        {transport === "http" ? (
          <Field label={t("mcp.field.url")}>
            <input className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" data-testid="mcp-url" />
          </Field>
        ) : (
          <>
            <Field label={t("mcp.field.command")}>
              <input className="field mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" data-testid="mcp-command" />
            </Field>
            <Field label={t("mcp.field.args")} help={t("mcp.field.argsHelp")}>
              <input className="field mono" value={argsLine} onChange={(e) => setArgsLine(e.target.value)} placeholder="-y some-mcp-server" data-testid="mcp-args" />
            </Field>
          </>
        )}
        <Field label={t("mcp.field.consent")} help={t("mcp.field.consentHelp")}>
          <select className="field" value={defaultConsent} onChange={(e) => setDefaultConsent(e.target.value as "auto" | "gated")} data-testid="mcp-consent">
            <option value="gated">{t("mcp.consent.gated")}</option>
            <option value="auto">{t("mcp.consent.auto")}</option>
          </select>
        </Field>
      </div>
    </Sheet>
  );
}
