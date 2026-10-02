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

**Verified build, 2026-10-01:** all three native jobs passed in
[36846656016](https://github.com/JyothirmayuduS/Exam_Platform/actions/runs/36846656016)
from `e0d99f1bb53617ffc5a4b0d872bcd84525855d36` on
`build/lockdown-installers-20261001`. The four required public client settings
are now configured as Actions secrets; no private server credentials were uploaded.
The missing app origin was resolved from the repository homepage and verified as
`https://exam-platform-gray-nine.vercel.app`. Main was not merged and no release
was published. Artifacts retain for 30 days from this run. Build verification is
not a Windows/Linux installed-device or authenticated exam smoke test.

Windows fixes verified by this run: exclude the web entry route from Git Bash's
environment path conversion, account for only Tauri's documented NSIS marker
patch during integrity verification, and suppress COM null output in MSI queries.

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
are not public student download URLs. The local `public/downloads/` Windows/Linux placeholders have been replaced with
verified outputs from this run. Binaries were not committed/published; use the
Actions artifacts and `public/downloads/build-manifest.json` for provenance. Downloaded artifact
ZIPs may lose Unix executable permissions: `chmod +x VignanExam.AppImage` before use.

## Publish installers to the public Blob store

CI only builds; publishing is a manual step because binaries never enter git and
the store token must stay out of CI. `vercel.json` redirects `/downloads/*` to
`https://<store>.public.blob.vercel-storage.com/lockdown/<file>`, so the blob
pathnames must stay exactly `lockdown/VignanExam_{setup.exe,msi,dmg,AppImage,deb}`.

1. Get the run ID of a green `Build Lockdown Browser` run
   (`gh run list --workflow=build-lockdown.yml --limit 3`).
2. Download the three artifacts:

   ```sh
   gh run download <run-id> -R JyothirmayuduS/Exam_Platform -D /tmp/lockdown-<run-id>
   ```

3. Upload (the script verifies `SHA256SUMS` first, refuses mismatches, and
   overwrites the previous version in place):

   ```sh
   npm install --no-save @vercel/blob
   export $(grep -E "^BLOB_READ_WRITE_TOKEN=" .env.local | xargs)
   node scripts/lockdown/upload-blob.mjs /tmp/lockdown-<run-id>
   ```

4. Verify the public URLs serve the new bytes:

   ```sh
   curl -sIL https://exam-platform-gray-nine.vercel.app/downloads/VignanExam.dmg | grep -i content-length
   ```

   The length must equal the artifact size (also in `manifest.json`). The
   `VITE_LOCKDOWN_DOWNLOAD_*` env vars, if configured, point at these same
   Blob URLs — no web redeploy is needed; redirects are part of `vercel.json`.

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
