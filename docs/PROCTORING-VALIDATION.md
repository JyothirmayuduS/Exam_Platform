# Proctor AI — phone detection validation

The modular engine (tracking → temporal confirmation → fusion → dedupe → risk)
is unit-tested and can no longer mislabel a head-down pose as a phone. What is
**not** yet proven is the *perception layer*: whether the EfficientDet-Lite0
object detector actually sees a real mobile phone on a real webcam. This is a
physical, manual test — run it before committing or trusting `phone_detected`.

## 1. Turn on the diagnostics HUD

Start the app with the AI debug overlay:

```bash
VITE_PROCTOR_DEBUG=1 npm run dev
```

or append `?proctorDebug=1` to the exam URL. The overlay (bottom-right)
shows:

```
AI ENGINE
step …            model load state / retries
fps …             AI loop cadence
face N            face count
gaze DOWN 100%    head-pose direction + score
audio …           RMS / VOICE
RISK 0 NORMAL     decaying risk score
TRACKS            live objects: #id kind conf hits misses CONFIRMED
OBJECT SAMPLES    every RAW model detection this second, e.g.
                  cell phone 71% idx=67 box=(0.42,0.50,0.18,0.24)
                  frame 1280x720
```

`OBJECT SAMPLES` logs **every** detection the model returns — sub-threshold,
benign (`person`, `book`), everything — plus the frame size. If a phone is in
view it will appear here *before* any tracking or violation logic runs. This
is where you find the truth about the model.

## 2. Read the pipeline correctly

```
model output (OBJECT SAMPLES)      ← is it SEEN here at all?
        ↓
classifyObject → kind gate         ← label matched? confidence above gate?
        ↓
ObjectTracker (3 hits / ~3.6 s)    ← seen repeatedly?
        ↓
decideObjectEvent (+ head pose)    ← phone_detected vs possible_phone_use
        ↓
ViolationGate (cooldown)           ← one log per incident
```

A phone missing from `OBJECT SAMPLES` is a **model problem** (or an input
problem). A phone present but never in `TRACKS` is a threshold/tracking
problem. Never tune fusion/risk to fix perception.

## 3. Position tests — record one line per row

Hold a real phone in view, one position at a time (2–3 s each), and record:

| Position | raw label | max conf | box (x,y,w,h) | in TRACKS? | hits | confirmed? |
|---|---|---|---|---|---|---|
| A. held in front of face | | | | | | |
| B. held beside face | | | | | | |
| C. held near chest | | | | | | |
| D. near bottom edge of frame | | | | | | |
| E. lying flat on the desk | | | | | | |
| F. partially behind hand/book | | | | | | |
| G. far from camera (small) | | | | | | |
| H. at extreme edge of frame | | | | | | |

Also test: screen off vs on, different phone orientations, room light vs dark.

## 4. Threshold sweep (diagnostic only — do not ship yet)

Temporarily set `OBJECT.PHONE_MIN_CONF` in `src/proctoring/config.ts` to each
value, repeat position A, and table the results:

| PHONE_MIN_CONF | phone detected? | false positives (non-phone → phone) |
|---|---|---|
| 0.25 | | |
| 0.35 | | |
| 0.45 (current) | | |
| 0.50 | | |
| 0.60 | | |

Pick the lowest threshold with **zero** false positives *and* reliable true
detections. Expect to keep it near 0.45–0.50; do not drop it to chase a weak
model.

## 5. Triage — which of these is happening?

Check `OBJECT SAMPLES` first:

- **A. Model never recognizes phones** — no `cell phone`/`phone` line ever.
  → The perception model is the bottleneck. Implement a pluggable
  `ObjectDetector` (ONNX/WebGPU/TF.js) or fine-tune/train on webcam images.
- **B. Recognizes but confidence too low** — line appears below ~0.35.
  → Small-object problem: enable `OBJECT.USE_PHONE_ROI` (extra detector pass
  on the lower 55 % of the frame) and/or raise input resolution.
- **C. Label mismatch** — a phone line shows a different name (e.g. `remote`,
  `clock`). → Fix `src/proctoring/labels.ts` after confirming the real label
  and `idx` in the overlay.
- **D. Bbox conversion wrong** — box coordinates look scaled/mirrored vs the
  video. → Check the MediaPipe → normalized-box mapping in
  `ProctorAI.toDetections`.
- **E. Input/preprocessing wrong** — `frame WxH` in the overlay is tiny or
  distorted. → Feed the detector the intended resolution, preserve aspect
  ratio.
- **F. Cadence too slow** — phone flashes in/out between 900 ms samples.
  → Raise detection rate (config `CADENCE.OBJECT_MS`) and measure CPU first.
- **G. Tracker discarding valid detections** — phone in SAMPLES but track
  dies despite hits. → Loosen `TRACKING` (`MAX_MISSES`, IoU).
- **H. Confirmation dropping valid tracks** — track builds hits but never
  `CONFIRMED`. → Check `MIN_HITS` vs `CONFIRM_WINDOW_MS` at the current
  cadence.

## 6. Acceptance matrix (final gate)

| Scenario | Expected | Pass? |
|---|---|---|
| No phone in view | no `phone_detected` | |
| Looking down, no phone | `gaze_away` only — text never mentions a phone | |
| Phone clearly visible ~1 s | nothing (below 3-hit confirmation) | |
| Phone visible ~3 s, head neutral | exactly one `phone_detected` | |
| Phone visible ~3 s + head down | one `possible_phone_use` | |
| Single 1-frame flash | no violation | |
| Phone dips out 1 sample (< 1 s) | track persists, still confirms | |
| Phone remains in view 60 s | phone_detected once, heartbeat ≈ every 25 s | |
| Repeat same incident | never more than one log inside the cooldown | |

## 7. Report back

After the physical test, record: raw labels + indices observed, max phone
confidence, minimum reliable confidence, chosen `PHONE_MIN_CONF`, cadence,
confirmation hits/window, tracker behavior, false positives seen, whether
EfficientDet is acceptable, and whether a replacement detector is required.
Only then commit.

See `src/proctoring/config.ts` for every knob referenced above.
