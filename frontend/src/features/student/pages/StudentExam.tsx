import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiAlertTriangle } from "react-icons/fi";
import * as Sentry from "@sentry/react";
import Seal from "@/shared/components/Seal";
import ProctorCamera from "@/features/proctoring/components/ProctorCamera";
import InvigilatorVoice from "@/features/proctoring/components/InvigilatorVoice";
import ExamTools from "@/features/student/components/ExamTools";
import ProctorAI, { FRAMING_HINT, type AIStatus } from "@/features/proctoring/components/ProctorAI";
import ExamHeader from "@/features/student/components/exam/ExamHeader";
import QuestionPanel from "@/features/student/components/exam/QuestionPanel";
import QuestionDisplay from "@/features/student/components/exam/QuestionDisplay";
import QuestionNavigationButtons from "@/features/student/components/exam/QuestionNavigationButtons";
import MonitorQRPanel from "@/features/student/components/exam/MonitorQRPanel";
import SubmitDialog from "@/features/student/components/exam/SubmitDialog";
import { supabaseConfigured } from "@/shared/data/env";
import { useAuth } from "@/features/auth/auth";
import {
  loadPaperForStudent,
  getStudentProfile,
  startAttempt,
  saveAnswers,
  submitAttempt,
  claimAttemptSession,
  deviceSessionId,
  saveViolation,
  listProctorMessages,
  subscribeToMessages,
  type DBQuestion,
  type PaperSlot,
} from "@/shared/data/examApi";
import type { ProctorMessage } from "@/shared/data/api/types";
import { lockdownReady, isTauri, downloadUrl, osLabel, detectOS, probeInstaller } from "@/shared/platform/platform";
import {
  launchExamInLockdown,
  openStudentSide,
  mediaPermissionStatus,
  openMediaSettings,
  requestMediaAccess,
  beginPermissionPhase,
  endPermissionPhase,
  relaunchExamBrowser,
  screenCaptureStatus,
  keyboardLockStatus,
  requestKeyboardLock,
  enterLockdown,
  leaveLockdown,
  LAUNCHED_FROM_LINK_KEY,
} from "@/shared/platform/lockdownBridge";
import { defaultWatermarkText, renderWatermarkTemplate } from "@/shared/services/watermark";
import ExamWatermark from "@/features/student/components/exam/ExamWatermark";
import useExamState from "@/features/student/hooks/useExamState";
import useExamTimer from "@/features/student/hooks/useExamTimer";
import useSectionTimer from "@/features/student/hooks/useSectionTimer";
import { markUploadHandled, shouldApplyUpload, uploadAnswer } from "@/features/student/services/uploadedAnswers";
import { getSupabase } from "@/shared/data/supabase";
import { autoGradeAttempt, describeNegative, groupBySection, releaseTiming, type AutoGradeResult, type ReleaseSettings, questionKind, KIND_LABEL, sectionWindows, type NegativeSettings, type QuestionKind } from "@/shared/domain/exam";
import useAutosave from "@/features/student/hooks/useAutosave";
import useProctoring from "@/features/proctoring/hooks/useProctoring";
import useKeyboardShortcuts from "@/features/student/hooks/useKeyboardShortcuts";
import useOfflineSync from "@/features/student/hooks/useOfflineSync";
import useCurrentProfile from "@/features/auth/hooks/useCurrentProfile";
import { invoke } from "@tauri-apps/api/core";
import { startNativeDisplayStream } from "@/shared/platform/nativeScreenShare";
import { uploadExamRecords, uploadRecordingPart, startScreenshotCapture, type ScreenshotHandle, type ViolationSnap } from "@/shared/services/examStorage";
import { startServerProctorWatchdog, type ServerProctorHandle } from "@/features/proctoring/services/serverProctor";
import {
  DownloadGateScreen,
  InstalledScreen,
  SystemCheckScreen,
  SubmittedScreen
} from "@/features/student/components/exam/ExamFlowScreens";
import RegistrationScreen from "@/features/student/components/exam/RegistrationScreen";
import StartScreen from "@/features/student/components/exam/StartScreen";
import { useNavigate, useSearchParams } from "react-router-dom";
import DeviceAccessFull from "@/features/student/components/exam/DeviceAccessFull";
import IdentityVerificationScreen from "@/features/student/components/exam/IdentityVerificationScreen";

type Question = { id: string; text: string; options: string[]; category: string; type?: "mcq" | "subjective"; kind: QuestionKind; section: string; subjective_mode?: "both" | "qr" | "textbox" | null; marks?: number; };

// Map a DB question row / the shape the exam UI renders. The id is the DB
// question id, so answers (keyed by id) survive paper slicing and match the
// grading side. MCQ options only; subjective questions still render (options
// fall back to none) so the paper is complete even if the pool mixes types.
function toUIQuestion(row: DBQuestion): Question {
  const kind = questionKind(row.type, row.options?.length ?? 0);
  const choice = kind === "mcq" || kind === "msq" || kind === "truefalse";
  return {
    id: row.id,
    text: row.title,
    options: choice ? row.options ?? [] : [],
    category: row.unit ?? "General",
    type: choice ? "mcq" : "subjective",
    kind,
    section: KIND_LABEL[kind],
    subjective_mode: row.subjective_mode,
    marks: row.marks || 1,
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

// Steps (mirrors the reference flow): gate (browser download) / check / access
// (devices) / register (name/email/USN + terms) / optional photo-ID verify /
// start (pick section) / exam / submitted. "installed" is a transient gate
// sub-state.
type Step = "gate" | "installed" | "check" | "access" | "register" | "verify" | "start" | "exam" | "submitted";

export default function StudentExam() {
  const [params] = useSearchParams();
  // A late/warm native link must load its own paper and preflight state, not
  // reuse the previous exam's answers, timers or missing-reference error.
  return <StudentExamSession key={params.get("examId") ?? params.get("exam") ?? ""} />;
}

function StudentExamSession() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const searchExamId = searchParams.get("examId") ?? searchParams.get("exam");
  const searchRoll = searchParams.get("roll");
  // The exam must come from the invite/deep link — there is deliberately no
  // hardcoded fallback exam any more.
  const EXAM_ID = searchExamId ?? "";
  const ROOM = EXAM_ID;
  const [durationMin, setDurationMin] = useState(45);

  // Real identity: the logged-in student's profile (auth_id-linked row). A
  // ?roll= URL param is honoured ONLY in the explicit anon sandbox mode
  // (VITE_ALLOW_ANON_ROLL=true) — never as a silent production fallback.
  const anonRollAllowed = import.meta.env.VITE_ALLOW_ANON_ROLL === "true";
  const { user: authUser, role: authRole, session: authSession, loading: authLoading } = useAuth();
  const { profile: authProfile, loading: profileLoading } = useCurrentProfile();
  const [resolvedRoll, setResolvedRoll] = useState<string>(() =>
    searchRoll && anonRollAllowed ? searchRoll : "",
  );
  useEffect(() => {
    if (authProfile && "roll" in authProfile && authProfile.roll) {
      setResolvedRoll(authProfile.roll);
    }
  }, [authProfile]);
  // Demo users (id starts with "demo-") get a mock roll so the install gate
  // and pre-flight checks can run without a real DB row.
  const demoRoll = authUser?.id?.startsWith("demo-")
    ? `DEMO${authUser.id.slice(5).toUpperCase()}`
    : null;
  const STUDENT_ROLL = demoRoll ?? resolvedRoll;
  const identityReady = profileLoading || Boolean(STUDENT_ROLL);
  const rollParamMismatch =
    !anonRollAllowed && searchRoll && STUDENT_ROLL && searchRoll !== STUDENT_ROLL;

  // Real flow: if the student is not inside the installed Vignan Lockdown Browser,
  // they must install the desktop package first. Only the packaged Tauri app can
  // continue into the pre-exam checks and the actual exam flow.
  const [step, setStep] = useState<Step>(() => (lockdownReady() ? "check" : "gate"));

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loadError, setLoadError] = useState("");
  const [examName, setExamName] = useState("");
  // Test Options for THIS exam (watermark tokens, flag-limit action, …) —
  // captured when the paper loads and read by the exam-step UI/effects.
  const [examSettings, setExamSettings] = useState<Record<string, unknown>>({});
  // Mirror the exam name for long-lived upload closures (recording parts,
  // screenshot loop) so they always write under the exam-name R2 folder.
  const examNameRef = useRef("");
  useEffect(() => { examNameRef.current = examName; }, [examName]);
  // Real student identity: preferred from the email link (?name=&email=&roll=),
  // otherwise resolved from the students table once the session is known.
  const urlName = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("name") : null;
  const urlEmail = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("email") : null;
  const [studentName, setStudentName] = useState<string>(urlName ?? "Candidate");
  const [studentEmail, setStudentEmail] = useState<string>(urlEmail ?? "");
  // The student's paper snapshot (DB question ids in order) — persisted with
  // the attempt row so reloads and grading see exactly what this student saw.
  const paperRef = useRef<PaperSlot[]>([]);
  const poolRef = useRef<DBQuestion[]>([]);
  const [submitGrade, setSubmitGrade] = useState<AutoGradeResult | null>(null);
  // Index of the first question of the section the student picked on the
  // "Ready to start?" screen (defaults to the very first question).
  const startIndexRef = useRef(0);

  // Attempt / DB
  const studentIdRef = useRef<string | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null); // state for immediate re-render
  const attemptStartedRef = useRef(false);
  const [attemptId, setAttemptId] = useState<string | undefined>();
  const [endMonitor, setEndMonitor] = useState(false);

  // Device access state
  const [cam, setCam] = useState<"idle" | "granted" | "denied">("idle");
  const [mic, setMic] = useState<"idle" | "granted" | "denied">("idle");
  const [screen, setScreen] = useState<"idle" | "granted" | "denied">("idle");
  // Kiosk only: the system-wide keyboard lock (macOS hot keys / Windows keyboard hook).
  const [keyboard, setKeyboard] = useState<"idle" | "granted" | "denied">(isTauri() ? "idle" : "granted");
  const [requesting, setRequesting] = useState(false);
  const [screenNeedsRestart, setScreenNeedsRestart] = useState(false);
  const permissionPhaseRef = useRef(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  // Hidden webcam video for the student's per-second snapshot timeline
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  // Screenshot capture handle (startScreenshotCapture)
  const screenshotHandleRef = useRef<ScreenshotHandle | null>(null);
  // Server-side proctor watchdog (downsampled frames -> proctor-ai-server fn)
  const serverProctorRef = useRef<ServerProctorHandle | null>(null);
  // Mirror the attempt id so long-lived effects always read the latest value.
  const attemptIdRef = useRef<string | undefined>(undefined);
  useEffect(() => { attemptIdRef.current = attemptId; }, [attemptId]);
  // Same credentials on a second laptop/tab: only the device holding the
  // attempt may write; the other gets a blocking screen.
  const deviceSession = useMemo(() => deviceSessionId(EXAM_ID), [EXAM_ID]);
  const [deviceConflict, setDeviceConflict] = useState<null | "busy" | "submitted">(null);
  const conflictLoggedRef = useRef(false);
  const claimRestoredRef = useRef(false);
  const deviceConflictRef = useRef(deviceConflict);
  deviceConflictRef.current = deviceConflict;
  // Real violation snapshot blobs (captured at violation moment), with the
  // offset in seconds from the exam start for the PDF + seek-bar timeline.
  const violationSnapshotsRef = useRef<ViolationSnap[]>([]);
  const examStartedAtRef = useRef<number | null>(null);
  const accessStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(!!document.fullscreenElement);
  // Where the exam recording actually landed after submit — surfaced on the
  // submitted screen so a silently lost recording can't happen unnoticed.
  // Where the exam recording actually landed after submit — tracked internally
  // (console only). The student UI deliberately does NOT show storage details:
  // candidates should never see infrastructure names like "Cloudflare".
  const [artifactStatus, setArtifactStatus] = useState<{ state: "uploading" | "stored" | "partial" | "failed"; detail?: string } | null>(null);
  // True when the final submitAttempt write failed (answers stayed local and
  // will retry on reconnect) — the submitted screen warns instead of faking it.
  const [submitFailed, setSubmitFailed] = useState(false);

  // AI proctoring state
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  // Shared camera stream ref so ProctorAI can read the same feed as ProctorCamera
  const cameraStreamRef = useRef<MediaStream | null>(null);
  // State to trigger re-render when stream is ready
  const [, forceUpdate] = useState(0);

  // "installed" deep-link state: tracks whether we tried vignan-exam:// launch
  const [deepLinkTried, setDeepLinkTried] = useState(false);
  const [deepLinkFailed, setDeepLinkFailed] = useState(false);
  const deepLinkCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { deepLinkCleanupRef.current?.(); }, []);
  function openInstalledExam() {
    deepLinkCleanupRef.current?.();
    setStep("installed");
    setDeepLinkTried(true);
    setDeepLinkFailed(false);
    const onLaunchUnconfirmed = () => setDeepLinkFailed(true);
    deepLinkCleanupRef.current = authSession
      ? launchExamInLockdown(EXAM_ID, STUDENT_ROLL, onLaunchUnconfirmed, authSession)
      : launchExamInLockdown(EXAM_ID, STUDENT_ROLL, onLaunchUnconfirmed);
  }
  // True while the invigilator has paused this candidate (attempt.state = "paused").
  const [proctorPaused, setProctorPaused] = useState(false);
  const [announcements, setAnnouncements] = useState<ProctorMessage[]>([]);
  const seenAnnouncementsKey = `vignan.announcementsSeen.${EXAM_ID}`;
  const [seenAnnouncements, setSeenAnnouncements] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(seenAnnouncementsKey) ?? "[]") as string[]; } catch { return []; }
  });

  // Screen recording runs separately from the webcam snapshot timeline.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recorderOnScreenRef = useRef(false);
  const submitStartedRef = useRef(false);
  const recordedChunksRef = useRef<Blob[]>([]);
  // Crash-proof recording: every chunk the recorder emits is also uploaded to
  // R2 immediately (parts/exam_NNNNNNNN.webm). A browser crash mid-exam then
  // loses at most the in-flight tail — the reviewer rebuilds the video from
  // the uploaded parts.
  //
  // IMPORTANT: the sequence number is assigned at ENQUEUE time, not after the
  // upload, so a failed upload can never silently renumber the parts and
  // corrupt the rebuild order. Each part gets up to 3 attempts before being
  // dropped, and uploads run strictly one-at-a-time to keep order stable.
  const partsSeqRef = useRef(0);
  const partsQueueRef = useRef<Array<{ seq: number; blob: Blob }>>([]);
  const partsBusyRef = useRef(false);
  async function drainRecordingParts(timeoutMs = 0) {
    if (partsBusyRef.current) return;
    partsBusyRef.current = true;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    try {
      while (partsQueueRef.current.length > 0) {
        if (deadline > 0 && Date.now() > deadline) break;
        const item = partsQueueRef.current[0];
        let attempts = 0;
        let ok = false;
        while (!ok && attempts < 3) {
          attempts += 1;
          try {
            ok = (await uploadRecordingPart({
              examId: EXAM_ID,
              examName: examNameRef.current,
              roll: STUDENT_ROLL,
              blob: item.blob,
              seq: item.seq,
            })) !== null;
          } catch { /* retry */ }
          if (!ok && deadline > 0 && Date.now() > deadline) break;
        }
        // Only dequeue after success or after exhausting retries — never reorder.
        partsQueueRef.current.shift();
      }
    } finally {
      partsBusyRef.current = false;
      if (partsQueueRef.current.length > 0) void drainRecordingParts();
    }
  }
  const queueRecordingPart = (blob: Blob) => {
    if (!supabaseConfigured || !EXAM_ID || !STUDENT_ROLL) return;
    partsQueueRef.current.push({ seq: (partsSeqRef.current += 1), blob });
    void drainRecordingParts();
  };

  /**
   * Start (or restart) the exam MediaRecorder on the given stream. Called once
   * at exam start and again if the screen-share track dies mid-exam — a dead
   * display track keeps producing BLACK frames, so we fail over to the live
   * camera stream instead of recording a black video. WebM chunks from both
   * sessions concatenate into one continuous timeline (the crash-part rebuild
   * in RecordingReview works the same way), so the merged video stays intact.
   */
  function startExamRecorder(stream: MediaStream) {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        // stop() flushes the final chunk (last real frames) into the list
        // before the new recorder starts.
        mediaRecorderRef.current.stop();
      }
      const mime =
        [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
          "video/mp4",
        ].find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1600000 } : { videoBitsPerSecond: 1600000 });
      mr.ondataavailable = (e) => {
        if (e.data.size <= 0) return;
        // 1) Local accumulation / merged full video at submit (unchanged).
        recordedChunksRef.current.push(e.data);
        // 2) Live upload of this chunk / crash-proof parts in R2.
        queueRecordingPart(e.data);
      };
      mr.start(10_000); // 10 s chunk cadence (final video is identical)
      mediaRecorderRef.current = mr;
    } catch (e) {
      console.warn("Failed to start MediaRecorder", e);
    }
  }

  /**
   * Fired when the OS/browser ends the screen share mid-exam (student clicks
   * “Stop sharing”, the picker is dismissed, the OS revokes the capture). A
   * MediaRecorder that keeps recording an ended display track writes BLACK
   * frames for the rest of the exam — the black-screen video symptom. This
   * fails the recorder AND the screenshot source over to the live camera
   * stream so the evidence keeps capturing real frames.
   */
  const handleScreenTrackEnded = () => {
    setScreen("denied");
    flag("Screen sharing stopped — recording continues with camera feed");
    screenStreamRef.current = null;
    // Stop the server-side screen watchdog IMMEDIATELY: left running on a dead
    // display track it analyses black frames and the server writes a
    // screen_black violation every cooldown window for the rest of the exam —
    // the main source of phantom violations the teacher saw (and a count the
    // student's own screen never showed).
    serverProctorRef.current?.stop();
    serverProctorRef.current = null;
    const cam = cameraStreamRef.current;
    if (!cam) return;
    const camLive = cam.getVideoTracks().some((t) => t.readyState === "live");
    if (recorderOnScreenRef.current) {
      recorderOnScreenRef.current = false;
      if (camLive) startExamRecorder(cam);
      else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
    }
    // Point the screenshot frame source at the camera too (it was the screen).
    const el = hiddenVideoRef.current;
    if (el && el.srcObject !== cam) {
      el.srcObject = cam;
      void el.play().catch(() => {});
    }
  };

  // Explicit consent to recording/proctoring (required before the exam starts;
  // persisted on the attempt row as consent_at).
  const [consentGiven, setConsentGiven] = useState(false);

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
    clearAnswer,
    toggleReview,
    isReviewed,
    getQuestionStatus,
    counts,
    markVisited,
  } = useExamState(questions);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  // Sections are real groupings of the student's own paper (mirrors the
  // reference layout where e.g. "Descriptive" and "MCQ" are separate).
  const sections = useMemo(() => {
    if (!examSettings.sections) return [];
    const groups = new Map<string, { name: string; ids: string[] }>();
    for (const q of questions) {
      const name = q.section;
      let g = groups.get(name);
      if (!g) {
        g = { name, ids: [] };
        groups.set(name, g);
      }
      g.ids.push(q.id);
    }
    return Array.from(groups.values()).map((g) => ({ name: g.name, count: g.ids.length, firstIndex: questions.findIndex((q) => q.id === g.ids[0]) }));
  }, [questions, examSettings.sections]);

  const negativeRule = useMemo(() => describeNegative(examSettings as NegativeSettings), [examSettings]);
  const windows = useMemo(
    () => (examSettings.sections === true && examSettings.sectionTiming === true && questions.length
      ? sectionWindows(questions.map((q) => q.section), examSettings.sectionMinutes as Record<string, number> | undefined, durationMin)
      : []),
    [examSettings, questions, durationMin],
  );

  useOfflineSync(studentIdRef.current);

  // Phone uploads land in question_submissions. Attach any new one to its
  // question even if the candidate has moved to another question meanwhile
  // (the QR panel only watches while its question is on screen).
  useEffect(() => {
    const db = getSupabase();
    if (step !== "exam" || !db || !attemptId || !studentId) return;
    let alive = true;
    const ids = new Set(questions.map((x) => x.id));
    const sync = async () => {
      const { data } = await db
        .from("question_submissions")
        .select("question_id, pdf_storage_path, created_at")
        .eq("attempt_id", attemptId)
        .eq("student_id", studentId)
        .order("created_at", { ascending: true });
      if (!alive) return;
      for (const row of data ?? []) {
        const qid = String(row.question_id);
        const path = row.pdf_storage_path as string | null;
        if (!path || !ids.has(qid) || !shouldApplyUpload(attemptId, path, answersRef.current[qid])) continue;
        markUploadHandled(attemptId, path);
        setAnswer(qid, uploadAnswer(path));
      }
    };
    void sync();
    const id = window.setInterval(() => void sync(), 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, [step, attemptId, studentId, questions, setAnswer]);

  const { violations, activeViolation, setActiveViolation, flag, handleAIViolation } = useProctoring(
    step === "exam",
    attemptId,
    EXAM_ID,
    studentIdRef.current ?? undefined
  );

  // ── Off-screen phone / answer-sheet scanning mitigation ────────────────────
  // A mobile upload is proof a phone was ACTIVE during the exam. The only way
  // to complete one without the webcam AI ever confirming a phone in frame is
  // to point the phone at the paper while the candidate's hands/eyes are on
  // the desk — the classic "scan answers without getting the phone into the
  // frame". On every completed upload we check the AI's phone detection state:
  // if no phone was seen within a window around the upload, log an explicit
  // integrity violation so the reviewer knows the feed did NOT corroborate the
  // device use. If the phone WAS confirmed in frame, the normal phone flags
  // already cover it.
  const phoneVisibleAtRef = useRef<number[]>([]);
  useEffect(() => {
    if (aiStatus?.phoneDetected) {
      phoneVisibleAtRef.current.push(Date.now());
      if (phoneVisibleAtRef.current.length > 200) phoneVisibleAtRef.current.shift();
    }
  }, [aiStatus?.phoneDetected]);
  const handleAnswerUploaded = useCallback((url: string) => {
    const now = Date.now();
    // Window: the phone must have been visible within ±2 min of the upload.
    const windowMs = 120_000;
    const seen = phoneVisibleAtRef.current.some((t) => now - t <= windowMs);
    if (!seen) {
      flag(
        `[Integrity] Answer uploaded from a mobile device with NO phone visible in the camera — answer sheet may have been scanned outside the proctored view`,
      );
    }
    // Keep the submitted URL with the answer (QuestionDisplay stores it as the
    // answer value); nothing else to do here.
    void url;
  }, [flag]);

  // On every new violation, capture a high-quality snapshot via the screenshot
  // handle and remember when (in seconds from the exam start) it happened, so
  // the PDF report + recording seek bar can timestamp it. Captured once per
  // flag (id).
  const capturedViolationIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!activeViolation || !screenshotHandleRef.current) return;
    if (capturedViolationIdsRef.current.has(activeViolation.id)) return;
    capturedViolationIdsRef.current.add(activeViolation.id);
    const capturedAt = Date.now();
    const offsetSec = examStartedAtRef.current
      ? Math.max(0, Math.round((capturedAt - examStartedAtRef.current) / 1000))
      : null;
    void screenshotHandleRef.current.captureViolationSnapshot(activeViolation.kind, capturedAt).then((blob) => {
      if (blob) violationSnapshotsRef.current.push({ label: activeViolation.kind, blob, offsetSec, capturedAt });
    });
    // AI camera evidence: MediaPipe attached a frame from the webcam feed at
    // flag time — keep it for the PDF + R2 evidence folder (dispute-proofing).
    if (activeViolation.evidenceBlob) {
      violationSnapshotsRef.current.push({
        label: `${activeViolation.kind} (camera evidence)`,
        blob: activeViolation.evidenceBlob,
        offsetSec,
        capturedAt,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViolation]);

  // Capture the STUDENT every second, whether or not AI raises a warning.
  // The screen stream remains the source for the separate screen recording.
  useEffect(() => {
    if (step !== "exam") return;
    const source = cameraStreamRef.current;
    const el = hiddenVideoRef.current;
    if (source && el) {
      el.srcObject = source;
      void el.play().catch(() => {});
      screenshotHandleRef.current = startScreenshotCapture({
        examId: EXAM_ID,
        examName: examNameRef.current,
        roll: STUDENT_ROLL,
        intervalMs: 1000,
        onError: (message) => {
          console.warn("[StudentExam]", message);
          setArtifactStatus({ state: "partial", detail: message });
        },
      });
      screenshotHandleRef.current.setVideo(el);
    }
    // Server-side watchdog: same screen feed, downsampled, analysed server-side.
    if (screenStreamRef.current) {
      serverProctorRef.current = startServerProctorWatchdog({
        stream: screenStreamRef.current,
        examId: EXAM_ID,
        attemptRef: () => attemptIdRef.current,
      });
    }
    // Stop when exam ends
    return () => {
      if (screenshotHandleRef.current) {
        void screenshotHandleRef.current.stop();
        screenshotHandleRef.current = null;
      }
      if (serverProctorRef.current) {
        serverProctorRef.current.stop();
        serverProctorRef.current = null;
      }
    };
  }, [step]);

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
      // Background-app detection temporarily disabled.
      // if (isTauri()) {
      //   try {
      //     const apps = await invoke<string[]>("check_prohibited_apps");
      //     if (apps.length > 0) {
      //       results.push({ label: "Background Apps", ok: false, detail: `Could not close: ${apps.join(", ")}. Quit them manually, then re-check.` });
      //     } else {
      //       results.push({ label: "Background Apps", ok: true, detail: "" });
      //     }
      //   } catch (err) {
      //     console.error(err);
      //   }
      // }

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

  // Load exam + this student's paper (per-student question snapshot) from the DB.
  useEffect(() => {
    if (!supabaseConfigured) return;
    // Wait until auth identity has resolved so demo users (no real Supabase
    // session) still get a student id. authUser is set from useAuth for both
    // demo and real accounts.
    if (authLoading) return;
    // A warm deep link can hydrate the session AFTER this page mounts: the
    // first run (pre-auth) legitimately finds no student row, and the re-run
    // after SIGNED_IN must clear that transient error or it blocks the exam
    // forever behind the "Cannot Load Exam" notice.
    setLoadError("");
    let active = true;
    (async () => {
      // Resolve the student row from the authenticated identity (authUser),
      // so paper snapshots and attempts are bound to the account. Demo users
      // (id starts with "demo-") get a mock roll so the install gate and
      // pre-flight checks can run without a real DB row.
      const db = await import("@/shared/data/supabase").then(m => m.getSupabase());
      const uid = authUser?.id ?? null;
      if (uid) {
        if (uid.startsWith("demo-")) {
          const mockRoll = `DEMO${uid.slice(5).toUpperCase()}`; // e.g. DEMOSTUDENT
          const mockId = `demo-${uid}`;
          studentIdRef.current = mockId;
          setStudentId(mockId);
          setResolvedRoll(mockRoll);
          if (!urlName) setStudentName("Demo Student");
          if (!urlEmail) setStudentEmail(`${uid}@demo.local`);
        } else if (db) {
          const { data: st } = await db
            .from("students")
            .select("id, roll, full_name, email")
            .eq("auth_id", uid)
            .maybeSingle();
          if (st) {
            studentIdRef.current = st.id;
            setStudentId(st.id);
            if (st.roll) setResolvedRoll(st.roll);
            if (!urlName) setStudentName(st.full_name || "Candidate");
            if (!urlEmail) setStudentEmail(st.email ?? "");
          }
        }
      } else if (anonRollAllowed && searchRoll) {
        // Explicit sandbox escape: demo without Supabase Auth. Never active
        // unless VITE_ALLOW_ANON_ROLL=true is set at build time.
        const st = await getStudentProfile(searchRoll);
        if (st?.id) {
          studentIdRef.current = st.id;
          setStudentId(st.id);
          setResolvedRoll(searchRoll);
          if (!urlName) setStudentName(st.full_name || "Candidate");
          if (!urlEmail) setStudentEmail(st.email ?? "");
        }
      }
      if (!active) return;

      if (!EXAM_ID) {
        setLoadError("This link is missing its exam reference. Open the exam from your invite email or the student dashboard.");
        return;
      }
      if (!studentIdRef.current) {
        setLoadError("Your account is not linked to a student record. Ask your exam administrator to link your registration number, then sign in again.");
        return;
      }

      const seed = studentIdRef.current;
      const { exam, questions: rows, paper } = await loadPaperForStudent(EXAM_ID, seed);
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
      setExamSettings((exam.settings ?? {}) as Record<string, unknown>);
      if (exam.duration_minutes) {
        setDurationMin(exam.duration_minutes);
      }

      if (rows.length === 0) {
        setLoadError("No questions found for this exam yet.");
        return;
      }
      paperRef.current = paper;
      poolRef.current = rows;
      const uiRows = rows.map(toUIQuestion);
      // Sections must be contiguous; papers built before per-type sections
      // are regrouped here (answers are keyed by id, so order is free).
      setQuestions(exam.settings?.sections === true ? groupBySection(uiRows, (r) => r.section).flatMap((g) => g.items) : uiRows);

      if (db && studentIdRef.current && active) {
        const { data: att } = await db.from("attempts").select("state").eq("exam_id", EXAM_ID).eq("student_id", studentIdRef.current).maybeSingle();
        if (att?.state === "submitted") {
          setStep("submitted");
        }
      }
    })();
    return () => { active = false; };
  }, [authUser, authLoading]);

  // Release any held media on unmount.
  useEffect(() => () => {
    accessStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Eagerly create the attempt as soon as the student is identified (e.g. during access check),
  // so that the Desk Monitor QR (which requires an attempt_id) can be shown early.
  useEffect(() => {
    if (supabaseConfigured && studentIdRef.current && EXAM_ID && questions.length > 0 && !attemptStartedRef.current) {
      // Only start if they are past the gate
      if (step !== "gate" && step !== "installed" && step !== "check") {
        attemptStartedRef.current = true;
        void import("@/shared/data/examApi").then(m => 
          m.startAttempt({ 
            examId: EXAM_ID, 
            studentId: studentIdRef.current!, 
            total: questions.length 
          })
        ).then(id => {
          if (id) setAttemptId(id);
        }).catch(err => {
          console.error("[StudentExam] eager startAttempt failed:", err);
          attemptStartedRef.current = false;
        });
      }
    }
  }, [supabaseConfigured, EXAM_ID, questions.length, step]);

  useEffect(() => {
    if (!supabaseConfigured || !attemptId || step === "gate" || step === "installed" || step === "check" || step === "submitted") return;
    let alive = true;
    // On taking (or retaking) the attempt, pull answers already saved by an
    // earlier session so this device's autosave doesn't overwrite them.
    const restoreSaved = async () => {
      const db = getSupabase();
      if (!db) return;
      const { data } = await db.from("attempts").select("answers").eq("id", attemptId).maybeSingle();
      const saved = (data?.answers ?? {}) as Record<string, unknown>;
      if (!alive) return;
      const ids = new Set(questions.map((q) => q.id));
      for (const [qid, value] of Object.entries(saved)) {
        if (ids.has(qid) && answersRef.current[qid] === undefined && value !== null && value !== "") setAnswer(qid, value);
      }
    };
    const claim = async () => {
      const res = await claimAttemptSession(attemptId, deviceSession);
      if (!alive) return;
      if (res === "ok") {
        if (!claimRestoredRef.current || deviceConflictRef.current) {
          claimRestoredRef.current = true;
          await restoreSaved();
        }
        setDeviceConflict(null);
      } else if (res === "submitted") setDeviceConflict("submitted");
      else if (res === "busy") {
        setDeviceConflict("busy");
        if (!conflictLoggedRef.current && studentIdRef.current) {
          conflictLoggedRef.current = true;
          void saveViolation(attemptId, EXAM_ID, studentIdRef.current, "multiple_devices",
            "Same candidate tried to open this exam on a second device while it was active on another", { severity: "critical", source: "system" });
        }
      }
    };
    void claim();
    const id = window.setInterval(() => void claim(), 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, [attemptId, step, deviceSession, EXAM_ID, questions, setAnswer]);

  const { secondsLeft, setSecondsLeft, timeString, tone: timerTone } = useExamTimer({
    durationMinutes: durationMin,
    // A proctor pause freezes the countdown until the attempt is resumed.
    active: step === "exam" && !proctorPaused,
    onTimeUp: () => void doSubmit(),
  });

  // ── Timed sections ────────────────────────────────────────────────────────
  // Each section has its own countdown; navigation is limited to the section
  // in progress and finished sections cannot be reopened.
  const [sectionNotice, setSectionNotice] = useState("");
  const [confirmFinishSection, setConfirmFinishSection] = useState(false);
  const sectionTimer = useSectionTimer({
    windows,
    active: step === "exam" && !proctorPaused,
    storageKey: EXAM_ID && STUDENT_ROLL ? `vignan.section.${EXAM_ID}.${STUDENT_ROLL}` : null,
    onExpire: (i) => {
      if (i >= windows.length - 1) {
        if (secondsLeft > 0) void doSubmit();
        return;
      }
      sectionTimer.advance();
      setSectionNotice(`Time for ${windows[i].name} is over. You are now in ${windows[i + 1].name}.`);
    },
  });
  const finishSection = () => {
    setConfirmFinishSection(false);
    const from = sectionTimer.current?.name;
    if (sectionTimer.advance()) setSectionNotice(`${from} submitted. You are now in ${windows[sectionTimer.index + 1]?.name}.`);
  };
  useEffect(() => {
    const w = sectionTimer.current;
    if (!sectionTimer.enabled || !w || step !== "exam") return;
    if (current < w.start) goTo(w.start);
    else if (current >= w.end) goTo(w.end - 1);
  }, [sectionTimer.enabled, sectionTimer.current, current, step, goTo]);

  // ── Flag-limit action (Test Options / Security & access) ──────────────────
  // When the teacher enabled "Take action after a number of proctoring flags",
  // crossing the limit either warns the candidate ONCE or auto-submits the
  // exam ONCE. Without the toggle, flags are recorded but never trigger
  // anything — that knob is exactly what the checkbox controls.
  const flagThresholdFiredRef = useRef(false);
  const [flagThresholdWarning, setFlagThresholdWarning] = useState("");
  useEffect(() => {
    if (step !== "exam" || flagThresholdFiredRef.current) return;
    if (!examSettings.violationLimitEnabled) return;
    const limit = Math.max(1, Number(examSettings.violationLimit ?? 3) || 3);
    if (violations.length < limit) return;
    const action = examSettings.violationAction === "warn" ? "warn" : "submit";
    flagThresholdFiredRef.current = true;
    if (action === "warn") {
      flag(`Flag limit reached (${violations.length}/${limit}) — candidate warned`);
      setFlagThresholdWarning(
        `You have raised ${violations.length} proctoring flags (limit ${limit}). Any further misconduct can auto-submit your exam.`,
      );
    } else {
      flag(`Flag limit reached (${violations.length}/${limit}) — exam auto-submitted`);
      void doSubmit();
    }
  }, [step, examSettings, violations.length, flag]);

  // ── Watermark line tiled across the exam screen ───────────────────────────
  // Test Options accepts placeholders ({registration number}, {name}, …) that
  // resolve to THIS candidate's details; empty template / classic fallback.
  const watermarkLine = (() => {
    const template = String(examSettings.watermarkText ?? "").trim();
    if (!template) return defaultWatermarkText({ name: studentName, roll: STUDENT_ROLL });
    return renderWatermarkTemplate(template, {
      name: studentName,
      roll: STUDENT_ROLL,
      email: studentEmail,
      examName,
      examId: EXAM_ID,
    });
  })();
  const watermarkMeta = useMemo(
    () => [examName, new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })].filter(Boolean).join("  ·  "),
    [examName],
  );

  // Announcements from the teacher/proctor consoles: every broadcast plus
  // messages addressed to this attempt. Unread ones stay pinned until the
  // candidate acknowledges them; the poll covers a dropped realtime socket.
  useEffect(() => {
    if (step !== "exam" || !supabaseConfigured) return;
    let alive = true;
    const load = () => {
      void listProctorMessages(EXAM_ID).then((rows) => {
        if (!alive) return;
        setAnnouncements(rows.filter((m) => m.kind === "broadcast" || (m.attempt_id && m.attempt_id === attemptIdRef.current)));
      });
    };
    load();
    const unsub = subscribeToMessages(EXAM_ID, load);
    const poll = window.setInterval(load, 15000);
    return () => { alive = false; unsub(); window.clearInterval(poll); };
  }, [step, EXAM_ID]);
  const unreadAnnouncements = announcements.filter((m) => !seenAnnouncements.includes(m.id));
  const acknowledgeAnnouncements = () => {
    const next = Array.from(new Set([...seenAnnouncements, ...announcements.map((m) => m.id)]));
    setSeenAnnouncements(next);
    try { localStorage.setItem(seenAnnouncementsKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };

  // React to the invigilator pausing/resuming/FORCE-SUBMITTING this attempt
  // (realtime on the attempts row). The teacher console writes state directly
  // via the DB, so this channel is how a proctor's Force Submit reaches the
  // candidate even though the student never clicked anything.
  const forceSubmitFiredRef = useRef(false);
  useEffect(() => {
    if (step !== "exam" || !supabaseConfigured || !studentIdRef.current) return;
    let stopped = false;
    let cleanup: (() => void) | null = null;
    void import("@/shared/data/supabase").then((m) => {
      const db = m.getSupabase();
      if (!db || !studentIdRef.current || stopped) return;
      const channel = db
        .channel(`attempt-pause-${studentIdRef.current}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "attempts",
            filter: `student_id=eq.${studentIdRef.current}`,
          },
          (payload: { new: { state?: string } | null }) => {
            // Pause / force-submit are already logged once by the proctor
            // console; logging them here too repeated them on every autosave
            // UPDATE while paused.
            const state = payload.new?.state;
            setProctorPaused(state === "paused");
            // Force submit: the invigilator ended this attempt remotely.
            // Guard so a realtime echo / double event can't submit twice —
            // doSubmit() itself is idempotent per attempt via the DB state.
            if (state === "submitted" && !forceSubmitFiredRef.current) {
              forceSubmitFiredRef.current = true;
              void doSubmit();
            }
          },
        )
        .subscribe();
      cleanup = () => { void db.removeChannel(channel); };
    });
    return () => { stopped = true; cleanup?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, flag]);

  // Safety net for missed/late realtime events: while the exam is running,
  // poll the attempt row every 10 s — if the DB says "submitted" but this
  // client is still on the exam screen, force-submit locally too.
  useEffect(() => {
    if (step !== "exam" || !supabaseConfigured || !studentIdRef.current) return;
    const id = window.setInterval(() => {
      if (forceSubmitFiredRef.current) return;
      void (async () => {
        const db = (await import("@/shared/data/supabase")).getSupabase();
        if (!db || !studentIdRef.current) return;
        const { data: att } = await db
          .from("attempts")
          .select("state")
          .eq("exam_id", EXAM_ID)
          .eq("student_id", studentIdRef.current)
          .maybeSingle();
        if (att?.state === "submitted" && !forceSubmitFiredRef.current) {
          forceSubmitFiredRef.current = true;
          void doSubmit();
        }
      })();
    }, 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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

    const minutesUsed = Math.round((durationMin * 60 - secondsLeft) / 60);
    const success = await saveAnswers({
      examId: EXAM_ID,
      studentId: studentIdRef.current,
      answers: answers as Record<string, unknown>,
      answered: answeredCount,
      minutesUsed,
      total: questions.length,
      sessionId: deviceSession,
    });

    if (!success) {
      try {
        localStorage.setItem(`pending_sync_${EXAM_ID}`, JSON.stringify({
          answers,
          answered: answeredCount,
          minutesUsed,
          sessionId: deviceSession,
          isSubmit: false
        }));
      } catch {}
      return false; // Tells autosave it failed so it shows "Offline - Saved locally" or similar if we modify it
    }
    
    return true;
  }, [answeredCount, answers, secondsLeft]);

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
      // Spacebar: for T/F questions cycle 0/1/clear, for MCQ clear current answer
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

  // Auto-exit the Tauri kiosk after submit. Two triggers:
  // 1. Evidence confirmed stored → immediate exit (800 ms delay for UX).
  // 2. Timeout (30 s) → exit regardless. Answers are already in the DB; the
  //    recording parts were streamed live, so at most a merged-video or tail
  //    snapshot is lost — acceptable vs. trapping the student in the app.
  const returnedToStudentSideRef = useRef(false);

  // The app starts as a normal window; the kiosk lock holds only while an
  // exam is open here, and is released when the student leaves the page.
  useEffect(() => {
    if (!isTauri() || !EXAM_ID || step === "submitted") return;
    void enterLockdown();
  }, [EXAM_ID, step]);
  useEffect(() => () => { void leaveLockdown(); }, []);

  useEffect(() => {
    if (step !== "submitted" || !isTauri() || returnedToStudentSideRef.current) return;

    const doExit = () => {
      if (returnedToStudentSideRef.current) return;
      returnedToStudentSideRef.current = true;
      let fromLink = false;
      try { fromLink = sessionStorage.getItem(LAUNCHED_FROM_LINK_KEY) === "1"; } catch { /* storage unavailable */ }
      if (!fromLink) {
        // Opened from the app's own dashboard: unlock and go back to it.
        void leaveLockdown().finally(() => navigate("/student/exams", { replace: true }));
        return;
      }
      void openStudentSide("/student/exams").finally(() => {
        void invoke("exit_app").catch(() => { /* app already closed */ });
      });
    };

    // Immediate exit once evidence is confirmed stored (unless submit itself failed).
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    if (!submitFailed && artifactStatus?.state === "stored") {
      confirmTimer = setTimeout(doExit, 800);
    }

    // Hard timeout so the student is never trapped. While the full recording
    // and PDF are still uploading allow up to 2 minutes; once that settles
    // (stored / partial / failed) exit after 30 s.
    const timeoutTimer = setTimeout(doExit, artifactStatus?.state === "uploading" ? 120_000 : 30_000);

    return () => {
      clearTimeout(confirmTimer);
      clearTimeout(timeoutTimer);
    };
  }, [step, submitFailed, artifactStatus?.state]);

  // ── Authoritative violation count (student↔teacher parity) ────────────────
  // The local `violations` list counts ONLY what this browser flagged. The
  // server watchdog (proctor-ai-server) writes screen_black / screen_frozen /
  // screen_whiteout rows straight into violation_events — those never existed
  // client-side, so the student's summary screen said 10 while the teacher
  // console said 14. After submit, read the DB count back so BOTH sides always
  // show the same number (falls back to the local count when the DB is down).
  const [dbViolationCount, setDbViolationCount] = useState<number | null>(null);
  useEffect(() => {
    if (step !== "submitted" || !attemptId) return;
    let alive = true;
    void import("@/shared/data/examApi").then(async (m) => {
      try {
        const rows = await m.listAttemptViolations(attemptId);
        if (alive && rows) setDbViolationCount(rows.length);
      } catch { /* fall back to the local count */ }
    });
    return () => { alive = false; };
  }, [step, attemptId]);

  // ── Device access ───────────────────────────────────────────────────────
  async function requestDevices() {
    setRequesting(true);
    setCam("idle");
    setMic("idle");
    setScreen("idle");
    setScreenNeedsRestart(false);

    const kiosk = isTauri();
    if (kiosk) {
      // The kiosk window sits above everything; lower it so the macOS
      // dialogs are visible inside the exam browser instead of behind it.
      // Only when a dialog can actually appear: with everything already
      // granted the window stays fullscreen and locked.
      const [camNow, micNow, screenNow] = await Promise.all([
        mediaPermissionStatus("camera"),
        mediaPermissionStatus("microphone"),
        screenCaptureStatus(),
      ]);
      if (camNow !== "granted" || micNow !== "granted" || screenNow !== "granted") {
        permissionPhaseRef.current = true;
        await beginPermissionPhase();
      }
      await requestMediaAccess("camera");
      await requestMediaAccess("microphone");
      const lock = await requestKeyboardLock();
      setKeyboard(lock === "denied" ? "denied" : "granted");
    }

    let screenLocalStream: MediaStream | null = null;
    try {
      if (kiosk) {
        // The whole main display only; the window/screen picker never shows.
        const native = await startNativeDisplayStream();
        if (native === "denied") setScreenNeedsRestart(true);
        else if (native) screenLocalStream = native.stream;
      } else {
        const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: DisplayMediaStreamOptions) => Promise<MediaStream> };
        if (typeof md.getDisplayMedia === "function") {
          const shared = await md.getDisplayMedia({
            video: { displaySurface: "monitor" },
            audio: false,
            monitorTypeSurfaces: "include",
            selfBrowserSurface: "exclude",
            surfaceSwitching: "exclude",
          } as DisplayMediaStreamOptions);
          const surface = shared.getVideoTracks()[0]?.getSettings().displaySurface;
          if (surface && surface !== "monitor") {
            shared.getTracks().forEach((t) => t.stop());
            alert("Please share your entire screen, not a window or tab.");
          } else {
            screenLocalStream = shared;
          }
        }
      }
    } catch (e) {
      console.warn("Screen share request failed", e);
    }

    // Camera + mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === "videoinput");
      const virtualKeywords = ["obs", "virtual", "snap camera", "epoccam", "camtwist"];
      
      let isVirtual = false;
      const activeVideoLabel = stream.getVideoTracks()[0]?.label.toLowerCase() || "";
      if (virtualKeywords.some(kw => activeVideoLabel.includes(kw))) {
        isVirtual = true;
      }
      
      if (isVirtual) {
        alert("Virtual webcam detected! Please disable it and use a real camera.");
        stream.getTracks().forEach(t => t.stop());
        setCam("denied");
        setMic("denied");
        if (!screenLocalStream) setScreen("denied");
        setRequesting(false);
        return;
      }

      accessStreamRef.current = stream;
      setCam(stream.getVideoTracks().length ? "granted" : "denied");
      setMic(stream.getAudioTracks().length ? "granted" : "denied");
      if (previewRef.current) previewRef.current.srcObject = stream;
    } catch (e: any) {
      if (isTauri()) {
        void Promise.all([
          mediaPermissionStatus("camera"),
          mediaPermissionStatus("microphone"),
        ]).then(([c, m]) => console.log("OS Media Status:", { camera: c, microphone: m }));
      }
      setCam("denied");
      setMic("denied");
    }

    if (screenLocalStream) {
      handleScreenGranted(screenLocalStream);
    } else {
      setScreen("denied");
    }

    // The window stays lowered while anything is still blocked so System
    // Settings stays reachable; the effect below restores the lockdown.
    setRequesting(false);
  }

  useEffect(() => {
    if (step === "access" || !permissionPhaseRef.current) return;
    permissionPhaseRef.current = false;
    void endPermissionPhase();
  }, [step]);

  const handleScreenGranted = useCallback((stream: MediaStream) => {
    screenStreamRef.current = stream;
    setScreen("granted");
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      handleScreenTrackEnded();
    });
  }, []);


  const devicesReady = cam === "granted" && mic === "granted" && screen === "granted" && keyboard === "granted";

  // Restore the full lockdown once every permission works.
  useEffect(() => {
    if (!devicesReady || requesting || !permissionPhaseRef.current) return;
    permissionPhaseRef.current = false;
    void endPermissionPhase();
  }, [devicesReady, requesting]);

  // Accessibility switched on in System Settings: the native lock starts by
  // itself; reflect it here without a restart.
  useEffect(() => {
    if (!isTauri() || step !== "access" || keyboard !== "denied" || requesting) return;
    const id = window.setInterval(async () => {
      const status = await keyboardLockStatus();
      if (status !== "denied") {
        window.clearInterval(id);
        setKeyboard("granted");
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [step, keyboard, requesting]);

  // Screen Recording switched on in System Settings: pick it up in place, no
  // restart and no leaving the setup page.
  useEffect(() => {
    if (!isTauri() || step !== "access" || !screenNeedsRestart || requesting) return;
    let alive = true;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if ((await screenCaptureStatus()) !== "granted") return;
        const native = await startNativeDisplayStream();
        if (!alive || !native || native === "denied") {
          if (native && native !== "denied") native.stop();
          return;
        }
        window.clearInterval(id);
        setScreenNeedsRestart(false);
        handleScreenGranted(native.stream);
      } finally {
        busy = false;
      }
    }, 1500);
    return () => { alive = false; window.clearInterval(id); };
  }, [step, screenNeedsRestart, requesting, handleScreenGranted]);

  // Kiosk recovery: after the student opens System Settings and toggles the
  // privacy switch for camera/mic, this function re-runs getUserMedia. The
  // previous version checked mediaPermissionStatus() first and gave up on a
  // "denied" result, but macOS and Windows update the status ONLY after the
  // next getUserMedia call — so the check always returned the stale "denied"
  // and the student could never recover without restarting the app.
  //
  // Now we ALWAYS call requestDevices(), which fires a fresh getUserMedia.
  // If the OS still blocks it, setCam/setMic will land on "denied" as before
  // and the student sees the "Open system settings" guidance again.
  async function reRequestPermissions() {
    setRequesting(true);
    // Small delay so the user sees the "Checking…" state (feedback)
    await new Promise((r) => setTimeout(r, 300));
    await requestDevices();
  }

  function openKioskMediaSettings(kind: "camera" | "microphone" | "screen" | "keyboard") {
    void openMediaSettings(kind);
  }

  function beginExam() {
    examStartedAtRef.current = Date.now();
    // Grab a fresh camera+mic stream for ProctorAI before releasing the preview
    // stream (ProctorCamera will open its own stream via LiveKit).
    if (accessStreamRef.current) {
      cameraStreamRef.current = accessStreamRef.current;
      // Keep the stream alive for ProctorAI; ProctorCamera acquires its own.
      accessStreamRef.current = null;
      // Force re-render so ProctorCamera receives the stream
      forceUpdate(n => n + 1);
    }
    // Enter full-screen lock (best-effort; Tauri kiosk is already fullscreen).
    try { if (!isTauri()) void document.documentElement.requestFullscreen?.(); } catch { /* ignore */ }
    // Start at the first question of the section the student picked.
    if (startIndexRef.current > 0 && startIndexRef.current < questions.length) {
      goTo(startIndexRef.current);
    }
    // Update the DB attempt with the generated paper and consent.
    if (supabaseConfigured && attemptId) {
      void import("@/shared/data/examApi").then(m => m.startAttempt({
        examId: EXAM_ID,
        studentId: studentIdRef.current!,
        total: questions.length,
        paper: paperRef.current
      }));
      if (consentGiven && attemptId) {
        void import("@/shared/data/examApi").then((m) =>
          m.recordConsent(attemptId, {
            text: "Candidate consented to video/audio/screen monitoring, automated integrity analysis, and secure retention of recordings/snapshots for audit and result-review purposes.",
            version: "1.0",
          }),
        );
      }
    }
    
    // The exam recording is the reviewer's main evidence: the candidate's
    // camera WITH the microphone. The screen is recorded separately by
    // ProctorCamera. Only without a live camera does this fall back to the
    // screen, still carrying the microphone so voices stay audible.
    const liveVideo = (ms?: MediaStream | null) =>
      !!ms && ms.getVideoTracks().some((t) => t.readyState === "live");
    const cam = cameraStreamRef.current;
    const screenVideo = screenStreamRef.current?.getVideoTracks().find((t) => t.readyState === "live");
    const micTracks = cam?.getAudioTracks().filter((t) => t.readyState === "live") ?? [];
    const targetStream = liveVideo(cam)
      ? cam
      : screenVideo
        ? new MediaStream([screenVideo, ...micTracks])
        : null;
    recorderOnScreenRef.current = !!targetStream && targetStream !== cam;
    if (targetStream) startExamRecorder(targetStream);

    setStep("exam");
  }

  async function doSubmit() {
    if (submitStartedRef.current) return;
    submitStartedRef.current = true;
    // Tear down the optional phone desk-monitor session before evidence upload.
    setEndMonitor(true);
    if (isTauri()) void invoke("set_window_sharing", { allow: false }).catch(() => {});
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setArtifactStatus({ state: "uploading", detail: "Securing your exam recording…" });
    // Stop sampling immediately, but keep uploading queued frames. The exit
    // flow waits for this promise as well as the recording, so the tail of a
    // slow-network exam is not abandoned when the native window closes.
    const snapshotsStored = screenshotHandleRef.current?.stop() ?? Promise.resolve(false);
    screenshotHandleRef.current = null;

    const grade = autoGradeAttempt(poolRef.current, paperRef.current, answers as Record<string, unknown>, examSettings as NegativeSettings);
    setSubmitGrade(grade);

    if (supabaseConfigured && studentIdRef.current) {
      const minutesUsed = Math.round((durationMin * 60 - secondsLeft) / 60);
      const success = await submitAttempt({
        examId: EXAM_ID,
        studentId: studentIdRef.current,
        answers: answers as Record<string, unknown>,
        answered: answeredCount,
        minutesUsed,
        total: questions.length,
        score: grade.score,
        sessionId: deviceSession,
      });

      if (!success) {
        // The answers did NOT land in the DB — keep them queued for the
        // reconnect retry AND tell the candidate instead of a fake success.
        setSubmitFailed(true);
        try {
          localStorage.setItem(`pending_sync_${EXAM_ID}`, JSON.stringify({
            answers,
            answered: answeredCount,
            minutesUsed,
            score: grade.score,
            sessionId: deviceSession,
            isSubmit: true
          }));
        } catch {}
      }
    }

    // Upload all exam artifacts: recording + violation snapshots + PDF — all to
    // private storage. The successful status enables Tauri auto-exit only
    // after the queued frames, merged video and complete PDF have landed.
    void (async () => {
      try {
        // 1. Give the recorder a moment to emit its final chunk. The full video
        //    and PDF go first: the kiosk closes shortly after submit, and the
        //    snapshot outbox can take minutes on a slow network (it keeps
        //    retrying in the background and survives a restart).
        await new Promise((r) => setTimeout(r, 400));
        void drainRecordingParts(20_000);
        const snapshotsSettled = Promise.race([
          snapshotsStored,
          new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
        ]);
        // 2. Merge the local chunks into one full video and upload it. This is
        //    the file the teacher's review prefers — parts are the crash fallback.
        const type = recordedChunksRef.current[0]?.type || "video/webm";
        const videoBlob = new Blob(recordedChunksRef.current, { type });
        const result = await uploadExamRecords({
          examId: EXAM_ID,
          examName: examNameRef.current,
          roll: STUDENT_ROLL,
          studentName: studentName,
          videoBlob,
          violationSnapshots: violationSnapshotsRef.current,
          durationSec: Math.max(0, Math.round(durationMin * 60 - secondsLeft)),
          startedAt: examStartedAtRef.current ? new Date(examStartedAtRef.current).toISOString() : null,
          violations: attemptIdRef.current
            ? await (await import("@/shared/data/examApi")).listAttemptViolations(attemptIdRef.current).then((events) =>
                (events ?? []).map((v) => ({ ...v, type: v.violation_type })),
              ).catch(() => undefined)
            : undefined,
        });
        console.log("[StudentExam] artifacts stored:", result);
        const allSnapshotsStored = await snapshotsSettled;
        // Tell the submitted screen what actually landed so the student (and
        // invigilator) can see storage worked instead of silently losing a
        // recording. Parts uploaded live during the exam are the crash fallback.
        if (result.recordingKey && result.pdfKey && allSnapshotsStored) {
          console.info("[StudentExam] recording stored:", result.recordingKey);
          setArtifactStatus({ state: "stored", detail: "Exam recording secured." });
        } else {
          console.warn("[StudentExam] exam evidence is incomplete or pending upload");
          setArtifactStatus({ state: "partial", detail: "Some exam evidence is missing or still pending upload. Please inform your invigilator before closing the app." });
        }
      } catch (err) {
        console.error("Failed to upload recording:", err);
        setArtifactStatus({ state: "failed", detail: "Recording upload failed." });
      }
    })();

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

  // Kiosk opened directly (no vignan-exam:// link → no examId). A cold kiosk
  // has no session either, so route to the in-app login instead of showing a
  // dead end; Login keeps the return path so the student lands on their
  // dashboard after signing in. A signed-in kiosk without an exam reference
  // still gets the normal notice below.
  useEffect(() => {
    if (!isTauri() || authLoading || authUser || EXAM_ID) return;
    navigate("/login", { replace: true });
  }, [authLoading, authUser, EXAM_ID, navigate]);

  const blockingError =
    rollParamMismatch
      ? "The roll number on this link does not match your signed-in account. Open the exam from your student dashboard instead."
      : loadError;
  if (blockingError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper p-4 text-center">
        <div className="max-w-md border border-line bg-paper p-8 shadow-sm">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Assessment notice</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold text-ink">Cannot Load Exam</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{blockingError}</p>
          <a
            href="/student/exams"
            className="mt-6 inline-block border border-forest bg-forest px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest/90"
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
        onDoneInstall={openInstalledExam}
        onPreview={() => {
          const url = new URL(window.location.href);
          url.searchParams.set("lockdown", "1");
          window.location.href = url.toString();
        }}
      />
    );
  }

  // ---------- Step: installed / Enter exam via deep link ----------
  // The install-confirmation click already requested the OS handler. All retry
  // buttons use the same synchronous launch and reset its fallback state.
  // A timeout is only a retry hint — browsers cannot prove an app is installed.
  if (step === "installed") {
    return (
      <InstalledScreen
        examName={examName}
        deepLinkTried={deepLinkTried}
        deepLinkFailed={deepLinkFailed}
        onEnter={openInstalledExam}
        onTryAgain={openInstalledExam}
        onBack={() => {
          deepLinkCleanupRef.current?.();
          setDeepLinkTried(false);
          setDeepLinkFailed(false);
          setStep("gate");
        }}
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
    return (
      <DeviceAccessFull
        attemptId={attemptId}
        cam={cam}
        mic={mic}
        screen={screen}
        keyboard={keyboard}
        requesting={requesting}
        devicesReady={devicesReady}
        inKiosk={isTauri()}
        onReRequest={() => void reRequestPermissions()}
        onOpenMediaSettings={openKioskMediaSettings}
        screenNeedsRestart={screenNeedsRestart}
        onRestart={() => void relaunchExamBrowser()}
        previewRef={previewRef}
        onRequest={requestDevices}
        onScreenGranted={handleScreenGranted}
        onExit={() => {
          if (isTauri()) {
            void invoke("exit_app");
          } else {
            window.location.href = "/student/dashboard";
          }
        }}
        onContinue={() => {
          // If already authenticated, we know who they are.
          // Skip the manual registration form and go straight to identity verification or start.
          if (authProfile && resolvedRoll) {
            setStudentName(authProfile.full_name || "Candidate");
            if (authUser?.email) setStudentEmail(authUser.email);
            setStep(examSettings.photoId === true || examSettings.photoId === "true" ? "verify" : "start");
          } else {
            setStep("register");
          }
        }}
      />
    );
  }
  // ---------- Step: registration (name / email / USN / terms) ----------
  if (step === "register") {
    return (
      <RegistrationScreen
        examName={examName}
        questionCount={questions.length}
        sectionCount={Math.max(1, sections.length)}
        durationMin={durationMin}
        studentName={studentName}
        initial={{
          email: studentEmail || authUser?.email || "",
          firstName: studentName !== "Candidate" && studentName ? studentName.split(" ")[0] : (authProfile?.full_name || authUser?.user_metadata?.full_name || "").split(" ")[0] || "",
          lastName: studentName !== "Candidate" && studentName ? studentName.split(" ").slice(1).join(" ") : (authProfile?.full_name || authUser?.user_metadata?.full_name || "").split(" ").slice(1).join(" ") || "",
          usn: STUDENT_ROLL || (authProfile && "roll" in authProfile ? (authProfile as any).roll : "") || ""
        }}
        onBack={() => setStep("access")}
        onDone={(info) => {
          if (info.firstName || info.lastName) setStudentName(`${info.firstName} ${info.lastName}`.trim());
          if (info.email) setStudentEmail(info.email);
          setStep(examSettings.photoId === true || examSettings.photoId === "true" ? "verify" : "start");
        }}
      />
    );
  }

  // ---------- Step: optional photo-ID verification ----------
  if (step === "verify") {
    return (
      <IdentityVerificationScreen
        examName={examName}
        studentName={studentName}
        studentRoll={STUDENT_ROLL}
        stream={accessStreamRef.current}
        previewRef={previewRef}
        onBack={() => setStep("register")}
        onVerified={() => setStep("start")}
      />
    );
  }

  // ---------- Step: ready to start? (pick section) ----------
  if (step === "start") {
    return (
      <StartScreen
        examName={examName}
        questionCount={questions.length}
        sectionCount={Math.max(1, sections.length)}
        durationMin={durationMin}
        studentName={studentName}
        studentRoll={STUDENT_ROLL}
        sections={sections.map((s) => ({ name: s.name, count: s.count, seconds: windows.find((w) => w.name === s.name)?.seconds }))}
        timedSections={windows.length > 0}
        rules={negativeRule ? [negativeRule] : []}
        consentGiven={consentGiven}
        onConsentChange={setConsentGiven}
        onBack={() => setStep("register")}
        onStart={(idx) => {
          const target = Math.max(0, Math.min(idx, Math.max(0, sections.length - 1)));
          startIndexRef.current = sections[target]?.firstIndex ?? 0;
          beginExam();
        }}
      />
    );
  }

  const releaseSettings = examSettings as ReleaseSettings;
  const showInstantReport = releaseTiming(releaseSettings) === "on_submit" || releaseSettings.results_published === true || releaseSettings.answer_key_published === true;
    if (step === "submitted") {
    return (
      <SubmittedScreen
        answeredCount={answeredCount}
        totalQuestions={questions.length}
        studentName={studentName}
        studentRoll={STUDENT_ROLL}
        violationsCount={dbViolationCount ?? violations.length}
        examId={EXAM_ID}
        attemptId={attemptId ?? null}
        uploadState={artifactStatus?.state}
        uploadDetail={artifactStatus?.detail}
        submitFailed={submitFailed}
        report={submitGrade && showInstantReport ? submitGrade : null}
        feedbackStudentId={examSettings.skipFeedback === true ? null : studentIdRef.current}
      />
    );
  }

  // ---------- Step: exam (kiosk mode) ----------
  const seatingHint = step === "exam" && aiStatus?.framing && aiStatus.framing !== "ok" ? FRAMING_HINT[aiStatus.framing] : null;

  return (
    <div className="exam-body">
      <ExamWatermark primary={watermarkLine} secondary={watermarkMeta} />
      {deviceConflict && (
        <div className="exam-scrim" role="alertdialog" aria-labelledby="device-conflict-title" style={{ zIndex: 95, background: "rgba(26, 24, 20, 0.95)" }}>
          <div className="exam-dialog" style={{ textAlign: "center", maxWidth: 460 }}>
            <h3 id="device-conflict-title">
              {deviceConflict === "submitted" ? "This exam was already submitted" : "This exam is open on another device"}
            </h3>
            <p className="exam-mute" style={{ marginTop: 8 }}>
              {deviceConflict === "submitted"
                ? "Your account submitted this exam from another device. Nothing more can be saved here."
                : "Your account is already writing this exam on another laptop or window. Only one device can write the exam, and this attempt has been reported to your invigilator."}
            </p>
            {deviceConflict === "busy" && (
              <p className="exam-sm" style={{ marginTop: 12 }}>
                If the other device crashed or was closed, this screen unlocks by itself within a minute and you can continue with your saved answers.
              </p>
            )}
          </div>
        </div>
      )}
      {proctorPaused && (
        <div className="exam-scrim" style={{ zIndex: 90, background: "rgba(26, 24, 20, 0.92)" }}>
          <div className="exam-dialog" style={{ textAlign: "center", maxWidth: 420 }}>
            <h3>Your invigilator has paused the exam</h3>
            <p className="exam-mute" style={{ marginTop: 8 }}>Your timer is frozen and your answers are safe. Keep this window open.</p>
            <p style={{ marginTop: 16 }}><span className="exam-pill w"><i />Time frozen · {timeString}</span></p>
          </div>
        </div>
      )}
      {(unreadAnnouncements.length > 0 || flagThresholdWarning || activeViolation || seatingHint) && (
        <div id="exam-banner" style={{ display: "flex" }}>
          {seatingHint && (
            <div className="exam-alert" role="status">
              <i>!</i>
              <div>
                <h3>Sit properly in front of the camera</h3>
                <p>{seatingHint}</p>
              </div>
            </div>
          )}
          {unreadAnnouncements.length > 0 && (
            <div className="exam-alert" role="alert" style={{ borderLeftColor: "var(--pri)", borderLeftWidth: 4 }}>
              <i>i</i>
              <div>
                <h3>
                  {unreadAnnouncements.length > 1 ? `${unreadAnnouncements.length} new announcements` : `Announcement from ${unreadAnnouncements[0].sender}`}
                </h3>
                {unreadAnnouncements.slice().reverse().map((m) => (
                  <p key={m.id} style={{ marginTop: 4, whiteSpace: "pre-wrap", color: "var(--ink)" }}>
                    {unreadAnnouncements.length > 1 && <b>{m.sender} · {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: </b>}
                    {m.body}
                  </p>
                ))}
                <button
                  onClick={acknowledgeAnnouncements}
                  style={{ marginTop: 8, padding: "4px 12px", border: "1px solid var(--pri)", borderRadius: 4, color: "var(--pri)", fontSize: 13, fontWeight: 600 }}
                >
                  Got it
                </button>
              </div>
            </div>
          )}
          {flagThresholdWarning && (
            <div className="exam-alert hi">
              <i>!</i>
              <div>
                <h3>Proctoring warning</h3>
                <p>{flagThresholdWarning}</p>
              </div>
              <button onClick={() => setFlagThresholdWarning("")}>×</button>
            </div>
          )}
          {activeViolation && (
            <div className="exam-alert hi" key={activeViolation.id} role="alert">
              <i>!</i>
              <div>
                <h3>{activeViolation.kind}</h3>
                <p>Logged at {activeViolation.at}. {violations.length} flag{violations.length === 1 ? "" : "s"} this session.</p>
              </div>
              <button onClick={() => setActiveViolation(null)}>×</button>
            </div>
          )}
        </div>
      )}

      <div className="relative z-10">
      <ExamHeader
        examName={examName}
        studentName={studentName}
        studentRoll={resolvedRoll || undefined}
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
            if (!isTauri()) void document.documentElement.requestFullscreen?.();
          }
        }}
      />

      <div className="exam-main">
        {/* LEFT */}
        <div className="exam-aside">
          <section className="exam-panel">
            <h2>Progress</h2>
            <div className="exam-stats">
              <div className="exam-stat"><b>{answeredCount}</b><span>Answered</span></div>
              <div className="exam-stat"><b>{remainingCount}</b><span>Remaining</span></div>
              <div className="exam-stat"><b>{markedCount}</b><span>Marked</span></div>
              <div className="exam-stat"><b>{visitedCount}</b><span>Visited</span></div>
            </div>
            <div className="exam-bar">
              <div style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
            </div>
            <div className="exam-sm exam-mute">{answeredCount}/{questions.length} complete</div>
          </section>
          {announcements.length > 0 && (
            <section className="exam-panel" aria-label="Announcements">
              <h2>Announcements · {announcements.length}</h2>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {announcements.slice().reverse().map((m) => (
                  <div key={m.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                    <div className="exam-sm exam-mute">
                      {m.sender} · {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {m.kind !== "broadcast" && " · to you"}
                    </div>
                    <div className="exam-sm" style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <QuestionPanel
            questions={questions}
            currentIndex={current}
            getStatus={getQuestionStatus}
            onJump={goTo}
            isLocked={sectionTimer.enabled ? (i) => !sectionTimer.inCurrent(i) : undefined}
          />
        </div>

        {/* CENTER */}
        <main className="exam-panel">
          {sectionTimer.enabled && sectionTimer.current && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-raised px-4 py-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Section {sectionTimer.index + 1} of {windows.length}</p>
                <p className="text-[14px] font-semibold">{sectionTimer.current.name} <span className="font-normal text-soft">· questions {sectionTimer.current.start + 1}–{sectionTimer.current.end}</span></p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="font-mono text-[9px] uppercase tracking-wider text-soft">Section time left</p>
                  <p className={`font-mono text-[18px] tabular-nums ${sectionTimer.secondsLeft <= 60 ? "text-alert" : sectionTimer.secondsLeft <= 300 ? "text-amber" : "text-ink"}`}>{sectionTimer.timeString}</p>
                </div>
                {!sectionTimer.isLast && (
                  <button onClick={() => setConfirmFinishSection(true)} className="exam-btn">Finish section</button>
                )}
              </div>
            </div>
          )}
          {sectionNotice && (
            <div className="mb-4 flex items-start justify-between gap-3 border border-forest bg-forest/5 px-4 py-2.5 text-[13px]" role="status">
              <span>{sectionNotice}</span>
              <button onClick={() => setSectionNotice("")} aria-label="Dismiss" className="text-soft hover:text-ink">×</button>
            </div>
          )}
          {negativeRule && (
            <p className="mb-3 border-l-2 border-amber bg-amber/5 px-3 py-2 text-[12px] text-ink">{negativeRule}</p>
          )}

          <QuestionDisplay
            question={q}
            showMarks={examSettings.showMarksInTest !== false && examSettings.showMarks !== false}
            examId={EXAM_ID}
            attemptId={attemptId}
            studentId={studentId}
            answer={q ? answers[q.id] : undefined}
            isReviewed={!!(q && isReviewed(q.id))}
            onSelectOption={selectOption}
            onToggleReview={() => {
              if (!q) return;
              toggleReview(q.id);
            }}
            onClear={() => {
              if (!q) return;
              clearAnswer(q.id);
            }}
            examName={examName}
            studentName={studentName}
            questionIndex={current + 1}
            totalQuestions={questions.length}
            onAnswerUploaded={handleAnswerUploaded}
          />
          <QuestionNavigationButtons
            currentIndex={current}
            total={questions.length}
            lastVisited={lastVisited}
            isReviewed={!!(q && isReviewed(q.id))}
            onPrev={goPrev}
            onNext={goNext}
            range={sectionTimer.current}
            onFinishSection={sectionTimer.enabled ? () => setConfirmFinishSection(true) : undefined}
            onJump={goTo}
            onGoLastVisited={goLastVisited}
            onToggleReview={toggleCurrentReview}
            onSaveNow={() => {
              void saveNow();
            }}
            onSubmit={() => setShowSubmitDialog(true)}
          />
        </main>

        {/* RIGHT */}
        <div className="exam-aside" style={{ alignSelf: "start" }}>
          <section className="exam-panel">
            <h2>Proctoring</h2>
            
            <div className="exam-cam exam-cam-live">
              <ProctorCamera
                room={ROOM}
                identity={STUDENT_ROLL}
                examId={EXAM_ID}
                examName={examName}
                studentId={STUDENT_ROLL}
                screenStream={screenStream}
                initialStream={cameraStream}
                violationActive={!!activeViolation}
                proctorMessages={violations.slice(-3).map((v) => `${v.kind} at ${v.at}`)}
              />
              <span className="exam-rec">Recording</span>
            </div>

            <div className="exam-chips">
              <div className={`exam-chip ${!cameraStream ? "w" : ""}`}>
                <span>Camera</span><span>{cameraStream ? "Connected" : "Waiting"}</span>
              </div>
              <div className={`exam-chip ${screen === "granted" ? "" : "b"}`}>
                <span>Screen</span><span>{screen === "granted" ? "Shared" : "Not shared"}</span>
              </div>
              <div className={`exam-chip ${aiStatus?.faceCount === 0 ? "w" : ""}`}>
                <span>Face</span><span>{aiStatus?.faceCount === 0 ? "Not visible" : "Visible"}</span>
              </div>
              <div className={`exam-chip ${aiStatus?.gazeDirection && aiStatus.gazeDirection !== "center" ? "b" : ""}`}>
                <span>Gaze</span>
                <span>
                  {aiStatus?.gazeDirection === "down"
                    ? "Looking down"
                    : aiStatus?.gazeDirection === "left" || aiStatus?.gazeDirection === "right"
                      ? "Looking away"
                      : aiStatus?.gazeDirection === "up"
                        ? "Looking up"
                        : "On screen"}
                </span>
              </div>
              <div className={`exam-chip ${aiStatus?.voiceSpeaking ? "b" : ""}`}>
                <span>Audio</span><span>{aiStatus?.voiceSpeaking ? "Speaking" : "Quiet"}</span>
              </div>
            </div>

            {(aiStatus?.faceCount === 0 || aiStatus?.voiceSpeaking || aiStatus?.gazeDirection === "down") && (
              <div className="exam-warn">
                {aiStatus?.gazeDirection === "down" ? (
                  <><b>Look at the screen.</b> Looking down has been logged. Your invigilator has been notified.</>
                ) : (
                  <><b>Move into frame.</b> Face the camera and keep it uncovered. Your invigilator has been notified.</>
                )}
              </div>
            )}

            <h2 style={{ marginTop: "14px" }}>Session log</h2>
            <ul className="exam-log">
              {violations.length === 0 ? (
                <li><span>No violations</span><span></span></li>
              ) : (
                violations.slice(-5).map((v, i) => (
                  <li key={i}>
                    <span>{v.kind}</span>
                    <span>{v.at}</span>
                  </li>
                ))
              )}
            </ul>
            
            <div className="exam-side-extra">
              <MonitorQRPanel attemptId={attemptId} onSubmitConsumed={() => setEndMonitor(true)} />
            </div>
            
            {/* Live proctor voice */}
            <InvigilatorVoice examId={EXAM_ID} roll={STUDENT_ROLL} active={step === "exam"} />
          </section>

          {/* Hidden ProctorAI engine */}
          <ProctorAI
            cameraStream={cameraStream}
            active={step === "exam"}
            onViolation={handleAIViolation}
            onStatus={setAiStatus}
          />

          {/* Screenshot frame source */}
          <div aria-hidden className="pointer-events-none fixed bottom-1 right-1 z-[-1] h-[90px] w-[160px] opacity-0">
            <video ref={hiddenVideoRef} autoPlay playsInline muted className="h-full w-full" />
          </div>

          {Boolean(examSettings.calculator) && (
            <div className="exam-panel">
              <h2>Tools</h2>
              <ExamTools />
            </div>
          )}
        </div>
      </div>
      {showShortcuts && (
        <div className="fixed bottom-4 right-4 z-[65] w-full max-w-sm border border-line bg-paper p-4 text-[12px] shadow-xl">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Keyboard shortcuts</p>
          <p className="mt-2">↑/↓ Prev/Next · ← First · / Last</p>
          <p>R or Ctrl+B Toggle review</p>
          <p>Ctrl+S Save · Alt+S Submit · ? hide</p>
        </div>
      )}

      {confirmFinishSection && sectionTimer.current && (
        <div className="exam-scrim" style={{ zIndex: 80 }} role="dialog" aria-modal="true" aria-labelledby="finish-section-title">
          <div className="exam-dialog">
            <h3 id="finish-section-title">Finish {sectionTimer.current.name}?</h3>
            <p className="exam-mute" style={{ marginTop: 6 }}>
              You won't be able to come back to this section. {(() => {
                const w = sectionTimer.current;
                const left = questions.slice(w.start, w.end).filter((x) => getQuestionStatus(x.id).status !== "answered").length;
                return left ? `${left} question${left === 1 ? " is" : "s are"} still unanswered.` : "All questions in this section are answered.";
              })()} The unused {sectionTimer.timeString} is not carried over.
            </p>
            <div className="exam-dact">
              <button onClick={() => setConfirmFinishSection(false)} className="exam-btn">Keep working</button>
              <button onClick={finishSection} className="exam-btn pri">Finish section</button>
            </div>
          </div>
        </div>
      )}

      <SubmitDialog
        open={showSubmitDialog}
        answered={answeredCount}
        total={questions.length}
        marked={markedCount}
        unanswered={questions.flatMap((x, i) => (getQuestionStatus(x.id).status === "answered" ? [] : [i + 1]))}
        onCancel={() => setShowSubmitDialog(false)}
        onConfirm={() => {
          setShowSubmitDialog(false);
          void doSubmit();
        }}
      />
      </div>
    </div>
  );
}
