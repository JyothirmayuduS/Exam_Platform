# Installer staging folder

Drop the built lockdown installers here **before** running `npm run build` so
they ship inside the web app (at `/downloads/…`) and the student download gate
can find them:

| OS      | Filename               |
| ------- | ---------------------- |
| Windows | `VignanExam_setup.exe` |
| macOS   | `VignanExam.dmg`       |
| Linux   | `VignanExam.AppImage`  |

**Windows/Linux still require real builds:** their checked-in files are tiny
placeholder headers, not working installers. `VignanExam.dmg` was rebuilt for
Apple Silicon (aarch64) with the snapshot/deep-link/login fixes and an **ad-hoc
signature**. Its checksum, installed-app signature integrity, URL scheme, actual
Chrome cold/warm process launch and downloaded bytes were verified. It is not an
Intel/universal build or Apple-notarized release; first-time approval and a full
authenticated exam/media check remain. See `src-tauri/DEEP_LINK_SMOKE.md`.
The Windows/Linux CI build track is documented in `scripts/lockdown/README.md`.

## How the gate verifies installers

`src/pages/StudentExam.tsx` does not show a **Download** button until
`src/lib/platform.ts` confirms the link resolves to real installer bytes:

- `.exe` → `MZ` plus a plausible PE header (not merely two placeholder bytes)
- `.dmg` → `koly` at the start of the final 512-byte UDIF trailer; when suffix
  ranges cannot be checked cheaply, offer a normal link without claiming verification
- `.AppImage` → ELF magic plus a valid ELF class, byte order and version

These probes are corruption/placeholder checks, not signature or trust verification.

If a file is missing, or the server answers with an HTML page (a 404/SPA
fallback), the gate shows **“Installer not published yet”** instead of offering
a download. This prevents the browser from saving HTML as `VignanExam.dmg`,
which macOS then rejects with *“the disk image is corrupted.”*

## Alternative: host the installers elsewhere

Point the per-OS env vars at your hosted assets
(`VITE_LOCKDOWN_DOWNLOAD_MAC`, `_WIN`, `_LINUX`), or set
`VITE_LOCKDOWN_DOWNLOAD_URL` to a single release page (the gate will open it in
a new tab). See `.env.example`.