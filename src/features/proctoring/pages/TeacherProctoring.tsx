import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import { supabaseConfigured } from "@/shared/data/env";
import { listLiveAttempts, subscribeToAttempts, forceSubmitAttempt, saveViolation, setAttemptPaused, listExamsForTeacher, listProctoringStats, listProctorAssignments, saveProctorAssignments, listFaculty, type LiveAttempt, type ViolationEvent, type FacultyMember } from "@/shared/data/examApi";
import { sendProctorAssignmentEmail } from "@/features/teacher/services/emailApi";
import ProctorChatPanel from "@/features/proctoring/components/ProctorChatPanel";
import { startProctorViewing, identityLabel, type RemoteFeed } from "@/features/proctoring/services/proctorViewer";
import { startVoiceBroadcast, voiceRoom } from "@/features/proctoring/services/proctorVoice";
import JobBanner from "@/shared/components/JobBanner";
import { downloadSessionReportPdf } from "@/shared/services/sessionReport";
import { downloadExamEvidenceZip } from "@/shared/services/zipExport";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { getTeacherNav } from "@/features/teacher/pages/TeacherDashboard";
import { FiVideo, FiMonitor, FiSmartphone, FiGrid, FiArrowLeft, FiMic, FiMicOff, FiUsers, FiChevronRight, FiVolume2, FiVolumeX } from "react-icons/fi";
import ProctoringAssessmentSelect from "@/features/teacher/components/teacher/ProctoringAssessmentSelect";
import { Button } from "@/shared/components/ui";
import type { ProctorAssignment } from "@/shared/data/examApi";

type Student = {
  name: string;
  roll: string;
  status: string;
  progress: number;
  violation: string;
  /** Attempt start (ISO) — used by the session report's snapshot timeline. */
  startedAt: string | null;
  studentId?: string;
  attemptId: string;
  // Real attempt UUID (null for enrolled candidates who haven't started —
  // their placeholder id looks like `enrolled-<uuid>` and can't hit the DB).
  realAttemptId: string | null;
  violations: ViolationEvent[];
};

function attemptToStudent(a: LiveAttempt): Student {
  const pct = a.total ? Math.round((a.answered / a.total) * 100) : 0;
  const status =
    a.state === "submitted" ? "Submitted" :
    a.state === "paused" ? "Paused" :
    a.state === "in_progress" ? "Writing" : "Not started";

  const isPlaceholder = String(a.id).startsWith("enrolled-");
  const realAttemptId = isPlaceholder ? null : a.id;

  // Sort violations descending by created_at (most recent first)
  const sortedVio = [...(a.violations ?? [])].sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
  const activeVio = sortedVio.length > 0 ? sortedVio[0].description || sortedVio[0].violation_type : "";

  return {
    name: a.student?.full_name ?? "Unknown",
    roll: a.student?.roll ?? "—",
    status,
    progress: pct,
    violation: activeVio,
    startedAt: a.started_at,
    studentId: a.student?.id,
    attemptId: a.id,
    realAttemptId,
    violations: [...(a.violations ?? [])],
  };
}

type FeedLookup = (s: Student) => RemoteFeed | null;

export default function TeacherProctoring() {
  const { profile } = useCurrentProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramExamId = searchParams.get("examId") ?? searchParams.get("exam");
  const [examList, setExamList] = useState<{ id: string; name: string; batch?: string; status: string; candidates: number; active: number }[]>([]);
  // Two-stage flow: pick the assessment(s) first (Mettl-style selector), then
  // enter the live command centre for the chosen exam. A ?examId deep link
  // jumps straight into monitoring.
  const [stage, setStage] = useState<"select" | "monitor">(paramExamId ? "monitor" : "select");
  const [selectedExamId, setSelectedExamId] = useState<string>(paramExamId ?? "");
  const beginMonitoring = (examId: string) => {
    setSelectedExamId(examId);
    setSearchParams({ examId });
    setStage("monitor");
  };
  const selectedExam = examList.find((e) => e.id === selectedExamId) ?? null;

  const [students, setStudents] = useState<Student[]>([]);
  const [live, setLive] = useState(false);
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);
  const [viewerState, setViewerState] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error">("idle");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Student | null>(null);
  const [view, setView] = useState<"wall" | "activity" | "chat">("wall");
  const [chatCount, setChatCount] = useState(0);
  const [filter, setFilter] = useState("All candidates");
  const [screenMode, setScreenMode] = useState(false);
  const [phoneMode, setPhoneMode] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  // Real faculty roster (teachers table) — modal rows come from the DB now.
  const [faculty, setFaculty] = useState<FacultyMember[]>([]);
  const [loadingFaculty, setLoadingFaculty] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, { role: "proctor" | "teacher" | "ta"; id?: string | null; email?: string | null }>>({});
  const [emailProctors, setEmailProctors] = useState(true);
  const [savingAssignments, setSavingAssignments] = useState(false);
  // Allocation: which proctors are assigned to this assessment, so the live
  // roster is fairly shared. Loads once per exam (the Assign modal reloads it
  // too).
  const [proctors, setProctors] = useState<ProctorAssignment[]>([]);
  useEffect(() => {
    if (!selectedExamId) return;
    let active = true;
    void listProctorAssignments(selectedExamId).then((rows) => { if (active) setProctors(rows); });
    return () => { active = false; };
  }, [selectedExamId]);

  // Live voice: push-to-talk to the selected candidate's own channel.
  const voiceRef = useRef<Awaited<ReturnType<typeof startVoiceBroadcast>> | null>(null);
  const [speakingTo, setSpeakingTo] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const stopSpeaking = () => {
    const h = voiceRef.current;
    voiceRef.current = null;
    setSpeakingTo(null);
    if (!h) return;
    void h.setSpeaking(false).finally(() => h.stop());
  };
  // Close the voice channel on unmount / when the exam changes.
  useEffect(() => () => stopSpeaking(), []);
  useEffect(() => { stopSpeaking(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selectedExamId]);
  // Feedback for proctor actions (send warning / pause / escalate / force submit)
  const [actionMsg, setActionMsg] = useState<{ text: string; tone: "ok" | "err" | "warn" } | null>(null);
  const actionTimer = useRef<number | null>(null);
  const flash = (text: string, tone: "ok" | "err" | "warn" = "ok") => {
    setActionMsg({ text, tone });
    if (actionTimer.current) window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => setActionMsg(null), 6000);
  };
  // Video wall: per-tile source. "camera" shows webcam, "screen" shows the
  // candidate's shared screen (which is also the recorded exam view). Defaults
  // to camera and persists per session via sessionStorage.
  const [wallSource, setWallSource] = useState<"camera" | "screen" | "phone">(() => {
    if (typeof window === "undefined") return "camera";
    return (sessionStorage.getItem("proctor-wall-source") as "camera" | "screen" | "phone") ?? "camera";
  });

  // Phone desk-monitor feeds: participants with identity `mobile:<roll>`.
  // They carry the student's second camera (desk/hands) from the QR flow.
  const mobileFeedByRoll = useMemo(() => {
    const map = new Map<string, RemoteFeed>();
    for (const f of feeds) {
      if (f.identity.startsWith("mobile:")) {
        map.set(identityLabel(f.identity).toLowerCase(), f);
      }
    }
    return map;
  }, [feeds]);

  // Load real exams + roster stats for the switcher. Prefer published papers
  // with enrollments so a draft like Test 16 is not the silent default.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [exams, stats] = await Promise.all([listExamsForTeacher(), listProctoringStats()]);
      if (!active) return;
      const list = (exams ?? [])
        .map((e) => ({
          id: e.id,
          name: e.name,
          batch: e.batch,
          status: e.status,
          candidates: stats[e.id]?.candidates ?? 0,
          active: stats[e.id]?.active ?? 0,
        }))
        .sort((a, b) => {
          const rank = (x: typeof a) => (x.status === "draft" ? 2 : x.candidates > 0 ? 0 : 1);
          return rank(a) - rank(b) || b.candidates - a.candidates || a.name.localeCompare(b.name);
        });
      setExamList(list);
      if (paramExamId) return;
      if (selectedExamId && list.some((e) => e.id === selectedExamId)) return;
      const preferred = list.find((e) => e.status !== "draft" && e.candidates > 0) ?? list.find((e) => e.status !== "draft") ?? list[0];
      if (preferred && stage === "monitor") {
        setSelectedExamId(preferred.id);
        setSearchParams({ examId: preferred.id });
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramExamId]);

  // Live attempt roster from the DB (realtime) for selected exam
  useEffect(() => {
    if (!supabaseConfigured || !selectedExamId) return;
    let active = true;
    const load = async () => {
      const rows = await listLiveAttempts(selectedExamId);
      if (!active) return;
      setLive(true);
      const mapped = rows.map(attemptToStudent);
      setStudents(mapped);
      setSelected((cur) => (cur ? mapped.find((s) => s.roll === cur.roll) ?? mapped[0] ?? null : mapped[0] ?? null));
    };
    void load();
    const unsub = subscribeToAttempts(selectedExamId, () => void load());
    return () => { active = false; unsub(); };
  }, [selectedExamId]);

  // Subscribe to LiveKit room for real-time video feeds (camera + screen).
  // Transient failures (flaky mobile network, LiveKit hiccup, expired token)
  // auto-retry with backoff instead of leaving a dead console — the banner
  // shows the real reason when live feeds can't come up.
  useEffect(() => {
    if (!supabaseConfigured || !selectedExamId) {
      setFeeds([]);
      setViewerState("idle");
      return;
    }
    let active = true;
    let viewer: Awaited<ReturnType<typeof startProctorViewing>> | null = null;
    let timer: number | undefined;
    let attempt = 0;

    const connectOnce = async () => {
      if (!active) return;
      attempt += 1;
      setViewerState("connecting");
      setViewerError(null);
      let lastError = "LiveKit feeds unavailable — retrying…";
      try {
        viewer = await startProctorViewing({
          room: selectedExamId,
          onState: (state) => {
            if (!active) return;
            console.debug("[proctor-viewer] state:", state);
            setViewerState(state);
            if (state === "connected") setViewerError(null);
          },
          onFeeds: (next: RemoteFeed[]) => {
            if (!active) return;
            console.debug("[proctor-viewer] feeds:", next.length, next.map(f => ({ identity: f.identity, hasCamera: !!f.cameraTrack, hasScreen: !!f.screenTrack })));
            setFeeds(next);
          },
        });
        viewerRef.current = viewer;
      } catch (err: unknown) {
        viewer = null;
        lastError = err instanceof Error ? err.message : lastError;
        if (active) setViewerError(lastError);
      }
      if (!active) return;
      if (viewer) {
        attempt = 0;
        setViewerState("connected");
        setViewerError(null);
        return;
      }
      if (active) {
        setViewerState("error");
        setViewerError(lastError);
      }
      // Config / auth failures will not heal by hammering the token endpoint.
      const fatal = /missing|not configured|unauthorized|forbidden|secrets/i.test(lastError);
      if (fatal || attempt >= 6) return;
      timer = window.setTimeout(() => void connectOnce(), Math.min(3_000 * attempt, 12_000));
    };

    void connectOnce();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      viewer?.stop();
      viewerRef.current = null;
    };
  }, [selectedExamId]);

  // Room diagnostics: participants/tracks the LiveKit viewer actually sees.
  const viewerRef = useRef<Awaited<ReturnType<typeof startProctorViewing>> | null>(null);
  const [roomDiag, setRoomDiag] = useState({ participants: 0, remoteTracks: 0 });
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = viewerRef.current?.diagnostics?.();
      if (d) setRoomDiag(d);
    }, 5_000);
    return () => window.clearInterval(id);
  }, [selectedExamId]);

  const feedFor: FeedLookup = useMemo(() => {
    const byId = new Map<string, RemoteFeed>();
    const byRoll = new Map<string, RemoteFeed>();
    for (const f of feeds) {
      // Phone monitor and staff identities share the roll suffix — they must
      // not overwrite the desktop student: camera tile.
      if (f.identity.startsWith("mobile:") || f.identity.startsWith("proctor:")) continue;
      const key = identityLabel(f.identity).toLowerCase();
      byId.set(key, f);
      byRoll.set(key, f);
    }
    return (s: Student) =>
      (s.studentId ? byId.get(s.studentId.toLowerCase()) : null) ??
      (s.roll && s.roll !== "—" ? byRoll.get(s.roll.toLowerCase()) : null) ??
      null;
  }, [feeds]);

  const visible = useMemo(() => {
    const filtered = filter === "Flagged only" ? students.filter((s) => s.violation) : filter === "Submitted" ? students.filter((s) => s.status === "Submitted") : students;
    return [...filtered].sort((a, b) => Number(Boolean(b.violation)) - Number(Boolean(a.violation)));
  }, [filter, students]);
  const selectCandidate = (candidate: Student) => { setSelected(candidate); setView("wall"); setScreenMode(true); };
  const feedCount = feeds.filter((f) => f.cameraTrack).length;
  const enrolledCount = students.length;
  const writingCount = students.filter((s) => s.status === "Writing" || s.status === "Paused").length;
  const flaggedCount = students.filter((s) => s.violation).length;
  const submittedAttemptsCount = students.filter((s) => s.status === "Submitted").length;
  const nav = getTeacherNav(writingCount, submittedAttemptsCount, flaggedCount, examList.length);
  const examIsEmpty = !!selectedExam && selectedExam.status === "draft" && enrolledCount === 0;

  const [zipping, setZipping] = useState(false);
  const [pdfJob, setPdfJob] = useState<string | null>(null);
  const [zipMsg, setZipMsg] = useState<string | null>(null);
  const exportZip = async () => {
    if (zipping) return;
    const rows = students
      .map((s) => ({ roll: s.roll, name: s.name }))
      .filter((s) => s.roll && s.roll !== "—");
    if (rows.length === 0) {
      setZipMsg("No candidates with roll numbers yet.");
      return;
    }
    setZipping(true);
    setZipMsg(null);
    try {
      const res = await downloadExamEvidenceZip({
        examId: selectedExamId,
        examName: examList.find((e) => e.id === selectedExamId)?.name || null,
        students: rows,
      });
      if (res.fileCount === 0) {
        setZipMsg("No recordings or screenshots found in storage for this exam.");
      } else if (res.errors.length > 0) {
        setZipMsg(`ZIP downloaded · ${res.fileCount} file(s) for ${res.studentCount} student(s) · ${res.errors.length} item(s) failed`);
      } else {
        setZipMsg(`ZIP downloaded · ${res.fileCount} file(s) for ${res.studentCount} student(s)`);
      }
    } catch (err) {
      console.error("[TeacherProctoring] evidence ZIP export failed:", err);
      setZipMsg("ZIP export failed — storage may be unavailable.");
    } finally {
      setZipping(false);
    }
  };

  const exportReport = () => {
    if (pdfJob) return;
    const examName = examList.find((e) => e.id === selectedExamId)?.name || selectedExamId;
    setPdfJob("Preparing session report…");
    void downloadSessionReportPdf(
      examName,
      selectedExamId,
      students.map((s) => ({
        name: s.name,
        roll: s.roll,
        state: s.status,
        progress: s.progress,
        startedAt: s.startedAt,
        violations: s.violations.map((v) => ({
          description: v.description || v.violation_type,
          type: v.violation_type,
          severity: v.severity,
          offset_seconds: v.offset_seconds,
          created_at: v.created_at,
        })),
      })),
      new Date(),
      { onProgress: setPdfJob },
    ).then(() => flash("PDF downloaded", "ok")).catch(() => flash("PDF export failed", "err")).finally(() => setPdfJob(null));
  };

  // Live voice: publish this proctor's mic into the candidate's own channel.
  // StudentExam listens on voice-<examId>-<roll>, so the warning is heard by
  // exactly that candidate. Falls back to a text warning when LiveKit is off.
  const toggleSpeak = async (candidate: Student | null) => {
    if (!candidate?.roll) return;
    if (speakingTo === candidate.roll) { stopSpeaking(); return; }
    stopSpeaking();
    setVoiceBusy(true);
    const handle = await startVoiceBroadcast(
      voiceRoom(selectedExamId, candidate.roll),
      (msg) => flash(msg, "err"),
    );
    setVoiceBusy(false);
    if (!handle) {
      void runAction("warning");
      return;
    }
    voiceRef.current = handle;
    await handle.setSpeaking(true);
    setSpeakingTo(candidate.roll);
    flash(`Microphone live — ${candidate.name} can hear you now. Click again to stop.`, "ok");
  };

  // Shared handler for the four proctor actions. Writes a violation_events row
  // (and toggles the attempt state for pause), then refreshes from the DB — the
  // realtime subscription also re-runs when the row lands.
  const runAction = async (kind: "warning" | "pause" | "resume" | "escalation" | "force_submit") => {
    if (!selected) return;
    const { studentId, realAttemptId, roll, name } = selected;
    if (!studentId) {
      flash(`Cannot act on ${name}: no student record linked.`, "err");
      return;
    }
    const examId = selectedExamId;
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const push = async (type: string, desc: string, severity?: "warning" | "high" | "critical") =>
      saveViolation(realAttemptId, examId, studentId, type, desc, { severity, source: "proctor" });

    try {
      if (kind === "warning") {
        const ok = await push("proctor_warning", `Warning sent to ${name} (${roll}) by proctor at ${now}`);
        if (!ok) flash("Warning could not be saved to the database.", "err");
        else flash(`Warning sent to ${name}.`, "ok");
      } else if (kind === "pause" || kind === "resume") {
        const paused = kind === "pause";
        let dbOk = true;
        if (realAttemptId) dbOk = await setAttemptPaused(realAttemptId, paused);
        const ok = paused
          ? await push("proctor_pause", `${name} (${roll}) paused by proctor at ${now}`)
          : await push("proctor_resume", `${name} (${roll}) resumed by proctor at ${now}`);
        if (!dbOk && realAttemptId) flash("Could not update the candidate's attempt state in the database.", "err");
        else if (!ok) flash(paused ? "Pause logged locally only (DB offline)." : "Resume logged locally only (DB offline).", "warn");
        else flash(paused ? `${name} paused.` : `${name} resumed.`, "ok");
      } else if (kind === "escalation") {
        const ok = await push("proctor_escalation", `Incident escalated for ${name} (${roll}) by proctor at ${now}`, "critical");
        if (!ok) flash("Escalation could not be saved to the database.", "err");
        else flash(`Incident escalated for ${name}.`, "ok");
      } else {
        // force_submit
        let dbOk = true;
        if (realAttemptId) dbOk = await forceSubmitAttempt(realAttemptId);
        const ok = await push("proctor_force_submit", `Exam forcefully submitted for ${name} (${roll}) by proctor at ${now}`, "high");
        if (!dbOk && realAttemptId) flash("Force submit could not update the attempt.", "err");
        else if (!ok) flash("Force submit logged locally only (DB offline).", "warn");
        else flash(`${name}'s exam was force submitted.`, "ok");
      }
    } catch (err) {
      console.error("[TeacherProctoring] action failed:", err);
      flash("Action failed — see console for details.", "err");
    }

    // Local optimistic update so the UI reflects the action immediately even
    // before the realtime refresh lands.
    setSelected((cur) => {
      if (!cur) return cur;
      const next = { ...cur };
      if (kind === "warning") next.violation = "Warning sent";
      if (kind === "pause") next.status = "Paused";
      if (kind === "resume") next.status = "Writing";
      if (kind === "escalation") next.violation = "Incident escalated";
      if (kind === "force_submit") { next.status = "Submitted"; next.progress = 100; next.violation = "Force submitted"; }
      return next;
    });
  };

  if (stage === "select") {
    return <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={getTeacherNav(0, 0, 0)}>
      <ProctoringAssessmentSelect onStart={beginMonitoring} />
    </RoleLayout>;
  }

  return <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={nav} status={live ? "Live monitoring active" : "Not connected"}>
    <JobBanner label={pdfJob ?? (zipping ? "Packing evidence ZIP…" : null)} />

    <header className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <button type="button" onClick={() => { setStage("select"); setSearchParams({}); }} className="inline-flex items-center gap-2 text-[13px] text-forest underline-offset-2 hover:underline">
          <FiGrid aria-hidden /> All assessments
        </button>
        <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight">Live proctoring</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-[12px] text-ink-soft">
            Exam
            <select
              value={selectedExamId}
              onChange={(e) => {
                setSelectedExamId(e.target.value);
                setSearchParams({ examId: e.target.value });
              }}
              aria-label="Select exam to monitor"
              className="ml-2 min-w-[220px] border border-line-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-forest"
            >
              {examList.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.name} · {ex.status} · {ex.candidates} enrolled
                </option>
              ))}
            </select>
          </label>
          <span className="text-[13px] text-ink-soft">{selectedExam?.batch || selectedExamId}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setShowAssignModal(true);
            setLoadingFaculty(true);
            setAssignments({});
            void listFaculty().then((rows) => { setFaculty(rows); setLoadingFaculty(false); });
            void listProctorAssignments(selectedExamId).then((rows) => {
              setAssignments((cur) => {
                const next = { ...cur };
                for (const r of rows) next[r.assignee_name] = { role: r.assignee_role, id: r.assignee_id, email: r.email };
                return next;
              });
            });
          }}
          className="border border-line-strong px-4 py-2.5 text-[13px] hover:border-forest hover:text-forest"
        >
          Assign proctors
        </button>
        <button type="button" onClick={() => void exportZip()} disabled={zipping} className="border border-forest px-4 py-2.5 text-[13px] text-forest hover:bg-forest/5 disabled:opacity-60">{zipping ? "Zipping…" : "Evidence ZIP"}</button>
        <button type="button" onClick={exportReport} className="border border-line-strong px-4 py-2.5 text-[13px] hover:border-forest hover:text-forest">Export report</button>
        <span className={`inline-flex items-center gap-2 border px-3 py-2.5 text-[12px] ${writingCount > 0 ? "border-alert/30 bg-alert/5 text-alert" : "border-line text-ink-soft"}`}>
          <span className={`h-1.5 w-1.5 ${writingCount > 0 ? "animate-pulse bg-alert" : "bg-line-strong"}`} />
          {writingCount > 0 ? "Session live" : "No one writing"}
        </span>
      </div>
    </header>

    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-2xl border border-line bg-paper p-4"><p className="text-[12px] text-ink-soft">On roster</p><p className="mt-1 font-serif text-3xl font-semibold tabular-nums">{enrolledCount}</p><p className="mt-1 text-[12px] text-ink-soft">Enrolled for this exam</p></article>
      <article className="rounded-2xl border border-line bg-paper p-4"><p className="text-[12px] text-ink-soft">Writing now</p><p className="mt-1 font-serif text-3xl font-semibold tabular-nums text-forest">{writingCount}</p><p className="mt-1 text-[12px] text-ink-soft">In progress or paused</p></article>
      <article className="rounded-2xl border border-line bg-paper p-4"><p className="text-[12px] text-ink-soft">Flags</p><p className={`mt-1 font-serif text-3xl font-semibold tabular-nums ${flaggedCount ? "text-alert" : ""}`}>{flaggedCount}</p><p className="mt-1 text-[12px] text-ink-soft">Candidates with violations</p></article>
      <article className="rounded-2xl border border-line bg-paper p-4"><p className="text-[12px] text-ink-soft">Camera feeds</p><p className={`mt-1 font-serif text-3xl font-semibold tabular-nums ${viewerState === "error" ? "text-alert" : ""}`}>{feedCount}</p><p className="mt-1 text-[12px] text-ink-soft">{viewerState === "connected" ? "LiveKit connected" : viewerState}</p></article>
    </div>

    <div className="mt-4">
      <AllocationPanel students={students} proctors={proctors} me={profile?.full_name ?? ""} />
    </div>

    {examIsEmpty && (
      <div className="mt-4 rounded-2xl border border-amber/40 bg-amber/5 px-4 py-3 text-[13px] text-amber">
        This exam is still a draft with nobody enrolled. Switch to a published paper with a roster, or enroll students first.
      </div>
    )}
    {viewerState === "error" && viewerError && !examIsEmpty && (
      <div className="mt-4 rounded-2xl border border-alert/40 bg-alert/5 px-4 py-3 text-[13px] text-alert" role="alert">
        {viewerError}
      </div>
    )}
    {viewerState === "connected" && writingCount === 0 && !examIsEmpty && (
      <div className="mt-4 rounded-2xl border border-line bg-paper px-4 py-3 text-[13px] text-ink-soft">
        Room is connected. Feeds appear when a candidate starts the exam and publishes their camera.
      </div>
    )}
    {zipMsg && <p className="mt-3 text-[12px] text-ink-soft">{zipMsg}</p>}

    <div className="mt-5 flex flex-col justify-between gap-3 border-b border-line pb-3 sm:flex-row sm:items-center">
      <div className="flex flex-wrap gap-1">
        {(["wall", "activity", "chat"] as const).map((tab) => (
          <button key={tab} type="button" onClick={() => setView(tab)} className={`rounded-full px-4 py-2 text-[13px] ${view === tab ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>
            {tab === "wall" ? "Video wall" : tab === "activity" ? "Activity" : `Proctor chat${chatCount ? ` (${chatCount})` : ""}`}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-[12px] ${live ? "text-success" : "text-ink-soft"}`}>{live ? `${feedCount} feed(s) · roster live` : "Roster offline"}</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-2 text-[13px]" aria-label="Filter candidates">
          <option>All candidates</option>
          <option>Flagged only</option>
          <option>Submitted</option>
        </select>
      </div>
    </div>

    <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 rounded-2xl border border-line bg-paper p-3 sm:p-4">
        {view === "wall" ? (
          <VideoWall visible={visible} selected={selected} onSelect={selectCandidate} feedFor={feedFor} mobileFeedFor={mobileFeedByRoll} source={wallSource} onSourceChange={(s) => { setWallSource(s); sessionStorage.setItem("proctor-wall-source", s); }}/>
        ) : view === "activity" ? (
          <ActivityView visible={visible} selected={selected} onSelect={selectCandidate}/>
        ) : (
          <ProctorChatPanel examId={selectedExamId} senderName={profile?.full_name ?? "Teacher"} senderRole="teacher" onCountChange={setChatCount} maxHeight={420} />
        )}
      </div>

      <aside className="h-fit rounded-2xl border border-line bg-paper p-5 xl:sticky xl:top-4">
        <p className="text-[12px] text-ink-soft">Selected candidate</p>
        {!selected ? (
          <p className="mt-3 text-[14px] text-ink-soft">Pick a candidate from the wall or activity list.</p>
        ) : (
          <>
            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-serif text-xl font-semibold">{selected.name}</h2>
                <p className="mt-1 text-[12px] text-ink-soft">{selected.roll} · {selected.status} · {selected.progress}%</p>
              </div>
              <span className={`shrink-0 text-[12px] font-semibold ${selected.violation ? "text-alert" : "text-success"}`}>{selected.violation ? "Flagged" : "Clear"}</span>
            </div>
            <div className="mt-4 flex gap-1 rounded-full bg-paper-raised p-1 text-[12px]">
              <button type="button" onClick={() => { setScreenMode(false); setPhoneMode(false); }} className={`flex-1 rounded-full px-2 py-1.5 ${!screenMode && !phoneMode ? "bg-paper text-forest" : "text-ink-soft"}`}>Camera</button>
              <button type="button" onClick={() => { setScreenMode(true); setPhoneMode(false); }} className={`flex-1 rounded-full px-2 py-1.5 ${screenMode && !phoneMode ? "bg-paper text-forest" : "text-ink-soft"}`}>Screen</button>
              <button type="button" onClick={() => { setPhoneMode(true); setScreenMode(false); }} className={`flex-1 rounded-full px-2 py-1.5 ${phoneMode ? "bg-paper text-forest" : "text-ink-soft"}`}>Phone</button>
            </div>
            {phoneMode ? (
              <div className="relative mt-3 flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-[#D9D5CB]">
                <FeedView feed={mobileFeedByRoll.get(selected.roll.toLowerCase()) ?? null} initials={selected.name.split(" ").map((x) => x[0]).slice(0, 2).join("")} />
              </div>
            ) : screenMode ? (
              <ScreenRecording selected={selected} feed={feedFor(selected)}/>
            ) : (
              <div className="relative mt-3 flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-[#D9D5CB]">
                <FeedView feed={feedFor(selected)} initials={selected.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}/>
              </div>
            )}
            <AudioPlayer track={feedFor(selected)?.audioTrack} />
            <div className="mt-4">
              <p className="text-[12px] text-ink-soft">Violations{selected.violations.length ? ` · ${selected.violations.length}` : ""}</p>
              {selected.violations.length === 0 ? (
                <p className="mt-2 text-[13px] text-ink-soft">No flags yet.</p>
              ) : (
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                  {[...selected.violations]
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .slice(0, 8)
                    .map((v) => (
                      <div key={v.id} className="rounded-lg border border-alert/20 bg-alert/[0.04] px-3 py-2">
                        <p className="text-[13px]">{v.description || v.violation_type}</p>
                        <p className="mt-0.5 text-[11px] text-ink-soft">
                          {new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          {v.offset_seconds != null ? ` · @ ${formatClock(v.offset_seconds)}` : ""}
                        </p>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div className="mt-4 grid gap-2">
              <button type="button" disabled={selected.status === "Submitted"} onClick={() => void runAction("warning")} className="rounded-xl border border-line-strong py-2.5 text-[13px] disabled:opacity-50 hover:border-forest">Send warning</button>
              <button
                type="button"
                disabled={voiceBusy || selected.status === "Submitted"}
                onClick={() => void toggleSpeak(selected)}
                className={`inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] disabled:opacity-50 ${
                  speakingTo === selected.roll ? "border border-alert bg-alert text-paper" : "border border-forest bg-forest/5 text-forest hover:bg-forest hover:text-paper"
                }`}
              >
                {speakingTo === selected.roll ? <><FiMicOff aria-hidden /> Stop speaking</> : voiceBusy ? "Connecting mic…" : <><FiMic aria-hidden /> Speak to candidate</>}
              </button>
              <button type="button" disabled={selected.status !== "Writing" && selected.status !== "Paused"} onClick={() => void runAction(selected.status === "Paused" ? "resume" : "pause")} className="rounded-xl border border-amber py-2.5 text-[13px] text-amber disabled:opacity-50">
                {selected.status === "Paused" ? "Resume candidate" : "Pause candidate"}
              </button>
              <button type="button" disabled={selected.status === "Submitted"} onClick={() => void runAction("escalation")} className="rounded-xl border border-alert py-2.5 text-[13px] text-alert disabled:opacity-50">Escalate incident</button>
              <button
                type="button"
                disabled={!selected.realAttemptId || selected.status === "Submitted"}
                onClick={() => {
                  if (!confirm(`Force submit the exam for ${selected.name}?`)) return;
                  void runAction("force_submit");
                }}
                className="rounded-xl border border-forest bg-forest/5 py-2.5 text-[13px] text-forest disabled:opacity-50 hover:bg-forest hover:text-paper"
              >
                Force submit
              </button>
              {actionMsg && (
                <p className={`rounded-xl border px-3 py-2 text-[12px] ${
                  actionMsg.tone === "err" ? "border-alert/40 bg-alert/5 text-alert" :
                  actionMsg.tone === "warn" ? "border-amber/40 bg-amber/5 text-amber" :
                  "border-success/40 bg-success/5 text-success"
                }`}>{actionMsg.text}</p>
              )}
            </div>
          </>
        )}
      </aside>
    </div>

    {showAssignModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper/80 backdrop-blur-sm">
        <div className="w-full max-w-md border border-line-strong bg-paper p-6 shadow-2xl animate-fade-in">
          <h2 className="font-serif text-xl font-semibold">Assign Proctors</h2>
          <p className="mt-2 text-[13px] text-ink-soft">Pick faculty from the platform to monitor this exam — they get console access and (optionally) an email invite.</p>
          <div className="mt-6 flex flex-col gap-2 max-h-[46vh] overflow-y-auto pr-1">
            {loadingFaculty ? (
              <p className="py-4 text-center text-[12px] text-ink-soft">Loading faculty…</p>
            ) : faculty.length === 0 ? (
              <p className="py-4 text-center text-[12px] text-ink-soft">No faculty found — add teachers from the Students tab (Global Directory) or the database first.</p>
            ) : faculty.map((p) => {
              const key = p.name;
              const checked = Boolean(assignments[key]);
              return (
                <label key={key} className={`flex items-start gap-3 border p-3 cursor-pointer transition-colors ${checked ? "border-forest bg-forest/5" : "border-line hover:bg-forest/5"}`}>
                  <input
                    type="checkbox"
                    className="accent-forest w-4 h-4 mt-0.5"
                    checked={checked}
                    onChange={(e) =>
                      setAssignments((cur) => {
                        const next = { ...cur };
                        if (e.target.checked) next[key] = {
                          role: "proctor",
                          id: p.id,
                          email: p.email,
                        };
                        else delete next[key];
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{p.name}</span>
                    <span className="block font-mono text-[10px] text-ink-soft truncate mt-0.5">
                      {p.role === "proctor" ? "Proctor" : "Faculty"}{p.department ? ` · ${p.department}` : ""}{p.email ? ` · ${p.email}` : " · no email"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {Object.keys(assignments).length > 0 && (
            <p className="mt-3 font-mono text-[9px] uppercase tracking-wider text-success">
              ✓ {Object.keys(assignments).length} assigned to {examList.find((e) => e.id === selectedExamId)?.name || selectedExamId}
            </p>
          )}
          <label className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 text-[12px]">
            <span>
              <span className="block font-medium">Email the assigned proctors</span>
              <span className="block text-[11px] text-ink-soft">Sends each one a duty email with the proctor console link.</span>
            </span>
            <input
              type="checkbox"
              className="accent-forest w-4 h-4"
              checked={emailProctors}
              onChange={(e) => setEmailProctors(e.target.checked)}
            />
          </label>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => { setShowAssignModal(false); setAssignments({}); }}
              className="px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
            <button
              disabled={savingAssignments}
              onClick={async () => {
                setSavingAssignments(true);
                const entries = Object.entries(assignments).map(([name, meta]) => ({ name, role: meta.role, id: meta.id, email: meta.email }));
                const ok = await saveProctorAssignments(selectedExamId, entries);
                setSavingAssignments(false);
                if (!ok) {
                  flash("Could not save assignments — check the database connection.", "err");
                  return;
                }
                if (emailProctors && entries.length > 0) {
                  const res = await sendProctorAssignmentEmail(selectedExamId, entries);
                  if (res.ok) {
                    const d = (res.data ?? {}) as { sent?: number; failed?: number; skipped?: number };
                    flash(`Assignments saved — proctor email${(d.sent ?? 0) === 1 ? "" : "s"} sent to ${d.sent ?? 0}${d.skipped ? ` (${d.skipped} no email)` : ""}.`, "ok");
                  } else {
                    flash("Assignments saved, but the proctor email failed to send.", "warn");
                  }
                } else {
                  flash("Proctor assignments saved.", "ok");
                }
                setShowAssignModal(false);
                setAssignments({});
              }}
              className="bg-forest px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90 disabled:opacity-50"
            >
              {savingAssignments ? "Saving…" : "Save Assignments"}
            </button>
          </div>
        </div>
      </div>
    )}
  </RoleLayout>;
}

function VideoWall({ visible, selected, onSelect, feedFor, mobileFeedFor, source, onSourceChange }: {
  visible: Student[];
  selected: Student | null;
  onSelect: (student: Student) => void;
  feedFor: FeedLookup;
  mobileFeedFor: Map<string, RemoteFeed>;
  source: "camera" | "screen" | "phone";
  onSourceChange: (s: "camera" | "screen" | "phone") => void;
}) {
  const showScreen = source === "screen";
  const showPhone = source === "phone";
  const initials = (name: string) => name.split(" ").map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <section className="mt-6 border border-line bg-paper p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">All student video feeds</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">
            {showScreen ? "Live screen wall" : "Live camera wall"}
          </h2>
        </div>

        {/* Camera / Screen / Phone toggle */}
        <div className="flex items-center gap-2 border border-line-strong bg-paper-raised p-1">
          <button
            onClick={() => onSourceChange("camera")}
            className={`flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              source === "camera" ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"
            }`}
          >
            <FiVideo aria-hidden /> Camera
          </button>
          <button
            onClick={() => onSourceChange("screen")}
            className={`flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              showScreen ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"
            }`}
          >
            <FiMonitor aria-hidden /> Screen
          </button>
          <button
            onClick={() => onSourceChange("phone")}
            className={`flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              showPhone ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"
            }`}
          >
            <FiSmartphone aria-hidden /> Phone
          </button>
        </div>
      </div>

      <p className="mt-2 font-mono text-[9px] text-ink-soft">
        {showScreen
          ? "Showing each candidate's shared screen — this is also the exam view being recorded."
          : showPhone
          ? "Showing the desk monitor feed (phone rear camera) for candidates who enabled it via QR."
          : "Showing each candidate's webcam feed. Flagged feeds appear first."}
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {visible.map((student, index) => {
          const feed = feedFor(student);
          const hasFeed = showScreen ? !!feed?.screenTrack : !!feed?.cameraTrack;
          const isSelected = selected?.roll === student.roll;
          const isViolated = !!student.violation;

          return (
            <button
              key={student.roll}
              onClick={() => onSelect(student)}
              className={`overflow-hidden border text-left transition-colors ${
                isViolated
                  ? "border-alert ring-1 ring-alert"
                  : isSelected
                  ? "border-forest ring-1 ring-forest"
                  : "border-line hover:border-line-strong"
              }`}
            >
              <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-[#252923]">
                <span className="absolute left-2 top-2 z-10 bg-ink/75 px-1.5 py-0.5 font-mono text-[7px] uppercase text-paper">
                  {showPhone ? <><FiSmartphone aria-hidden /> Phone</> : showScreen ? <><FiMonitor aria-hidden /> Screen</> : <><FiVideo aria-hidden /> Camera</>}
                </span>

                {showPhone ? (
                  <FeedView feed={mobileFeedFor.get(student.roll.toLowerCase()) ?? null} initials={initials(student.name)} />
                ) : showScreen ? (
                  <ScreenFeedView feed={feed} />
                ) : (
                  <FeedView feed={feed} initials={initials(student.name)} />
                )}

                <span className={`absolute right-2 top-2 h-2 w-2 rounded-none ${hasFeed ? "bg-success" : "bg-ink-soft"}`} />

                {index === 0 && isViolated && (
                  <span className="absolute left-2 top-5 z-10 bg-alert px-1.5 py-0.5 font-mono text-[7px] uppercase text-paper">REVIEW FIRST</span>
                )}

                <span className="absolute bottom-0 left-0 right-0 z-10 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">
                  {student.status} · {student.progress}%
                </span>
              </div>

              <div className="p-2">
                <p className="truncate text-[11px] font-medium">{student.name}</p>
                <p className={`truncate font-mono text-[9px] ${isViolated ? "text-alert" : "text-ink-soft"}`}>
                  {isViolated
                    ? student.violation
                    : showPhone
                    ? (mobileFeedFor.has(student.roll.toLowerCase()) ? "Desk feed active" : "No phone feed")
                    : hasFeed
                    ? (showScreen ? "Screen active" : "Camera active")
                    : "No feed"}
                </p>
              </div>
            </button>
          );
        })}

        {visible.length === 0 && (
          <div className="col-span-full border border-dashed border-line-strong p-10 text-center font-mono text-[11px] text-ink-soft">
            Waiting for candidates to begin…
          </div>
        )}
      </div>
    </section>
  );
}
function AudioPlayer({ track }: { track: any }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(0.7);
  const [audioReady, setAudioReady] = useState(false);
  const [needsUserGesture, setNeedsUserGesture] = useState(true);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;

    // Attach the track so the audio element receives the media stream
    track.attach(el);
    el.volume = volume;
    el.muted = isMuted;
    setAudioReady(true);

    // Try to play (may fail due to autoplay policy)
    const tryPlay = async () => {
      try {
        await el.play();
        setNeedsUserGesture(false);
      } catch (err) {
        // Autoplay blocked - user needs to click to enable
        setNeedsUserGesture(true);
        setIsMuted(true);
      }
    };
    void tryPlay();

    return () => {
      try { track.detach(el); } catch { /* ignore */ }
    };
  }, [track]);

  // Update volume when slider changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Update muted state
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = isMuted;
  }, [isMuted]);

  const handleEnableAudio = async () => {
    if (!audioRef.current) return;
    setIsMuted(false);
    audioRef.current.muted = false;
    try {
      await audioRef.current.play();
      setNeedsUserGesture(false);
    } catch (err) {
      console.warn("Audio play failed:", err);
    }
  };

  const handleToggleMute = () => {
    setIsMuted(!isMuted);
  };

  if (!track) return null;

  return (
    <div className="mt-3 border border-line bg-paper-raised p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-none ${audioReady && !isMuted ? "bg-success animate-pulse" : "bg-ink-soft"}`} />
          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">
            {isMuted ? "Muted (teacher-side only)" : "Live Audio"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {needsUserGesture && (
            <button
              onClick={handleEnableAudio}
              className="border border-forest bg-forest/10 px-2 py-1 font-mono text-[9px] uppercase text-forest hover:bg-forest/20"
            >
              <FiVolume2 aria-hidden /> Enable Audio
            </button>
          )}
          <button
            onClick={handleToggleMute}
            disabled={needsUserGesture}
            className={`px-2 py-1 font-mono text-[9px] uppercase ${isMuted ? "text-alert hover:bg-alert/10" : "text-success hover:bg-success/10"} ${needsUserGesture ? "opacity-50" : ""}`}
            title={isMuted ? "Unmute (teacher only)" : "Mute (teacher only)"}
          >
            {isMuted ? <><FiVolumeX aria-hidden /> Muted</> : <><FiVolume2 aria-hidden /> Unmuted</>}
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[9px] text-ink-soft">VOL</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="flex-1 accent-forest"
          disabled={needsUserGesture}
        />
        <span className="font-mono text-[9px] text-ink-soft w-8">{Math.round(volume * 100)}%</span>
      </div>
      <p className="mt-1.5 font-mono text-[8px] text-ink-soft/70">
        Mute only silences audio in this proctor view. Student's mic stays active.
      </p>
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
    </div>
  );
}

function ActivityView({ visible, selected, onSelect }: { visible: Student[]; selected: Student | null; onSelect: (student: Student) => void }) { return <section className="mt-6 border border-line"><div className="border-b border-line bg-paper-raised px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Activity stream</p><h2 className="mt-1 font-serif text-xl font-semibold">Student activity by priority</h2></div><div className="divide-y divide-line">{visible.map((student) => <button key={student.roll} onClick={() => onSelect(student)} className={`flex w-full flex-col gap-3 px-5 py-4 text-left sm:flex-row sm:items-center sm:justify-between ${selected?.roll === student.roll ? "bg-success/5" : "hover:bg-paper-raised"}`}><div><p className="text-[13px] font-medium">{student.name} <span className="ml-2 font-mono text-[10px] text-ink-soft">{student.roll}</span></p><p className="mt-1 text-[11px] text-ink-soft">Last event: {student.violation || "Status updated recently"}</p></div><span className={`font-mono text-[10px] uppercase ${student.violation ? "text-alert" : "text-success"}`}>{student.violation ? <span className="inline-flex items-center gap-1">Review violation <FiChevronRight /></span> : "Monitoring clear"}</span></button>)}{visible.length === 0 && <div className="p-10 text-center font-mono text-[11px] text-ink-soft">No active candidates.</div>}</div></section>; }
function ScreenRecording({ selected, feed }: { selected: Student; feed: RemoteFeed | null }) { const liveScreen = !!feed?.screenTrack; return <div className="mt-4"><div className="relative flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#252923]">{liveScreen ? <ScreenFeedView feed={feed}/> : <><div className="absolute inset-3 bg-ink/90 flex items-center justify-center text-paper font-mono text-[10px] uppercase">Screen feed unavailable</div></>}<span className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1.5 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">{liveScreen ? <><span className="h-1 w-1 rounded-none bg-alert" /> Live screen share</> : <><span className="h-1 w-1 rounded-none border border-paper/60" /> Screen preview</>}</span></div><p className="mt-3 text-[11px] text-ink-soft">{selected.name} · {liveScreen ? "Live screen share" : "Screen recording · awaiting feed"}</p></div>; }
function FeedView({ feed, initials }: { feed: RemoteFeed | null; initials: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !feed?.cameraTrack) return;
    feed.cameraTrack.attach(video);
    void video.play().catch(() => {});
    return () => { feed?.cameraTrack?.detach?.(video); };
  }, [feed?.cameraTrack]);
  return (
    <div className="absolute inset-0 z-0 flex items-center justify-center">
      {feed?.cameraTrack ? (
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      ) : (
        <span className="font-serif text-3xl text-ink/20">{initials}</span>
      )}
    </div>
  );
}

// Screen tab: shows the candidate's real shared screen when the LiveKit feed
// carries one, otherwise a representative placeholder so the panel isn't empty.
function ScreenFeedView({ feed }: { feed: RemoteFeed | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !feed?.screenTrack) return;
    feed.screenTrack.attach(video);
    void video.play().catch(() => {});
    return () => { feed?.screenTrack?.detach?.(video); };
  }, [feed?.screenTrack]);
  return (
    <div className="absolute inset-0 z-0 flex items-center justify-center">
      {feed?.screenTrack && <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />}
    </div>
  );
}
function Stat({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) { return <div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p><p className={`mt-2 font-serif text-3xl ${alert ? "text-alert" : "text-ink"}`}>{value}</p><p className="mt-1 text-[12px] text-ink-soft">{sub}</p></div>; }

/**
 * Mettl-style allocation: the live roster is shared fairly between the
 * proctors assigned to this assessment (assignments come from the DB via the
 * Assign Proctors modal). With no assignment rows the current user is treated
 * as the single proctor.
 */
function AllocationPanel({ students, proctors, me }: { students: Student[]; proctors: ProctorAssignment[]; me: string }) {
  const total = students.length;
  const online = students.filter((s) => s.status === "Writing" || s.status === "Paused").length;
  const proctorNames = proctors.length > 0 ? proctors.map((p) => p.assignee_name) : me ? [me] : [];
  const effective = Math.max(1, proctorNames.length);
  const share = Math.ceil(total / effective);
  const myTurn = proctorNames.indexOf(me) >= 0;
  return (
    <section className="mt-6 border border-line bg-paper-raised p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center border border-line-strong bg-paper text-forest"><FiUsers aria-hidden /></span>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Allocation · fair share of the live roster</p>
            <p className="mt-0.5 text-[13px]">{total} candidate{total === 1 ? "" : "s"} across {effective} proctor{effective === 1 ? "" : "s"} · your share ≈ <strong className="font-serif text-[15px]">{share}</strong></p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-right">
          <div><p className="font-serif text-xl">{online}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Online now</p></div>
          <div><p className="font-serif text-xl">{total - online}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Idle / submitted</p></div>
          <div><p className={`font-serif text-xl ${myTurn ? "text-forest" : "text-amber"}`}>{myTurn ? "Active" : "Standby"}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Your role</p></div>
        </div>
      </div>
      {proctors.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {proctors.map((p) => (
            <span key={p.assignee_name} className={`px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${p.assignee_name === me ? "border border-forest bg-forest/10 text-forest" : "border border-line-strong bg-paper text-ink-soft"}`}>
              {p.assignee_name} · {p.assignee_role}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
