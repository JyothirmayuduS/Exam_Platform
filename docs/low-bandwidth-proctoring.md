# Low-bandwidth proctoring

All numbers live in `frontend/src/shared/services/lowBandwidth.ts`.

## What changes on a weak connection

The exam shows the student a connection state in the header and the proctoring
panel: **good**, **weak** or **lost**. Proctors see the same three states on
each candidate's tile and in the selected-candidate panel.

| Signal | Student state |
| --- | --- |
| Browser offline, or answer saves failing (existing rule) | lost |
| LiveKit reports the link as poor, or the browser estimates 3G or slower / RTT over 600 ms / under 1 Mbps / data saver | weak |
| Otherwise | good |

The state gets worse at once, but only returns to good after 20 s of good
signals. The proctor's view comes from the per-participant quality that LiveKit
reports. A candidate who is writing but has left the video room shows as lost.

Anything other than good turns on low-bandwidth mode:

- Live camera: 150 kbps, 10 fps, half width and height (normally 450 kbps, 15 fps).
- Live screen share: 300 kbps, 2 fps (normally 800 kbps, 5 fps).
- Webcam snapshots: still taken every second and saved on the device, but
  their uploads wait until the link recovers. None are dropped.
- Recording pieces stay on the device and upload when the link recovers.
- Submit still drains both the held snapshots and the held recording pieces.

Grading, the server deadline, answer saving and violation flags are untouched.
Every violation still captures its own frame immediately, whatever the
snapshot interval. The question paper stays text-only.

## Always on (any connection)

- Snapshots every second: 480 px JPEG at quality 0.5 (was 640 px at 0.6).
- Violation frames: 960 px at quality 0.7 (was 1600 px at 0.85). From the
  640×480 exam camera, the frame size stays the same.
- Live video uses a single capped layer (no simulcast).
- Stored recordings: camera 500 kbps (was 1.6 Mbps), screen 700 kbps (was 2.5 Mbps).

## Storage for one 2-hour exam

Measured with `node frontend/scripts/measure-proctor-storage.mjs 45 120`. The
script runs Chromium's real JPEG encoder and MediaRecorder (VP9 + Opus) on a
640×480 webcam-like scene with microphone audio, and on a 1366×768 text exam
page. It then scales bytes per second to 120 minutes.

Each recording is stored once, as 10 s pieces under `recordings/parts/` (see
`frontend/src/shared/services/recordingParts.ts`). No merged copy is uploaded
at submit; review and the evidence ZIP join the pieces when they are read.
Every figure below is for that one stored copy.

| | Before | Now |
| --- | --- | --- |
| Camera + mic recording | 923 kbps → 0.83 GB | 399 kbps → 0.36 GB |
| Screen recording (text page) | 23 kbps → 21 MB | 18 kbps → 16 MB |
| Webcam snapshots (one per second) | 7,201 × 23.5 KB → 169 MB | 7,201 × 14.0 KB → 101 MB |
| Each violation frame | 46.9 KB | 29.2 KB |
| **Total** | **≈ 1.02 GB** | **≈ 0.48 GB** (53% less) |

Snapshots were briefly taken every 20 s (361 per exam, about 5 MB). They are
back to one per second; the smaller 480 px frames keep that at about 101 MB.

These are measured figures for that synthetic scene. A real webcam with more
motion and noise can push the camera recorder toward its cap. That is
1.6 Mbps → 1.44 GB per exam before, and 500 kbps → 0.45 GB after. A static
exam page costs almost nothing to record. Scrolling and window switching raise
the screen recording toward its cap: 2.5 Mbps → 2.25 GB before, and
700 kbps → 0.63 GB after.

Older kiosks also uploaded a merged copy of each recording at submit, so they
stored the recording rows twice (≈ 1.87 GB per exam before these limits).
