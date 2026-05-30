# Releasing the exfer mobile wallet (iOS + Android)

The app is Tauri 2: one React/Vite frontend + one Rust core that embeds
`walletd` in-process, built for both stores from this single repo. There
is no in-app OTA (store policy forbids out-of-band code) — fast iteration
runs through **TestFlight** (iOS) and the **Play internal testing track**
(Android). A push of a `v*` tag runs `.github/workflows/release.yml`,
which builds, signs, and uploads to both.

## Local dev loop

```bash
npm install
npm run dev            # browser UI only (devmock backend, no walletd)
npm run tauri ios dev      # iOS simulator / device, real embedded walletd
npm run tauri android dev  # Android emulator / device, real embedded walletd
```

Prereqs: Xcode + an Apple Developer account (iOS); Android Studio / SDK +
NDK 26 + JDK 17 (Android). See https://v2.tauri.app/start/prerequisites/.

`tauri ios init` / `tauri android init` generate the native projects under
`src-tauri/gen/`. That directory is gitignored and regenerated in CI; commit
it only once you customize the native side (manifest permissions, launch
screen, signing) and want those edits to persist.

## CI

- `ci.yml` (push/PR): `frontend` is the hard gate (tsc + vite build).
  `android-build` and `ios-build` compile the native app and are
  `continue-on-error` until the toolchain/signing settle, so they inform
  without blocking.
- `release.yml` (tag `v*`): builds a signed `.ipa` → TestFlight and a
  signed `.aab` → Play internal track, and attaches both to a draft
  GitHub Release. Every signing/upload step is gated on its secret, so an
  un-provisioned repo still produces (unsigned) artifacts.

## Secrets to set (repo → Settings → Secrets and variables → Actions)

### iOS (App Store Connect API key)
- `APPLE_API_ISSUER` — issuer UUID from App Store Connect → Users and Access → Integrations → API Keys
- `APPLE_API_KEY_ID` — the key ID (e.g. `A1B2C3D4E5`)
- `APPLE_API_KEY_P8` — the `.p8` private key, base64-encoded (`base64 -i AuthKey_XXX.p8`)

You also need, in App Store Connect, an app record whose bundle id matches
`com.exfer.wallet`, and an iOS Distribution certificate / provisioning that
the API key can manage (Tauri uses automatic signing).

### Android (upload keystore + Play service account)
- `ANDROID_KEY_BASE64` — the upload keystore `.jks`, base64-encoded (`base64 -i upload.jks`)
- `ANDROID_KEY_PASSWORD` — keystore + key password
- `ANDROID_KEY_ALIAS` — key alias inside the keystore
- `PLAY_SERVICE_ACCOUNT_JSON` — a Google Play service-account JSON with
  release permissions on the `com.exfer.wallet` app

Create the upload keystore once:

```bash
keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias exfer-upload
```

The Android `packageName` (`com.exfer.wallet`) must already exist in the
Play Console with an internal testing track configured.

## Cutting a release

```bash
# bump version in package.json + src-tauri/tauri.conf.json (+ Cargo.toml)
git tag v0.1.0
git push origin v0.1.0
```

Then in App Store Connect / Play Console, promote the uploaded build to the
relevant testers. Publish the draft GitHub Release when ready.

## Identity / app id

- App id (both platforms): `com.exfer.wallet`
- Product name: `exfer-wallet`
- iOS min: 14.0 · Android min: API 28 (Android 9)

Note: on Android the keystore "remember passphrase" path currently falls
back to app-private file storage (`src-tauri/src/secrets.rs`); moving it to
the hardware-backed Android Keystore (tauri-plugin-keystore, optionally
biometric-gated) is a tracked hardening follow-up. The walletd seed itself
is always sealed with the user's Argon2id passphrase regardless.
