// ProctorAI.tsx – Real-time AI proctoring for the Vignan Lockdown Exam
//
// Runs entirely in the browser using:
//   • MediaPipe FaceDetector   → face count (no-face / multi-person)
//   • MediaPipe FaceLandmarker → head-pose gaze estimation (left/right/up/down)
//   • MediaPipe ObjectDetector → phone / cell-phone detection
//   • Web Audio API            → voice / unexpected-sound detection
//
// All models load from the MediaPipe CDN as WASM to avoid bundling ~30 MB of
// binary assets. The component is invisible: it renders a hidden <video> that
// receives the camera stream and emits violation events to the parent.

import { useCallback, useEffect, useRef, useState } from "react";

// ── Public types ─────────────────────────────────────────────────────────────
export type AIViolationType =
  | "no_face"         // camera feed shows no face
  | "multiple_faces"  // more than one person in frame
  | "gaze_away"       // head turned / eyes off screen
  | "phone_detected"  // mobile phone visible in camera
  | "laptop_detected" // external electronic gadgets
  | "audio_detected"  // unexpected voice / ambient sound
  | "partial_face";   // face is partially cut off or out of frame

export interface AIViolation {
  type: AIViolationType;
  label: string;       // human-readable description
  confidence: number;  // 0-1
  at: number;          // Date.now()
  /** Low-res JPEG camera frame captured at flag time — uploaded as evidence. */
  evidenceBlob?: Blob;
}

export interface AIStatus {
  loading: boolean;
  loadStep: string;
  error: boolean;
  faceCount: number;
  gazeDirection: "center" | "left" | "right" | "up" | "down";
  gazeScore: number;      // 1 = looking straight at screen
  phoneDetected: boolean;
  voiceLevel: number;     // 0-1 RMS amplitude
  voiceSpeaking: boolean;
}

interface Props {
  /** The camera + mic MediaStream from getUserMedia. */
  cameraStream: MediaStream | null;
  /** True only while the exam step is active. Models stay loaded but loop stops. */
  active: boolean;
  onViolation: (v: AIViolation) => void;
  onStatus?: (s: AIStatus) => void;
}

// ── Tuning constants ─────────────────────────────────────────────────────────
// Minimum ms between back-to-back flags of the same type (avoids log spam).
const COOL: Record<AIViolationType, number> = {
  no_face:        8_000,
  multiple_faces: 8_000,
  gaze_away:      6_000,
  phone_detected: 8_000,
  laptop_detected: 10_000,
  audio_detected: 8_000,
  partial_face:   8_000,
};

// Deviation (in nose/eye-ratio units) from the student's OWN calibrated
// neutral that counts as looking away. 0.10 ≈ a clearly visible head turn.
const GAZE_DEVIATION  = 0.10;
// A condition must persist for this many consecutive samples before it is
// reported, so a single frame of jitter never fires a flag.
const SUSTAIN_SAMPLES = 4;      // gaze / face checks run every GAZE_MS
const SUSTAIN_FACE    = 6;      // ~3 s of no-face at FACE_MS=500
const SUSTAIN_AUDIO   = 4;      // ~1.6 s of sustained sound at AUDIO_MS=400
const CLEAR_SAMPLES   = 6;      // samples back in range before a flag can re-arm

const VOICE_RMS        = 0.05;  // RMS amplitude above which we flag speaking
const FACE_MS          = 500;   // face-count detection interval
const GAZE_MS          = 250;   // gaze estimation interval (MediaPipe head pose)
const PHONE_MS         = 2_500; // phone detection interval (heavy model — slow it down)
const AUDIO_MS         = 400;   // audio RMS check interval
const PHONE_MIN_CONF   = 0.45;  // object detector confidence before flagging a phone
const LAPTOP_MIN_CONF  = 0.55;  // and for "other electronics" (laptop/tv/monitor only)
const FACE_MIN_CONF    = 0.6;   // face-detector confidence gate

// Landmarker outputs the facial transformation matrix — used to confirm a real
// face pose before we trust the 2-D gaze ratio.
const LANDMARK_MIN_CONF = 0.45;

// CDN base for MediaPipe WASM (pinned minor version for reproducibility)
const MP_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

// Model URLs (Google's MediaPipe model CDN)
const MODEL_FACE_DET =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MODEL_FACE_LM =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_OBJ_DET =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite";

// ── Singleton WASM resolver (shared across mounts) ───────────────────────────
function dataUrlToBlob(dataUrl: string): Blob | undefined {
  try {
    const i = dataUrl.indexOf(",");
    const mime = dataUrl.slice(5, i).split(";")[0];
    const bin = atob(dataUrl.slice(i + 1));
    const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: mime });
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _visionCache: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _visionPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getVision(): Promise<any> {
  if (_visionCache) return _visionCache;
  if (!_visionPromise) {
    _visionPromise = import("@mediapipe/tasks-vision").then(({ FilesetResolver }) =>
      FilesetResolver.forVisionTasks(MP_WASM).then((v: unknown) => {
        _visionCache = v;
        return v;
      })
    );
  }
  return _visionPromise;
}

// ── Head-pose / gaze estimation ──────────────────────────────────────────────
// Uses 4 facial landmark indices from MediaPipe Face Landmarker to estimate
// rough yaw (left/right) and pitch (up/down) as pure geometric RATIOS:
//
//   1   → nose tip     33 → left eye outer corner
// 152   → chin        263 → right eye outer corner
//
// The ratios are NOT absolute angles — their neutral value depends on the
// camera's height and the student's seating. ProctorAI therefore calibrates a
// per-student baseline from their own neutral pose and flags only sustained
// DEVIATIONS from it (see gazeRef below). That kills the classic false positive
// where a laptop/phone camera angle makes "looking straight" read as "down".

type GazeEst = { yaw: number; pitch: number };

function estimateGaze(lms: ReadonlyArray<{ x: number; y: number; z: number }>): GazeEst {
  const nose = lms[1];
  const lEye = lms[33];
  const rEye = lms[263];
  const chin = lms[152];
  if (!nose || !lEye || !rEye || !chin) return { yaw: 0, pitch: 0 };

  const eyeMidX = (lEye.x + rEye.x) / 2;
  const eyeMidY = (lEye.y + rEye.y) / 2;
  const eyeSpan = Math.abs(rEye.x - lEye.x);
  if (eyeSpan < 0.005) return { yaw: 0, pitch: 0 };

  const yaw      = (nose.x - eyeMidX) / eyeSpan;
  const vertSpan = Math.abs(chin.y - eyeMidY) || 0.18;
  const pitch    = (nose.y - eyeMidY) / vertSpan; // ≈ 0.5 when looking straight

  return { yaw, pitch };
}

// Neutral-pose baseline + gaze state machine, kept per mount.
type GazeTracker = {
  pitch: number;   // slow EMA of the student's own neutral pose
  yaw: number;
  calibrated: boolean;
  awayStreak: number;  // consecutive off-neutral samples (decays on neutral)
  clearStreak: number; // consecutive neutral samples since last flag
};

function freshGaze(): GazeTracker {
  return { pitch: 0, yaw: 0, calibrated: false, awayStreak: 0, clearStreak: 0 };
}

// Calibrate from the first ~2 s of samples so the baseline is valid before the
// loop can flag, and update it only while the head is plausibly neutral.
function updateGazeBaseline(t: GazeTracker, g: GazeEst, dev: number): void {
  if (t.calibrated) {
    if (dev < GAZE_DEVIATION * 0.8) {
      const k = 0.05;
      t.pitch += k * (g.pitch - t.pitch);
      t.yaw   += k * (g.yaw - t.yaw);
    }
  } else {
    t.pitch = g.pitch;
    t.yaw = g.yaw;
    t.calibrated = true;
  }
}

// ── Component ────────────────────────────────────────────────────────────────
export default function ProctorAI({ cameraStream, active, onViolation, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // MediaPipe model instances (kept alive between re-renders)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faceDetRef  = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objDetRef   = useRef<any>(null);

  // Audio analysis
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);

  // Timing refs
  const rafRef   = useRef(0);
  const tFace    = useRef(0);
  const tGaze    = useRef(0);
  const tPhone   = useRef(0);
  const tAudio   = useRef(0);
  const lastFlag = useRef<Partial<Record<AIViolationType, number>>>({});

  const [status, setStatus] = useState<AIStatus>({
    loading: true,
    loadStep: "Preparing AI proctor…",
    error: false,
    faceCount: 0,
    gazeDirection: "center",
    gazeScore: 1,
    phoneDetected: false,
    voiceLevel: 0,
    voiceSpeaking: false,
  });

  // Grab a small JPEG frame from the camera <video> as tamper-evident evidence.
  const captureEvidence = useCallback((): Blob | undefined => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return undefined;
    try {
      const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      const ctx = c.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.55);
      return dataUrl.length > 0 ? dataUrlToBlob(dataUrl) : undefined;
    } catch {
      return undefined;
    }
  }, []);

  // Violation emitter with per-type cooldown + attached evidence frame
  const emit = useCallback(
    (type: AIViolationType, label: string, confidence: number) => {
      const now = Date.now();
      if (now - (lastFlag.current[type] ?? 0) < COOL[type]) return;
      lastFlag.current[type] = now;
      onViolation({ type, label, confidence, at: now, evidenceBlob: captureEvidence() });
    },
    [onViolation, captureEvidence]
  );

  // Feed camera stream into hidden video element
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !cameraStream) return;
    v.srcObject = cameraStream;
    void v.play().catch(() => {});
    return () => { v.srcObject = null; };
  }, [cameraStream]);

  // Web Audio API & Speech Recognition for voice / noise detection
  useEffect(() => {
    if (!cameraStream || !active) return;
    if (!cameraStream.getAudioTracks().length) return;

    // Web Audio API
    const ctx      = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(cameraStream).connect(analyser);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    audioBufRef.current = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));

    // Web Speech API for lightweight STT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recognition: any = null;
    if (SpeechRecognition) {
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      
      const stopwords = new Set(["the", "is", "at", "which", "on", "a", "an", "and", "in", "it"]);
      
      recognition.onresult = (event: any) => {
        const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
        const words = transcript.split(/\s+/).filter((w: string) => !stopwords.has(w) && w.length > 2);
        if (words.length > 0) {
          emit("audio_detected", `Speech detected: "${words.join(" ")}"`, 0.95);
        }
      };
      
      try { recognition.start(); } catch { /* ignore */ }
    }

    return () => {
      void ctx.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
      if (recognition) {
        try { recognition.stop(); } catch { /* ignore */ }
      }
    };
  }, [cameraStream, active, emit]);

  // Load MediaPipe models once; singletons survive unmount/remount.
  // Every model is created with the GPU delegate first, and automatically
  // falls back to CPU when the GPU is unsupported (iOS Safari / many phones
  // throw on WebGL GPU delegates — previously AI silently never started there).
  useEffect(() => {
    if (!active) return;
    let alive = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createWithFallback = async (make: (delegate: "GPU" | "CPU") => Promise<any>, step: string) => {
      setStatus(s => ({ ...s, loadStep: step }));
      try {
        return await make("GPU");
      } catch {
        console.warn(`[ProctorAI] GPU delegate unavailable for ${step} — retrying on CPU`);
        return make("CPU");
      }
    };

    void (async () => {
      try {
        setStatus(s => ({ ...s, loadStep: "Downloading AI models (first run ~10 s)…" }));
        const vision = await getVision();
        if (!alive) return;

        const { FaceDetector, FaceLandmarker, ObjectDetector } = await import("@mediapipe/tasks-vision");

        if (!faceDetRef.current) {
          faceDetRef.current = await createWithFallback(
            (delegate) =>
              FaceDetector.createFromOptions(vision, {
                baseOptions: { modelAssetPath: MODEL_FACE_DET, delegate },
                runningMode: "VIDEO",
                minDetectionConfidence: 0.5,
              }),
            "Loading face detector…",
          );
        }
        if (!alive) return;

        if (!landmarkRef.current) {
          landmarkRef.current = await createWithFallback(
            (delegate) =>
              FaceLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath: MODEL_FACE_LM, delegate },
                runningMode: "VIDEO",
                numFaces: 3,
                outputFaceBlendshapes: false,
                outputFacialTransformationMatrixes: false,
              }),
            "Loading gaze tracker…",
          );
        }
        if (!alive) return;

        if (!objDetRef.current) {
          objDetRef.current = await createWithFallback(
            (delegate) =>
              ObjectDetector.createFromOptions(vision, {
                baseOptions: { modelAssetPath: MODEL_OBJ_DET, delegate },
                runningMode: "VIDEO",
                scoreThreshold: 0.20,
                maxResults: 6,
              }),
            "Loading object detector…",
          );
        }
        if (!alive) return;

        setStatus(s => ({ ...s, loading: false, loadStep: "AI proctor active" }));
      } catch (err) {
        console.error("[ProctorAI] model load error:", err);
        if (alive) setStatus(s => ({ ...s, loading: false, error: true, loadStep: "AI unavailable — manual review only" }));
      }
    })();

    return () => { alive = false; };
  }, [active]);

  // Main detection loop. Every decision is gated on a SUSTAINED condition (a
  // single jitter frame never flags) and — for gaze — on deviation from the
  // student's own calibrated neutral pose, which removes camera-angle bias.
  useEffect(() => {
    if (!active || status.loading) return;
    let running = true;
    const gaze = freshGaze();
    let noFaceStreak = 0;
    let multiFaceStreak = 0;
    let audioStreak = 0;
    let landmarksVisible = false;

    const tick = () => {
      if (!running) return;
      const now   = Date.now();
      const video = videoRef.current;

      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ── Gaze / head pose (runs first — landmarks also veto no_face) ─────
      if (landmarkRef.current && now - tGaze.current > GAZE_MS) {
        tGaze.current = now;
        try {
          const { faceLandmarks } = landmarkRef.current.detectForVideo(video, now) as { faceLandmarks: Array<Array<{ x: number; y: number; z: number }>> };
          landmarksVisible = faceLandmarks.length > 0;
          if (landmarksVisible) {
            const lms = faceLandmarks[0];

            // Face partially out of frame — sustained, then flag.
            let outOfBounds = false;
            for (const p of lms) {
              if (p.x < 0.01 || p.x > 0.99 || p.y < 0.01 || p.y > 0.99) {
                outOfBounds = true;
                break;
              }
            }
            if (outOfBounds && gaze.awayStreak >= SUSTAIN_SAMPLES) {
              emit("partial_face", "Face partially out of frame — centre yourself in the camera", 0.85);
            }

            const g = estimateGaze(lms);
            const devPitch = Math.abs(g.pitch - gaze.pitch);
            const devYaw   = Math.abs(g.yaw - gaze.yaw);
            const dev      = Math.max(devPitch, devYaw);
            updateGazeBaseline(gaze, g, dev);

            if (gaze.calibrated) {
              const neutral = dev < GAZE_DEVIATION;
              if (neutral) {
                gaze.awayStreak = Math.max(0, gaze.awayStreak - 1);
                gaze.clearStreak += 1;
                if (gaze.clearStreak >= CLEAR_SAMPLES) gaze.awayStreak = 0;
              } else {
                gaze.clearStreak = 0;
                gaze.awayStreak += 1;
              }

              let dir: AIStatus["gazeDirection"] = "center";
              if (gaze.awayStreak >= SUSTAIN_SAMPLES) {
                if (devYaw >= devPitch) dir = g.yaw < gaze.yaw ? "left" : "right";
                else dir = g.pitch < gaze.pitch ? "up" : "down";
                const conf = Math.min(1, dev / (GAZE_DEVIATION * 3));
                if (gaze.awayStreak === SUSTAIN_SAMPLES || gaze.awayStreak % 12 === 0) {
                  const dirLabel: Record<string, string> = {
                    left:  "Head turned left / looking away from the screen",
                    right: "Head turned right / looking away from the screen",
                    up:    "Looking up — away from the screen",
                    down:  "Head tilted down — check for phone / notes use",
                  };
                  emit("gaze_away", dirLabel[dir] ?? "Looking away from the screen", conf);
                }
              }
              setStatus(s => ({ ...s, gazeDirection: dir, gazeScore: Math.max(0, Math.min(1, 1 - dev / (GAZE_DEVIATION * 3))) }));
            }
          }
        } catch { /* model busy */ }
      }

      // ── Face count (landmarks veto the "no face" false positive) ────────
      if (faceDetRef.current && now - tFace.current > FACE_MS) {
        tFace.current = now;
        try {
          const { detections } = faceDetRef.current.detectForVideo(video, now) as { detections: Array<{ categories: Array<{ score: number }> }> };
          const confident = detections.filter(d => d.categories[0]?.score >= FACE_MIN_CONF).length;
          if (confident === 0 && !landmarksVisible) noFaceStreak += 1;
          else noFaceStreak = 0;
          if (confident > 1) multiFaceStreak += 1;
          else multiFaceStreak = 0;

          if (noFaceStreak === SUSTAIN_FACE) {
            emit("no_face", "No face visible — camera may be covered or the student left", 0.9);
          } else if (noFaceStreak > SUSTAIN_FACE && noFaceStreak % 6 === 0) {
            emit("no_face", "Still no face visible in the camera", 0.9);
          }
          if (multiFaceStreak === SUSTAIN_FACE) {
            emit("multiple_faces", `${confident} people detected — only one person is allowed`, 0.9);
          } else if (multiFaceStreak > SUSTAIN_FACE && multiFaceStreak % 6 === 0) {
            emit("multiple_faces", `${confident} people still in frame`, 0.9);
          }
          setStatus(s => ({ ...s, faceCount: landmarksVisible ? Math.max(confident, 1) : confident }));
        } catch { /* model busy */ }
      }

      // ── Phone / object detection (slow cadence — heavy model) ───────────
      if (objDetRef.current && now - tPhone.current > PHONE_MS) {
        tPhone.current = now;
        try {
          const { detections } = objDetRef.current.detectForVideo(video, now) as {
            detections: Array<{ categories: Array<{ categoryName: string; score: number }> }>
          };
          const phoneHit = detections.find(d =>
            d.categories.some(c => {
              const n = c.categoryName.toLowerCase();
              return (n.includes("cell phone") || n.includes("mobile phone")) && c.score >= PHONE_MIN_CONF;
            })
          );
          if (phoneHit) {
            const conf = phoneHit.categories[0].score;
            emit("phone_detected", `Mobile phone detected in view (${Math.round(conf * 100)}% conf)`, conf);
            setStatus(s => ({ ...s, phoneDetected: true }));
          } else {
            setStatus(s => ({ ...s, phoneDetected: false }));
          }

          // Only clear "other electronics" — laptop/tv/monitor — and only at
          // high confidence. Headphones/earbuds/pads are dropped: a student
          // wearing earbuds is not an exam violation by itself.
          const electronicsHit = detections.find(d =>
            d.categories.some(c => {
              const n = c.categoryName.toLowerCase();
              return (n.includes("laptop") || n.includes("tv") || n.includes("monitor")) && c.score >= LAPTOP_MIN_CONF;
            })
          );
          if (electronicsHit) {
            const conf = electronicsHit.categories[0].score;
            emit("laptop_detected", `Electronic device visible: ${electronicsHit.categories[0].categoryName} (${Math.round(conf * 100)}% conf)`, conf);
          }
        } catch { /* skip */ }
      }

      // ── Audio / voice (sustained before flagging) ──────
      if (analyserRef.current && audioBufRef.current && now - tAudio.current > AUDIO_MS) {
        tAudio.current = now;
        analyserRef.current.getFloatTimeDomainData(audioBufRef.current);
        const rms = Math.sqrt(
          audioBufRef.current.reduce((acc, v) => acc + v * v, 0) / audioBufRef.current.length
        );
        const voiceLevel    = Math.min(1, rms / 0.08);
        const voiceSpeaking = rms > VOICE_RMS;
        if (voiceSpeaking) audioStreak += 1;
        else audioStreak = Math.max(0, audioStreak - 1);
        if (audioStreak === SUSTAIN_AUDIO) {
          emit("audio_detected", "Sustained voice or unexpected audio detected", voiceLevel);
        } else if (audioStreak > SUSTAIN_AUDIO && audioStreak % 12 === 0) {
          emit("audio_detected", "Voice/audio still detected", voiceLevel);
        }
        setStatus(s => ({ ...s, voiceLevel, voiceSpeaking: voiceSpeaking && audioStreak >= 2 }));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, status.loading, emit]);

  // Propagate status to parent
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  return (
    <div className="pointer-events-none absolute h-0 w-0 opacity-0 overflow-hidden">
      <video ref={videoRef} playsInline muted className="pointer-events-none sr-only" />
    </div>
  );
}
