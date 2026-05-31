<h1 align="center">exfer-wallet (mobile)</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
</p>

A mobile wallet (iOS + Android) for the Exfer blockchain, built from one
codebase. The app embeds the
[`exfer-walletd`](https://github.com/exfer-stack/exfer-walletd) daemon
**in-process on the device**: keys never leave the phone, balances and
sends go through a loopback HTTPS channel whose self-signed cert is pinned
by SHA-256 fingerprint inside the Rust shell, and walletd is reached only
through three scoped bearer tokens (read / manage / spend) routed per
method on the Rust side. The webview never makes a network call itself.

This is the mobile sibling of
[`exfer-walletd-desktop`](https://github.com/exfer-stack/exfer-walletd-desktop):
it reuses that app's Rust core (`walletd_supervisor`, `rpc_client`,
`export_key`) and React data layer (`src/lib/*`) unchanged, and adds a
phone-native UI.

Built with **Tauri 2 + React 19 + TypeScript + Vite**. No Tailwind — the UI
runs on a hand-written design-token stylesheet (`src/styles/exfer.css`).
Brand: pure-black canvas, cyan accent, Geist / Geist Mono.

## Wallet model (flat keyring)

Every address is its own independent 1:1 key with its own lifecycle:

- **Receive** — QR + copyable address; mint a fresh address per payer for privacy.
- **Send** — multiple recipients, live fee simulation, broadcast → receipt.
- **Per-address recovery phrase** — each address has its own 24 words.
- **Real delete** — with a funds guard (refuses a non-empty address unless you confirm the funds are unrecoverable).
- **Vault backup** — seal the whole keyring into one encrypted `.vault` file; no seed phrase to copy.
- **Import** — a new address from a 24-word phrase or an encrypted `wallet.key` (EXFK) file.

## Screens

Bottom tab bar: **Wallet** / **Activity** / **Settings**. Receive, Send, and
the per-address detail open as full-screen sheets. Onboarding creates a
password-encrypted wallet or restores from a `.vault` backup. Settings
covers appearance (theme / accent / hide-balance), the upstream node, vault
backup & restore, daemon status, and a typed-confirmation wipe.

## Develop

```bash
npm install
npm run dev                # browser UI only (devmock backend — no Tauri/walletd needed)
npm run tauri ios dev      # iOS simulator/device, real embedded walletd
npm run tauri android dev  # Android emulator/device, real embedded walletd
```

`npm run dev` serves the full UI against an in-browser mock (`src/lib/devmock.ts`)
so you can iterate screens without the native toolchain. The real backend
only runs inside a Tauri build.

Prereqs for the native targets (Xcode / Android SDK + NDK 26 + JDK 17):
https://v2.tauri.app/start/prerequisites/

## Install

Android: grab the `.apk` from the
[latest release](https://github.com/exfer-stack/exfer-walletd-mobile/releases/latest)
and sideload it — step-by-step in [`docs/INSTALL.md`](docs/INSTALL.md). iOS
ships via TestFlight/App Store once signing is provisioned.

## Release

Tag-triggered CI (`git tag vX.Y.Z && git push origin vX.Y.Z`) builds the
Android `.apk` (+ signed `.aab` → Play and `.ipa` → TestFlight once secrets
are set) and publishes a GitHub Release with the APK attached. See
[`docs/RELEASE.md`](docs/RELEASE.md) for the signing secrets.

## App identity

- App id: `com.exfer.wallet` · Product: `exfer-wallet`
- iOS 14.0+ · Android 9 (API 28)+
