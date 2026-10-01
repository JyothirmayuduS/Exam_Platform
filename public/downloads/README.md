# Verified installer staging

Build branch: `build/lockdown-installers-20261001`.
All native jobs passed in [Actions run 36846656016](https://github.com/JyothirmayuduS/Exam_Platform/actions/runs/36846656016),
source commit `e0d99f1bb53617ffc5a4b0d872bcd84525855d36`.

| Platform | Local installer |
| --- | --- |
| Windows x64 | `VignanExam_setup.exe`, `VignanExam.msi` |
| Linux x64 | `VignanExam.AppImage`, `VignanExam.deb` |
| Apple Silicon macOS | `VignanExam.dmg` |

The local placeholder downloads have been replaced with real outputs. SHA-256
hashes were checked against each Actions manifest before staging. `SHA256SUMS`
and `build-manifest.json` preserve their provenance. Installer binaries are not
committed/published by this change; download the corresponding Actions artifacts
when preparing another checkout. Artifacts are retained for 30 days.

Checks: Windows PE/x64 payload, exact Tauri bundle marker integrity and NSIS/MSI
protocol metadata; Linux extracted ELF payloads, desktop URL forwarding and deb
dependencies; macOS DMG checksum, app signature integrity and URL scheme.
**These are package checks, not full installed-device exam tests.**

Windows is unsigned; macOS uses ad-hoc signing and is **not Apple-notarized**.
Intel macOS and Windows/Linux ARM builds are not included. Real Chrome-to-macOS
cold/warm process handoff was tested locally; full authentication/media/exam
checks, first-time approval, and Windows/Linux OS handoff still need test devices.
See `src-tauri/DEEP_LINK_SMOKE.md` and `scripts/lockdown/README.md`.

## Website deployment

Copy the approved builds here before `npm run build`, or set
`VITE_LOCKDOWN_DOWNLOAD_WIN`, `_MAC`, `_LINUX` to approved HTTPS asset URLs.
The current website does not gain new installers until separately deployed.
The AppImage is over GitHub's ordinary 100 MB per-file limit: host it as a release
asset or in approved object storage, not a normal Git commit. No release was
published as part of this build.

## Download verification

`src/lib/platform.ts` rejects HTML/404 responses and obvious placeholder headers.
Windows requires a plausible PE header; Linux a valid ELF header; macOS checks
`koly` at the beginning of the final 512-byte UDIF trailer, using an explicit
byte range when the object size is known. These checks do not establish trust
or replace platform signing/notarization.
