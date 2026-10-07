import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import { byNewest } from "@/shared/domain/exam/phase";
import { supabaseConfigured } from "@/shared/data/env";
import { listLiveAttempts, subscribeToAttempts, forceSubmitAttempt, saveViolation, setAttemptPaused, listExamsForTeacher, listProctoringStats, listProctorAssignments, saveProctorAssignments, listFaculty, sendProctorMessage, type LiveAttempt, type ViolationEvent, type FacultyMember } from "@/shared/data/examApi";
import { sendProctorAssignmentEmail } from "@/features/teacher/services/emailApi";
import ProctorChatPanel from "@/features/proctoring/components/ProctorChatPanel";
import { startProctorViewing, identityLabel, type RemoteFeed } from "@/features/proctoring/services/proctorViewer";
import { startVoiceBroadcast, voiceRoom } from "@/features/proctoring/services/proctorVoice";
import JobBanner from "@/shared/components/JobBanner";
import { usePromptDialog } from "@/shared/components/PromptDialog";
import { downloadSessionReportPdf } from "@/shared/services/sessionReport";
import { downloadExamEvidenceZip } from "@/shared/services/zipExport";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { getTeacherNav } from "@/features/teacher/navigation";
import { FiVideo, FiMonitor, FiSmartphone, FiGrid, FiArrowLeft, FiMic, FiMicOff, FiUsers, FiChevronRight, FiVolume2, FiVolumeX } from "react-icons/fi";
import ProctoringAssessmentSelect from "@/features/proctoring/components/ProctoringAssessmentSelect";
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
  /** Auth user id — LiveKit identity when the token function could not resolve a roll. */
  authId?: string | null;
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
    authId: a.student?.auth_id ?? null,
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
  const [examList, setExamList] = useState<{ id: string; name: string; batch?: string; status: string; candidates: number }[]>([]);
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

  const [promptDialog, ask] = usePromptDialog();
  const [announceStatus, setAnnounceStatus] = useState<string | null>(null);
  const announce = async () => {
    if (!selectedExamId) return;
    const body = await ask({
      title: "Announce to all candidates",
      detail: `Pinned on every candidate's exam screen in ${selectedExam?.name ?? "this exam"} until they acknowledge it.`,
      placeholder: "e.g. Question 4 has a typo — option B should read 25, not 52.",
      confirmLabel: "Announce",
      multiline: true,
    });
    if (!body) return;
    const ok = await sendProctorMessage({ examId: selectedExamId, sender: profile?.full_name || "Teacher", senderRole: "teacher", body, kind: "broadcast" });
    setAnnounceStatus(ok ? `Announced at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Announcement failed — try again");
  };

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

  // Load exams + roster counts for the switcher. Prefer published papers with
  // enrollments so an empty draft is not the silent default.
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
          created_at: e.created_at,
          candidates: stats[e.id]?.candidates ?? 0,
        }))
        .sort(byNewest);
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
      (s.authId ? byId.get(s.authId.toLowerCase()) : null) ??
      null;
  }, [feeds]);

  const visible = useMemo(() => {
    const filtered = filter === "Flagged only" ? students.filter((s) => s.violation) : filter === "Submitted" ? students.filter((s) => s.status === "Submitted") : students;
    return [...filtered].sort((a, b) => Number(Boolean(b.violation)) - Number(Boolean(a.violation)));
  }, [filter, students]);
  const selectCandidate = (candidate: Student) => { setSelected(candidate); setView("wall"); setScreenMode(true); };
  const feedCount = feeds.filter((f) => f.cameraTrack).length;
  const rosterCount = students.length;
  const writingCount = students.filter((s) => s.status === "Writing" || s.status === "Paused").length;
  const flaggedCount = students.filter((s) => s.violation).length;
  const submittedAttemptsCount = students.filter((s) => s.status === "Submitted").length;
  const nav = getTeacherNav(writingCount, submittedAttemptsCount, flaggedCount, examList.length);
  const examIsEmpty = !!selectedExam && selectedExam.status === "draft" && rosterCount === 0;

  const [zipping, setZipping] = useState(false);
  const [zipStep, setZipStep] = useState<string | null>(null);
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
        onProgress: setZipStep,
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
      setZipStep(null);
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
    {promptDialog}
    <JobBanner label={pdfJob ?? (zipping ? zipStep ?? "Packing evidence ZIP…" : null)} />

    {/* Session header card */}
    <section className="border border-line bg-paper">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <button onClick={() => { setStage("select"); setSearchParams({}); }} className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:text-forest">
          <FiGrid aria-hidden /> All assessments
        </button>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Proctoring centre · {selectedExam?.name || selectedExamId}
        </span>
      </div>
      <div className="flex flex-col gap-5 px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Proctoring</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-3xl font-semibold">Live proctoring</h1>
            {examList.length > 0 && (
              <select
                value={selectedExamId}
                onChange={(e) => {
                  setSelectedExamId(e.target.value);
                  setSearchParams({ examId: e.target.value });
                }}
                aria-label="Select exam to monitor"
                className="max-w-full border border-line-strong bg-paper-raised px-3 py-1.5 font-serif text-base font-semibold text-maroon hover:border-maroon focus:border-maroon focus:outline-none cursor-pointer"
              >
                {examList.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name} ({ex.batch || ex.id}) · {ex.status} · {ex.candidates} enrolled
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="mt-2 text-[13px] text-ink-soft">
            <strong className="text-ink">{selectedExam?.name || selectedExamId}</strong>
            {" · "}{rosterCount} on roster · {writingCount} writing
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {announceStatus && <span className="font-mono text-[10px] text-soft" role="status">{announceStatus}</span>}
          <button
            onClick={() => void announce()}
            className="border border-forest bg-forest px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-paper transition hover:bg-forest-soft"
          >
            Announce to all candidates
          </button>
          <button
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
            className="border border-line-strong bg-paper-raised px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest"
          >
            Assign Proctors
          </button>
          <button onClick={() => void exportZip()} disabled={zipping} className="border border-forest bg-forest/5 px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest hover:text-paper disabled:cursor-not-allowed disabled:opacity-60">
            {zipping ? "Zipping…" : "Download Evidence ZIP"}
          </button>
          <button onClick={exportReport} className="border border-line-strong bg-paper-raised px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
            Export Report
          </button>
          <span className={`inline-flex items-center gap-2 border px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider ${writingCount > 0 ? "border-alert/30 bg-alert/5 text-alert" : "border-line bg-paper-raised text-ink-soft"}`}>
            <span className={`h-1.5 w-1.5 rounded-none ${writingCount > 0 ? "animate-pulse bg-alert" : "bg-line-strong"}`} />
            {writingCount > 0 ? "Session live" : "No one writing"}
          </span>
          {zipMsg && <span className="font-mono text-[10px] text-ink-soft">{zipMsg}</span>}
        </div>
      </div>
    </section>

    {/* Stats cards */}
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="Candidates" value={rosterCount.toString()} sub="on roster" />
      <Stat label="Writing" value={writingCount.toString()} sub="in progress" />
      <Stat label="Flags" value={flaggedCount.toString()} sub="violations" alert={flaggedCount > 0} />
      <Stat label="Live Feeds" value={feedCount.toString()} sub={viewerState === "connected" ? "Live" : viewerState} alert={viewerState === "error" || viewerState === "disconnected"} />
    </div>

    <AllocationPanel students={students} proctors={proctors} me={profile?.full_name ?? ""} />

    {examIsEmpty && (
      <div className="mt-4 border border-amber/40 bg-amber/5 px-4 py-3 font-mono text-[11px] text-amber">
        This exam is a draft with nobody enrolled. Switch to a published paper with a roster, or enroll students first.
      </div>
    )}
    {viewerState === "error" && viewerError && !examIsEmpty && (
      <div className="mt-4 border border-alert/40 bg-alert/5 px-4 py-3 font-mono text-[11px] text-alert">
        <strong>LiveKit Error:</strong> {viewerError}
      </div>
    )}
    {viewerState === "connected" && writingCount === 0 && !examIsEmpty && (
      <div className="mt-4 border border-line bg-paper px-4 py-3 font-mono text-[11px] text-ink-soft">
        LiveKit is connected. Camera feeds appear when a candidate starts and publishes video.
      </div>
    )}

    {/* Workspace: wall + selected candidate + activity */}
    <section className="mt-4 border border-line bg-paper">
      <div className="flex flex-col justify-between gap-3 border-b border-line px-5 py-3 sm:flex-row sm:items-center">
        <div className="flex gap-1">
          {([
            ["wall", "Video wall"],
            ["activity", "Activity"],
            ["chat", `Proctor Chat${chatCount > 0 ? ` (${chatCount})` : ""}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === key ? "border-forest text-forest" : "border-transparent text-ink-soft hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] ${live ? "text-success" : "text-ink-soft"}`}>
            <span className={`h-1.5 w-1.5 rounded-none ${live ? "bg-success" : "bg-line-strong"}`} />
            {live ? `${feedCount} feed(s) · DB live` : "Not connected"}
          </span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="border border-line-strong bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
            <option>All candidates</option>
            <option>Flagged only</option>
            <option>Submitted</option>
          </select>
        </div>
      </div>

      <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 border-b border-line xl:border-b-0 xl:border-r">
          {view === "wall" ? (
            <VideoWall visible={visible} selected={selected} onSelect={selectCandidate} feedFor={feedFor} mobileFeedFor={mobileFeedByRoll} source={wallSource} onSourceChange={(s) => { setWallSource(s); sessionStorage.setItem("proctor-wall-source", s); }} />
          ) : view === "activity" ? (
            <ActivityView visible={visible} selected={selected} onSelect={selectCandidate} />
          ) : (
            <div className="p-5">
              <ProctorChatPanel examId={selectedExamId} senderName={profile?.full_name ?? "Teacher"} senderRole="teacher" onCountChange={setChatCount} maxHeight={420} />
            </div>
          )}

          {/* Activity + actions under the wall (same left column) */}
          <div className="border-t border-line p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Candidate activity</p>
            <p className="mt-1 text-[13px] text-ink-soft">{selected ? selected.name : "No candidate selected"}</p>
            <div className="mt-4 max-h-56 space-y-2 overflow-y-auto">
              {!selected ? (
                <p className="border border-dashed border-line-strong px-4 py-6 text-center text-[12px] text-ink-soft">Select a candidate to view activity.</p>
              ) : selected.violations.length === 0 ? (
                <p className="border border-line bg-paper-raised px-4 py-4 text-[12px] text-ink-soft">No proctoring activity recorded for this candidate yet.</p>
              ) : (
                [...selected.violations]
                  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                  .map((v) => (
                    <div key={v.id} className="flex gap-3 border border-line bg-paper-raised px-3 py-2.5">
                      <span className="shrink-0 font-mono text-[10px] text-ink-soft">
                        {new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <p className="text-[12px] leading-snug">{v.description || v.violation_type}</p>
                    </div>
                  ))
              )}
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <button
                disabled={!selected || selected.status === "Submitted"}
                onClick={() => void runAction("warning")}
                className="border border-line-strong bg-paper-raised py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink disabled:opacity-50 hover:border-forest hover:text-forest"
              >
                Send warning
              </button>
              <button
                disabled={!selected || voiceBusy || selected.status === "Submitted"}
                onClick={() => void toggleSpeak(selected)}
                className={`inline-flex items-center justify-center gap-2 py-2.5 font-mono text-[10px] uppercase tracking-wider disabled:opacity-50 ${
                  speakingTo === selected?.roll
                    ? "border border-alert bg-alert text-paper"
                    : "border border-forest bg-forest/5 text-forest hover:bg-forest hover:text-paper"
                }`}
              >
                {speakingTo === selected?.roll ? <><FiMicOff aria-hidden /> Stop speaking</> : voiceBusy ? "Connecting mic…" : <><FiMic aria-hidden /> Speak to candidate</>}
              </button>
              <button
                disabled={!selected || (selected.status !== "Writing" && selected.status !== "Paused")}
                onClick={() => void runAction(selected?.status === "Paused" ? "resume" : "pause")}
                className="border border-amber bg-amber/5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-amber disabled:opacity-50 hover:bg-amber/10"
              >
                {selected?.status === "Paused" ? "Resume candidate" : "Pause candidate"}
              </button>
              <button
                disabled={!selected || selected.status === "Submitted"}
                onClick={() => void runAction("escalation")}
                className="border border-alert bg-alert/5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-alert disabled:opacity-50 hover:bg-alert/10"
              >
                Escalate incident
              </button>
              <button
                disabled={!selected || !selected.realAttemptId || selected.status === "Submitted"}
                onClick={() => {
                  if (!selected) return;
                  if (!confirm(`Are you sure you want to force submit the exam for ${selected.name}?`)) return;
                  void runAction("force_submit");
                }}
                className="border border-forest bg-forest py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper disabled:opacity-50 hover:bg-forest/90 sm:col-span-2"
              >
                Force Submit
              </button>
              {actionMsg && (
                <p className={`sm:col-span-2 border px-3 py-2 font-mono text-[9px] uppercase tracking-wider ${
                  actionMsg.tone === "err" ? "border-alert/40 bg-alert/5 text-alert" :
                  actionMsg.tone === "warn" ? "border-amber/40 bg-amber/5 text-amber" :
                  "border-success/40 bg-success/5 text-success"
                }`}>
                  {actionMsg.text}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Selected candidate card */}
        <aside className="p-5 h-fit xl:sticky xl:top-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Selected candidate</p>
          {!selected ? (
            <div className="mt-4 border border-dashed border-line-strong bg-paper-raised px-4 py-8 text-center text-[13px] text-ink-soft">
              Select a tile on the wall to inspect a candidate.
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="border border-line bg-paper-raised p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-serif text-xl font-semibold">{selected.name}</h2>
                    <p className="mt-1 font-mono text-[10px] text-ink-soft">{selected.roll} · {selected.status} · {selected.progress}%</p>
                  </div>
                  <span className={`shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${selected.violation ? "border-alert/40 bg-alert/5 text-alert" : "border-success/40 bg-success/5 text-success"}`}>
                    {selected.violation ? "Flagged" : "Clear"}
                  </span>
                </div>
              </div>

              <div className="flex border border-line font-mono text-[10px] uppercase tracking-wider">
                <button
                  onClick={() => { setScreenMode(false); setPhoneMode(false); }}
                  className={`flex-1 border-r border-line px-2 py-2.5 ${!screenMode && !phoneMode ? "bg-forest text-paper" : "bg-paper-raised text-ink-soft hover:text-ink"}`}
                >
                  Camera
                </button>
                <button
                  onClick={() => { setScreenMode(true); setPhoneMode(false); }}
                  className={`flex-1 border-r border-line px-2 py-2.5 ${screenMode && !phoneMode ? "bg-forest text-paper" : "bg-paper-raised text-ink-soft hover:text-ink"}`}
                >
                  Screen
                </button>
                <button
                  onClick={() => { setPhoneMode(true); setScreenMode(false); }}
                  className={`flex-1 px-2 py-2.5 ${phoneMode ? "bg-forest text-paper" : "bg-paper-raised text-ink-soft hover:text-ink"}`}
                >
                  <FiSmartphone className="mr-1 inline" aria-hidden /> Phone
                </button>
              </div>

              {phoneMode ? (
                <div className="relative flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#D9D5CB]">
                  <FeedView feed={mobileFeedByRoll.get(selected.roll.toLowerCase()) ?? null} initials={selected.name.split(" ").map((x) => x[0]).slice(0, 2).join("")} />
                  <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper"><span className="h-1 w-1 rounded-none bg-alert" /> Phone desk</span>
                </div>
              ) : screenMode ? (
                <ScreenRecording selected={selected} feed={feedFor(selected)} />
              ) : (
                <div className="relative flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#D9D5CB]">
                  <FeedView feed={feedFor(selected)} initials={selected.name.split(" ").map((x) => x[0]).slice(0, 2).join("")} />
                  <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper"><span className="h-1 w-1 rounded-none bg-alert" /> Live camera</span>
                </div>
              )}
              <AudioPlayer track={feedFor(selected)?.audioTrack} />

              <div className="border border-line bg-paper-raised p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  Evidence{selected.violations.length > 0 ? ` · ${selected.violations.length}` : ""}
                </p>
                {selected.violations.length === 0 ? (
                  <p className="mt-3 border-l-2 border-success bg-success/[0.04] px-3 py-2 text-[12px] text-ink-soft">No proctoring flags. All checks are passing.</p>
                ) : (
                  <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {[...selected.violations]
                      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                      .slice(0, 8)
                      .map((v) => (
                        <div key={v.id} className="border border-alert/25 bg-alert/[0.04] px-3 py-2.5">
                          <p className="text-[12px] leading-snug">{v.description || v.violation_type}</p>
                          <p className="mt-1 font-mono text-[9px] text-ink-soft">
                            {v.violation_type} · {new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            {v.offset_seconds != null ? ` · @ ${formatClock(v.offset_seconds)}` : ""}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>

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
    <div className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">All student video feeds</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">
            {showPhone ? "Live phone wall" : showScreen ? "Live screen wall" : "Live camera wall"}
          </h2>
        </div>
        <div className="flex items-center border border-line-strong bg-paper-raised p-1">
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

      <p className="mt-2 text-[12px] text-ink-soft">
        {showScreen
          ? "Each candidate's shared screen — the exam view being recorded."
          : showPhone
          ? "Desk monitor feeds for candidates who enabled phone via QR."
          : "Webcam feeds. Flagged candidates appear first."}
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {visible.map((student, index) => {
          const feed = feedFor(student);
          const hasFeed = showPhone
            ? mobileFeedFor.has(student.roll.toLowerCase())
            : showScreen
            ? !!feed?.screenTrack
            : !!feed?.cameraTrack;
          const isSelected = selected?.roll === student.roll;
          const isViolated = !!student.violation;

          return (
            <button
              key={student.roll}
              onClick={() => onSelect(student)}
              className={`group overflow-hidden border bg-paper-raised text-left transition ${
                isViolated
                  ? "border-alert shadow-[inset_0_0_0_1px_rgba(180,60,60,0.35)]"
                  : isSelected
                  ? "border-forest shadow-[inset_0_0_0_1px_rgba(40,75,52,0.35)]"
                  : "border-line hover:border-line-strong hover:bg-paper"
              }`}
            >
              <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-[#252923]">
                <span className="absolute left-2 top-2 z-10 bg-ink/80 px-1.5 py-0.5 font-mono text-[7px] uppercase text-paper">
                  {showPhone ? "Phone" : showScreen ? "Screen" : "Camera"}
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
                  <span className="absolute left-2 top-6 z-10 bg-alert px-1.5 py-0.5 font-mono text-[7px] uppercase text-paper">Review first</span>
                )}

                <span className="absolute bottom-0 left-0 right-0 z-10 bg-ink/80 px-2 py-1 font-mono text-[9px] text-paper">
                  {student.status} · {student.progress}%
                </span>
              </div>

              <div className="border-t border-line px-2.5 py-2">
                <p className="truncate text-[12px] font-medium">{student.name}</p>
                <p className={`mt-0.5 truncate font-mono text-[9px] ${isViolated ? "text-alert" : "text-ink-soft"}`}>
                  {isViolated
                    ? student.violation
                    : hasFeed
                    ? (showPhone ? "Desk feed active" : showScreen ? "Screen active" : "Camera active")
                    : "No feed"}
                </p>
              </div>
            </button>
          );
        })}

        {visible.length === 0 && (
          <div className="col-span-full border border-dashed border-line-strong bg-paper-raised p-10 text-center font-mono text-[11px] text-ink-soft">
            Waiting for candidates to begin…
          </div>
        )}
      </div>
    </div>
  );
}
function AudioPlayer({ track }: { track: any }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!track) {
      el.srcObject = null;
      setListening(false);
      return;
    }
    try {
      track.attach(el);
      el.volume = volume;
      el.muted = !listening;
    } catch (err) {
      console.warn("[AudioPlayer] attach failed:", err);
    }
    return () => {
      try { track.detach(el); } catch { /* ignore */ }
    };
  }, [track]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume;
    el.muted = !listening;
  }, [volume, listening]);

  const startListening = async () => {
    const el = audioRef.current;
    if (!el || !track) return;
    setError(null);
    try {
      if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = true;
      track.attach(el);
      el.muted = false;
      el.volume = volume;
      await el.play();
      setListening(true);
    } catch (err) {
      console.warn("[AudioPlayer] play failed:", err);
      setListening(false);
      setError("Click again to allow audio in this browser tab.");
    }
  };

  const stopListening = () => {
    const el = audioRef.current;
    if (el) {
      el.muted = true;
      el.pause();
    }
    setListening(false);
  };

  return (
    <div className="mt-3 border border-line bg-paper-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Candidate microphone</p>
          <p className="mt-0.5 text-[11px] text-ink-soft">
            {!track ? "Waiting for student mic…" : listening ? "Listening live" : "Mic available — tap Listen"}
          </p>
        </div>
        <button
          type="button"
          disabled={!track}
          onClick={() => { if (listening) stopListening(); else void startListening(); }}
          className={`inline-flex shrink-0 items-center gap-1.5 border px-3 py-2 font-mono text-[10px] uppercase tracking-wider disabled:opacity-40 ${
            listening
              ? "border-forest bg-forest text-paper"
              : "border-forest bg-forest/5 text-forest hover:bg-forest hover:text-paper"
          }`}
        >
          {listening ? <><FiVolumeX aria-hidden /> Mute</> : <><FiVolume2 aria-hidden /> Listen</>}
        </button>
      </div>
      {listening && (
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
          />
          <span className="w-8 font-mono text-[9px] text-ink-soft">{Math.round(volume * 100)}%</span>
        </div>
      )}
      {error && <p className="mt-2 font-mono text-[9px] text-amber">{error}</p>}
      <p className="mt-1.5 font-mono text-[8px] text-ink-soft">
        Mute only affects your speakers. The student mic stays live for recording.
      </p>
      <audio ref={audioRef} playsInline className="hidden" />
    </div>
  );
}

function ActivityView({ visible, selected, onSelect }: { visible: Student[]; selected: Student | null; onSelect: (student: Student) => void }) {
  return (
    <div className="p-5 sm:p-6">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Activity stream</p>
      <h2 className="mt-1 font-serif text-xl font-semibold">Student activity by priority</h2>
      <div className="mt-4 space-y-2">
        {visible.map((student) => (
          <button
            key={student.roll}
            onClick={() => onSelect(student)}
            className={`flex w-full flex-col gap-2 border px-4 py-3.5 text-left transition sm:flex-row sm:items-center sm:justify-between ${
              selected?.roll === student.roll
                ? "border-forest bg-forest/5"
                : student.violation
                ? "border-alert/30 bg-alert/[0.03] hover:border-alert"
                : "border-line bg-paper-raised hover:border-line-strong"
            }`}
          >
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                {student.name} <span className="ml-2 font-mono text-[10px] text-ink-soft">{student.roll}</span>
              </p>
              <p className="mt-1 truncate text-[11px] text-ink-soft">Last event: {student.violation || "Status updated recently"}</p>
            </div>
            <span className={`inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase ${student.violation ? "text-alert" : "text-success"}`}>
              {student.violation ? <>Review <FiChevronRight /></> : "Clear"}
            </span>
          </button>
        ))}
        {visible.length === 0 && (
          <div className="border border-dashed border-line-strong p-10 text-center font-mono text-[11px] text-ink-soft">No active candidates.</div>
        )}
      </div>
    </div>
  );
}

function ScreenRecording({ selected, feed }: { selected: Student; feed: RemoteFeed | null }) {
  const liveScreen = !!feed?.screenTrack;
  return (
    <div>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#252923]">
        {liveScreen ? (
          <ScreenFeedView feed={feed} />
        ) : (
          <div className="absolute inset-3 flex items-center justify-center bg-ink/90 font-mono text-[10px] uppercase text-paper">Screen feed unavailable</div>
        )}
        <span className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1.5 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">
          {liveScreen ? <><span className="h-1 w-1 rounded-none bg-alert" /> Live screen share</> : <><span className="h-1 w-1 rounded-none border border-paper/60" /> Screen preview</>}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-ink-soft">{selected.name} · {liveScreen ? "Live screen share" : "Awaiting screen feed"}</p>
    </div>
  );
}
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
function Stat({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className={`border bg-paper p-5 ${alert ? "border-alert/35" : "border-line"}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p>
      <p className={`mt-2 font-serif text-3xl font-semibold ${alert ? "text-alert" : "text-ink"}`}>{value}</p>
      <p className="mt-1 text-[12px] text-ink-soft">{sub}</p>
    </div>
  );
}

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
    <section className="mt-4 border border-line bg-paper px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center border border-line-strong bg-paper-raised text-forest"><FiUsers aria-hidden /></span>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Allocation</p>
            <p className="mt-0.5 text-[13px]">
              {total} candidate{total === 1 ? "" : "s"} · {effective} proctor{effective === 1 ? "" : "s"} · your share ≈{" "}
              <strong className="font-serif text-[15px]">{share}</strong>
            </p>
          </div>
        </div>
        <div className="flex items-stretch gap-2">
          {[
            [String(online), "Online now"],
            [String(total - online), "Idle / submitted"],
            [myTurn ? "Active" : "Standby", "Your role"],
          ].map(([value, label], i) => (
            <div key={label} className={`min-w-[88px] border px-3 py-2 text-right ${i === 2 && myTurn ? "border-forest/40 bg-forest/5" : "border-line bg-paper-raised"}`}>
              <p className={`font-serif text-lg ${i === 2 ? (myTurn ? "text-forest" : "text-amber") : "text-ink"}`}>{value}</p>
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
            </div>
          ))}
        </div>
      </div>
      {proctors.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
          {proctors.map((p) => (
            <span key={p.assignee_name} className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${p.assignee_name === me ? "border-forest bg-forest/10 text-forest" : "border-line-strong bg-paper-raised text-ink-soft"}`}>
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
