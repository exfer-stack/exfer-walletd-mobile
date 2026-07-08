import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Read the LLM API key for the browser-real verification path WITHOUT ever
// shipping it to the browser. The /llm proxy injects it as an Authorization
// header server-side (in the vite dev process), so the webview only ever sees a
// same-origin /llm URL with a placeholder key. The key comes from the env that
// launches vite: DEEPSEEK_API_KEY directly, or a dotenv-style file pointed at by
// LLM_KEY_FILE. No path is hardcoded — the key never lands in import.meta.env.
function readDeepseekKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const keyFile = process.env.LLM_KEY_FILE;
  if (keyFile) {
    try {
      const raw = readFileSync(keyFile, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, "").trim();
      }
    } catch {
      /* key file absent — browser-real LLM path just won't authenticate */
    }
  }
  return "";
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Browser-real path only: a dynamic server-side fetch proxy. The first-party
// capability tools (crypto_* discovery, web_fetch/web_search) read the open web,
// which the browser blocks cross-origin (CORS). On a real phone the Rust
// `fetch_url` command forwards these server-side; in the browser preview there is
// no such host, so without this the whole research surface goes dark on CORS.
// This middleware is the browser-preview equivalent of `fetch_url`: POST
// {url, method, body, headers} → it fetches server-side (in the vite process, no
// CORS) and returns {status, body}. Dev-only; a shipped Tauri build never uses it.
function webfetchPlugin() {
  return {
    name: "exfer-webfetch-proxy",
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/webfetch" || req.method !== "POST") return next();
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          try {
            const { url, method, body, headers } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            const r = await fetch(String(url), {
              method: method ?? "GET",
              body: body ?? undefined,
              headers: headers ?? undefined,
              signal: AbortSignal.timeout(25000),
            });
            const text = await r.text();
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ status: r.status, body: text }));
          } catch (e) {
            res.statusCode = 200; // return a soft status so the tool sees a 0/empty, not a proxy 500
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ status: 0, body: `webfetch error: ${e instanceof Error ? e.message : String(e)}` }));
          }
        });
      });
    },
  };
}

// App version, baked in at build time from package.json so the update checker
// can compare it against the latest GitHub release. Exposed as __APP_VERSION__.
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // Load .env / .env.local explicitly. Vite only injects VITE_-prefixed vars
  // into client code via import.meta.env; it does NOT put them on
  // process.env for the config itself — so reading process.env here misses
  // .env.local and the /__walletd proxy silently never registers (the app
  // then fails with "Unexpected end of JSON input"). loadEnv reads the
  // dotenv files directly, so the proxy target works straight from
  // .env.local with no separate shell `export`.
  // @ts-expect-error process is a nodejs global
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_WALLETD_PROXY_TARGET;
  const voteProxyTarget = env.VITE_VOTE_PROXY_TARGET;

  // Browser-real verification path (VITE_USE_REAL_AGENT=true, no Tauri):
  //   /mcp → the Node http-bridge running REAL exfer-mcp + walletd (port 7399).
  //   /llm → the LLM provider base URL; the proxy injects the API key as an
  //          Authorization header server-side so the key never reaches the
  //          browser and the call is same-origin (CORS-free).
  const llmTarget = env.LLM_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
  const deepseekKey = readDeepseekKey();

  return {
    plugins: [react(), webfetchPlugin()],

    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },

    // Down-level modern syntax (optional chaining, nullish coalescing, etc.)
    // so the bundle parses on the older WebViews shipped by Android 7–8 and
    // non-GMS ROMs (Huawei/HarmonyOS), where System WebView may be stale.
    // We use no runtime-only modern APIs (verified), so syntax transpilation
    // is enough — no need for the heavier @vitejs/plugin-legacy polyfills.
    // Floor matches the Android 7.0 (API 24) minSdk.
    build: {
      target: ["es2019", "chrome70", "safari12"],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
      // Dev proxies (browser-mode only; a real Tauri build routes through
      // Rust instead).
      //   /__walletd → a real walletd daemon. Activated by
      //     VITE_WALLETD_PROXY_TARGET in .env.local (strips the prefix so
      //     walletd sees `POST /`); see lib/devmock.ts for the switch.
      //   /__price   → the public EXFER OTC market API. archeotc sends no
      //     CORS headers, so a direct browser fetch is blocked; the proxy
      //     lets dev-mode read the price. Production uses the Rust
      //     get_market_price command (see lib/market.ts).
      proxy: {
        "/__price": {
          target: "https://archeotc.com",
          changeOrigin: true,
          secure: true,
          rewrite: (p: string) => p.replace(/^\/__price/, ""),
        },
        // BNB/USD spot (Binance public API) — the independent USD anchor for BNB
        // so the EXFER price can track the live pool ratio. Mirrors get_bnb_price
        // on the Tauri side.
        "/__bnbusd": {
          target: "https://api.binance.com",
          changeOrigin: true,
          secure: true,
          rewrite: (p: string) => p.replace(/^\/__bnbusd/, ""),
        },
        // Browser-real agent backend (no rewrite — the bridge serves
        // /mcp/list_tools and /mcp/call_tool verbatim).
        "/mcp": {
          target: "http://127.0.0.1:7399",
          changeOrigin: true,
          secure: false,
        },
        // Browser-real LLM. The key is injected here, server-side, so the
        // browser only sees a same-origin /llm path with a placeholder key.
        "/llm": {
          target: llmTarget,
          changeOrigin: true,
          secure: true,
          rewrite: (p: string) => p.replace(/^\/llm/, ""),
          configure: (proxy: { on: (ev: string, cb: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (deepseekKey) proxyReq.setHeader("Authorization", `Bearer ${deepseekKey}`);
            });
          },
        },
        ...(proxyTarget
          ? {
              "/__walletd": {
                target: proxyTarget,
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/__walletd/, ""),
              },
            }
          : {}),
        // /__vote → a real exfer-vote service. Activated by
        //   VITE_VOTE_PROXY_TARGET in .env.local (strips the prefix so the
        //   service sees bare `/proposals`, `/votes`, …). `secure: false`
        //   because exfer-vote serves a self-signed cert in dev. Leave unset
        //   for the in-browser mock (see lib/devmock.ts).
        ...(voteProxyTarget
          ? {
              "/__vote": {
                target: voteProxyTarget,
                changeOrigin: true,
                secure: false,
                rewrite: (p: string) => p.replace(/^\/__vote/, ""),
              },
            }
          : {}),
      },
    },
  };
});
