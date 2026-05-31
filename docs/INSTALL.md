# Installing exfer wallet

## Android (sideload the APK)

Each release attaches an installable `.apk` to the GitHub Release.

1. On your Android phone, open the latest release:
   **https://github.com/exfer-stack/exfer-walletd-mobile/releases/latest**
2. Download the `.apk` asset (e.g. `exfer-wallet_<version>_arm64.apk`).
3. Tap the downloaded file. Android will ask to allow installs from this
   source — enable **Settings → Apps → (your browser) → Install unknown
   apps**, then tap **Install**.
4. Open **exfer wallet**, set a password, and you're in.

Notes
- The early test builds are **debug-signed** (so they install without a
  Play account). Android may warn it's from an unknown developer — that's
  expected for a sideloaded build. A Play Store listing follows once a
  release signing key is provisioned.
- Builds target **arm64 (arm64-v8a)** — every phone since ~2017. A very old
  32-bit device won't be supported by the test APK.
- Minimum Android 9 (API 28).

## iOS

iOS does not allow sideloading arbitrary `.ipa` files. An iPhone build is
distributed through **TestFlight / the App Store** once Apple signing is
provisioned (see `docs/RELEASE.md`). Until then there is no iOS install
path — iOS users should wait for the TestFlight invite.

## What "install" gives you

The app embeds the `walletd` engine in-process — there is no separate
server to run. Keys are generated and stored on the device; the app only
talks to a public Exfer node to read balances and broadcast transactions.

## For maintainers: cutting a release

```bash
# bump version in package.json + src-tauri/tauri.conf.json (+ Cargo.toml)
git tag v0.1.0
git push origin v0.1.0   # triggers .github/workflows/release.yml
```

That builds the APK (and, once signing secrets are set, the signed `.aab`
for Play / signed `.ipa` for TestFlight) and publishes a GitHub Release
with the APK attached. See `docs/RELEASE.md` for the signing secrets.
