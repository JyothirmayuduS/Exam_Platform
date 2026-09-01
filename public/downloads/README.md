# Installer staging folder

Drop the built lockdown installers here **before** running `npm run build` so
they ship inside the web app (at `/downloads/…`) and the student download gate
can find them:

| OS      | Filename               |
| ------- | ---------------------- |
| Windows | `VignanExam_setup.exe` |
| macOS   | `VignanExam.dmg`       |
| Linux   | `VignanExam.AppImage`  |

## How the gate verifies installers

`src/pages/StudentExam.tsx` does not show a **Download** button until
`src/lib/platform.ts` confirms the link resolves to real installer bytes:

- `.exe` → must start with the `MZ` DOS header
- `.dmg` → must carry the UDIF `koly` trailer (final 512 bytes, when the server
  honours `Range`); otherwise at least be binary and non-HTML
- `.AppImage` → must start with the `\x7fELF` magic

If a file is missing, or the server answers with an HTML page (a 404/SPA
fallback), the gate shows **“Installer not published yet”** instead of offering
a download. This prevents the browser from saving HTML as `VignanExam.dmg`,
which macOS then rejects with *“the disk image is corrupted.”*

## Alternative: host the installers elsewhere

Point the per-OS env vars at your hosted assets
(`VITE_LOCKDOWN_DOWNLOAD_MAC`, `_WIN`, `_LINUX`), or set
`VITE_LOCKDOWN_DOWNLOAD_URL` to a single release page (the gate will open it in
a new tab). See `.env.example`.