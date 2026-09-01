import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import Seal from "../components/Seal";
import ProctorCamera from "../components/ProctorCamera";
import ExamTools from "../components/ExamTools";
import ProctorAI, { type AIStatus, type AIViolation } from "../components/ProctorAI";
import { supabaseConfigured } from "../lib/env";
import {
  loadExamBundle,
  getCurrentStudentIdentity,
  startAttempt,
  saveAnswers,
  submitAttempt,
  type DBQuestion,
} from "../lib/examApi";
import { lockdownReady, isTauri, downloadUrl, osLabel, detectOS, probeInstaller } from "../lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { jsPDF } from "jspdf";
import { uploadExamRecords } from "../lib/examStorage";

const FALLBACK_EXAM_ID = "EXAM-2026-014";
const DEFAULT_DURATION_MIN = 45;

type Violation = { id: number; kind: string; at: string };
type QStatus = "unvisited" | "visited" | "answered" | "marked";

type Question = { id: number; text: string; options: string[]; category: string; type?: "mcq" | "subjective" };

// Built-in questions — used when Supabase isn't configured (prototype/offline).
const DEMO_QUESTIONS: Question[] = [
  { id: 1, text: "Explain the data structure that underlies the call stack used for recursive function execution.", options: [], category: "Data Structures", type: "subjective" },
  { id: 2, text: "In relational databases, which normal form eliminates transitive dependency on the primary key?", options: ["1NF", "2NF", "3NF", "BCNF"], category: "Databases", type: "mcq" },
  { id: 3, text: "What is the time complexity of binary search on a sorted array of n elements?", options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"], category: "Algorithms", type: "mcq" },
  { id: 4, text: "Describe the process and flags used to gracefully terminate a TCP connection.", options: [], category: "Networks", type: "subjective" },
  { id: 5, text: "In operating systems, which scheduling algorithm can cause starvation of low-priority processes?", options: ["Round Robin", "FCFS", "Priority Scheduling", "SJF (non-preemptive, fair queue)"], category: "Operating Systems", type: "mcq" },
  { id: 6, text: "Which of these is NOT a property required for a valid B-tree of order m?", options: ["Every node has at most m children", "Every non-leaf node has at least ⌈m/2⌉ children", "All leaves appear at the same level", "Every node must be colored red or black"], category: "Data Structures", type: "mcq" },
];

// Map a DB question row → the shape the exam UI renders. MCQ options only;
// subjective questions still render (options fall back to none) so the paper is
// complete even if the pool mixes types.
function toUIQuestion(row: DBQuestion, index: number): Question {
  return {
    id: index + 1,
    text: row.title,
    options: row.options ?? [],
    category: row.unit ?? "General",
  };
}

// ── System compatibility checks (real, not simulated) ────────────────────────
type CheckResult = { label: string; ok: boolean; detail: string };

function runCompatChecks(): CheckResult[] {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const secure = typeof window !== "undefined" ? window.isSecureContext : false;
  // Inside the Tauri kiosk the window is always secure, fullscreen is always
  // on, and all APIs are available — mark them as passed without querying.
  const inTauri = isTauri();
  return [
    { label: "Secure connection (HTTPS)", ok: inTauri || !!secure, detail: inTauri ? "Lockdown app" : secure ? "Encrypted" : "Insecure origin" },
    { label: "Camera & microphone API", ok: inTauri || !!md?.getUserMedia, detail: inTauri ? "Available" : md?.getUserMedia ? "Available" : "Unsupported" },
    { label: "Screen sharing API", ok: inTauri || !!md?.getDisplayMedia, detail: inTauri ? "Available" : md?.getDisplayMedia ? "Available" : "Unsupported" },
    { label: "Full-screen lock", ok: inTauri || (typeof document !== "undefined" && !!document.documentElement.requestFullscreen), detail: inTauri ? "Kiosk mode" : "Supported" },
    { label: "Lockdown environment", ok: lockdownReady(), detail: isTauri() ? "Vignan Lockdown Browser" : "Demo bypass" },
  ];
}

// Steps: gate (browser download) → check → access (devices) → rules → exam → submitted.
// "installed" is a transient gate sub-state shown after the student confirms they installed the app.
type Step = "gate" | "installed" | "check" | "access" | "rules" | "exam" | "submitted";

export default function StudentExam() {
  const { examId: examIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const examId = examIdParam ?? searchParams.get("exam") ?? FALLBACK_EXAM_ID;

  // Real flow: if the student is not inside the installed Vignan Lockdown Browser,
  // they must install the desktop package first. Only the packaged Tauri app can
  // continue into the pre-exam checks and the actual exam flow.
  const [step, setStep] = useState<Step>(() => (lockdownReady() ? "check" : "gate"));

  // Questions: DB-backed when configured, else built-in demo set.
  const [questions, setQuestions] = useState<Question[]>(DEMO_QUESTIONS);
  const [examName, setExamName] = useState("Data Structures & Algorithms — Sem III");
  const [examStartAt, setExamStartAt] = useState<string | null>(null);
  const [durationMin, setDurationMin] = useState(DEFAULT_DURATION_MIN);
  const [studentRoll, setStudentRoll] = useState("UNKNOWN");
  const [studentName, setStudentName] = useState("Student");
  const [accessDenied, setAccessDenied] = useState(false);

  // Attempt / DB
  const studentIdRef = useRef<string | null>(null);
  const attemptStartedRef = useRef(false);

  // Device access state
  const [cam, setCam] = useState<"idle" | "granted" | "denied">("idle");
  const [mic, setMic] = useState<"idle" | "granted" | "denied">("idle");
  const [screen, setScreen] = useState<"idle" | "granted" | "denied">("idle");
  const [requesting, setRequesting] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const accessStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const [agreed, setAgreed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [status, setStatus] = useState<Record<number, QStatus>>({});
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_DURATION_MIN * 60);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const violationId = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // AI proctoring state
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  // Shared camera stream ref so ProctorAI can read the same feed as ProctorCamera
  const cameraStreamRef = useRef<MediaStream | null>(null);

  // "installed" deep-link state: tracks whether we tried vignan-exam:// launch
  const [deepLinkTried, setDeepLinkTried] = useState(false);
  const [deepLinkFailed, setDeepLinkFailed] = useState(false);

  // Recording and screenshots state
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const screenshotsRef = useRef<string[]>([]);
  const screenshotIntervalRef = useRef<number | undefined>(undefined);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);

  // Download gate: only offer the installer after confirming the link resolves
  // to real installer bytes. Without the probe, an unhosted path returns a 404
  // / SPA HTML page that the browser saves as "VignanExam.dmg" — macOS then
  // reports "the disk image is corrupted". A reachable HTML release page is
  // offered as "Open download page" instead of a forced binary download.
  const [installer, setInstaller] = useState<"checking" | "ready" | "release" | "missing">("checking");
  useEffect(() => {
    if (step !== "gate") return;
    const url = downloadUrl();
    if (!url) { setInstaller("missing"); return; }
    const os = detectOS();
    let active = true;
    void probeInstaller(url, os).then((state) => {
      if (active) setInstaller(state);
    });
    return () => { active = false; };
  }, [step]);

  // System compatibility checks (run once when we reach the check step).
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [checkIndex, setCheckIndex] = useState(0);
  useEffect(() => {
    if (step !== "check") return;
    let active = true;
    let id: number | undefined;

    async function checkAll() {
      const results = runCompatChecks();
      if (isTauri()) {
        try {
          const apps = await invoke<string[]>("check_prohibited_apps");
          if (apps.length > 0) {
            results.push({ label: "Background Apps", ok: false, detail: `Prohibited apps running: ${apps.join(", ")}` });
          } else {
            results.push({ label: "Background Apps", ok: true, detail: "" });
          }
        } catch (err) {
          console.error(err);
        }
      }

      if (!active) return;
      setChecks(results);
      setCheckIndex(0);
      let i = 0;
      id = window.setInterval(() => {
        i += 1;
        setCheckIndex(i);
        if (i >= results.length) window.clearInterval(id);
      }, 450);
    }

    void checkAll();
    return () => { active = false; window.clearInterval(id); };
  }, [step]);
  const checksDone = checks.length > 0 && checkIndex >= checks.length;
  const checksPassed = checksDone && checks.every((c) => c.ok);

  const flag = useCallback((kind: string) => {
    const v: Violation = { id: (violationId.current += 1), kind, at: new Date().toLocaleTimeString() };
    setViolations((list) => [...list, v]);
    setActiveViolation(v);
  }, []);

  // Handle AI violation events from ProctorAI — feed into same violations system
  const handleAIViolation = useCallback((v: AIViolation) => {
    flag(`[AI] ${v.label}`);
  }, [flag]);

  // Load exam + questions from the DB (falls back to demo set silently).
  useEffect(() => {
    if (!supabaseConfigured) return;
    let active = true;
    (async () => {
      const { exam, questions: rows } = await loadExamBundle(examId);
      if (!active) return;
      if (!exam) {
        setAccessDenied(true);
        return;
      }
      if (exam.name) setExamName(exam.name);
      if (exam.scheduled_at) setExamStartAt(exam.scheduled_at);
      if (exam.duration_minutes > 0) {
        setDurationMin(exam.duration_minutes);
        setSecondsLeft(exam.duration_minutes * 60);
      }
      if (rows.length) setQuestions(rows.map(toUIQuestion));
      const identity = await getCurrentStudentIdentity();
      if (!identity) {
        setAccessDenied(true);
        return;
      }
      studentIdRef.current = identity.id;
      setStudentRoll(identity.roll);
      setStudentName(identity.full_name);
    })();
    return () => { active = false; };
  }, [examId]);

  // Keep the status map in sync with the (possibly DB-loaded) question set.
  useEffect(() => {
    setStatus((prev) => {
      const next: Record<number, QStatus> = {};
      for (const q of questions) next[q.id] = prev[q.id] ?? "unvisited";
      return next;
    });
  }, [questions]);

  // Live proctoring flags: tab switch, focus loss, full-screen exit, network disconnect.
  useEffect(() => {
    if (step !== "exam") return;
    const onVisibility = () => { if (document.hidden) flag("Tab / window switched away"); };
    const onBlur = () => flag("Exam window lost focus");
    const onFullscreen = () => { if (!document.fullscreenElement) flag("Exited full-screen mode"); };
    const onOffline = () => flag("Network Disconnected / Offline");
    
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("offline", onOffline);
    
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("offline", onOffline);
    };
  }, [step, flag]);

  // Exam timer.
  useEffect(() => {
    if (step !== "exam") return;
    if (secondsLeft <= 0) { void doSubmit(); return; }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, secondsLeft]);

  // Auto-dismiss the violation popup.
  useEffect(() => {
    if (!activeViolation) return;
    const t = setTimeout(() => setActiveViolation(null), 5000);
    return () => clearTimeout(t);
  }, [activeViolation]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Release any held media on unmount.
  useEffect(() => () => {
    accessStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    clearInterval(screenshotIntervalRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const timeString = useMemo(() => {
    const m = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
    const s = (secondsLeft % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }, [secondsLeft]);

  const secondsUntilStart = useMemo(() => {
    if (!examStartAt) return 0;
    const delta = Math.floor((new Date(examStartAt).getTime() - now) / 1000);
    return Math.max(0, delta);
  }, [examStartAt, now]);

  const startCountdown = useMemo(() => {
    const mm = Math.floor(secondsUntilStart / 60).toString().padStart(2, "0");
    const ss = (secondsUntilStart % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  }, [secondsUntilStart]);

  const q = questions[current] ?? questions[0];
  const answeredCount = Object.values(status).filter((s) => s === "answered").length;
  const markedCount = Object.values(status).filter((s) => s === "marked").length;
  const visitedCount = Object.values(status).filter((s) => s === "visited").length;
  const remainingCount = questions.length - answeredCount;

  const categories = useMemo(() => {
    const map = new Map<string, { total: number; answered: number }>();
    for (const qq of questions) {
      const entry = map.get(qq.category) ?? { total: 0, answered: 0 };
      entry.total += 1;
      if (status[qq.id] === "answered") entry.answered += 1;
      map.set(qq.category, entry);
    }
    return [...map.entries()].map(([name, v]) => ({ name, ...v }));
  }, [questions, status]);

  useEffect(() => {
    if (step === "exam" && q) {
      setStatus((s) => (s[q.id] === "unvisited" ? { ...s, [q.id]: "visited" } : s));
    }
  }, [current, step, q]);

  // Autosave answers to the DB (debounced) whenever they change during the exam.
  useEffect(() => {
    if (step !== "exam" || !supabaseConfigured || !studentIdRef.current) return;
    const t = setTimeout(() => {
      void saveAnswers({
        examId,
        studentId: studentIdRef.current!,
        answers,
        answered: answeredCount,
        minutesUsed: Math.round((durationMin * 60 - secondsLeft) / 60),
      });
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, step]);

  // ── Device access ───────────────────────────────────────────────────────────
  async function requestDevices() {
    setRequesting(true);
    setCam("idle");
    setMic("idle");
    if (!isTauri()) setScreen("idle"); // Leave screen as granted for Tauri
    
    // Give React time to render the "idle" state so the user sees the button change,
    // otherwise the browser's instant rejection causes the state to flip too fast.
    await new Promise((r) => setTimeout(r, 600));
    
    // Camera + mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      
      // Virtual Webcam Detection
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === "videoinput");
      const virtualKeywords = ["obs", "virtual", "snap camera", "epoccam", "camtwist"];
      
      let isVirtual = false;
      for (const d of videoDevices) {
        const label = d.label.toLowerCase();
        if (virtualKeywords.some(kw => label.includes(kw))) {
          isVirtual = true;
          break;
        }
      }
      
      if (isVirtual) {
        alert("Virtual webcam detected! Please disable it and use a real camera.");
        stream.getTracks().forEach(t => t.stop());
        setCam("denied");
        setMic("denied");
        setRequesting(false);
        return;
      }

      accessStreamRef.current = stream;
      setCam(stream.getVideoTracks().length ? "granted" : "denied");
      setMic(stream.getAudioTracks().length ? "granted" : "denied");
      if (previewRef.current) previewRef.current.srcObject = stream;
    } catch {
      setCam("denied");
      setMic("denied");
    }
    // Screen share — request the entire monitor (not just a tab or window).
    try {
      if (isTauri()) {
        // macOS WKWebView does not support getDisplayMedia(). Since the Tauri app
        // is already natively locking down the OS (kiosk mode, no alt-tab, etc),
        // we can safely bypass the screen recording requirement here.
        setScreen("granted");
      } else {
        const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: unknown) => Promise<MediaStream> };
        if (md.getDisplayMedia) {
          const disp = await md.getDisplayMedia({
            video: { displaySurface: "monitor" } as MediaTrackConstraints,
            audio: false,
          });
          screenStreamRef.current = disp;
          setScreen("granted");
          disp.getVideoTracks()[0]?.addEventListener("ended", () => {
            setScreen("denied");
            flag("Screen sharing stopped");
          });
        } else {
          setScreen("denied");
        }
      }
    } catch {
      setScreen("denied");
    }
    setRequesting(false);
  }

  const devicesReady = cam === "granted" && mic === "granted" && screen === "granted";

  function beginExam() {
    // Grab a fresh camera+mic stream for ProctorAI before releasing the preview
    // stream (ProctorCamera will open its own stream via LiveKit).
    if (accessStreamRef.current) {
      cameraStreamRef.current = accessStreamRef.current;
      // Keep the stream alive for ProctorAI; ProctorCamera acquires its own.
      accessStreamRef.current = null;
    }
    // Enter full-screen lock (best-effort; Tauri kiosk is already fullscreen).
    try { void document.documentElement.requestFullscreen?.(); } catch { /* ignore */ }
    // Start / resume the DB attempt.
    if (supabaseConfigured && studentIdRef.current && !attemptStartedRef.current) {
      attemptStartedRef.current = true;
      void startAttempt({ examId, studentId: studentIdRef.current, total: questions.length });
    }
    
    // Start Recording and Screenshots
    const targetStream = screenStreamRef.current || cameraStreamRef.current;
    if (targetStream) {
      try {
        const mr = new MediaRecorder(targetStream, { mimeType: "video/webm" });
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) recordedChunksRef.current.push(e.data);
        };
        mr.start(1000);
        mediaRecorderRef.current = mr;
      } catch (e) {
        console.warn("Failed to start MediaRecorder", e);
      }

      if (hiddenVideoRef.current) {
        hiddenVideoRef.current.srcObject = targetStream;
        hiddenVideoRef.current.play().catch(() => {});
      }
      
      screenshotIntervalRef.current = window.setInterval(() => {
        const video = hiddenVideoRef.current;
        if (!video) return;
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext("2d");
        if (ctx && video.videoWidth) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          screenshotsRef.current.push(canvas.toDataURL("image/jpeg", 0.5));
        }
      }, 1000);
    }
    
    setStep("exam");
  }

  async function doSubmit() {
    clearInterval(screenshotIntervalRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    if (supabaseConfigured && studentIdRef.current) {
      await submitAttempt({
        examId,
        studentId: studentIdRef.current,
        answers,
        answered: answeredCount,
        minutesUsed: Math.round((durationMin * 60 - secondsLeft) / 60),
      });
    }
    
    // Generate PDF and upload
    setTimeout(async () => {
      try {
        const pdf = new jsPDF("landscape");
        const shots = screenshotsRef.current;
        for (let i = 0; i < shots.length; i++) {
          if (i > 0) pdf.addPage();
          pdf.addImage(shots[i], "JPEG", 10, 10, 277, 190);
        }
        const pdfBlob = pdf.output("blob");
        const videoBlob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        
        await uploadExamRecords({
          examId,
          studentIdentifier: studentRoll,
          pdfBlob,
          videoBlob,
        });
      } catch (err) {
        console.error("Failed to upload records:", err);
      }
    }, 500);

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    setStep("submitted");
  }

  function selectOption(optIndex: number) {
    if (!q) return;
    setAnswers((a) => ({ ...a, [q.id]: optIndex }));
    setStatus((s) => ({ ...s, [q.id]: "answered" }));
  }
  function markForReview() {
    if (!q) return;
    setStatus((s) => ({ ...s, [q.id]: s[q.id] === "answered" ? "answered" : "marked" }));
    goNext();
  }
  function goNext() { if (current < questions.length - 1) setCurrent((c) => c + 1); }
  function goTo(i: number) { setCurrent(i); }

  if (accessDenied) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-lg border border-alert/40 bg-paper p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Access denied</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold">Exam not available</h1>
          <p className="mt-2 text-[13px] text-ink-soft">
            You are not enrolled for this exam, or the exam id is invalid.
          </p>
        </div>
      </div>
    );
  }

  // ---------- Step: download gate (opened in a normal browser) ----------
  // Hard requirement: exams run ONLY inside the Vignan Exam Browser (Tauri app).
  // One installation lets the student write ALL their Vignan exams — no
  // per-exam downloads. The app connects to the same web backend the browser
  // uses and loads every exam from there.
  if (step === "gate") {
    const osRaw = detectOS();
    const os = osLabel(osRaw);
    const href = downloadUrl(osRaw);
    const downloadFilename =
      osRaw === "windows" ? "Vignan Exam Browser Setup.exe" :
      osRaw === "macos"   ? "Vignan Exam Browser.dmg" :
      osRaw === "linux"   ? "Vignan Exam Browser.AppImage" :
                            "Vignan Exam Browser Setup.exe";
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-lg">
          {/* Header */}
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Vignan University · Secure exam platform</p>
          <h1 className="mb-1 font-serif text-2xl font-semibold">Install Vignan Exam Browser</h1>
          <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
          <p className="mb-6 text-[13.5px] leading-relaxed text-ink-soft">
            Your exams run inside the <strong className="text-ink">Vignan Exam Browser</strong> — a
            secure desktop app. Install it <strong className="text-ink">once</strong> and use it for
            every exam. Each paper loads automatically from the Vignan server — no separate
            file to download per exam.
          </p>

          {/* Download card */}
          <div className="border border-line bg-paper-raised p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-serif text-[15px] font-medium">Vignan Exam Browser</p>
                <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft">Version 1.0 · Detected OS: {os}</p>
              </div>
              <span className="h-2 w-2 bg-maroon" />
            </div>

            {/* One-time install badge */}
            <div className="mt-3 flex items-center gap-2 border border-amber/40 bg-amber/10 px-3 py-1.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-amber">✦ Install once · use for all Vignan exams</span>
            </div>

            {installer === "checking" && (
              <div className="mt-4 w-full border border-line py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink-soft">
                Locating installer…
              </div>
            )}
            {installer === "ready" && (
              <a
                href={href}
                download={downloadFilename}
                className="mt-4 block w-full border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-maroon/90"
              >
                ↓ Download Vignan Exam Browser for {os}
              </a>
            )}
            {installer === "release" && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block w-full border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-maroon/90"
              >
                Open download page →
              </a>
            )}
            {installer === "missing" && (
              <div className="mt-4 space-y-3">
                <div className="border border-line bg-paper px-4 py-3 text-[12.5px] leading-relaxed text-ink-soft">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink">Not yet available for {os}</p>
                  <p className="mt-1.5">Contact your invigilator — they can provide a direct download link or arrange an alternative.</p>
                </div>
                <a
                  href="mailto:exam-support@vignan.ac.in"
                  className="block w-full border border-ink py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink transition-colors hover:bg-paper-raised"
                >
                  Contact invigilator →
                </a>
              </div>
            )}
            <p className="mt-3 text-center font-mono text-[9px] text-ink-soft">
              {installer === "ready" ? "~45 MB · Verified installer · browser alone cannot run exams"
                : installer === "release" ? "Opens the official download page in a new tab"
                : "Desktop app required · browser alone cannot run exams"}
            </p>
          </div>

          {/* After installing */}
          <div className="mt-4 border border-line p-4 text-[12.5px] text-ink-soft">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink">After installing — what happens</p>
            <p className="mt-2">1. Come back to <strong className="text-ink">My Exams</strong> on this website.</p>
            <p className="mt-1">2. Click <strong className="text-ink">Enter exam</strong> on any published paper.</p>
            <p className="mt-1">3. The Vignan Exam Browser opens and loads your exam automatically — <strong className="text-ink">no extra download needed.</strong></p>
          </div>

          <div className="mt-4 flex flex-col items-center gap-3">
            {/* "Done installing" — transitions to the Enter Exam screen */}
            {(installer === "ready" || installer === "release") && (
              <button
                onClick={() => setStep("installed")}
                className="w-full border border-success bg-success/10 py-3 font-mono text-[12px] uppercase tracking-widest text-success transition-colors hover:bg-success/20"
              >
                ✓ Done — I've installed it
              </button>
            )}
            {/* Dev/preview bypass */}
            <button
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set("lockdown", "1");
                window.location.href = url.toString();
              }}
              className="font-mono text-[10px] text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Preview exam flow (dev bypass)
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Step: installed → Enter exam via deep link ----------
  // Student installed the Vignan Exam Browser. Now "Enter exam" fires the
  // vignan-exam:// URL scheme — the OS opens the app with the exam pre-loaded.
  // If the scheme is not handled (app not actually installed / wrong OS),
  // we show the download button as fallback after a 3-second timeout.
  if (step === "installed") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center border-2 border-success bg-success/10">
            <span className="text-2xl text-success">✓</span>
          </div>
          <h1 className="mt-5 font-serif text-2xl font-semibold">Vignan Exam Browser installed!</h1>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
          <p className="mt-1 font-mono text-[9px] text-ink-soft">This app works for all your Vignan exams — no re-download needed</p>

          {/* Enter exam — tries deep link, falls back to download */}
          {!deepLinkTried ? (
            <>
              <p className="mt-5 text-[13.5px] leading-relaxed text-ink-soft">
                Click <strong className="text-ink">Enter exam</strong> — the Vignan Exam Browser
                opens and loads <strong className="text-ink">{examName}</strong> automatically
                from the Vignan server. No extra download.
              </p>
              <button
                onClick={() => {
                  setDeepLinkTried(true);
                  // Fire the registered URL scheme. The installed Tauri app intercepts
                  // this and navigates to the exam. The examId is passed as a query param
                  // so the app can route directly to the right paper.
                  window.location.href = `vignan-exam://open?exam=${encodeURIComponent(examId)}`;
                  // If nothing happened after 3 s the scheme isn't registered → show fallback.
                  setTimeout(() => setDeepLinkFailed(true), 3000);
                }}
                className="mt-6 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-maroon/90"
              >
                Enter exam →
              </button>
            </>
          ) : (
            <>
              <p className="mt-5 text-[13.5px] leading-relaxed text-ink-soft">
                {deepLinkFailed
                  ? "The Vignan Exam Browser didn't open. Make sure the installation completed, then try again — or re-download below."
                  : "Opening Vignan Exam Browser…"}
              </p>
              {!deepLinkFailed && (
                <div className="mt-5 flex items-center justify-center gap-2 font-mono text-[11px] text-ink-soft">
                  <span className="h-2 w-2 animate-pulse bg-maroon" />
                  Launching Vignan Exam Browser…
                </div>
              )}
              {deepLinkFailed && (
                <div className="mt-4 space-y-3">
                  <button
                    onClick={() => {
                      window.location.href = `vignan-exam://open?exam=${encodeURIComponent(examId)}`;
                    }}
                    className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-maroon/90"
                  >
                    Try again →
                  </button>
                  <a
                    href={downloadUrl(detectOS())}
                    download={
                      detectOS() === "windows" ? "Vignan Exam Browser Setup.exe" :
                      detectOS() === "macos"   ? "Vignan Exam Browser.dmg" :
                                                 "Vignan Exam Browser.AppImage"
                    }
                    className="block w-full border border-line-strong py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink transition-colors hover:bg-paper-raised"
                  >
                    ↓ Download Vignan Exam Browser again
                  </a>
                </div>
              )}
            </>
          )}

          <div className="mt-6 border border-line bg-paper-raised p-4 text-left text-[12.5px] text-ink-soft">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink">How it works</p>
            <p className="mt-2">• One app · all Vignan exams · no per-exam downloads</p>
            <p className="mt-1">• Exam paper loads from the Vignan server inside the app</p>
            <p className="mt-1">• AI proctoring + kiosk lockdown run throughout the session</p>
          </div>
          <button
            onClick={() => setStep("gate")}
            className="mt-4 font-mono text-[10px] text-ink-soft underline underline-offset-2 hover:text-ink"
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  // ---------- Step: system compatibility check ----------
  if (step === "check") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 1 of 3</p>
          <h1 className="mb-1 font-serif text-2xl font-semibold">System readiness check</h1>
          <p className="mb-8 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
          <div className="space-y-3 border border-line bg-paper-raised p-5">
            {checks.map((c, i) => (
              <div key={c.label} className="flex flex-col text-[13.5px]">
                <div className="flex items-center justify-between">
                  <span className={i < checkIndex ? "text-ink" : "text-ink-soft"}>{c.label}</span>
                  {i < checkIndex ? (
                    <span className={`font-mono text-[11px] ${c.ok ? "text-success" : "text-alert"}`}>{c.ok ? "PASS" : "FAIL"}</span>
                  ) : i === checkIndex ? (
                    <span className="font-mono text-[11px] text-amber">CHECKING…</span>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-soft">—</span>
                  )}
                </div>
                {i < checkIndex && !c.ok && c.detail && (
                  <span className="mt-1 text-[11px] text-maroon">{c.detail}</span>
                )}
              </div>
            ))}
            {checks.length === 0 && <p className="font-mono text-[11px] text-ink-soft">Initializing…</p>}
          </div>
          {checksDone && (
            checksPassed ? (
              <button
                onClick={() => setStep("access")}
                className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90"
              >
                Continue
              </button>
            ) : (
              <button
                onClick={() => { setChecks([]); setCheckIndex(0); setStep("gate"); setTimeout(() => setStep("check"), 0); }}
                className="mt-6 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-maroon/90"
              >
                Re-check Environment
              </button>
            )
          )}
          {checksDone && !checksPassed && (
            <p className="mt-3 text-center font-mono text-[10px] text-alert">
              Resolve the failed checks above and re-check to continue.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---------- Step: device access ----------
  if (step === "access") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-lg">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 2 of 3</p>
          <h1 className="mb-2 font-serif text-2xl font-semibold">Grant camera, mic & screen</h1>
          <p className="mb-6 text-[13px] text-ink-soft">Proctoring requires all three. They record for the duration of the exam and stop when you submit.</p>
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <div className="overflow-hidden border border-line-strong bg-ink">
              <video ref={previewRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" />
              <p className="px-2 py-1.5 text-center font-mono text-[9px] uppercase tracking-wider text-paper">Self preview</p>
            </div>
            <div className="space-y-2">
              <AccessRow label="Camera" state={cam} />
              <AccessRow label="Microphone" state={mic} />
              <AccessRow label="Screen sharing" state={screen} />
            </div>
          </div>
          <button
            onClick={requestDevices}
            disabled={requesting}
            className="mt-6 w-full border border-line-strong py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-paper-raised disabled:opacity-60"
          >
            {requesting ? "Requesting access…" : devicesReady ? "Re-check devices" : (cam === "denied" || mic === "denied" || screen === "denied") ? "Retry granting access" : "Allow camera, microphone & screen"}
          </button>
          {(cam === "denied" || mic === "denied" || screen === "denied") && (
            <p className="mt-2 text-center text-[12px] text-maroon">
              Access was blocked. Please ensure your OS (System Settings) allows the Vignan Exam Browser to use the camera and microphone, then click Retry.
            </p>
          )}
          <button
            disabled={!devicesReady}
            onClick={() => setStep("rules")}
            className="mt-3 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }
  // ---------- Step: rules, timer & instructions ----------
  if (step === "rules") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-lg">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 3 of 3</p>
          <h1 className="mb-4 font-serif text-2xl font-semibold">{examName}</h1>
          <div className="mb-5 grid grid-cols-3 gap-3">
            <div className="border border-line bg-paper-raised p-3 text-center">
              <p className="font-serif text-2xl">{durationMin}</p>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">Minutes</p>
            </div>
            <div className="border border-line bg-paper-raised p-3 text-center">
              <p className="font-serif text-2xl">{questions.length}</p>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">Questions</p>
            </div>
            <div className="border border-line bg-paper-raised p-3 text-center">
              <p className="font-serif text-2xl text-maroon">Live</p>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">Proctored</p>
            </div>
          </div>
          <div className="max-h-52 space-y-3 overflow-y-auto border border-line bg-paper-raised p-5 text-[13.5px] leading-relaxed text-ink-soft">
            <p>1. The exam runs in full-screen. Exiting full-screen or switching windows is flagged to the proctor.</p>
            <p>2. Your webcam, microphone and screen record for the full duration.</p>
            <p>3. A second device or unauthorized software will be detected and flagged.</p>
            <p>4. Answers save automatically as you attempt them.</p>
            <p>5. The exam auto-submits when the timer reaches zero.</p>
          </div>
          {secondsUntilStart > 0 && (
            <div className="mt-4 border border-amber/40 bg-amber/10 px-4 py-3 text-[12px] text-ink-soft">
              Exam starts in <span className="font-mono text-[12px] text-ink">{startCountdown}</span>.
            </div>
          )}
          <label className="mt-5 flex items-start gap-3 text-[13px]">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-maroon" />
            <span>I have read the rules and consent to audio, video and screen monitoring for this exam.</span>
          </label>
          <button
            disabled={!agreed || secondsUntilStart > 0}
            onClick={beginExam}
            className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
          >
            {secondsUntilStart > 0 ? `Starts in ${startCountdown}` : "Start exam"}
          </button>
        </div>
      </div>
    );
  }

  // ---------- Step: submitted ----------
  useEffect(() => {
    if (step === "submitted" && isTauri()) {
      const t = setTimeout(() => {
        void invoke("exit_app");
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [step]);

  if (step === "submitted") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <Seal label="Submitted" sublabel="Receipt recorded" tone="success" size={100} />
          <h1 className="mt-6 font-serif text-2xl font-semibold text-success">Student Completed</h1>
          <p className="mt-2 font-serif text-xl">Your exam has been submitted successfully</p>
          <p className="mt-2 text-[13.5px] text-ink-soft">{answeredCount} of {questions.length} questions answered.</p>
          <div className="mt-6 border border-line bg-paper-raised p-4 text-left font-mono text-[11px] text-ink-soft">
            <div className="flex justify-between"><span>Candidate</span><span className="text-ink">{studentName}</span></div>
            <div className="mt-1 flex justify-between"><span>Roll No.</span><span className="text-ink">{studentRoll}</span></div>
            <div className="mt-1 flex justify-between"><span>Violations logged</span><span className="text-ink">{violations.length}</span></div>
            <div className="mt-1 flex justify-between"><span>Submitted at</span><span className="text-ink">{new Date().toLocaleTimeString()}</span></div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Step: exam (kiosk mode) ----------
  const statusStyle: Record<QStatus, string> = {
    unvisited: "border-line text-ink-soft",
    visited: "border-line-strong text-ink",
    answered: "border-success bg-success text-paper",
    marked: "border-amber bg-amber text-paper",
  };
  return (
    <div className="min-h-screen bg-paper text-ink">
      <video ref={hiddenVideoRef} style={{ display: "none" }} muted playsInline />
      {activeViolation && (
        <div className="fixed inset-x-0 top-0 z-[60] flex justify-center px-4 py-3">
          <div className="flex w-full max-w-xl items-center gap-3 border border-alert bg-alert px-4 py-3 text-paper shadow-2xl">
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse bg-paper" />
            <div className="flex-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-paper/75">Proctor alert · logged</p>
              <p className="mt-0.5 text-[14px] font-medium">{activeViolation.kind}</p>
              <p className="mt-0.5 font-mono text-[10px] text-paper/70">{activeViolation.at} · {violations.length} violation(s) this session</p>
            </div>
            <button onClick={() => setActiveViolation(null)} className="font-mono text-[15px] leading-none text-paper/80 hover:text-paper">×</button>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4">
          <div>
            <p className="font-serif text-[15px] font-semibold">{examName}</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Locked session · No exit</p>
          </div>
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse bg-alert" />
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Recording</span>
            </div>
            <div className={`tabular border px-3 py-1.5 font-mono text-[15px] font-medium ${secondsLeft < 300 ? "border-alert text-alert" : "border-ink text-ink"}`}>
              {timeString}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[264px_minmax(0,1fr)_224px] lg:px-8">
        {/* LEFT */}
        <aside className="space-y-4 lg:sticky lg:top-[84px] lg:self-start">
          <div className="border border-line bg-paper-raised p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Progress</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center">
              <Stat n={answeredCount} label="Answered" tone="text-success" />
              <Stat n={remainingCount} label="Remaining" tone="text-ink" />
              <Stat n={markedCount} label="Marked" tone="text-amber" />
              <Stat n={visitedCount} label="Visited" tone="text-ink-soft" />
            </div>
            <div className="mt-3 h-1.5 w-full bg-line">
              <div className="h-full bg-success transition-all" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
            </div>
            <p className="mt-2 text-center font-mono text-[10px] text-ink-soft">{answeredCount}/{questions.length} complete</p>
          </div>

          <div className="border border-line bg-paper-raised p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Categories</p>
            <div className="mt-3 space-y-2.5">
              {categories.map((c) => (
                <div key={c.name}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-ink">{c.name}</span>
                    <span className="font-mono text-[10px] text-ink-soft">{c.answered}/{c.total}</span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-line">
                    <div className="h-full bg-maroon" style={{ width: `${(c.answered / c.total) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-line bg-paper-raised p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question navigator</p>
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {questions.map((qq, i) => (
                <button
                  key={qq.id}
                  onClick={() => goTo(i)}
                  className={`flex h-9 items-center justify-center border font-mono text-[12px] transition-colors ${statusStyle[status[qq.id] ?? "unvisited"]} ${current === i ? "ring-2 ring-maroon ring-offset-1" : ""}`}
                >
                  {qq.id}
                </button>
              ))}
            </div>
            <div className="mt-3 space-y-1.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-success bg-success" />Answered</span>
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-amber bg-amber" />Marked</span>
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-line-strong" />Visited</span>
              <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-line" />Not visited</span>
            </div>
          </div>
        </aside>

        {/* CENTER */}
        <main>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-maroon">Question {current + 1} of {questions.length}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{q?.category}</p>
            </div>
          </div>

          <section className="border border-line bg-paper-raised p-5 sm:p-7">
            <h2 className="font-serif text-[22px] leading-snug text-ink sm:text-[26px]">{q?.text}</h2>
            <div className="mt-7 space-y-3">
              {(q?.options ?? []).map((opt, i) => {
                const selected = q ? answers[q.id] === i : false;
                return (
                  <button
                    key={i}
                    onClick={() => selectOption(i)}
                    className={`flex w-full items-center gap-3 border px-4 py-3 text-left text-[13.5px] transition-colors ${selected ? "border-maroon bg-maroon/[0.06] text-ink" : "border-line text-ink hover:border-line-strong"}`}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${selected ? "border-maroon bg-maroon text-paper" : "border-line-strong text-ink-soft"}`}>
                      {String.fromCharCode(65 + i)}
                    </span>
                    {opt}
                  </button>
                );
              })}
              {q?.type === "subjective" && (
                <div className="flex flex-col items-center justify-center border border-dashed border-line-strong bg-paper p-8">
                  <p className="mb-4 font-mono text-[12px] uppercase tracking-wider text-ink">Subjective Upload Required</p>
                  <p className="mb-6 text-center text-[13px] text-ink-soft">Scan this QR code with your mobile phone to take a photo of your handwritten answer sheet.</p>
                  <div className="bg-white p-2">
                    <QRCodeSVG 
                      value={`${window.location.origin}/mobile-upload?examId=${examId}&qId=${q.id}&student=${studentIdRef.current}`} 
                      size={180} 
                    />
                  </div>
                </div>
              )}
              {(!q?.options || q.options.length === 0) && q?.type !== "subjective" && (
                <p className="border border-dashed border-line-strong p-4 font-mono text-[11px] text-ink-soft">
                  Subjective question — answer captured by the proctor recording.
                </p>
              )}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button onClick={markForReview} className="border border-line-strong px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink">Mark for review &amp; next</button>
              <button onClick={goNext} disabled={current === questions.length - 1} className="border border-ink bg-ink px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft">Save &amp; next</button>
              <button onClick={() => void doSubmit()} className="ml-auto border border-maroon bg-maroon px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon-dark">Submit exam</button>
            </div>
          </section>
        </main>

        {/* RIGHT */}
        <aside className="space-y-4 lg:sticky lg:top-[84px] lg:self-start">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctoring</p>
            <ProctorCamera room={examId} identity={studentRoll} examId={examId} studentId={studentRoll} screenStream={screenStreamRef.current} />
          </div>

          {/* AI Proctor status panel */}
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">AI Monitor</p>
            <div className="border border-line bg-paper-raised p-3 space-y-2">
              {/* Loading state */}
              {aiStatus?.loading && (
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 animate-pulse bg-amber" />
                  <span className="font-mono text-[9px] text-ink-soft truncate">{aiStatus.loadStep}</span>
                </div>
              )}
              {/* Error state */}
              {aiStatus?.error && (
                <p className="font-mono text-[9px] text-alert">AI unavailable — manual review</p>
              )}
              {/* Active state */}
              {aiStatus && !aiStatus.loading && !aiStatus.error && (
                <>
                  {/* Face count */}
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] text-ink-soft">Faces</span>
                    <span className={`font-mono text-[10px] font-medium ${
                      aiStatus.faceCount === 1 ? "text-success" :
                      aiStatus.faceCount === 0 ? "text-alert" : "text-alert"
                    }`}>
                      {aiStatus.faceCount === 0 ? "NONE" : aiStatus.faceCount === 1 ? "1 ✓" : `${aiStatus.faceCount} ⚠`}
                    </span>
                  </div>
                  {/* Gaze */}
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] text-ink-soft">Gaze</span>
                    <span className={`font-mono text-[10px] font-medium ${
                      aiStatus.gazeDirection === "center" ? "text-success" : "text-alert"
                    }`}>
                      {aiStatus.gazeDirection.toUpperCase()}
                    </span>
                  </div>
                  {/* Voice level bar */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[9px] text-ink-soft">Voice</span>
                      <span className={`font-mono text-[9px] ${aiStatus.voiceSpeaking ? "text-alert" : "text-ink-soft"}`}>
                        {aiStatus.voiceSpeaking ? "SPEAKING ⚠" : "SILENT ✓"}
                      </span>
                    </div>
                    <div className="h-1 w-full bg-line">
                      <div
                        className={`h-full transition-all ${ aiStatus.voiceSpeaking ? "bg-alert" : "bg-success" }`}
                        style={{ width: `${Math.round(aiStatus.voiceLevel * 100)}%` }}
                      />
                    </div>
                  </div>
                  {/* Phone detection */}
                  {aiStatus.phoneDetected && (
                    <div className="flex items-center gap-1.5 border border-alert/40 bg-alert/10 px-2 py-1">
                      <span className="h-1.5 w-1.5 animate-pulse bg-alert" />
                      <span className="font-mono text-[9px] text-alert">Phone detected</span>
                    </div>
                  )}
                </>
              )}
              {/* Not yet started */}
              {!aiStatus && (
                <p className="font-mono text-[9px] text-ink-soft">Starting…</p>
              )}
            </div>
          </div>

          {/* Hidden ProctorAI engine */}
          <ProctorAI
            cameraStream={cameraStreamRef.current}
            active={step === "exam"}
            onViolation={handleAIViolation}
            onStatus={setAiStatus}
          />

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Tools</p>
            <ExamTools />
          </div>
        </aside>
      </div>
    </div>
  );
}

function AccessRow({ label, state }: { label: string; state: "idle" | "granted" | "denied" }) {
  const tone = state === "granted" ? "text-success" : state === "denied" ? "text-alert" : "text-ink-soft";
  const text = state === "granted" ? "GRANTED" : state === "denied" ? "BLOCKED" : "NOT REQUESTED";
  const dot = state === "granted" ? "bg-success" : state === "denied" ? "bg-alert" : "bg-line-strong";
  return (
    <div className="flex items-center justify-between border border-line px-3 py-2.5 text-[13px]">
      <span className="flex items-center gap-2"><span className={`h-2 w-2 ${dot}`} />{label}</span>
      <span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>{text}</span>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="border border-line bg-paper py-2">
      <p className={`font-serif text-2xl leading-none ${tone}`}>{n}</p>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
    </div>
  );
}
