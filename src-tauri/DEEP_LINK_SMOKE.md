# Exam browser deep-link verification

These manual checks open a fullscreen lockdown app. Run them only on a designated
test device with permission, not on a shared development desktop. Automated
regressions mock native IPC/navigation and do **not** open the kiosk.

## Latest local verification (2026-10-01)

- `npx playwright test --config playwright.lockdown.config.ts`: **8 passed** in
  Chromium/WebKit, including real staged-DMG download/hash, installer rejection,
  first-click/retry/back UI and exam-reference preservation across sign-in.
  These deterministic browser tests replace only the external OS handoff.
- `LOCKDOWN_TEST_APP='/Applications/Vignan Exam Browser.app' node
  scripts/smoke-lockdown-macos.mjs --allow-kiosk`: **passed** for the actual Chrome
  installed-button → OS → installed app cold launch and warm single-process launch.
  The temporary Chrome profile remembered approval for localhost only; no personal
  browser preferences were changed. App/watchdog/browser/server were stopped.
- Native UI content and an authenticated exam were **not** inspected: this host
  has no Accessibility/Screen Recording authorization for the automation tools.
  The observed result is a real browser handoff and stable/single app process,
  not a completed camera/microphone/exam test or a first-time prompt interaction.
- The first bundle failed `codesign --verify` despite a valid DMG checksum. Rebuilt
  with `bundle.macOS.signingIdentity="-"`: installed app and app extracted from the
  DMG now pass `codesign --verify --deep --strict`. `hdiutil verify` and URL scheme
  verification also pass. Current `public/downloads/VignanExam.dmg` is that rebuild.
- `spctl --assess` still rejects ad-hoc trust, as expected: **no Developer ID or
  notarization credentials are installed**. Do not describe this as an
  Apple-trusted/notarized release or bypass Gatekeeper to distribute it.
- Browser tests exposed and now cover loss of the exam reference after login,
  plus a static-server suffix-range bug. Login retains the exam route; the DMG
  probe uses the explicit final-byte range from Content-Range's total size.

Windows/Linux builds and package/protocol verification now pass in Actions run
[36846656016](https://github.com/JyothirmayuduS/Exam_Platform/actions/runs/36846656016).
The approved build branch and four public settings are configured. Installed-device
and authenticated media/exam tests remain pending; see `scripts/lockdown/README.md`.

## Build and installation prerequisite

1. Build a new installer on each supported OS; changing the web deployment alone
   does not update an installed app's Rust handler or bundled frontend.
   - macOS: `npm run tauri:build -- --bundles app,dmg`
   - Windows: `npm run tauri:build -- --bundles nsis,msi`
   - Linux: `npm run tauri:build -- --bundles appimage`
2. Publish those installers to the exact URLs configured by
   `VITE_LOCKDOWN_DOWNLOAD_*` / `VITE_LOCKDOWN_DOWNLOAD_URL`, or copy them to the
   fallback filenames in `src/shared/platform/platform.ts`: `VignanExam.dmg`,
   `VignanExam_setup.exe`, and `VignanExam.AppImage`. Local staged Windows/Linux
   files are now real CI builds; they are not committed release assets.
   `public/downloads/VignanExam.dmg` is the rebuilt Apple Silicon DMG;
   SHA-256 checksums and build provenance are alongside the installers.
   It has a verified ad-hoc signature and basic installed browser-launch checks.
   Developer ID/notarization and authenticated exam/media validation remain.
   Future web builds/source changes do not update those installers automatically.
3. Install the new version normally. On macOS copy the `.app` from the DMG to
   Applications; merely downloading/mounting the DMG is not installation. On
   Windows run the installer rather than an unregistered standalone executable.
   For a Linux AppImage, make it executable and run it once on the test device
   so its handler can register (requires `xdg-mime` / `update-desktop-database`).
4. On macOS, inspect the installed bundle without launching it:
   `plutil -extract CFBundleURLTypes json -o - '/Applications/Vignan Exam Browser.app/Contents/Info.plist'`
   The registered schemes must include `vignan-exam`.

## Browser → app checks

Use a test student account with an assigned exam. Browser authentication is not
copied into the desktop app; sign in there if needed. Never put session tokens or
passwords in a protocol URL.

- **Cold start:** With the app closed, open the exam's normal browser install
  gate and click **Done — I've installed it** once. Accept the browser's external
  app prompt. Expect one native app window and the correct exam. The browser
  should immediately show launching feedback, not require a second Enter click.
- **Late macOS URL:** Repeat cold start from Safari/Chrome. The exam reference
  must survive the OS URL event arriving after native setup.
- **Warm start:** With the app already open, click a different assigned exam's
  link from the browser. Expect the existing window to receive that exam; do not
  start a second kiosk instance. This also exercises **My exams → Enter exam**.
- **Unregistered/cancelled handler:** On a separate device/profile without the
  app (or cancel the external-app prompt), keep the browser tab visible. After
  about three seconds the install screen should offer **Try again / Download
  again**. This timeout is a hint, not proof of installation failure.
- **Retry/back:** Retry should show launching feedback again with a fresh
  timeout. Back and navigation away should cancel outstanding launch timers.
- **App foregrounded:** If the browser becomes hidden during handoff, its
  fallback timer must not later mark that launch as failed.

A correct protocol URL cannot force the OS to open an uninstalled/unregistered
app or bypass a blocked external-app prompt. If there is no native process at all,
check installation/OS association and the browser prompt before debugging exam
routing. Automated checks cannot establish those OS facts.

## Automated checks

```sh
npx vitest run src/shared/platform/lockdownBridge.test.ts src/shared/platform/lockdownLaunch.test.ts src/features/student/pages/StudentExam.launch.test.tsx src/main.deeplink.test.tsx
npx tsc -b
cargo check --manifest-path src-tauri/Cargo.toml --locked --bins
```

The bridge regression specifically covers the plugin's `deep-link://new-url`
event used by macOS. The boot regression ensures subscription completes before
the current URL is read and covers both a late cold-start event and warm starts.
