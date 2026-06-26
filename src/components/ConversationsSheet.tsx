import { useState } from "react";
import { useT, relativeTime, type Lang } from "../lib/i18n";
import { Sheet, Field } from "./ui";
import { Icon } from "../lib/icons";
import { list, rename, remove, type Conversation } from "../lib/conversationStore";

// Conversation history (mobile) as a bottom sheet. Mirrors McpManagerSheet: each
// row is a title + relative updatedAt, tap to switch, a trailing ⋯ for
// rename/delete. Switching is blocked while a turn is busy (the parent gates it
// too, but we disable the rows so it reads clearly).

type T = ReturnType<typeof useT>["t"];

export function ConversationsSheet({
  lang,
  activeId,
  busy,
  onClose,
  onSwitch,
  onNew,
}: {
  lang: Lang;
  activeId: string;
  busy: boolean;
  onClose: () => void;
  onSwitch: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useT();
  const [items, setItems] = useState<Conversation[]>(() => list());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const refresh = () => setItems(list());

  if (renaming) {
    return (
      <RenameSheet
        t={t}
        conv={renaming}
        onClose={(saved) => {
          setRenaming(null);
          if (saved) refresh();
        }}
      />
    );
  }

  const footer = (
    <button type="button" className="btn btn-block" onClick={onNew} disabled={busy} data-testid="convs-new">
      {t("agent.conv.new")}
    </button>
  );

  return (
    <Sheet title={t("agent.conv.title")} onClose={onClose} footer={footer}>
      <div data-testid="convs-list" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {items.length === 0 ? (
          <p className="dim" style={{ fontSize: 13.5, textAlign: "center", padding: "8px 0" }}>{t("agent.conv.empty")}</p>
        ) : (
          items.map((c) => (
            <div key={c.id} className="agent-card" style={{ padding: "11px 12px" }} data-testid="convs-row">
              <div className="h-row" style={{ gap: "10px", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => onSwitch(c.id)}
                  disabled={busy}
                  style={{ minWidth: 0, flex: 1, textAlign: "left", background: "none", border: 0, padding: 0, color: "inherit", cursor: busy ? "not-allowed" : "pointer" }}
                  data-testid="convs-switch"
                >
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: c.id === activeId ? "var(--accent)" : "var(--text)" }}>
                    {c.title || t("agent.conv.untitled")}
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{relativeTime(c.updatedAt, lang)}</div>
                </button>
                <button type="button" className="icon-btn" aria-label={t("agent.conv.rename")} onClick={() => setMenuFor(menuFor === c.id ? null : c.id)} data-testid="convs-menu">
                  <Icon name="more" size={18} />
                </button>
              </div>
              {menuFor === c.id && (
                <div className="h-row" style={{ gap: "8px", marginTop: "8px", justifyContent: "flex-end" }}>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => { setMenuFor(null); setRenaming(c); }} data-testid="convs-rename">
                    {t("agent.conv.rename")}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    style={{ color: "#f87171" }}
                    onClick={() => {
                      remove(c.id);
                      setMenuFor(null);
                      // Deleting the active conversation: let the parent re-bind by
                      // switching to whatever is now most-recent (or a fresh chat).
                      if (c.id === activeId) {
                        const next = list()[0];
                        if (next) onSwitch(next.id);
                        else onNew();
                      } else {
                        refresh();
                      }
                    }}
                    data-testid="convs-delete"
                  >
                    {t("agent.conv.delete")}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}

function RenameSheet({ t, conv, onClose }: { t: T; conv: Conversation; onClose: (saved: boolean) => void }) {
  const [name, setName] = useState(conv.title);
  const footer = (
    <div className="h-row" style={{ gap: "10px" }}>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => onClose(false)}>{t("agent.conv.cancel")}</button>
      <button
        type="button"
        className="btn btn-block"
        onClick={() => {
          rename(conv.id, name);
          onClose(true);
        }}
        data-testid="convs-rename-save"
      >
        {t("agent.conv.save")}
      </button>
    </div>
  );
  return (
    <Sheet title={t("agent.conv.renameTitle")} onBack={() => onClose(false)} onClose={() => onClose(false)} footer={footer}>
      <Field label={t("agent.conv.renameTitle")}>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("agent.conv.namePh")} data-testid="convs-rename-input" autoFocus />
      </Field>
    </Sheet>
  );
}
