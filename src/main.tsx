// Side-effect import FIRST: patches console.* into the debug-log ring buffer
// (Settings → Diagnostics) before any other module can log at startup.
import "./lib/debugLog";
import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted (offline, Tauri-friendly) typefaces: Geist for UI, Geist Mono
// for amounts/addresses. Replaces the system-ui / ui-monospace default stack.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import "./styles/exfer.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
