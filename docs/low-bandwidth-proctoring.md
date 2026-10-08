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
- Webcam snapshots: every 30 s (normally every 20 s).
- Recording parts stay on the device and upload when the link recovers. The
  submit-time upload still runs.

Grading, the server deadline, answer saving and violation flags are untouched.
Every violation still captures its own frame immediately, whatever the
snapshot interval. The question paper stays text-only.

## Always on (any connection)

- Snapshots every 20 s instead of every second: 480 px JPEG at quality 0.5
  (was 640 px at 0.6).
- Violation frames: 960 px at quality 0.7 (was 1600 px at 0.85). From the
  640×480 exam camera, the frame size stays the same.
- Live video uses a single capped layer (no simulcast).
- Stored recordings: camera 500 kbps (was 1.6 Mbps), screen 700 kbps (was 2.5 Mbps).

## Storage for one 2-hour exam

Measured with `node frontend/scripts/measure-proctor-storage.mjs 45 120`. The
script runs Chromium's real JPEG encoder and MediaRecorder (VP9 + Opus) on a
640×480 webcam-like scene with microphone audio, and on a 1366×768 text exam
page. It then scales bytes per second to 120 minutes. Each recording is stored
twice: the live parts, plus the merged file at submit.

| | Before | After |
| --- | --- | --- |
| Camera + mic recording | 923 kbps → 1.66 GB | 399 kbps → 0.72 GB |
| Screen recording (text page) | 23 kbps → 42 MB | 18 kbps → 33 MB |
| Webcam snapshots | 7,201 × 23.5 KB → 169 MB | 361 × 14.0 KB → 5 MB |
| Each violation frame | 46.9 KB | 29.2 KB |
| **Total** | **≈ 1.87 GB** | **≈ 0.76 GB** (60% less) |

These are measured figures for that synthetic scene. A real webcam with more
motion and noise can push the camera recorder toward its cap. That is
1.6 Mbps → 2.9 GB per exam before, and 500 kbps → 0.9 GB after. A static exam
page costs almost nothing to record. Scrolling and window switching raise the
screen recording toward its cap: 2.5 Mbps → 4.5 GB before, and
700 kbps → 1.3 GB after.
