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
  no_face:        2_000,
  multiple_faces: 1_500,
  gaze_away:      1_000,
  phone_detected: 1_500,
  laptop_detected: 2_000,
  audio_detected: 2_000,
  partial_face:   2_000,
};

const GAZE_THRESH      = 0.35;  // normalised head-pose deviation to trigger flag
const VOICE_RMS        = 0.018; // RMS amplitude above which we flag speaking
const FACE_MS          = 200;   // face-count detection interval
const GAZE_MS          = 100;   // gaze estimation interval
const PHONE_MS         = 150;   // phone detection interval (fast model)
const AUDIO_MS         = 100;   // audio RMS check interval

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
// rough yaw (left/right) and pitch (up/down).
//
//   1   → nose tip     33 → left eye outer corner
// 152   → chin        263 → right eye outer corner

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

  const yaw      = ((nose.x - eyeMidX) / eyeSpan) * 2.2;
  const vertSpan = Math.abs(chin.y - eyeMidY) || 0.18;
  const pitch    = (((nose.y - eyeMidY) / vertSpan) - 0.48) * 2.0;

  return { yaw, pitch };
}

function gazeDir(yaw: number, pitch: number): AIStatus["gazeDirection"] {
  const t = GAZE_THRESH;
  if (Math.abs(yaw) <= t && Math.abs(pitch) <= t) return "center";
  return Math.abs(yaw) >= Math.abs(pitch)
    ? (yaw < 0 ? "left" : "right")
    : (pitch < 0 ? "down" : "up");
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

  // Violation emitter with per-type cooldown
  const emit = useCallback(
    (type: AIViolationType, label: string, confidence: number) => {
      const now = Date.now();
      if (now - (lastFlag.current[type] ?? 0) < COOL[type]) return;
      lastFlag.current[type] = now;
      onViolation({ type, label, confidence, at: now });
    },
    [onViolation]
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

  // Load MediaPipe models once; singletons survive unmount/remount
  useEffect(() => {
    if (!active) return;
    let alive = true;

    void (async () => {
      try {
        setStatus(s => ({ ...s, loadStep: "Downloading AI models (first run ~10 s)…" }));
        const vision = await getVision();
        if (!alive) return;

        const { FaceDetector, FaceLandmarker, ObjectDetector } = await import("@mediapipe/tasks-vision");

        if (!faceDetRef.current) {
          setStatus(s => ({ ...s, loadStep: "Loading face detector…" }));
          faceDetRef.current = await FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_FACE_DET, delegate: "GPU" },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.5,
          });
        }
        if (!alive) return;

        if (!landmarkRef.current) {
          setStatus(s => ({ ...s, loadStep: "Loading gaze tracker…" }));
          landmarkRef.current = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_FACE_LM, delegate: "GPU" },
            runningMode: "VIDEO",
            numFaces: 3,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          });
        }
        if (!alive) return;

        if (!objDetRef.current) {
          setStatus(s => ({ ...s, loadStep: "Loading object detector…" }));
          objDetRef.current = await ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_OBJ_DET, delegate: "GPU" },
            runningMode: "VIDEO",
            scoreThreshold: 0.20,
            maxResults: 6,
          });
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

  // Main detection loop
  useEffect(() => {
    if (!active || status.loading) return;
    let running = true;

    const tick = () => {
      if (!running) return;
      const now   = Date.now();
      const video = videoRef.current;

      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ── Face count ──────────────────────────────────────
      if (faceDetRef.current && now - tFace.current > FACE_MS) {
        tFace.current = now;
        try {
          const { detections } = faceDetRef.current.detectForVideo(video, now) as { detections: Array<{ categories: Array<{ score: number }> }> };
          const count = detections.length;
          if (count === 0) emit("no_face", "No face visible — camera may be covered", 0.9);
          else if (count > 1) emit("multiple_faces", `${count} people detected — only 1 person allowed`, 0.87);
          setStatus(s => ({ ...s, faceCount: count }));
        } catch { /* model busy */ }
      }

      // ── Gaze / head pose & Oral Movements ────────────────────────────────
      if (landmarkRef.current && now - tGaze.current > GAZE_MS) {
        tGaze.current = now;
        try {
          const { faceLandmarks } = landmarkRef.current.detectForVideo(video, now) as { faceLandmarks: Array<Array<{ x: number; y: number; z: number }>> };
          if (faceLandmarks.length > 0) {
            const lms = faceLandmarks[0];
            
            // Check if face is near the edges (partially cut off)
            let outOfBounds = false;
            for (const p of lms) {
              if (p.x < 0.02 || p.x > 0.98 || p.y < 0.02 || p.y > 0.98) {
                outOfBounds = true;
                break;
              }
            }
            if (outOfBounds) {
              emit("partial_face", "Face is partially cut off. Please center yourself in frame.", 0.9);
            }

            const { yaw, pitch } = estimateGaze(lms);
            const dir   = gazeDir(yaw, pitch);
            const score = Math.max(0, 1 - (Math.abs(yaw) + Math.abs(pitch)) / (2 * GAZE_THRESH));

            if (dir !== "center") {
              const dirLabel: Record<string, string> = {
                left:  "Looking left — eyes off screen",
                right: "Looking right — eyes off screen",
                up:    "Looking up — eyes off screen",
                down:  "Looking down — possible phone use",
              };
              emit("gaze_away", dirLabel[dir] ?? "Gaze off screen", Math.max(Math.abs(yaw), Math.abs(pitch)));
            }

            // Oral Movement Detection (using MediaPipe FaceMesh lips)
            // 13: Upper lip, inner
            // 14: Lower lip, inner
            const upperLip = lms[13];
            const lowerLip = lms[14];
            if (upperLip && lowerLip) {
              const mouthDist = Math.abs(upperLip.y - lowerLip.y);
              // Threshold tuned for an open mouth while speaking
              if (mouthDist > 0.035) {
                 emit("audio_detected", "Oral movement detected (mouth opening)", Math.min(mouthDist * 10, 1));
              }
            }

            setStatus(s => ({ ...s, gazeDirection: dir, gazeScore: score }));
          }
        } catch { /* skip */ }
      }

      // ── Phone / object detection ────────────────────────
      if (objDetRef.current && now - tPhone.current > PHONE_MS) {
        tPhone.current = now;
        try {
          const { detections } = objDetRef.current.detectForVideo(video, now) as {
            detections: Array<{ categories: Array<{ categoryName: string; score: number }> }>
          };
          const phoneHit = detections.find(d =>
            d.categories.some(c => {
              const n = c.categoryName.toLowerCase();
              return n.includes("cell phone") || n.includes("mobile") || n === "phone";
            })
          );
          if (phoneHit) {
            const conf = phoneHit.categories[0].score;
            emit("phone_detected", `Electronic device detected (Phone/Earbuds) (${Math.round(conf * 100)}% conf)`, conf);
            setStatus(s => ({ ...s, phoneDetected: true }));
          } else {
            setStatus(s => ({ ...s, phoneDetected: false }));
          }

          const laptopHit = detections.find(d =>
            d.categories.some(c => {
              const n = c.categoryName.toLowerCase();
              return n.includes("laptop") || n.includes("tv") || n.includes("monitor") || n.includes("tablet") || n.includes("computer") || n.includes("pad") || n.includes("headphone") || n.includes("earphone") || n.includes("buds");
            })
          );
          if (laptopHit) {
            const conf = laptopHit.categories[0].score;
            emit("laptop_detected", `Electronic device detected: ${laptopHit.categories[0].categoryName} (${Math.round(conf * 100)}% conf)`, conf);
          }
        } catch { /* skip */ }
      }

      // ── Audio / voice ───────────────────────────────────
      if (analyserRef.current && audioBufRef.current && now - tAudio.current > AUDIO_MS) {
        tAudio.current = now;
        analyserRef.current.getFloatTimeDomainData(audioBufRef.current);
        const rms = Math.sqrt(
          audioBufRef.current.reduce((acc, v) => acc + v * v, 0) / audioBufRef.current.length
        );
        const voiceLevel    = Math.min(1, rms / 0.08);
        const voiceSpeaking = rms > VOICE_RMS;
        if (voiceSpeaking) emit("audio_detected", "Speaking or unexpected audio detected", voiceLevel);
        setStatus(s => ({ ...s, voiceLevel, voiceSpeaking }));
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
