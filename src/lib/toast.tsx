import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icons";

export type ToastKind = "success" | "error" | "info" | "incoming";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastApi {
  push: (t: Omit<Toast, "id">, ttlMs?: number) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  incoming: (title: string, message?: string) => void;
}

// The api surface consumers use (wallet.tsx imports `useToast`).
const ToastCtx = createContext<ToastApi | null>(null);

// A separate channel that exposes the live toast list + dismiss to the host
// component. Kept internal so the public `useToast()` API is unchanged.
interface ToastHostData {
  toasts: Toast[];
  remove: (id: number) => void;
}
const ToastHostCtx = createContext<ToastHostData | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const DEFAULT_TTL = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">, ttlMs: number = DEFAULT_TTL) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { ...t, id }]);
      // incoming deposits linger a touch longer
      const ttl = t.kind === "incoming" ? Math.max(ttlMs, 7000) : ttlMs;
      window.setTimeout(() => remove(id), ttl);
    },
    [remove],
  );

  const api: ToastApi = {
    push,
    success: (title, message) => push({ kind: "success", title, message }),
    error: (title, message) => push({ kind: "error", title, message }, 8000),
    info: (title, message) => push({ kind: "info", title, message }),
    incoming: (title, message) => push({ kind: "incoming", title, message }),
  };

  return (
    <ToastCtx.Provider value={api}>
      <ToastHostCtx.Provider value={{ toasts, remove }}>
        {children}
      </ToastHostCtx.Provider>
    </ToastCtx.Provider>
  );
}

interface ToastStyle {
  ico: string;
  bg: string;
  color: string;
}

const KIND_STYLE: Record<ToastKind, ToastStyle> = {
  success: {
    ico: "✓",
    bg: "color-mix(in srgb,#34d399 18%,transparent)",
    color: "#34d399",
  },
  error: {
    ico: "!",
    bg: "color-mix(in srgb,#f87171 18%,transparent)",
    color: "#f87171",
  },
  info: {
    ico: "i",
    bg: "color-mix(in srgb,var(--accent) 18%,transparent)",
    color: "var(--accent)",
  },
  incoming: {
    ico: "↓",
    bg: "color-mix(in srgb,#34d399 18%,transparent)",
    color: "#34d399",
  },
};

/** The mobile toast host. Renders inside `.phone` so its absolute position
 *  anchors to the device frame (matches the prototype's `.toast-host`). */
export function ToastHost() {
  const ctx = useContext(ToastHostCtx);
  if (!ctx) return null;
  const { toasts, remove } = ctx;
  return (
    <div className="toast-host">
      {toasts.map((t) => {
        const s = KIND_STYLE[t.kind];
        return (
          <div
            key={t.id}
            className="toast"
            role="status"
            onClick={() => remove(t.id)}
          >
            <div
              className="toast-ico"
              style={{ background: s.bg, color: s.color }}
              aria-hidden
            >
              {s.ico}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                className="toast-title"
                style={
                  t.kind === "incoming"
                    ? {
                        fontFamily: '"Geist Mono Variable","Geist Mono",monospace',
                        color: "#34d399",
                      }
                    : undefined
                }
              >
                {t.title}
              </div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 26, height: 26, background: "transparent" }}
              onClick={(e) => {
                e.stopPropagation();
                remove(t.id);
              }}
              aria-label="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
