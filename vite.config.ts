import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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

  return {
    plugins: [react()],

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
        ...(proxyTarget
          ? {
              "/__walletd": {
                target: proxyTarget,
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/__walletd/, ""),
              },
            }
          : {}),
      },
    },
  };
});
