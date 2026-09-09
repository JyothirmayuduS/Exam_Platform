// ProctorAI.tsx — real-time AI proctoring for the Vignan Lockdown Exam
//
// This component is now a THIN CONTROLLER. All decision logic lives in the
// modular engine under src/proctoring/ (unit-tested, no DOM):
//
//   models (MediaPipe)     / loaded here (same-origin first, CDN fallback)
//   face / gaze / audio    / read here from the shared camera <video>
//   raw object detections  / classified (labels.ts), identity-tracked and
//                            temporally confirmed (ObjectTracker.ts)
//   phone + head-pose      / fused (fusion.ts) — "head down" NEVER claims a
//                            phone by itself; "possible phone use" requires
//                            BOTH a confirmed phone AND a sustained head-down
//   dedupe / risk          / ViolationGate + RiskEngine
//   diagnostics            / diag sink read by ProctorDebugOverlay (dev only)
//
// The component renders an invisible <video> receiving the camera stream and
// emits violation events to the parent — its public props are unchanged.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CADENCE,
  PHONE_ACK_MS,
  GAZE,
  FACE,
  OBJECT,
  AUDIO,
  ObjectTracker,
  RiskEngine,
  ViolationGate,
  classifyObject,
  decideObjectEvent,
  gazeLabel,
  lowerRegion,
  pushObjectSample,
  proctorDiag,
} from "../proctoring";
import type { Detection, ProctorCategory, RiskLevel } from "../proctoring";
import { env } from "../lib/env";
import ProctorDebugOverlay from "./ProctorDebugOverlay";

// ── Public types (kept for back-compat; machine ids now come from the engine) ─
export type AIViolationType = ProctorCategory;

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
  /** Risk engine (0..100) — set when it changes. */
  riskScore?: number;
  riskLevel?: RiskLevel;
}

interface Props {
  /** The camera + mic MediaStream from getUserMedia. */
  cameraStream: MediaStream | null;
  /** True only while the exam step is active. Models stay loaded but loop stops. */
  active: boolean;
  onViolation: (v: AIViolation) => void;
  onStatus?: (s: AIStatus) => void;
}

// ── Timing / cadence (all tunable in src/proctoring/config.ts) ──────────────
const GAZE_MS    = CADENCE.GAZE_MS;
const FACE_MS    = CADENCE.FACE_MS;
const OBJECT_MS  = CADENCE.OBJECT_MS;
const AUDIO_MS   = CADENCE.AUDIO_MS;

// ── Asset loading: SAME-ORIGIN FIRST, CDN fallback ─────────────────────────
// The WASM runtime and the three model files are vendored into the app bundle
// (public/ai/…) and loaded from the app's OWN origin, so the AI engine works
// even when Google's model CDN (storage.googleapis.com) or jsDelivr is blocked
// or flaky on the candidate's network — the classic "AI never detects" failure
// in the field. The CDN URLs are kept as automatic fallbacks and each source
// is retried with backoff before giving up.
//
// BASE_URL keeps the paths correct under sub-path deployments and the Tauri
// asset protocol (Vite base is `/` in dev and on Vercel).
const APP_BASE = import.meta.env.BASE_URL || "/";
const MP_WASM = `${APP_BASE}ai/wasm`;

// Google's model CDN (fallback when the same-origin copy is unreachable).
const MODEL_FACE_DET_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MODEL_FACE_LM_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_OBJ_DET_CDN =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

// Order matters: same-origin (guaranteed by the app's own hosting) first, then
// the CDN mirror. The SDK fetches modelAssetPath internally; createFromOptions
// throws when a source is unreachable, so we walk the list on failure.
const MODEL_FACE_DET_SOURCES = [`${APP_BASE}ai/models/blaze_face_short_range.tflite`, MODEL_FACE_DET_CDN];
const MODEL_FACE_LM_SOURCES  = [`${APP_BASE}ai/models/face_landmarker.task`, MODEL_FACE_LM_CDN];
const MODEL_OBJ_DET_SOURCES  = [`${APP_BASE}ai/models/efficientdet_lite0.tflite`, MODEL_OBJ_DET_CDN];

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

/** Per-kind confidence gate (mirrors the pipeline test's gating rule). */
function minConfForKind(kind: Detection["kind"]): number {
  if (kind === "phone") return OBJECT.PHONE_MIN_CONF;
  if (kind === "earbuds") return OBJECT.EARBUDS_MIN_CONF;
  return OBJECT.LAPTOP_MIN_CONF;
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
//   1   / nose tip     33 / left eye outer corner
// 152   / chin        263 / right eye outer corner
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
    if (dev < GAZE.DEVIATION * 0.8) {
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

/** Raw MediaPipe detection / normalized, confidence-gated engine Detections.
 *
 *  MediaPipe's ObjectDetector returns the bounding box in PIXELS
 *  (originX / originY / width / height), NOT normalized [0,1] units. Clamping
 *  those pixel values into [0,1] collapsed every phone to the bottom-right
 *  corner of the frame — which silently wrecked IoU identity tracking
 *  (geometry.ts), desk-ROI filtering and the debug overlay, the #1 cause of
 *  "proctoring never detects". We must divide by the actual video resolution.
 */
function toDetections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  video: HTMLVideoElement,
): Detection[] {
  const out: Detection[] = [];
  // Guard against a still-initializing / 0x0 video (iOS Safari sometimes reads
  // videoWidth 0 until the first decoded frame).
  const vw = Math.max(1, video.videoWidth || 0);
  const vh = Math.max(1, video.videoHeight || 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of result?.detections ?? []) {
    for (const c of d?.categories ?? []) {
      const kind = classifyObject(String(c.categoryName ?? ""));
      const score = Number(c.score ?? 0);
      if (!kind || !d.boundingBox) continue;
      const box = d.boundingBox;
      const minConf = minConfForKind(kind);
      if (score < minConf) continue; // gate here — the model threshold stays low
      // Real pixel dims, never negative, clamped to the visible frame.
      const px = Math.max(0, Number(box.originX ?? 0));
      const py = Math.max(0, Number(box.originY ?? 0));
      const pw = Math.max(0, Number(box.width ?? 0));
      const ph = Math.max(0, Number(box.height ?? 0));
      out.push({
        kind,
        label: String(c.categoryName),
        score,
        bbox: {
          x: Math.min(1, px / vw),
          y: Math.min(1, py / vh),
          width: Math.min(1, pw / vw),
          height: Math.min(1, ph / vh),
        },
      });
    }
  }
  return out;
}

/**
 * Second detection pass on an upscaled crop of the lower desk/hands region.
 *
 * Phones are small objects: the full-frame pass frequently misses a phone that
 * comfortably fills 40% of a quarter-frame crop. We copy the bottom
 * `PHONE_ROI_FRACTION` of the frame to an offscreen canvas (up to the input
 * dimensions MediaPipe already works at), run the IMAGE-mode detector, and map
 * every returned PIXEL box back into FULL-FRAME normalized [0,1] coordinates
 * so it composes with the full-frame pass before identity tracking.
 */
function detectDeskRoi(
  now: number,
  vw: number,
  vh: number,
  video: HTMLVideoElement,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roiDetector: any,
): Detection[] {
  const roi = lowerRegion(OBJECT.PHONE_ROI_FRACTION); // normalized full-frame ROI
  const roiX = Math.round(roi.x * vw);
  const roiY = Math.round(roi.y * vh);
  const roiW = Math.round(roi.width * vw);
  const roiH = Math.round(roi.height * vh);
  if (roiW < 16 || roiH < 16) return [];

  try {
    const canvas = document.createElement("canvas");
    canvas.width = roiW;
    canvas.height = roiH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(video, -roiX, -roiY);

    if (!roiDetector) return [];
    const result = roiDetector.detect(canvas);
    const out: Detection[] = [];
    for (const d of result?.detections ?? []) {
      for (const c of d?.categories ?? []) {
        const kind = classifyObject(String(c.categoryName ?? ""));
        const score = Number(c.score ?? 0);
        if (!kind || !d.boundingBox) continue;
        const box = d.boundingBox;
        const minConf = minConfForKind(kind);
        if (score < minConf) continue;
        // Crop-local pixels / full-frame normalized.
        const px = Math.max(0, Number(box.originX ?? 0)) + roiX;
        const py = Math.max(0, Number(box.originY ?? 0)) + roiY;
        const pw = Math.max(0, Number(box.width ?? 0));
        const ph = Math.max(0, Number(box.height ?? 0));
        out.push({
          kind,
          label: String(c.categoryName),
          score,
          bbox: {
            x: Math.min(1, px / vw),
            y: Math.min(1, py / vh),
            width: Math.min(1, pw / vw),
            height: Math.min(1, ph / vh),
          },
        });
      }
    }
    return out;
  } catch {
    return []; // ROI pass is best-effort — never crash the detection loop
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
  const objDetRef   = useRef<any>(null);     // VIDEO mode for full-frame
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objDetRoiRef = useRef<any>(null);    // IMAGE mode for desk-ROI crop

  // Engine singletons (stable for the component's lifetime; created once in an
  // effect so refs are never touched during render). They survive active/pause
  // cycles — only a true unmount (leaving the exam) discards risk + cooldowns.
  const trackerRef = useRef<ObjectTracker | null>(null);
  const gateRef    = useRef<ViolationGate | null>(null);
  const riskRef    = useRef<RiskEngine | null>(null);
  const riskShown  = useRef<string>("");

  useEffect(() => {
    trackerRef.current ??= new ObjectTracker();
    gateRef.current ??= new ViolationGate();
    riskRef.current ??= new RiskEngine();
  }, []);

  // Latest gaze state, consumed by fusion when an object confirms.
  const gazeFusion = useRef<{ headDown: boolean; headDownSince: number | null; direction: "center" | "left" | "right" | "up" | "down" }>({
    headDown: false,
    headDownSince: null,
    direction: "center",
  });

  // Audio analysis
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  // Rolling ambient-noise floor for the adaptive voice gate (see AUDIO config).
  const noiseFloorRef = useRef(0.004);
  const noiseFloorAtRef = useRef(0);

  // Timing refs
  const rafRef   = useRef(0);
  const tFace    = useRef(0);
  const tGaze    = useRef(0);
  const tPhone   = useRef(0);
  const tAudio   = useRef(0);
  const lastAck  = useRef(0);
  const lastEarbudsAck = useRef(0);
  const frameDims = useRef(""); // diag: log the frame size once per change
  // rAF fps measurement (diagnostics)
  const fpsFrames = useRef(0);

  // Behavioral pattern detection for mobile phone use outside camera frame
  // Detects suspicious patterns like sustained head-down + hand movement
  const behavioralRef = useRef({
    headDownStartTime: null as number | null,
    frameDiffHistory: [] as Uint8ClampedArray[],
    suspiciousBehaviorStreak: 0,
    lastAnalysisTime: 0,
  });
  const fpsAt     = useRef(0);

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

  // Push the current risk state to React only when it actually changed
  // (keeps the parent from re-rendering on every tick).
  const syncRisk = useCallback(() => {
    const risk = riskRef.current;
    if (!risk) return;
    const s = risk.state;
    const key = `${s.score}:${s.level}`;
    if (key === riskShown.current) return;
    riskShown.current = key;
    proctorDiag.risk = s;
    setStatus((prev) => ({ ...prev, riskScore: s.score, riskLevel: s.level }));
  }, []);

  // Violation emitter: cooldown gate (dedupe) / risk / evidence frame / parent.
  const emit = useCallback(
    (category: ProctorCategory, label: string, confidence: number) => {
      const now = Date.now();
      const gate = gateRef.current;
      const risk = riskRef.current;
      if (!gate || !risk) return;
      if (!gate.allows(category, now)) return;
      gate.markFired(category, now);
      risk.add(category, now);
      syncRisk();
      onViolation({ type: category, label, confidence, at: now, evidenceBlob: captureEvidence() });
    },
    [onViolation, captureEvidence, syncRisk]
  );

  // Reset identity tracking when the camera stream changes (new session /
  // resolution) so stale boxes never follow the wrong candidate.
  useEffect(() => {
    trackerRef.current?.reset();
  }, [cameraStream]);

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

    // Browsers start a fresh AudioContext SUSPENDED unless it was created in a
    // direct user-gesture call stack — and the exam flow creates this one from
    // an effect, so RMS read 0 forever and voice was never detected. resume()
    // flips it to running; if the browser still blocks it, retry once on the
    // next user interaction.
    if (ctx.state !== "running") {
      void ctx.resume().then(() => {
        if (ctx.state !== "running") {
          console.warn("[ProctorAI] AudioContext suspended — voice detection idle until first user interaction");
          const kick = () => {
            void ctx.resume();
            window.removeEventListener("pointerdown", kick);
            window.removeEventListener("keydown", kick);
          };
          window.addEventListener("pointerdown", kick, { once: true });
          window.addEventListener("keydown", kick, { once: true });
        }
      }).catch(() => {});
    }

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    audioBufRef.current = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));

    // Web Speech API for lightweight STT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recognition: any = null;
    let sttAlive = false;
    if (SpeechRecognition) {
      sttAlive = true;
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

      // Chrome ENDS the recognition stream after each utterance (and after
      // ~60 s even with continuous=true). Without an onend restart the STT
      // went silent one minute into every exam. Restart with a small backoff
      // until the effect tears down; 'not-allowed' means the mic was revoked.
      recognition.onend = () => {
        if (!sttAlive) return;
        window.setTimeout(() => {
          if (!sttAlive) return;
          try { recognition.start(); } catch { /* already started */ }
        }, 250);
      };
      recognition.onerror = (e: any) => {
        if (e?.error === "not-allowed" || e?.error === "service-not-allowed") sttAlive = false;
      };

      try { recognition.start(); } catch { /* ignore */ }
    }

    return () => {
      sttAlive = false;
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
  //
  // Each model also tries its SOURCE LIST (same-origin copy first, CDN mirror
  // second) with retry + backoff, so a flaky or blocked network can't leave
  // the AI engine half-loaded — the root cause of "proctoring never detects".
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

    // Try each asset source (same-origin / CDN) with 2 retries + backoff so a
    // transient network failure on a big file doesn't kill the model.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withRetry = async (make: (source: string) => Promise<any>, sources: string[], step: string): Promise<any> => {
      let lastErr: unknown = null;
      for (const source of sources) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            setStatus(s => ({ ...s, loadStep: `${step} — retry ${attempt}/2…` }));
            await new Promise(r => setTimeout(r, 800 * attempt));
          }
          try {
            return await make(source);
          } catch (err) {
            lastErr = err;
            console.warn(`[ProctorAI] ${step} failed (${source}, attempt ${attempt + 1}):`, err);
          }
        }
      }
      throw lastErr ?? new Error(`${step} failed`);
    };

    void (async () => {
      try {
        setStatus(s => ({ ...s, loadStep: "Loading AI engine (first run ~10 s)…" }));
        const vision = await getVision();
        if (!alive) return;

        const { FaceDetector, FaceLandmarker, ObjectDetector } = await import("@mediapipe/tasks-vision");

        if (!faceDetRef.current) {
          faceDetRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                FaceDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  minDetectionConfidence: 0.5,
                }),
              "Loading face detector…",
            ),
            MODEL_FACE_DET_SOURCES,
            "face detector",
          );
        }
        if (!alive) return;

        if (!landmarkRef.current) {
          landmarkRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                FaceLandmarker.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  numFaces: 3,
                  outputFaceBlendshapes: false,
                  outputFacialTransformationMatrixes: false,
                }),
              "Loading gaze tracker…",
            ),
            MODEL_FACE_LM_SOURCES,
            "gaze tracker",
          );
        }
        if (!alive) return;

        if (!objDetRef.current) {
          objDetRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                ObjectDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  scoreThreshold: OBJECT.SCORE_THRESHOLD,
                  maxResults: OBJECT.MAX_RESULTS,
                }),
              "Loading object detector…",
            ),
            MODEL_OBJ_DET_SOURCES,
            "object detector",
          );
        }
        if (!alive) return;

        // IMAGE-mode detector for the desk-ROI second pass (can't reuse VIDEO mode)
        if (!objDetRoiRef.current) {
          objDetRoiRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                ObjectDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "IMAGE",
                  scoreThreshold: OBJECT.SCORE_THRESHOLD,
                  maxResults: OBJECT.MAX_RESULTS,
                }),
              "Loading desk-ROI object detector…",
            ),
            MODEL_OBJ_DET_SOURCES,
            "desk-ROI object detector",
          );
        }
        if (!alive) return;

        setStatus(s => ({ ...s, loading: false, loadStep: "AI proctor active" }));
      } catch (err) {
        console.error("[ProctorAI] model load error:", err);
        if (alive) {
          proctorDiag.engineError = err instanceof Error ? err.message : String(err);
          setStatus(s => ({ ...s, loading: false, error: true, loadStep: "AI unavailable — manual review only" }));
        }
      }
    })();

    return () => { alive = false; };
  }, [active]);

  // Main detection loop. Every decision is gated on a SUSTAINED condition (a
  // single jitter frame never flags) and — for gaze — on deviation from the
  // student's own calibrated neutral pose, which removes camera-angle bias.
  // Object events additionally require TEMPORAL CONFIRMATION (ObjectTracker)
  // and are fused with the head pose (fusion.ts).
  useEffect(() => {
    if (!active || status.loading) return;
    let running = true;
    const gaze = freshGaze();
    let noFaceStreak = 0;
    let multiFaceStreak = 0;
    let audioStreak = 0;
    let earbudsStreak = 0;
    let landmarksVisible = false;

    // 1 Hz risk decay — clean behavior steadily lowers the score.
    const decayId = window.setInterval(() => {
      riskRef.current?.advance();
      syncRisk();
    }, 1_000);

    const tick = () => {
      if (!running) return;
      const now   = Date.now();
      const video = videoRef.current;

      // Diagnostics: fps (only needed for the dev overlay — cheap math).
      if (fpsAt.current === 0) fpsAt.current = now;
      fpsFrames.current += 1;
      if (now - fpsAt.current >= 1_000) {
        proctorDiag.fps = Math.round((fpsFrames.current * 1_000) / (now - fpsAt.current));
        fpsFrames.current = 0;
        fpsAt.current = now;
      }

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
            if (outOfBounds && gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
              emit("partial_face", "Face partially out of frame — centre yourself in the camera", 0.85);
            }

            const g = estimateGaze(lms);
            const devPitch = Math.abs(g.pitch - gaze.pitch);
            const devYaw   = Math.abs(g.yaw - gaze.yaw);
            const dev      = Math.max(devPitch, devYaw);
            updateGazeBaseline(gaze, g, dev);

            if (gaze.calibrated) {
              const neutral = dev < GAZE.DEVIATION;
              if (neutral) {
                gaze.awayStreak = Math.max(0, gaze.awayStreak - 1);
                gaze.clearStreak += 1;
                if (gaze.clearStreak >= GAZE.CLEAR_SAMPLES) gaze.awayStreak = 0;
              } else {
                gaze.clearStreak = 0;
                gaze.awayStreak += 1;
              }

              let dir: AIStatus["gazeDirection"] = "center";
              if (gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
                if (devYaw >= devPitch) dir = g.yaw < gaze.yaw ? "left" : "right";
                else dir = g.pitch < gaze.pitch ? "up" : "down";
                const conf = Math.min(1, dev / (GAZE.DEVIATION * 3));
                if (gaze.awayStreak === GAZE.SUSTAIN_SAMPLES || gaze.awayStreak % 24 === 0) {
                  emit("gaze_away", gazeLabel(dir), conf);
                }
              }

              // Feed the fusion layer: sustained head-down state + direction.
              const wasDown = gazeFusion.current.headDown;
              gazeFusion.current.direction = dir;
              if (dir === "down" && gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
                if (!wasDown) gazeFusion.current.headDownSince = now;
                gazeFusion.current.headDown = true;
              } else {
                gazeFusion.current.headDown = false;
                gazeFusion.current.headDownSince = null;
              }

              setStatus(s => ({ ...s, gazeDirection: dir, gazeScore: Math.max(0, Math.min(1, 1 - dev / (GAZE.DEVIATION * 3))) }));

              // ── Behavioral pattern detection for mobile phone use ──────
              // Detect sustained head-down + frame movement that suggests
              // the candidate is looking at something below the screen (phone)
              if (dir === "down" && gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
                if (!behavioralRef.current.headDownStartTime) {
                  behavioralRef.current.headDownStartTime = now;
                }
                const headDownDuration = now - behavioralRef.current.headDownStartTime;

                // Analyze frame for hand movement (suggesting holding a phone)
                if (videoRef.current && now - behavioralRef.current.lastAnalysisTime > 500) {
                  behavioralRef.current.lastAnalysisTime = now;
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = 64;
                    canvas.height = 48;
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      // Capture lower portion of frame (where hands/phone would be)
                      ctx.drawImage(
                        videoRef.current,
                        0, videoRef.current.videoHeight * 0.5,
                        videoRef.current.videoWidth, videoRef.current.videoHeight * 0.5,
                        0, 0, 64, 48
                      );
                      const frameData = ctx.getImageData(0, 0, 64, 48).data;

                      // Calculate frame difference to detect movement
                      if (behavioralRef.current.frameDiffHistory.length > 0) {
                        const lastFrame = behavioralRef.current.frameDiffHistory[behavioralRef.current.frameDiffHistory.length - 1];
                        if (lastFrame) {
                          let diff = 0;
                          for (let i = 0; i < frameData.length; i += 4) {
                            diff += Math.abs(frameData[i]! - lastFrame[i]!);
                          }
                          diff /= (frameData.length / 4);

                          // Significant movement while head is down = suspicious
                          if (diff > 15 && headDownDuration > 3000) {
                            behavioralRef.current.suspiciousBehaviorStreak++;
                            if (behavioralRef.current.suspiciousBehaviorStreak >= 3) {
                              emit("possible_phone_use", "Suspicious behavior detected — possible mobile device use below camera view", 0.7);
                              behavioralRef.current.suspiciousBehaviorStreak = 0;
                            }
                          } else if (diff < 5) {
                            behavioralRef.current.suspiciousBehaviorStreak = Math.max(0, behavioralRef.current.suspiciousBehaviorStreak - 1);
                          }
                        }
                      }

                      // Store frame data for comparison (copy the array)
                      const frameCopy = new Uint8ClampedArray(frameData.length);
                      frameCopy.set(frameData);
                      behavioralRef.current.frameDiffHistory.push(frameCopy);
                      if (behavioralRef.current.frameDiffHistory.length > 5) {
                        behavioralRef.current.frameDiffHistory.shift();
                      }
                    }
                  } catch { /* ignore frame analysis errors */ }
                }
              } else {
                behavioralRef.current.headDownStartTime = null;
                behavioralRef.current.suspiciousBehaviorStreak = 0;
                behavioralRef.current.frameDiffHistory = [];
              }
            }
          } else {
            // No landmarks — head state is unknown, so fusion must not treat
            // stale "head down" as ongoing.
            gazeFusion.current.headDown = false;
            gazeFusion.current.headDownSince = null;
            gazeFusion.current.direction = "center";
            behavioralRef.current.headDownStartTime = null;
            behavioralRef.current.suspiciousBehaviorStreak = 0;
            behavioralRef.current.frameDiffHistory = [];
          }
        } catch { /* model busy */ }
      }

      // ── Face count (landmarks veto the "no face" false positive) ────────
      if (faceDetRef.current && now - tFace.current > FACE_MS) {
        tFace.current = now;
        try {
          const { detections } = faceDetRef.current.detectForVideo(video, now) as { detections: Array<{ categories: Array<{ score: number }> }> };
          const confident = detections.filter(d => d.categories[0]?.score >= FACE.MIN_CONF).length;
          if (confident === 0 && !landmarksVisible) noFaceStreak += 1;
          else noFaceStreak = 0;
          if (confident > 1) multiFaceStreak += 1;
          else multiFaceStreak = 0;

          if (noFaceStreak === FACE.SUSTAIN) {
            emit("no_face", "No face visible — camera may be covered or the student left", 0.9);
          } else if (noFaceStreak > FACE.SUSTAIN && noFaceStreak % 6 === 0) {
            emit("no_face", "Still no face visible in the camera", 0.9);
          }
          if (multiFaceStreak === FACE.SUSTAIN) {
            emit("multiple_faces", `${confident} people detected — only one person is allowed`, 0.9);
          } else if (multiFaceStreak > FACE.SUSTAIN && multiFaceStreak % 6 === 0) {
            emit("multiple_faces", `${confident} people still in frame`, 0.9);
          }
          setStatus(s => ({ ...s, faceCount: landmarksVisible ? Math.max(confident, 1) : confident }));
        } catch { /* model busy */ }
      }

      // ── Object detection: track + confirm, then fuse with head pose ─────
      // (moderate cadence — the heaviest model; raw frames never become events)
      if (objDetRef.current && now - tPhone.current > OBJECT_MS) {
        tPhone.current = now;
        try {
          // TWo-PASS DETECTION for maximum phone sensitivity:
          //   1. the full frame,
          //   2. a zoomed crop of the lower desk/hands region (where phones are
          //      held) — small phones the model misses at full-frame size are
          //      caught on the upsized crop, then the boxes are mapped back to
          //      full-frame normalized coordinates before tracking.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = objDetRef.current.detectForVideo(video, now);
          const dets: Detection[] = toDetections(result, video);

          if (OBJECT.USE_PHONE_ROI && video.videoWidth > 0 && video.videoHeight > 0) {
            const roi: Detection[] = detectDeskRoi(now, video.videoWidth, video.videoHeight, video, objDetRoiRef.current);
            // Merged ROI detections are normalized to the SAME [0,1] full-frame
            // coordinate space, so they compose cleanly with the full-frame pass.
            dets.push(...roi);
          }

          // Diagnostics: log EVERY raw detection the model returns — benign
          // objects, sub-threshold phones, low scores included — plus the
          // frame size once, so a missing phone can be traced to the model
          // output (label / index / confidence / box), never guessed at.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = (result?.detections ?? []) as Array<{
            categories?: Array<{ categoryName?: string; score?: number; index?: number }>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            boundingBox?: any;
          }>;
          const vw = video.videoWidth || 0;
          const vh = video.videoHeight || 0;
          if (frameDims.current !== `${vw}x${vh}`) {
            frameDims.current = `${vw}x${vh}`;
            pushObjectSample(`frame ${vw}x${vh}`);
          }
          if (raw.length === 0) pushObjectSample("(no objects)");
          for (const d of raw) {
            const c = d.categories?.[0];
            if (!c) continue;
            const b = d.boundingBox ?? {};
            const box = [Number(b.originX ?? 0).toFixed(2), Number(b.originY ?? 0).toFixed(2), Number(b.width ?? 0).toFixed(2), Number(b.height ?? 0).toFixed(2)].join(",");
            pushObjectSample(`${c.categoryName ?? "?"} ${Math.round((c.score ?? 0) * 100)}% idx=${c.index ?? "?"} box=(${box})`);
          }

          const tracker = trackerRef.current;
          if (tracker) {
            const fresh = tracker.update(dets, now);
            for (const track of fresh) {
              const outcome = decideObjectEvent(track, gazeFusion.current, now);
              if (outcome.fired) emit(outcome.category, outcome.label, outcome.confidence);
              if (track.kind === "phone") lastAck.current = now; // fresh confirm — reset the heartbeat
            }
          }

          // Slow re-acknowledgement while a CONFIRMED phone stays in view.
          const liveConfirmed = tracker?.live.some(
            (t) => t.kind === "phone" && t.confirmed && now - t.lastSeen <= 4_000
          );
          if (liveConfirmed && now - lastAck.current >= PHONE_ACK_MS) {
            lastAck.current = now;
            const track = tracker?.live.find(
              (t) => t.kind === "phone" && t.confirmed && now - t.lastSeen <= 4_000
            );
            if (track) {
              const outcome = decideObjectEvent(track, gazeFusion.current, now);
              if (outcome.fired) emit(outcome.category, outcome.label, outcome.confidence);
            }
          }

          setStatus(s => ({ ...s, phoneDetected: liveConfirmed === true }));
        } catch { /* skip */ }
      }

      // ── Audio / voice (sustained before flagging) ──────
      if (analyserRef.current && audioBufRef.current && now - tAudio.current > AUDIO_MS) {
        tAudio.current = now;
        analyserRef.current.getFloatTimeDomainData(audioBufRef.current);
        const rms = Math.sqrt(
          audioBufRef.current.reduce((acc, v) => acc + v * v, 0) / audioBufRef.current.length
        );
        // Adaptive gate: track the AMBIENT noise floor (rolling min ≈ the
        // quietest 5 s window) and require speech to clear a multiple of it —
        // quiet laptop mics peaked at 0.02 RMS, far under the old fixed 0.04.
        const floor = noiseFloorRef.current;
        if (rms < floor) {
          noiseFloorRef.current = floor + (rms - floor) * 0.05; // fast fall
        } else if (now - noiseFloorAtRef.current > 5_000) {
          noiseFloorRef.current = floor + (rms - floor) * 0.02; // slow rise
          noiseFloorAtRef.current = now;
        }
        const voiceGate = Math.max(AUDIO.VOICE_RMS_MIN, noiseFloorRef.current * AUDIO.VOICE_NOISE_FACTOR);
        const voiceLevel    = Math.min(1, rms / Math.max(0.06, voiceGate * 2));
        const voiceSpeaking = rms > voiceGate;
        if (voiceSpeaking) audioStreak += 1;
        else audioStreak = Math.max(0, audioStreak - 1);
        if (audioStreak === AUDIO.SUSTAIN) {
          emit("audio_detected", "Sustained voice or unexpected audio detected", voiceLevel);
        } else if (audioStreak > AUDIO.SUSTAIN && audioStreak % 12 === 0) {
          emit("audio_detected", "Voice/audio still detected", voiceLevel);
        }

        // ── Earbud/headphone leak detection ─────────────────────────────────
        // A faint PERSISTENT BROADBAND signal is the earbud-leak signature:
        // music/lecture audio spreads energy across many bins between 250 Hz
        // and 8 kHz, while silence has none and mechanical noise (fan, AC)
        // concentrates in a handful of low bins. Speech is EXCLUDED here —
        // direct speech is loud (rms above the leak window) and intermittent.
        //
        // The old heuristic never fired in the field: it demanded the RMS sit
        // in a razor-thin window AND two per-band averages exceed floors no
        // real leak reaches (byte spectrum values are tiny when energy is
        // spread thin). The new rule counts ACTIVE BINS, not average energy.
        if (
          analyserRef.current &&
          rms >= AUDIO.EARBUDS_RMS_MIN &&
          rms <= AUDIO.EARBUDS_RMS_MAX &&
          !voiceSpeaking
        ) {
          const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(freqData);

          const binHz = analyserRef.current.context.sampleRate / 2 / freqData.length;
          const lowIdx  = Math.max(1, Math.ceil(AUDIO.EARBUDS_FREQ_LOW / binHz));
          const highIdx = Math.min(freqData.length - 1, Math.floor(AUDIO.EARBUDS_FREQ_HIGH / binHz));

          // Count bins with meaningful energy — broadband content keeps many
          // bins above the floor; tonal/mechanical noise keeps only a few.
          let activeBins = 0;
          for (let i = lowIdx; i <= highIdx; i++) {
            if (freqData[i] >= AUDIO.EARBUDS_ACTIVE_BIN_FLOOR) activeBins += 1;
          }

          if (activeBins >= AUDIO.EARBUDS_MIN_ACTIVE_BINS) {
            earbudsStreak += 1;
            if (earbudsStreak === AUDIO.EARBUDS_SUSTAIN) {
              lastEarbudsAck.current = now;
              emit(
                "earbuds_detected",
                `Audio leak consistent with earbuds/headphones (${activeBins} active frequency bands, sustained)`,
                Math.min(0.9, 0.4 + activeBins / 64),
              );
            } else if (
              earbudsStreak > AUDIO.EARBUDS_SUSTAIN &&
              now - lastEarbudsAck.current >= AUDIO.EARBUDS_ACK_MS
            ) {
              // Still leaking — re-notify so the log shows ongoing presence.
              lastEarbudsAck.current = now;
              emit(
                "earbuds_detected",
                "Audio leak still present — earbuds/headphones likely in use",
                Math.min(0.9, 0.4 + activeBins / 64),
              );
            }
          } else {
            earbudsStreak = Math.max(0, earbudsStreak - 1);
          }
        } else {
          earbudsStreak = Math.max(0, earbudsStreak - 1);
        }

        setStatus(s => ({ ...s, voiceLevel, voiceSpeaking: voiceSpeaking && audioStreak >= 2 }));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      window.clearInterval(decayId);
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, status.loading, emit, syncRisk]);

  // Propagate status to parent
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  // Mirror live status + tracks into the diag sink for the dev overlay. The
  // sink lives outside React so the AI loop itself never triggers renders.
  useEffect(() => {
    proctorDiag.loadStep = status.loadStep;
    proctorDiag.faceCount = status.faceCount;
    proctorDiag.gazeDirection = status.gazeDirection;
    proctorDiag.gazeScore = status.gazeScore;
    proctorDiag.phoneDetected = status.phoneDetected;
    proctorDiag.voiceLevel = status.voiceLevel;
    proctorDiag.voiceSpeaking = status.voiceSpeaking;
    proctorDiag.tracks = trackerRef.current?.live ?? [];
  }, [status]);

  // The analysis <video> must stay in the document at a REAL (painted) size:
  // iOS Safari stops decoding frames for 0x0 / display:none video elements, so
  // detection silently never fires on phones. It renders transparent at the
  // bottom corner — invisible to the student, but WebKit keeps advancing frames.
  return (
    <>
      <div className="pointer-events-none fixed bottom-1 left-1 z-[-1] h-[180px] w-[240px] opacity-0">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full" />
      </div>
      <ProctorDebugOverlay enabled={env.proctorDebug} />
    </>
  );
}
