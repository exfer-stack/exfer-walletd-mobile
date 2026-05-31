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
      // Proxy /__walletd → a real walletd daemon for dev-mode testing
      // outside Tauri. Activated by setting VITE_WALLETD_PROXY_TARGET in
      // .env.local; see lib/devmock.ts for the client-side switch. The
      // proxy strips the /__walletd prefix so walletd sees `POST /`.
      proxy: proxyTarget
        ? {
            "/__walletd": {
              target: proxyTarget,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/__walletd/, ""),
            },
          }
        : undefined,
    },
  };
});
