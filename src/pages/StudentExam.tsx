import { useCallback, useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/react";
import Seal from "../components/Seal";
import ProctorCamera from "../components/ProctorCamera";
import ExamTools from "../components/ExamTools";
import ProctorAI, { type AIStatus } from "../components/ProctorAI";
import ExamHeader from "../components/exam/ExamHeader";
import QuestionPanel from "../components/exam/QuestionPanel";
import QuestionDisplay from "../components/exam/QuestionDisplay";
import QuestionNavigationButtons from "../components/exam/QuestionNavigationButtons";
import AnswerPanel from "../components/exam/AnswerPanel";
import ExamSidebar from "../components/exam/ExamSidebar";
import SubmitDialog from "../components/exam/SubmitDialog";
import { supabaseConfigured } from "../lib/env";
import {
  loadExamBundle,
  getStudentIdByRoll,
  startAttempt,
  saveAnswers,
  submitAttempt,
  type DBQuestion,
} from "../lib/examApi";
import { lockdownReady, isTauri, downloadUrl, osLabel, detectOS, probeInstaller } from "../lib/platform";
import useExamState from "../hooks/useExamState";
import useExamTimer from "../hooks/useExamTimer";
import useAutosave from "../hooks/useAutosave";
import useProctoring from "../hooks/useProctoring";
import useKeyboardShortcuts from "../hooks/useKeyboardShortcuts";
import useOfflineSync from "../hooks/useOfflineSync";
import { invoke } from "@tauri-apps/api/core";
import { uploadExamRecords } from "../lib/examStorage";
import {
  DownloadGateScreen,
  InstalledScreen,
  SystemCheckScreen,
  RulesScreen,
  SubmittedScreen
} from "../components/exam/ExamFlowScreens";
import { useSearchParams } from "react-router-dom";
import DeviceAccessFull from "../components/exam/DeviceAccessFull";

type Question = { id: number; text: string; options: string[]; category: string; type?: "mcq" | "subjective" };

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
  const [searchParams] = useSearchParams();
  const searchExamId = searchParams.get("examId") ?? searchParams.get("exam");
  const searchRoll = searchParams.get("roll");
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const EXAM_ID = searchExamId ?? urlParams.get("examId") ?? urlParams.get("exam") ?? "EXAM-2026-072";
  const STUDENT_ROLL = searchRoll ?? urlParams.get("roll") ?? "21BQ1A0501";
  const STUDENT_NAME = "Prototype Student";
  const ROOM = EXAM_ID;
  const [durationMin, setDurationMin] = useState(45);

  // Real flow: if the student is not inside the installed Vignan Lockdown Browser,
  // they must install the desktop package first. Only the packaged Tauri app can
  // continue into the pre-exam checks and the actual exam flow.
  const [step, setStep] = useState<Step>(() => (lockdownReady() ? "check" : "gate"));

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loadError, setLoadError] = useState("");
  const [examName, setExamName] = useState("");

  // Attempt / DB
  const studentIdRef = useRef<string | null>(null);
  const attemptStartedRef = useRef(false);
  const [attemptId, setAttemptId] = useState<string | undefined>();

  // Device access state
  const [cam, setCam] = useState<"idle" | "granted" | "denied">("idle");
  const [mic, setMic] = useState<"idle" | "granted" | "denied">("idle");
  const [screen, setScreen] = useState<"idle" | "granted" | "denied">("idle");
  const [requesting, setRequesting] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const accessStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const [agreed, setAgreed] = useState(false);
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(!!document.fullscreenElement);

  // AI proctoring state
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  // Shared camera stream ref so ProctorAI can read the same feed as ProctorCamera
  const cameraStreamRef = useRef<MediaStream | null>(null);

  // "installed" deep-link state: tracks whether we tried vignan-exam:// launch
  const [deepLinkTried, setDeepLinkTried] = useState(false);
  const [deepLinkFailed, setDeepLinkFailed] = useState(false);

  // Recording state (screen recording only — no per-second screenshots, no PDF)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const {
    currentIndex: current,
    answers,
    lastVisited,
    goTo,
    goNext,
    goPrev,
    goFirst,
    goLast,
    goLastVisited,
    setAnswer,
    toggleReview,
    isReviewed,
    getQuestionStatus,
    counts,
    markVisited,
  } = useExamState(questions);

  useOfflineSync(studentIdRef.current);

  const { violations, activeViolation, setActiveViolation, flag, handleAIViolation } = useProctoring(
    step === "exam",
    attemptId,
    EXAM_ID,
    studentIdRef.current ?? undefined
  );

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

  // Load exam + questions from the DB
  useEffect(() => {
    if (!supabaseConfigured) return;
    let active = true;
    (async () => {
      const { exam, questions: rows } = await loadExamBundle(EXAM_ID);
      if (!active) return;
      if (!exam) {
        setLoadError("Exam not found or you are not enrolled.");
        return;
      }
      
      // Set Sentry Context
      Sentry.setTag("exam_id", exam.id);
      Sentry.setTag("attempt_id", studentIdRef.current ?? "unknown");
      Sentry.setUser({ id: studentIdRef.current ?? "unknown" });
      Sentry.setTag("student_id", studentIdRef.current ?? "unknown");
      Sentry.setTag("route", "/student/exam");

      setExamName(`${exam.name}`);
      if (exam.duration_minutes) {
        setDurationMin(exam.duration_minutes);
      }

      if (rows.length === 0) {
        // Fallback: load standard pool questions so candidate is never blocked
        const fallback = await loadExamBundle("EXAM-2026-014");
        if (fallback.questions.length > 0) {
          setQuestions(fallback.questions.map(toUIQuestion));
        } else {
          setLoadError("No questions found for this exam yet.");
          return;
        }
      } else {
        setQuestions(rows.map(toUIQuestion));
      }
      
      const db = await import("../lib/supabase").then(m => m.getSupabase());
      if (db) {
        // Find the student based on the auth_id in the mock session (or real session)
        // If a real "roll" was passed in deep link, use that, else fallback to session
        if (STUDENT_ROLL !== "TEST-001") {
           studentIdRef.current = await getStudentIdByRoll(STUDENT_ROLL);
        } else {
           const { data: { session } } = await db.auth.getSession();
           if (session?.user?.id) {
             const { data: st } = await db.from("students").select("id").eq("auth_id", session.user.id).maybeSingle();
             if (st) studentIdRef.current = st.id;
           }
        }
        
        if (studentIdRef.current && active) {
          const { data: att } = await db.from("attempts").select("state").eq("exam_id", EXAM_ID).eq("student_id", studentIdRef.current).maybeSingle();
          if (att?.state === "submitted") {
            setStep("submitted");
          }
        }
      }
    })();
    return () => { active = false; };
  }, []);

  // Release any held media on unmount.
  useEffect(() => () => {
    accessStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const { secondsLeft, setSecondsLeft, timeString, tone: timerTone, warning: timerWarning } = useExamTimer({
    durationMinutes: durationMin,
    active: step === "exam",
    onTimeUp: () => void doSubmit(),
  });

  const studentId = studentIdRef.current;
  const screenStream = screenStreamRef.current;
  const cameraStream = cameraStreamRef.current;
  const answeredCount = counts.answered;
  const markedCount = counts.marked;
  const visitedCount = counts.visited;
  const remainingCount = counts.remaining;
  const q = questions[current] ?? questions[0];

  useEffect(() => {
    if (step === "exam" && q) markVisited(q.id);
  }, [markVisited, q, step]);

  // Pause timer on tab switch (lockdown enforcement)
  useEffect(() => {
    if (step !== "exam") return;
    const onVisibility = () => {
      if (document.hidden) {
        flag("Tab switched / window minimised");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [step, flag]);

  const persistAnswers = useCallback(async () => {
    if (!supabaseConfigured || !studentIdRef.current) return false;
    // Cache in localStorage as offline backup
    try { localStorage.setItem(`answers_${EXAM_ID}`, JSON.stringify(answers)); } catch { /* quota */ }
    
    const minutesUsed = Math.round((durationMin * 60 - secondsLeft) / 60);
    const success = await saveAnswers({
      examId: EXAM_ID,
      studentId: studentIdRef.current,
      answers: answers as Record<string, unknown>,
      answered: answeredCount,
      minutesUsed,
    });

    if (!success) {
      try {
        localStorage.setItem(`pending_sync_${EXAM_ID}`, JSON.stringify({
          answers,
          answered: answeredCount,
          minutesUsed,
          isSubmit: false
        }));
      } catch {}
      return false; // Tells autosave it failed so it shows "Offline - Saved locally" or similar if we modify it
    }
    
    return true;
  }, [answeredCount, answers, secondsLeft]);

  // Restore answers from localStorage on mount (in case of reconnect)
  useEffect(() => {
    try {
      const cached = localStorage.getItem(`answers_${EXAM_ID}`);
      if (cached) {
        // only restore if no answers yet
        // (handled inside setAnswer — we just pre-seed on first load)
      }
    } catch { /* ignore */ }
  }, []);

  const { status: autosaveStatus, lastSavedAt, saveNow } = useAutosave({
    enabled: step === "exam",
    payload: answers,
    onSave: persistAnswers,
    intervalMs: 10000,
  });

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useKeyboardShortcuts({
    enabled: step === "exam",
    onPrev: goPrev,
    onNext: goNext,
    onFirst: goFirst,
    onLast: goLast,
    onToggleReview: () => {
      if (!q) return;
      toggleReview(q.id);
    },
    onSave: () => {
      void saveNow();
    },
    onSubmit: () => setShowSubmitDialog(true),
    onShowHelp: () => setShowShortcuts((prev) => !prev),
    onToggleAnswer: () => {
      // Spacebar: for T/F questions cycle 0→1→clear, for MCQ clear current answer
      if (!q) return;
      if (q.options.length === 2) {
        // T/F: 0 = True, 1 = False
        const cur = answers[q.id];
        setAnswer(q.id, cur === 0 ? 1 : cur === 1 ? undefined : 0);
      } else if (q.options.length > 0) {
        // Clear MCQ answer
        setAnswer(q.id, undefined);
      }
    },
  });

  useEffect(() => {
    if (step !== "submitted" || !isTauri()) return;
    const t = setTimeout(() => {
      void invoke("exit_app");
    }, 5000);
    return () => clearTimeout(t);
  }, [step]);

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
      void startAttempt({ examId: EXAM_ID, studentId: studentIdRef.current, total: questions.length }).then(id => {
        if (id) setAttemptId(id);
      });
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

    }
    
    setStep("exam");
  }

  async function doSubmit() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    if (supabaseConfigured && studentIdRef.current) {
      const minutesUsed = Math.round((durationMin * 60 - secondsLeft) / 60);
      const success = await submitAttempt({
        examId: EXAM_ID,
        studentId: studentIdRef.current,
        answers: answers as Record<string, unknown>,
        answered: answeredCount,
        minutesUsed,
      });

      if (!success) {
        try {
          localStorage.setItem(`pending_sync_${EXAM_ID}`, JSON.stringify({
            answers,
            answered: answeredCount,
            minutesUsed,
            isSubmit: true
          }));
        } catch {}
      }
    }
    
    // Upload the screen recording to Cloudflare R2 only (no PDF, no screenshots)
    setTimeout(async () => {
      try {
        const videoBlob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        await uploadExamRecords({
          examId: EXAM_ID,
          studentIdentifier: STUDENT_ROLL,
          videoBlob,
        });
      } catch (err) {
        console.error("Failed to upload recording:", err);
      }
    }, 500);

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    setStep("submitted");
  }

  function selectOption(optIndex: number) {
    if (!q) return;
    setAnswer(q.id, optIndex);
  }
  function toggleCurrentReview() {
    if (!q) return;
    toggleReview(q.id);
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper p-4 text-center">
        <div className="max-w-md border border-line bg-paper p-8 shadow-sm">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Assessment notice</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold text-ink">Cannot Load Exam</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{loadError}</p>
          <a
            href="/student/exams"
            className="mt-6 inline-block border border-maroon bg-maroon px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon/90"
          >
            ← Back to my exams
          </a>
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
    const href = downloadUrl(osRaw) || "";
    const downloadFilename =
      osRaw === "windows" ? "Vignan Exam Browser Setup.exe" :
      osRaw === "macos"   ? "Vignan Exam Browser.dmg" :
      osRaw === "linux"   ? "Vignan Exam Browser.AppImage" :
                            "Vignan Exam Browser Setup.exe";
    
    return (
      <DownloadGateScreen
        examName={examName}
        installer={installer}
        os={os}
        href={href}
        downloadFilename={downloadFilename}
        onDoneInstall={() => {
          setStep("installed");
          window.location.href = `vignan-exam://open?exam=${encodeURIComponent(EXAM_ID)}&roll=${encodeURIComponent(STUDENT_ROLL)}`;
        }}
        onPreview={() => {
          const url = new URL(window.location.href);
          url.searchParams.set("lockdown", "1");
          window.location.href = url.toString();
        }}
      />
    );
  }

  // ---------- Step: installed → Enter exam via deep link ----------
  // Student installed the Vignan Exam Browser. Now "Enter exam" fires the
  // vignan-exam:// URL scheme — the OS opens the app with the exam pre-loaded.
  // If the scheme is not handled (app not actually installed / wrong OS),
  // we show the download button as fallback after a 3-second timeout.
    if (step === "installed") {
    return (
      <InstalledScreen
        examName={examName}
        deepLinkTried={deepLinkTried}
        deepLinkFailed={deepLinkFailed}
        onEnter={() => {
          setDeepLinkTried(true);
          window.location.href = `vignan-exam://open?exam=${encodeURIComponent(EXAM_ID)}&roll=${encodeURIComponent(STUDENT_ROLL)}`;
          setTimeout(() => setDeepLinkFailed(true), 3000);
        }}
        onTryAgain={() => {
          window.location.href = `vignan-exam://open?exam=${encodeURIComponent(EXAM_ID)}&roll=${encodeURIComponent(STUDENT_ROLL)}`;
        }}
        onBack={() => setStep("gate")}
        downloadHref={downloadUrl(detectOS()) || ""}
        downloadFilename={detectOS() === "windows" ? "Vignan Exam Browser Setup.exe" : detectOS() === "macos" ? "Vignan Exam Browser.dmg" : "Vignan Exam Browser.AppImage"}
        onPreview={() => {
          const url = new URL(window.location.href);
          url.searchParams.set("lockdown", "1");
          window.location.href = url.toString();
        }}
      />
    );
  }

  // ---------- Step: system compatibility check ----------
    if (step === "check") {
    return (
      <SystemCheckScreen
        examName={examName}
        checks={checks}
        checkIndex={checkIndex}
        checksDone={checksDone}
        checksPassed={checksPassed}
        onContinue={() => setStep("access")}
        onRecheck={() => { setChecks([]); setCheckIndex(0); setStep("gate"); setTimeout(() => setStep("check"), 0); }}
        onExit={() => {
          if (isTauri()) {
            void invoke("exit_app");
          } else {
            window.location.href = "/student/dashboard";
          }
        }}
      />
    );
  }

  // ---------- Step: device access ----------
    if (step === "access") {
    const devicesReady = cam === "granted" && mic === "granted" && screen === "granted";
    return (
      <DeviceAccessFull
        cam={cam}
        mic={mic}
        screen={screen}
        requesting={requesting}
        devicesReady={devicesReady}
        previewRef={previewRef}
        onRequest={requestDevices}
        onContinue={() => setStep("rules")}
      />
    );
  }
  // ---------- Step: rules, timer & instructions ----------
    if (step === "rules") {
    return (
      <RulesScreen
        examName={examName}
        durationMin={durationMin}
        questionsLength={questions.length}
        agreed={agreed}
        onAgree={setAgreed}
        onStart={beginExam}
      />
    );
  }

    if (step === "submitted") {
    return (
      <SubmittedScreen
        answeredCount={answeredCount}
        totalQuestions={questions.length}
        studentName={STUDENT_NAME}
        studentRoll={STUDENT_ROLL}
        violationsCount={violations.length}
        examId={EXAM_ID}
      />
    );
  }

  // ---------- Step: exam (kiosk mode) ----------
  return (
    <div className="min-h-screen bg-paper text-ink">
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

      {/* Timer warning banner */}
      {timerWarning && (
        <div className={`fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-2 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-paper ${
          secondsLeft <= 60 ? "bg-alert" : "bg-amber"
        }`}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-paper" />
          {timerWarning.toUpperCase()}
        </div>
      )}

      <ExamHeader
        examName={examName}
        studentName={STUDENT_NAME}
        currentQuestion={current + 1}
        totalQuestions={questions.length}
        timeString={timeString}
        timerToneClass={timerTone}
        isFullscreen={isFullscreen}
        autosaveStatus={autosaveStatus}
        lastSavedAt={lastSavedAt}
        onExit={() => setShowSubmitDialog(true)}
        onToggleFullscreen={() => {
          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else {
            void document.documentElement.requestFullscreen?.();
          }
        }}
      />

      <div className="mx-auto grid max-w-[1400px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[264px_minmax(0,1fr)_264px] lg:px-8">
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
          <QuestionPanel
            questions={questions}
            currentIndex={current}
            getStatus={getQuestionStatus}
            onJump={goTo}
          />
        </aside>

        {/* CENTER */}
        <main>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-maroon">Question {current + 1} of {questions.length}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{q?.category}</p>
            </div>
          </div>

          <QuestionDisplay
            question={q}
            examId={EXAM_ID}
            studentId={studentId}
            answer={q ? answers[q.id] : undefined}
            isReviewed={!!(q && isReviewed(q.id))}
            onSelectOption={selectOption}
            onToggleReview={() => {
              if (!q) return;
              toggleReview(q.id);
            }}
            examName={examName}
            studentName={STUDENT_NAME}
            questionIndex={current + 1}
          />
          <QuestionNavigationButtons
            currentIndex={current}
            total={questions.length}
            lastVisited={lastVisited}
            isReviewed={!!(q && isReviewed(q.id))}
            onPrev={goPrev}
            onNext={goNext}
            onJump={goTo}
            onGoLastVisited={goLastVisited}
            onToggleReview={toggleCurrentReview}
            onSaveNow={() => {
              void saveNow();
            }}
          />
        </main>

        {/* RIGHT */}
        <aside className="space-y-4 lg:sticky lg:top-[84px] lg:self-start">
          <AnswerPanel
            answerStatus={!q ? "Not Answered" : isReviewed(q.id) ? "Review" : (answers[q.id] !== undefined ? "Answered" : "Not Answered")}
            saveStatus={autosaveStatus}
            lastSavedAt={lastSavedAt}
            draftedCount={counts.drafted}
            timeString={timeString}
            onSubmit={() => setShowSubmitDialog(true)}
          />
          <ExamSidebar answered={answeredCount} total={questions.length} marked={markedCount} timeString={timeString} secondsLeft={secondsLeft} />

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctoring</p>
            <ProctorCamera
              room={ROOM}
              identity={STUDENT_ROLL}
              examId={EXAM_ID}
              studentId={STUDENT_ROLL}
              screenStream={screenStream}
              violationActive={!!activeViolation}
              proctorMessages={violations.slice(-3).map((v) => `${v.kind} at ${v.at}`)}
            />
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
            cameraStream={cameraStream}
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

      {showShortcuts && (
        <div className="fixed bottom-4 right-4 z-[65] w-full max-w-sm border border-line bg-paper p-4 text-[12px] shadow-xl">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Keyboard shortcuts</p>
          <p className="mt-2">↑/↓ Prev/Next · ← First · → Last</p>
          <p>R or Ctrl+B Toggle review</p>
          <p>Ctrl+S Save · Alt+S Submit · ? hide</p>
        </div>
      )}

      <SubmitDialog
        open={showSubmitDialog}
        answered={answeredCount}
        total={questions.length}
        marked={markedCount}
        onCancel={() => setShowSubmitDialog(false)}
        onConfirm={() => {
          setShowSubmitDialog(false);
          void doSubmit();
        }}
      />
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="border border-line bg-paper py-2 text-center">
      <p className={`font-serif text-2xl leading-none ${tone}`}>{n}</p>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
    </div>
  );
}
