# Lockdown installer build track

`.github/workflows/build-lockdown.yml` builds **Windows x64 NSIS + MSI**, **Linux
x64 AppImage + deb**, and the existing **Apple Silicon macOS DMG** track. It only
uploads Actions artifacts: it does not publish a release, deploy the website,
install the application, or open the kiosk. These are unsigned Windows/Linux
builds; the macOS build uses ad-hoc signing, not Developer ID/notarization.

## Before triggering a build

1. Review and commit/push the intended **frontend, Rust, Cargo.lock, workflow and
   helper changes together**. Actions builds the selected remote commit, never
   local uncommitted fixes. Do not include private `.env` files.
2. In the repository's **Settings → Secrets and variables → Actions**, configure
   these names as repository secrets or variables (secrets take precedence):

   | Required name | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Real HTTPS Supabase project origin |
   | `VITE_SUPABASE_ANON_KEY` | Public publishable key, or compatible legacy `anon` JWT for that project |
   | `VITE_LIVEKIT_URL` | Real `wss://` LiveKit server URL |
   | `VITE_APP_BASE_URL` | Public HTTPS web-app origin, needed for phone/QR uploads from a desktop webview |

   Only **public client configuration** goes here: Vite embeds it in the app.
   Never use Supabase `service_role`/`sb_secret_` keys, R2 credentials, LiveKit API
   secrets, passwords, or user session tokens. The preflight rejects missing,
   placeholder and malformed settings, privileged/expired/wrong-project legacy
   keys, and unsafe release flags. It checks shape, **not backend connectivity
   or JWT authenticity**. No key values are printed or recorded in manifests.

   Optional settings: `VITE_LOCKDOWN_DOWNLOAD_URL`, `_WIN`, `_MAC`, `_LINUX`,
   `VITE_SENTRY_DSN` (secrets or variables), and `VITE_SUPABASE_BUCKET_NAME`
   (variable; defaults to `exam-records`). Download overrides must be HTTPS URLs.
   `VITE_EXAM_ENTRY_PATH=/student/exam`, `VITE_PROCTOR_CAPTURE=true` and
   `VITE_ALLOW_ANON_ROLL=false` are explicit release settings.
3. Once authorized, use **Actions → Build Lockdown Browser → Run workflow** and
   select that remote ref, or push an authorized `lockdown-v*` tag. All three
   native jobs run. No release is published automatically.

As inspected on **2026-10-01**, origin `main` was `101997bd97d75115f6d2d6bff5f8f6bf28a84ffb`;
repository Actions secrets and variables lists were empty. The newest successful
installer run was [35328662650](https://github.com/JyothirmayuduS/Exam_Platform/actions/runs/35328662650),
from **2026-09-18**, commit `1f0d19f1bc9af2f88d4e5cdc708ced5a73013b62`.
Its Windows/macOS artifacts expire **2026-10-18** and predate the local fixes.
There was no Linux installer run/artifact and no GitHub Release. These observations
are not a current-source build result; recheck metadata before distribution.

## Outputs and verification

Each successful job uploads `vignan-exam-browser-<windows|linux|macos>`, containing:

| Track | Stable filenames |
| --- | --- |
| Windows x64 | `VignanExam_setup.exe`, `VignanExam.msi` |
| Linux x64 | `VignanExam.AppImage`, `VignanExam.deb` |
| macOS arm64 | `VignanExam.dmg` |

Each artifact also contains `SHA256SUMS` and `manifest.json` with checkout SHA,
target architecture, run ID, package sizes/hashes and performed checks. Staging
is under `src-tauri/target/installers/<platform>/`; it requires exactly one fresh
package of **each** requested format and refuses a pre-existing staging folder.

Checks performed on the native runner:
- NSIS: nontrivial size and PE header, generated per-user protocol registry recipe
  with quoted executable/URL, extraction with 7-Zip, x64 payload and SHA-256 match
  against the just-built executable with only Tauri's documented first
  `__TAURI_BUNDLE_TYPE_VAR_UNK` → `..._NSS` package marker patch applied. Tauri
  restores the original Cargo executable after bundling, so raw hashes otherwise
  differ; any change beyond that exact patch fails. **Not an installed registry test.**
- MSI: compound-file header and read-only Windows Installer database inspection
  of product, x64 architecture, main file and quoted `vignan-exam` registry command.
  **No MSI installation is performed.**
- Linux: ELF64/type-2 AppImage and Debian headers, actual extraction, x64 payloads,
  Debian runtime dependencies, and `desktop-file-validate` plus handler/URL argument
  checks on packaged desktop entries. AppImage runs **only** `--appimage-extract`,
  never `AppRun` or the application binary.
- macOS: `hdiutil verify`, `codesign --verify --deep --strict`, and `vignan-exam`
  in the corresponding built `.app` plist. The build requests **app,dmg** so Tauri
  retains the app for inspection (DMG-only builds clean up the app afterward).
  Ad-hoc integrity verification does not establish Apple trust/notarization.

The Linux overlay enables AppImage GStreamer media bundling and deb media/xdg
runtime dependencies. Its desktop template passes `%U`: the pinned Tauri CLI
2.11.4 default template has `Exec={{exec}}` without a URL argument. Both AppImage
and deb use Tauri's Debian data-generation/template path. This check catches a
package that registers a scheme but drops the exam URL.

Node 22 matches the current lockfile's Supabase requirement. Linux uses Ubuntu
22.04 as the older WebKitGTK 4.1/glibc build baseline, not `ubuntu-latest`. Explicit
Rust targets identify architectures; `npm ci` and Cargo `--locked` retain lockfiles.
The isolated CI checkout removes old bundle outputs and `public/downloads` before
building so desktop bundles don't recursively embed stale installers/placeholders.

Download a **successful current-SHA** artifact from its Actions run, verify hashes,
then copy the stable installers to the website's `public/downloads/` before its
separate web build, or publish them to approved HTTPS URLs. Actions artifact URLs
are not public student download URLs. The checked-in Windows/Linux placeholder
files are **not replaced merely by changing this workflow**. Downloaded artifact
ZIPs may lose Unix executable permissions: `chmod +x VignanExam.AppImage` before use.

## Local static checks

No backend secrets, `.env` loading or kiosk launch is needed:

```sh
node --test scripts/lockdown/checks.mjs
node --check scripts/lockdown/validate-env.mjs
node --check scripts/lockdown/stage-installers.mjs
actionlint .github/workflows/build-lockdown.yml
```

The helper fixtures validate failure paths; they are **not installers** and never
enter staging. Real package/native checks require native runner outputs. The MSI
PowerShell COM check cannot run on macOS/Linux.

## Remaining release/device smoke tests

On designated test machines, install **each** Windows format separately and the
Linux deb; run/integrate the AppImage from its intended permanent path. Confirm
`vignan-exam` associations, cold/warm browser handoff to the correct exam and a
single process/window. Follow `src-tauri/DEEP_LINK_SMOKE.md` for browser retry and
cancel cases. Also verify sign-in/backend access, webcam/mic/screen capture,
LiveKit audio/video, QR phone upload, a short exam with snapshot/PDF evidence,
exit/uninstall and reinstallation. Test Linux's intended X11/Wayland sessions,
WebKit/media/portal support and AppImage relocation/first-run registration.

Package metadata does not prove installed OS routing, signing trust, WebView2
installation, Linux desktop compatibility or media permissions. Windows ARM,
Linux ARM, and Intel macOS are not built by this matrix. Windows signing and
macOS notarization remain a separate authorized release step.
