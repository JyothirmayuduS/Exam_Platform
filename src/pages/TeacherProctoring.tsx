import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { supabaseConfigured } from "../lib/env";
import { listLiveAttempts, subscribeToAttempts, forceSubmitAttempt, saveViolation, listExams, type LiveAttempt } from "../lib/examApi";
import { startProctorViewing, identityLabel, type RemoteFeed } from "../lib/proctorViewer";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";
import { getTeacherNav } from "./TeacherDashboard";

type Student = { name: string; roll: string; status: string; progress: number; violation: string; studentId?: string; attemptId?: string; timeLeft?: string };

function attemptToStudent(a: LiveAttempt): Student {
  const pct = a.total ? Math.round((a.answered / a.total) * 100) : 0;
  const status = a.state === "submitted" ? "Submitted" : a.state === "in_progress" ? "Writing" : "Not started";
  
  // Sort violations descending by created_at (most recent first)
  const sortedVio = [...(a.violations || [])].sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
  const activeVio = sortedVio.length > 0 ? sortedVio[0].description : "";
  
  return { name: a.student?.full_name ?? "Unknown", roll: a.student?.roll ?? "—", status, progress: pct, violation: activeVio, studentId: a.student?.id, attemptId: a.id };
}

type FeedLookup = (s: Student) => RemoteFeed | null;

export default function TeacherProctoring() {
  const { profile } = useCurrentProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramExamId = searchParams.get("examId") ?? searchParams.get("exam");
  const [examList, setExamList] = useState<{ id: string; name: string; batch?: string }[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>(paramExamId ?? "EXAM-2026-072");

  const [students, setStudents] = useState<Student[]>([]);
  const [live, setLive] = useState(false);
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);
  const [selected, setSelected] = useState<Student | null>(null);
  const [view, setView] = useState<"wall" | "activity" | "chat">("wall");
  const [filter, setFilter] = useState("All candidates");
  const [screenMode, setScreenMode] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);

  // Load available exams for switcher
  useEffect(() => {
    let active = true;
    (async () => {
      const all = await listExams();
      if (!active) return;
      if (all && all.length > 0) {
        setExamList(all);
        if (!paramExamId) {
          const defaultExam = all.find((x: any) => x.status === "published" || x.id === "EXAM-2026-072") || all[0];
          setSelectedExamId(defaultExam.id);
        }
      }
    })();
    return () => { active = false; };
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

  // Live camera feeds from LiveKit
  useEffect(() => {
    if (!selectedExamId) return;
    let handle: Awaited<ReturnType<typeof startProctorViewing>> | null = null;
    let cancelled = false;
    (async () => {
      handle = await startProctorViewing({ room: selectedExamId, onFeeds: setFeeds });
      if (cancelled) handle?.stop();
    })();
    return () => { cancelled = true; handle?.stop(); };
  }, [selectedExamId]);

  const feedFor: FeedLookup = useMemo(() => {
    const byId = new Map<string, RemoteFeed>();
    for (const f of feeds) byId.set(identityLabel(f.identity), f);
    return (s: Student) => (s.roll ? byId.get(s.roll) ?? null : null);
  }, [feeds]);

  const visible = useMemo(() => {
    const filtered = filter === "Flagged only" ? students.filter((s) => s.violation) : filter === "Submitted" ? students.filter((s) => s.status === "Submitted") : students;
    return [...filtered].sort((a, b) => Number(Boolean(b.violation)) - Number(Boolean(a.violation)));
  }, [filter, students]);
  const selectCandidate = (candidate: Student) => { setSelected(candidate); setView("wall"); setScreenMode(true); };
  const feedCount = feeds.filter((f) => f.cameraTrack).length;
  
  const activeCount = students.length;
  const flaggedCount = students.filter(s => s.violation).length;
  const clearCount = activeCount - flaggedCount;
  
  const liveAttemptsCount = students.filter(s => s.status !== "Submitted").length;
  const submittedAttemptsCount = students.filter(s => s.status === "Submitted").length;
  const needsAttentionCount = students.filter(s => s.violation !== "").length;
  const nav = getTeacherNav(liveAttemptsCount, submittedAttemptsCount, needsAttentionCount);

  return <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={nav} status="Live monitoring active">
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
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
              className="border border-line-strong bg-paper px-3 py-1 font-serif text-lg font-semibold text-maroon hover:border-maroon focus:border-maroon focus:outline-none cursor-pointer"
            >
              {examList.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.name} ({ex.batch || ex.id})
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="mt-1 text-[13px] text-ink-soft">
          Active Session: <strong className="text-ink">{examList.find(e => e.id === selectedExamId)?.name || selectedExamId}</strong> · Monitoring {students.length} candidate(s)
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={() => setShowAssignModal(true)} className="border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">Assign Proctors</button>
        <button className="border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">Export Report</button>
        <span className="border border-alert/30 bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert">● Session live</span>
      </div>
    </div>
    <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Active candidates" value={activeCount.toString()} sub="connected to session"/><Stat label="Clear" value={clearCount.toString()} sub="No active flags"/><Stat label="Needs attention" value={flaggedCount.toString()} sub="Active violations" alert={flaggedCount > 0} /><Stat label="Live Feeds" value={feedCount.toString()} sub="Camera / screen connected"/></div>
    <div className="mt-8 flex flex-col justify-between gap-4 border-b border-line pb-3 sm:flex-row sm:items-center"><div className="flex gap-1"><button onClick={() => setView("wall")} className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === "wall" ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Video wall</button><button onClick={() => setView("activity")} className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === "activity" ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Activity</button><button onClick={() => setView("chat")} className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === "chat" ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Proctor Chat (2)</button></div><div className="flex items-center gap-3"><span className={`font-mono text-[10px] ${live ? "text-success" : "text-ink-soft"}`}>● {live ? `${feedCount} feed(s) · DB live` : "Demo mode"}</span><select value={filter} onChange={(e) => setFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider"><option>All candidates</option><option>Flagged only</option><option>Submitted</option></select></div></div>
    {view === "wall" ? <VideoWall visible={visible} selected={selected} onSelect={selectCandidate} feedFor={feedFor}/> : view === "activity" ? <ActivityView visible={visible} selected={selected} onSelect={selectCandidate}/> : <ProctorChat />}
    <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]">
      <section className="border border-line bg-paper p-5 sm:p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Selected candidate</p>
        {!selected ? (
          <div className="mt-4 text-[13px] text-ink-soft">No candidate selected or no active candidates.</div>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-serif text-xl font-semibold">{selected.name}</h2>
                <p className="mt-1 font-mono text-[10px] text-ink-soft">{selected.roll} · {selected.status} · {selected.progress}% complete</p>
              </div>
              <span className={`font-mono text-[10px] uppercase ${selected.violation ? "text-alert" : "text-success"}`}>{selected.violation ? "Violation detected" : "Clear"}</span>
            </div>
            <div className="mt-5 flex border-b border-line font-mono text-[10px] uppercase tracking-wider">
              <button onClick={() => setScreenMode(false)} className={`border-b-2 px-3 py-2 ${!screenMode ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Camera view</button>
              <button onClick={() => setScreenMode(true)} className={`border-b-2 px-3 py-2 ${screenMode ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Screen recording</button>
            </div>
            {screenMode ? (
              <ScreenRecording selected={selected} feed={feedFor(selected)}/>
            ) : (
              <div className="relative mt-4 flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#D9D5CB]">
                <FeedView feed={feedFor(selected)} initials={selected.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}/>
                <span className="absolute bottom-2 left-2 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">● LIVE CAMERA</span>
              </div>
            )}
            <AudioPlayer track={feedFor(selected)?.audioTrack} />
            <div className="mt-5 border-l-2 border-alert px-3 py-2 text-[12px] text-ink-soft">{selected.violation || "No active proctoring flags. All checks are passing."}</div>
          </>
        )}
      </section>
      <aside className="border border-line p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Candidate activity</p>
        <div className="mt-4 space-y-4">
          {!selected ? (
            <p className="text-[12px] text-ink-soft">Select a candidate to view activity.</p>
          ) : (
            [["10:17 AM", "Answered question 04"], ["10:16 AM", selected.violation || "Camera check passed"], ["10:12 AM", "Session connection stable"], ["10:00 AM", "Exam started"]].map(([time, event]) => (
              <div key={time} className="flex gap-3"><span className="font-mono text-[10px] text-ink-soft">{time}</span><p className="text-[12px]">{event}</p></div>
            ))
          )}
        </div>
        <div className="mt-6 grid gap-2">
          <button 
            disabled={!selected || selected.status === "Submitted"} 
            onClick={async () => {
              if (!selected?.attemptId || !selected?.studentId) return;
              await saveViolation(selected.attemptId, selectedExamId, selected.studentId, "proctor_warning", "Warning sent by proctor");
              setSelected({ ...selected, violation: "Warning sent" });
            }} 
            className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft disabled:opacity-50 hover:bg-line-strong transition-colors"
          >
            Send warning
          </button>
          <button 
            disabled={!selected || selected.status === "Submitted"} 
            onClick={async () => {
              if (!selected?.attemptId || !selected?.studentId) return;
              await saveViolation(selected.attemptId, selectedExamId, selected.studentId, "proctor_pause", "Candidate paused by proctor");
              setSelected({ ...selected, status: "Paused" });
            }} 
            className="border border-amber py-2 font-mono text-[10px] uppercase tracking-wider text-amber disabled:opacity-50 hover:bg-amber/10 transition-colors"
          >
            Pause candidate
          </button>
          <button 
            disabled={!selected || selected.status === "Submitted"} 
            onClick={async () => {
              if (!selected?.attemptId || !selected?.studentId) return;
              await saveViolation(selected.attemptId, selectedExamId, selected.studentId, "proctor_escalation", "Incident escalated by proctor");
              setSelected({ ...selected, violation: "Incident escalated" });
            }} 
            className="border border-alert py-2 font-mono text-[10px] uppercase tracking-wider text-alert disabled:opacity-50 hover:bg-alert/10 transition-colors"
          >
            Escalate incident
          </button>
          <button 
            disabled={!selected || selected.status === "Submitted"} 
            onClick={async () => {
              if (!selected?.attemptId || !selected?.studentId) return;
              if (!confirm(`Are you sure you want to force submit the exam for ${selected.name}?`)) return;
              await forceSubmitAttempt(selected.attemptId);
              await saveViolation(selected.attemptId, selectedExamId, selected.studentId, "proctor_force_submit", "Exam forcefully submitted by proctor");
              setSelected({ ...selected, status: "Submitted", progress: 100, violation: "Force submitted" });
            }} 
            className="border border-forest bg-forest/5 py-2 font-mono text-[10px] uppercase tracking-wider text-forest disabled:opacity-50 hover:bg-forest hover:text-paper transition-colors"
          >
            Force Submit
          </button>
        </div>
      </aside>
    </div>

    {showAssignModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper/80 backdrop-blur-sm">
        <div className="w-full max-w-md border border-line-strong bg-paper p-6 shadow-2xl animate-fade-in">
          <h2 className="font-serif text-xl font-semibold">Assign Proctors</h2>
          <p className="mt-2 text-[13px] text-ink-soft">Select faculty members to assist in monitoring Hall B.</p>
          <div className="mt-6 flex flex-col gap-3">
            {["Dr. Ramesh Kumar (CS Dept)", "Prof. Anjali Sharma", "K. Srinivas (TA)", "P. Venkat (TA)"].map((p, i) => (
              <label key={i} className="flex items-center gap-3 border border-line p-3 hover:bg-forest/5 cursor-pointer transition-colors">
                <input type="checkbox" className="accent-forest w-4 h-4" />
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink">{p}</span>
              </label>
            ))}
          </div>
          <div className="mt-8 flex justify-end gap-3">
            <button onClick={() => setShowAssignModal(false)} className="px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Cancel</button>
            <button onClick={() => setShowAssignModal(false)} className="bg-forest px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90">Save Assignments</button>
          </div>
        </div>
      </div>
    )}
  </RoleLayout>;
}

function VideoWall({ visible, selected, onSelect, feedFor }: { visible: Student[]; selected: Student | null; onSelect: (student: Student) => void; feedFor: FeedLookup }) { return <section className="mt-6 border border-line bg-paper p-5 sm:p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">All student video feeds</p><h2 className="mt-1 font-serif text-xl font-semibold">Live camera wall</h2></div><span className="font-mono text-[10px] text-ink-soft">Flagged feeds appear first</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">{visible.map((student, index) => <button key={student.roll} onClick={() => onSelect(student)} className={`overflow-hidden border text-left ${student.violation ? "border-alert ring-1 ring-alert" : selected?.roll === student.roll ? "border-forest ring-1 ring-forest" : "border-line hover:border-line-strong"}`}><div className="relative flex aspect-video items-center justify-center overflow-hidden bg-[#D9D5CB]"><FeedView feed={feedFor(student)} initials={student.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}/><span className={`absolute right-2 top-2 z-10 h-2 w-2 rounded-full ${student.violation ? "bg-alert" : "bg-success"}`}/><span className="absolute left-2 top-2 z-10 bg-ink/75 px-1.5 py-0.5 font-mono text-[8px] text-paper">{index === 0 && student.violation ? "REVIEW FIRST" : "REC"}</span><span className="absolute bottom-0 left-0 right-0 z-10 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">{student.status} · {student.progress}%</span></div><div className="p-2"><p className="truncate text-[11px] font-medium">{student.name}</p><p className={`truncate font-mono text-[9px] ${student.violation ? "text-alert" : "text-ink-soft"}`}>{student.violation || "No violations"}</p></div></button>)}{visible.length === 0 && <div className="col-span-full border border-dashed border-line-strong p-10 text-center font-mono text-[11px] text-ink-soft">Waiting for candidates to begin…</div>}</div></section>; }
function AudioPlayer({ track }: { track: any }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return track ? <audio ref={audioRef} autoPlay controls className="mt-3 w-full h-8 outline-none rounded bg-ink/10" /> : null;
}

function ActivityView({ visible, selected, onSelect }: { visible: Student[]; selected: Student | null; onSelect: (student: Student) => void }) { return <section className="mt-6 border border-line"><div className="border-b border-line bg-paper-raised px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Activity stream</p><h2 className="mt-1 font-serif text-xl font-semibold">Student activity by priority</h2></div><div className="divide-y divide-line">{visible.map((student) => <button key={student.roll} onClick={() => onSelect(student)} className={`flex w-full flex-col gap-3 px-5 py-4 text-left sm:flex-row sm:items-center sm:justify-between ${selected?.roll === student.roll ? "bg-success/5" : "hover:bg-paper-raised"}`}><div><p className="text-[13px] font-medium">{student.name} <span className="ml-2 font-mono text-[10px] text-ink-soft">{student.roll}</span></p><p className="mt-1 text-[11px] text-ink-soft">Last event: {student.violation || "Status updated recently"}</p></div><span className={`font-mono text-[10px] uppercase ${student.violation ? "text-alert" : "text-success"}`}>{student.violation ? "Review violation →" : "Monitoring clear"}</span></button>)}{visible.length === 0 && <div className="p-10 text-center font-mono text-[11px] text-ink-soft">No active candidates.</div>}</div></section>; }
function ScreenRecording({ selected, feed }: { selected: Student; feed: RemoteFeed | null }) { const liveScreen = !!feed?.screenTrack; return <div className="mt-4"><div className="relative flex aspect-video items-center justify-center overflow-hidden border border-line bg-[#252923]">{liveScreen ? <ScreenFeedView feed={feed}/> : <><div className="absolute inset-3 bg-ink/90 flex items-center justify-center text-paper font-mono text-[10px] uppercase">Screen feed unavailable</div></>}<span className="absolute bottom-2 left-2 z-10 bg-ink/75 px-2 py-1 font-mono text-[9px] text-paper">{liveScreen ? "● LIVE SCREEN SHARE" : "○ SCREEN PREVIEW"}</span></div><p className="mt-3 text-[11px] text-ink-soft">{selected.name} · {liveScreen ? "Live screen share" : "Screen recording · awaiting feed"}</p></div>; }
function FeedView({ feed, initials }: { feed: RemoteFeed | null; initials: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !feed?.cameraTrack) return;
    feed.cameraTrack.attach(video);
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

function ProctorChat() {
  return (
    <section className="mt-6 border border-line bg-paper p-5 sm:p-6 h-[400px] flex flex-col">
      <div className="border-b border-line pb-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Team communication</p>
        <h2 className="mt-1 font-serif text-xl font-semibold">Proctor Chat</h2>
      </div>
      <div className="flex-1 flex items-center justify-center py-4">
        <p className="text-center font-mono text-[11px] text-ink-soft">No active messages in team chat.</p>
      </div>
      <div className="mt-4">
        <input type="text" placeholder="Type a message to proctor team..." className="w-full border border-line-strong bg-paper px-4 py-3 font-mono text-[11px] uppercase placeholder:text-ink/30 focus:border-forest focus:outline-none" />
      </div>
    </section>
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
    return () => { feed?.screenTrack?.detach?.(video); };
  }, [feed?.screenTrack]);
  return (
    <div className="absolute inset-0 z-0 flex items-center justify-center">
      {feed?.screenTrack && <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />}
    </div>
  );
}
function Stat({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) { return <div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p><p className={`mt-2 font-serif text-3xl ${alert ? "text-alert" : "text-ink"}`}>{value}</p><p className="mt-1 text-[12px] text-ink-soft">{sub}</p></div>; }
