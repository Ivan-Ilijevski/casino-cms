# Ship our own APK (Trusted Web Activity) so the kiosk gets a real, working icon

> **Status: planned, not implemented.** Parked for a later session. Written 2026-09-04 after
> diagnosing the crash below on the Android 8.0 kiosk. Nothing in this document has been built yet.
>
> Already shipped and working in the tree (do not redo): `web/public/manifest.webmanifest`,
> `web/public/sw.js`, `web/public/icons/`, `web/src/fullscreen.ts`, `web/src/views/Settings.tsx`
> (gear → Settings → fullscreen toggle), `test/pwaManifest.test.ts`.

## Context

Installing the staff app on the Android 8.0 kiosk via Chrome → "Install app" produces an icon that
crashes instantly with **"CMS keeps stopping"**. `adb logcat -b crash` gives the cause outright:

```
Process: org.chromium.webapk.aff984add835f14e5_v2
java.lang.RuntimeException: Unable to get provider
  org.chromium.webapk.shell_apk.h2o.SplashContentProvider
Caused by: java.lang.ClassNotFoundException
  Suppressed: java.io.IOException: Failed to open dex files from …/base.apk
    because: Unrecognized version number in …/base.apk: 0 3 9
```

Google's WebAPK minting server built that APK with **DEX 039** bytecode. DEX 039 arrived in
Android 9 (API 28); this kiosk is Android 8.0 (API 26), whose ART reads up to DEX 038. The dex
cannot be opened at all, so every class in it is missing — including Chrome's own
`SplashContentProvider` — and the process dies during `handleBindApplication`, before any of our
code runs.

**No manifest field can influence that**, so the WebAPK route is closed. The fix is to build the
APK ourselves, where `minSdkVersion` is ours to set: D8 picks the DEX version from it
(`<24` → 035, `24–25` → 037, `26–27` → 038, `≥28` → **039**). Setting **minSdkVersion 21 → DEX 035**
loads on Android 8.0 and everything newer. That is the whole bug, and the whole fix.

Confirmed with the user: HTTPS with a real certificate, `adb` works for sideloading, and they want
a real home-screen icon rather than a shortcut.

### What is *not* the problem

| Suspicion | Verdict |
|---|---|
| Browser too old for our bundle | **No.** Chrome 112 clears our measured floors (JS 85, CSS 87); the site works in a tab |
| `display: "fullscreen"` being exotic | **No.** The crash precedes any display mode being applied |
| Our JS, CSS, service worker or icons | **No.** The process never reaches a WebView |

So the existing web app, manifest, worker and icons are unchanged. All new work is the APK and the
one server route it needs.

### Interim workaround, if the kiosk is needed before this is built

Chrome → **"Add to Home screen"** makes a plain bookmark shortcut — no APK, no dex, nothing to
crash — then Settings gear → *Влези во цел екран* hides Chrome's UI and the Android bars. The
preference is restored on the first tap after any reload, so a reboot costs one tap. Uninstall the
crashing icon first; it is a real package (`adb uninstall org.chromium.webapk.aff984add835f14e5_v2`).

## 1. Serve Digital Asset Links — [src/config.ts](../../src/config.ts), [src/http/server.ts](../../src/http/server.ts)

A TWA runs chrome-less only if the origin vouches for the APK at
`https://<origin>/.well-known/assetlinks.json`. Without it Chrome falls back to a Custom Tab with a
visible URL bar — which defeats the point.

Two details that will silently break this if missed:

- **It must be routed before the SPA fallback.** The catch-all at `src/http/server.ts:76`
  (`/^\/(?!api\/).*/`) would otherwise answer with `index.html`, and Chrome would see HTML instead
  of JSON.
- **Do not rely on `express.static` for a dot-directory.** serve-static's `dotfiles` handling
  defaults to ignoring paths beginning with a dot, so a file dropped in `web/public/.well-known/`
  may never be served. An explicit route avoids the question entirely, and works even when
  `web/dist` does not exist.

Add to `Config`/`DEFAULT_CONFIG`/`loadConfig`, following the existing env-driven pattern:
- `twaPackage: string | null` ← `CMS_TWA_PACKAGE`
- `twaFingerprints: string[]` ← `CMS_TWA_FINGERPRINTS`, comma-separated so a debug and a release
  key can both be trusted

Then a route mounted before the static/SPA block, returning `application/json`:
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "<CMS_TWA_PACKAGE>",
    "sha256_cert_fingerprints": ["<…>"]
  }
}]
```
When the env vars are unset it 404s, so a deployment that does not use the APK is unaffected.

Document both vars in [.env.example](../../.env.example) alongside the existing entries.

## 2. The TWA project — new `twa/`

Generated with Bubblewrap (`npx @bubblewrap/cli init --manifest https://<origin>/manifest.webmanifest`),
which seeds name, icons, colours, `start_url` and `display` from the manifest we already ship. It
prompts to install a JDK and the Android SDK itself.

**The one setting that matters: `minSdkVersion 21`.** Bubblewrap does not reliably expose it in
`twa-manifest.json`, so expect to set it in the generated `twa/app/build.gradle`. This is the
difference between an APK that runs and the one that crashes today — verify it from the artifact,
not from the config (see verification).

Package name should be reverse-DNS of the real domain. Signing uses a Bubblewrap-generated
keystore; its SHA-256 goes into `CMS_TWA_FINGERPRINTS` (read back any time with
`keytool -list -v -keystore android.keystore`).

Commit `twa/twa-manifest.json` and a short `twa/README.md` with the build/sign/install commands.
**Add the keystore, `twa/app/build/`, `twa/.gradle/` and `*.keystore` to [.gitignore](../../.gitignore)** —
a committed signing key would let anyone publish as this app.

## 3. Tests and docs

- `test/assetlinks.test.ts` — supertest, following [test/staffApi.test.ts](../../test/staffApi.test.ts):
  the route returns 200 `application/json` with the configured package and fingerprint; it 404s
  when unconfigured; and — the regression that actually bites — it is **not** shadowed by the SPA
  fallback, and needs no auth.
- [README.md](../../README.md) — replace the "Installing it fullscreen" section. Record that
  Chrome's "Install app" produces a DEX 039 WebAPK that cannot load below API 28, with the
  greppable logcat line (`Unrecognized version number … 0 3 9`), and that the supported route on
  the tablets is this APK. Keep the note that the plain PWA install still works on Android 9+.

Unchanged: `web/public/manifest.webmanifest`, `web/public/sw.js`, the icons,
`web/src/fullscreen.ts`, `web/src/views/Settings.tsx`, `test/pwaManifest.test.ts`. The Settings
fullscreen toggle stays useful — it is what makes the app fullscreen in a plain browser tab, and
inside the TWA the status line will correctly read *како инсталирана апликација*.

## Verification

1. `npm run typecheck && npm test` — new assetlinks test passes; the 3 failures in the untracked
   `test/customersApi.test.ts` were pre-existing branch WIP at the time of writing.
2. `curl -s https://<origin>/.well-known/assetlinks.json` → the JSON, `content-type: application/json`,
   **not** `text/html`. This is the check that catches the SPA-fallback shadowing.
3. **Verify the DEX version from the built artifact, not the gradle config** — this is the entire
   point of the exercise:
   ```
   unzip -p twa/app/build/outputs/apk/release/app-release-signed.apk classes.dex | head -c 8 | xxd
   ```
   Must read `dex\n035` (`64 65 78 0a 30 33 35 00`). If it shows `039`, `minSdkVersion` did not take
   and the APK will crash exactly as the current one does.
4. `adb install -r app-release-signed.apk`, then `adb logcat -b crash -c` and launch the icon;
   `adb logcat -b crash` returns nothing.
5. The app opens **with no URL bar** — that proves asset-link verification passed. A visible URL bar
   means the fingerprint or package name in `assetlinks.json` does not match the installed APK.
6. Log in and confirm the status bar and nav bar are gone (`display: "fullscreen"` carries into the TWA).
7. **Run one full POS charge (tap → PIN → done).** Web NFC through a TWA surface is the one thing
   here I would not assume — it is the reason the tablet exists, so it gets tested explicitly
   rather than inferred from Chrome working.
8. Reboot the kiosk and relaunch, confirming it comes back clean.

## Notes

- Not lowering the Vite build target. Chrome 112 is well above our measured floors and a TWA renders
  through Chrome, not the system WebView — so there is nothing to gain and bundle size to lose.
- The ngrok interstitial issue is separate and still stands: the free tier answers
  `/manifest.webmanifest` and `/sw.js` with HTML (`ERR_NGROK_6024`), which is why the PWA install is
  never offered through that tunnel. Bubblewrap reads the manifest over HTTPS at init time, so run
  it against the real certificated origin, not the tunnel, or it will read the interstitial instead.
