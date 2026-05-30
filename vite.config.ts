import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
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
    // @ts-expect-error process is a nodejs global
    proxy: process.env.VITE_WALLETD_PROXY_TARGET
      ? {
          "/__walletd": {
            // @ts-expect-error process is a nodejs global
            target: process.env.VITE_WALLETD_PROXY_TARGET,
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/__walletd/, ""),
          },
        }
      : undefined,
  },
}));
