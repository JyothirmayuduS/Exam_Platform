import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { supabaseConfigured } from "../lib/env";
import { listLiveAttempts, subscribeToAttempts, saveViolation, setAttemptPaused, forceSubmitAttempt, sendProctorMessage, extendAttemptTime, listAssignedExamsForAuthUser, type LiveAttempt, type ViolationEvent } from "../lib/examApi";
import { startProctorViewing, identityLabel, type RemoteFeed, type ViewerState } from "../lib/proctorViewer";
import { startVoiceBroadcast, voiceRoom } from "../lib/proctorVoice";
import RecordingReviewer from "../components/RecordingReview";
import useCurrentProfile from "../hooks/useCurrentProfile";
import { storeViolationSnapshot, captureFrame } from "../lib/examStorage";
import {
  downloadSessionReportPdf,
  downloadSessionReportCsv,
  type ReportRow,
} from "../lib/sessionReport";

// Proctor console — a live monitoring dashboard for the exam the signed-in
// proctor is assigned to (?exam=... overrides the pick). The roster comes from
// the DB (realtime) and the LiveKit room IS the exam id, so every candidate's
// camera AND screen share appear as soon as they begin. No demo data.
const TONE = "#B7791F"; // proctor accent (amber/gold)

type Severity = "none" | "low" | "high";
type Tile = {
  id: string;
  name: string;
  roll: string;
  initials: string;
  severity: Severity;
  reason?: string;
  time?: string;
  status: string;
  progress: number;
  studentId?: string;
};

const NAV = [
  { label: "Overview", to: "/proctor", end: true },
  { label: "Live monitoring", to: "/proctor" },
  { label: "Flags & incidents", to: "/proctor" },
  { label: "Recordings", to: "/proctor" },
];

const severityTone: Record<Severity, string> = { none: "#3F7D5B", low: "#B7791F", high: "#9B2C2C" };
const severityRank: Record<Severity, number> = { high: 0, low: 1, none: 2 };
const severityLabel: Record<Severity, string> = { none: "Clear", low: "Notice", high: "Critical" };

function initialsOf(name: string): string {
  return name.split(" ").map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function attemptToTile(a: LiveAttempt): Tile {
  const name = a.student?.full_name ?? "Unknown candidate";
  const roll = a.student?.roll ?? "—";
  const pct = a.total ? Math.round((a.answered / a.total) * 100) : 0;
  const status = a.state === "submitted" ? "Submitted" : a.state === "paused" ? "Paused" : a.state === "in_progress" ? "Writing" : "Not started";
  
  let severity: Severity = "none";
  let reason: string | undefined = undefined;
  let time: string | undefined = undefined;

  if (a.violations && a.violations.length > 0) {
    const latest = [...a.violations].sort((v1, v2) => new Date(v2.created_at).getTime() - new Date(v1.created_at).getTime())[0];
    const isHigh = a.violations.some(v => v.severity === "high" || v.severity === "critical");
    severity = isHigh ? "high" : "low";
    reason = latest.description || latest.severity;
    const diffMin = Math.round((Date.now() - new Date(latest.created_at).getTime()) / 60000);
    time = diffMin === 0 ? "just now" : `${diffMin}m ago`;
  }

  return { id: a.id, name, roll, initials: initialsOf(name), severity, reason, time, status, progress: pct, studentId: a.student?.id };
}

type ViewMode = "split" | "camera" | "screen";
type Filter = "all" | "flagged" | "submitted";
type FeedLookup = (t: Tile) => RemoteFeed | null;

// PLACEHOLDER_BODY

export default function ProctorGrid() {
  const { profile } = useCurrentProfile();
  const [searchParams] = useSearchParams();
  const paramExam = searchParams.get("exam") ?? searchParams.get("examId");
  // Real exam list: exams the signed-in proctor is assigned to (Supabase).
  const [examOptions, setExamOptions] = useState<{ id: string; name: string; batch: string; status: string }[]>([]);
  const [loadingExam, setLoadingExam] = useState(true);
  const [examId, setExamId] = useState<string | null>(paramExam);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [live, setLive] = useState(false);
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);
  const [viewerState, setViewerState] = useState<ViewerState | "off">("off");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("split");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [autoFocus, setAutoFocus] = useState(true);
  const [size, setSize] = useState<"S"|"M"|"L">("M");
  const [mainTab, setMainTab] = useState<"live"|"reports"|"recordings">("live");
  const [note, setNote] = useState("");
  const [log, setLog] = useState<{ time: string; text: string }[]>([]);
  // Live voice: push-to-talk to the focused candidate's own channel.
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
  useEffect(() => () => stopSpeaking(), []);
  useEffect(() => { stopSpeaking(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [examId]);

  // Load the proctor's assigned exams once. ?exam= picks a specific one.
  useEffect(() => {
    let active = true;
    void listAssignedExamsForAuthUser().then((rows) => {
      if (!active) return;
      setExamOptions(rows);
      setLoadingExam(false);
      if (!paramExam) {
        if (rows.length > 0) setExamId(rows[0].id);
        else setExamId(null);
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const examName = examOptions.find((e) => e.id === examId)?.name ?? examId ?? "";
  const examBatch = examOptions.find((e) => e.id === examId)?.batch ?? "";
  // Handlers below run only when an exam is selected; keep a non-null copy for the API calls.
  const examIdSafe = examId ?? "";

  // DB roster (live attempts) — realtime refresh on any attempt change.
  useEffect(() => {
    if (!supabaseConfigured || !examId) { setTiles([]); setLive(false); return; }
    let active = true;
    const load = async () => {
      const rows = await listLiveAttempts(examId);
      if (!active) return;
      setLive(true);
      const mapped = rows.map(attemptToTile);
      setTiles(mapped);
      setSelectedId((cur) => (mapped.some((t) => t.id === cur) ? cur : mapped[0]?.id ?? null));
    };
    void load();
    const unsub = subscribeToAttempts(examId, () => void load());
    return () => { active = false; unsub(); };
  }, [examId]);

  // Live camera + screen viewer — subscribe to the room and collect remote feeds.
  useEffect(() => {
    if (!examId) { setFeeds([]); setViewerState("off"); return; }
    let handle: Awaited<ReturnType<typeof startProctorViewing>> | null = null;
    let cancelled = false;
    (async () => {
      handle = await startProctorViewing({ room: examId, onState: setViewerState, onFeeds: setFeeds });
      if (cancelled) { handle?.stop(); return; }
      if (handle) setViewerState((s) => (s === "off" ? "connecting" : s));
    })();
    return () => { cancelled = true; handle?.stop(); };
  }, [examId]);

  // Live voice toggle for the focused candidate (speak → they hear you live).
  const toggleSpeak = async () => {
    if (!selected) return;
    const roll = selected.roll;
    if (speakingTo === roll) { stopSpeaking(); return; }
    stopSpeaking();
    if (!examId) return;
    setVoiceBusy(true);
    const handle = await startVoiceBroadcast(
      voiceRoom(examId, roll),
      (msg) => pushLog(`Live voice unavailable — ${msg}`),
    );
    setVoiceBusy(false);
    if (!handle) return;
    voiceRef.current = handle;
    await handle.setSpeaking(true);
    setSpeakingTo(roll);
    pushLog(`Speaking live to ${selected.name} — they can hear you now.`);
  };

  // Map a tile → its live feed (matched by student uuid embedded in identity).
  const feedFor: FeedLookup = useMemo(() => {
    const byId = new Map<string, RemoteFeed>();
    for (const f of feeds) byId.set(identityLabel(f.identity), f);
    return (t: Tile) => (t.studentId ? byId.get(t.studentId) ?? null : null);
  }, [feeds]);

  const selected = (selectedId ? tiles.find((t) => t.id === selectedId) : null) ?? tiles[0];
  const flaggedCount = tiles.filter((t) => t.severity !== "none").length;
  const submittedCount = tiles.filter((t) => t.status === "Submitted").length;
  const activeCount = tiles.filter((t) => t.status !== "Submitted" && t.status !== "Not started").length;
  const screenCount = feeds.filter((f) => f.screen).length;
  const cameraCount = feeds.filter((f) => f.camera).length;

  const visible = useMemo(() => {
    let list = filter === "flagged" ? tiles.filter((t) => t.severity !== "none")
      : filter === "submitted" ? tiles.filter((t) => t.status === "Submitted")
      : tiles;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t.name.toLowerCase().includes(q) || t.roll.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  }, [tiles, filter, search]);

  const pushLog = (text: string) => setLog((l) => [{ time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), text }, ...l].slice(0, 6));
  const sendMessage = () => {
    if (!note.trim() || !selected) return;
    pushLog(`Message to ${selected.name}: “${note.trim()}”`);
    if (selected.studentId) {
      void saveViolation(
        selected.studentId.startsWith("enrolled-") ? null : selected.id,
        examIdSafe,
        selected.studentId,
        "proctor_warning",
        `Warning sent to ${selected.name}: ${note.trim()}`,
        { severity: "warning", source: "proctor" },
      );
    }
    setNote("");
  };

  const pauseCandidate = () => {
    if (!selected || !selected.studentId) return;
    const paused = selected.status !== "Paused";
    if (selected.studentId && !selected.studentId.startsWith("enrolled-")) {
      void setAttemptPaused(selected.id, paused);
    }
    if (selected.studentId) {
      void saveViolation(
        selected.studentId.startsWith("enrolled-") ? null : selected.id,
        examIdSafe,
        selected.studentId,
        paused ? "proctor_pause" : "proctor_resume",
        paused ? `Paused ${selected.name}'s session` : `Resumed ${selected.name}'s session`,
        { severity: "high", source: "proctor" },
      );
    }
    pushLog(paused ? `Paused ${selected.name}'s session` : `Resumed ${selected.name}'s session`);
  };
  const escalate = () => {
    if (!selected || !selected.studentId) return;
    if (selected.studentId) {
      void saveViolation(
        selected.studentId.startsWith("enrolled-") ? null : selected.id,
        examIdSafe,
        selected.studentId,
        "proctor_escalation",
        `Escalated ${selected.name} to teacher`,
        { severity: "critical", source: "proctor" },
      );
    }
    pushLog(`Escalated ${selected.name} to teacher`);
  };

  const forceSubmit = () => {
    if (!selected || !selected.studentId) return;
    const realId = selected.studentId.startsWith("enrolled-") ? null : selected.id;
    if (realId) void forceSubmitAttempt(realId);
    if (selected.studentId) {
      void saveViolation(
        realId,
        examIdSafe,
        selected.studentId,
        "proctor_force_submit",
        `Force submitted ${selected.name}'s exam`,
        { severity: "high", source: "proctor" },
      );
    }
    pushLog(`Force submitted ${selected.name}'s exam`);
  };

  const logViolation = (type: string, desc: string, severity?: "info" | "warning" | "high" | "critical") => {
    if (!selected || !selected.studentId) return;
    const realId = selected.studentId.startsWith("enrolled-") ? null : selected.id;
    void saveViolation(realId, examIdSafe, selected.studentId, type, desc, { severity, source: "proctor" });
    pushLog(desc);
  };

  const flagActivity = () =>
    logViolation("proctor_manual_flag", `Flagged ${selected?.name}'s activity for suspicious behavior`, "high");


  const extendTime = () => {
    if (!selected || !selected.studentId) return;
    const realId = selected.studentId.startsWith("enrolled-") ? null : selected.id;
    if (realId) void extendAttemptTime(realId, 5);
    logViolation("proctor_extend_time", `Extended ${selected.name}'s time by 5 minutes`, "info");
    pushLog(`Extended ${selected.name}'s time by 5 minutes`);
  };

  const takeScreenshot = async () => {
    if (!selected || !selected.studentId) return;
    const camEl = feedFor(selected)?.camera;
    const blob = camEl ? captureFrame(camEl, 0.85) : null;
    if (!blob) {
      pushLog(`Screenshot of ${selected.name} failed — no live feed`);
      return;
    }
    const stored = await storeViolationSnapshot({
      examId: examIdSafe,
      roll: selected.roll,
      label: `proctor_screenshot_${selected.name.replace(/\s+/g, "_")}`,
      blob,
    });
    const realId = selected.studentId.startsWith("enrolled-") ? null : selected.id;
    await saveViolation(
      realId,
      examIdSafe,
      selected.studentId,
      "proctor_screenshot",
      `Screenshot taken of ${selected.name}`,
      { severity: "info", source: "proctor", snapshotKey: stored?.key ?? null },
    );
    pushLog(stored ? `Screenshot of ${selected.name} stored in ${stored.provider.toUpperCase()}` : `Screenshot taken of ${selected.name} (storage unavailable)`);
  };

  const toReportRows = (rows: LiveAttempt[]): ReportRow[] =>
    rows.map((a) => ({
      name: a.student?.full_name ?? "Unknown",
      roll: a.student?.roll ?? "—",
      state: a.state === "submitted" ? "Submitted" : a.state === "paused" ? "Paused" : a.state === "in_progress" ? "Writing" : "Not started",
      progress: a.total ? Math.round((a.answered / a.total) * 100) : 0,
      violations: (a.violations ?? []).map((v) => ({
        description: v.description || v.violation_type,
        type: v.violation_type,
        severity: v.severity,
        offset_seconds: v.offset_seconds,
        created_at: v.created_at,
      })),
    }));

  const connLabel = !live ? "Not connected" : viewerState === "connected" ? `${cameraCount} cam · ${screenCount} screen` : "DB synced · feeds off";
  const connTone = live ? (viewerState === "connected" ? "text-success" : "text-amber") : "text-ink-soft";

  // No assigned exams yet: real empty state instead of demo candidates.
  if (!loadingExam && !examId) {
    return (
      <RoleLayout role="Proctor" name={profile?.full_name ?? "Proctor"} subtitle="Invigilator" tone={TONE} items={NAV} status="No exam assigned">
        <div className="mx-auto mt-16 max-w-xl border border-dashed border-line-strong p-10 text-center">
          <p className="font-serif text-2xl font-semibold">No exams assigned yet</p>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
            The exams you are assigned to monitor appear here, with live camera/screen feeds, violation flags, and
            speak / warn / pause / escalate tools. Ask the exam teacher to add you via{" "}
            <span className="font-mono text-[11px] text-ink">Assign Proctors</span> on their Live proctoring page — you will
            also receive an email invite.
          </p>
        </div>
      </RoleLayout>
    );
  }

  return (
    <RoleLayout role="Proctor" name={profile?.full_name ?? "Proctor"} subtitle="Invigilator" tone={TONE} items={NAV} status={live ? "Live monitoring active" : "Not connected"}>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctor console / {mainTab === "live" ? "Live monitoring" : "Dashboard & Reports"}</p>
          <div className="mt-2 flex items-center gap-4">
            <h1 className="font-serif text-3xl font-semibold">Live proctoring</h1>
            {examOptions.length > 1 && (
              <select
                value={examId ?? ""}
                onChange={(e) => { setExamId(e.target.value); setSelectedId(null); }}
                aria-label="Select assigned exam to monitor"
                className="border border-line-strong bg-paper px-3 py-1 font-serif text-lg font-semibold text-maroon hover:border-maroon focus:border-maroon focus:outline-none cursor-pointer"
              >
                {examOptions.map((ex) => (
                  <option key={ex.id} value={ex.id}>{ex.name} ({ex.batch || ex.id})</option>
                ))}
              </select>
            )}
            <div className="flex border border-line bg-paper">
              <button onClick={() => setMainTab("live")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider ${mainTab === "live" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Live Grid</button>
              <button onClick={() => setMainTab("reports")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider border-l border-line ${mainTab === "reports" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Reports & Dashboard</button>
              <button onClick={() => setMainTab("recordings")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider border-l border-line ${mainTab === "recordings" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Recordings</button>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-ink-soft">{examName || "Assigned exam"} · {examId}{examBatch ? ` · ${examBatch}` : ""}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const body = window.prompt("Broadcast message to all candidates:");
                if (body?.trim()) {
                  void sendProctorMessage({
                    examId: examIdSafe,
                    sender: profile?.full_name ?? "Proctor",
                    senderRole: "proctor",
                    body,
                    kind: "broadcast",
                  }).then((ok) => {
                    if (ok) pushLog("Broadcast sent to all candidates");
                    else pushLog("Broadcast failed — database unavailable");
                  });
                }
              }}
              className="border border-forest text-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-forest/5"
            >
              Broadcast to all
            </button>
            <span className="flex items-center gap-2 border border-alert/30 bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-alert" /> Session live</span>
          </div>
          <span className="font-mono text-[9px] text-ink-soft tracking-wider">Ping: 12ms · Proctor FPS: 24</span>
        </div>
      </div>

      {mainTab === "live" ? (
        <>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active candidates" value={String(activeCount)} sub={`of ${tiles.length} in room`} />
        <StatCard label="Clear" value={String(tiles.length - flaggedCount)} sub="no active flags" />
        <StatCard label="Needs attention" value={String(flaggedCount)} sub="flagged candidates" alert={flaggedCount > 0} />
        <StatCard label="Submitted" value={String(submittedCount)} sub="papers received" />
      </div>

      <div className="mt-8 flex flex-col justify-between gap-4 border-b border-line pb-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-1">
            {(["split", "camera", "screen"] as ViewMode[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === v ? "text-ink" : "border-transparent text-ink-soft hover:text-ink"}`} style={view === v ? { borderColor: TONE, color: TONE } : undefined}>
                {v === "split" ? "Camera + screen" : v === "camera" ? "Camera wall" : "Screen wall"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 border-l border-line pl-4">
            <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft mr-2">Grid:</span>
            {(["S", "M", "L"] as const).map(s => <button key={s} onClick={() => setSize(s)} className={`px-2 py-1 font-mono text-[10px] border ${size === s ? "border-forest bg-forest text-paper" : "border-line text-ink-soft hover:border-forest"}`}>{s}</button>)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 font-mono text-[9px] uppercase text-ink-soft"><input type="checkbox" checked={autoFocus} onChange={e => setAutoFocus(e.target.checked)} className="accent-forest"/> Auto-focus violations</label>
          <span className={`font-mono text-[10px] ${connTone}`}>● {connLabel}</span>
          <input type="text" placeholder="Search ID/Name..." value={search} onChange={e => setSearch(e.target.value)} className="border border-line-strong bg-paper px-3 py-2 font-mono text-[10px] outline-none focus:border-forest w-32" />
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="border border-line-strong bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
            <option value="all">All candidates</option>
            <option value="flagged">Flagged only</option>
            <option value="submitted">Submitted</option>
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
        <section>
          <div className={`grid gap-3 ${size === "S" ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-5" : size === "M" ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}>
            {visible.map((t) => (
              <MonitorTile key={t.id} tile={t} feed={feedFor(t)} view={view} selected={selectedId === t.id} onSelect={() => setSelectedId(t.id)} />
            ))}
          </div>
          {visible.length === 0 && (
            <div className="border border-dashed border-line-strong p-12 text-center font-mono text-[11px] text-ink-soft">
              {filter === "all" ? "Waiting for candidates to begin the exam…" : "No candidates match this filter."}
            </div>
          )}
        </section>

            <DetailPanel
              selected={selected}
              feed={selected ? feedFor(selected) : null}
              note={note}
              setNote={setNote}
              onSend={sendMessage}
              onPause={pauseCandidate}
              onEscalate={escalate}
              onForceSubmit={forceSubmit}
              onFlag={flagActivity}
              onLogViolation={() => {
                const desc = window.prompt("Violation description:", "Manual violation logged by proctor");
                if (desc) logViolation("proctor_manual_log", desc, "warning");
              }}
              onExtend={extendTime}
              onScreenshot={() => void takeScreenshot()}
              speaking={selected ? speakingTo === selected.roll : false}
              voiceBusy={voiceBusy}
              onSpeak={() => void toggleSpeak()}
              log={log}
            />
          </div>
        </>
      ) : mainTab === "reports" ? (
        <ProctorReports examId={examId ?? ""} examName={examName || examId || "Exam session"} onShowRecordings={() => setMainTab("recordings")} />
      ) : (
        <ProctorRecordings examId={examId ?? ""} tiles={tiles} />
      )}
    </RoleLayout>
  );
}

function StatCard({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className={`border bg-paper-raised p-5 ${alert ? "border-alert/40" : "border-line"}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p>
      <p className={`mt-2 font-serif text-3xl ${alert ? "text-alert" : "text-ink"}`}>{value}</p>
      <p className="mt-1 text-[12px] text-ink-soft">{sub}</p>
    </div>
  );
}

// Renders a live <video> element (from LiveKit) into a holder, or an initials
// placeholder when that feed isn't available yet.
function FeedVideo({ el, initials, label }: { el: HTMLVideoElement | null; initials: string; label: string }) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    holder.innerHTML = "";
    if (el) { el.className = "h-full w-full object-cover"; holder.appendChild(el); }
    return () => { if (holder) holder.innerHTML = ""; };
  }, [el]);
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#1F231D]">
      <div ref={holderRef} className="absolute inset-0" />
      {!el && <span className="font-serif text-2xl text-paper/30">{initials}</span>}
      {el && <span className="absolute left-1.5 top-1.5 bg-ink/75 px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-paper">● {label}</span>}
    </div>
  );
}

function MonitorTile({ tile, feed, view, selected, onSelect }: { tile: Tile; feed: RemoteFeed | null; view: ViewMode; selected: boolean; onSelect: () => void }) {
  const border = tile.severity === "high" ? "border-alert ring-1 ring-alert" : tile.severity === "low" ? "border-amber" : selected ? "ring-1" : "border-line hover:border-line-strong";
  return (
    <button onClick={onSelect} className={`overflow-hidden border text-left ${border}`} style={selected && tile.severity === "none" ? { borderColor: TONE, boxShadow: `0 0 0 1px ${TONE}` } : undefined}>
      {view === "split" ? (
        <div className="grid grid-cols-2 gap-px bg-line">
          <div className="aspect-[4/3]"><FeedVideo el={feed?.camera ?? null} initials={tile.initials} label="CAM" /></div>
          <div className="aspect-[4/3]"><FeedVideo el={feed?.screen ?? null} initials="⧉" label="SCREEN" /></div>
        </div>
      ) : (
        <div className="aspect-video"><FeedVideo el={view === "screen" ? feed?.screen ?? null : feed?.camera ?? null} initials={view === "screen" ? "⧉" : tile.initials} label={view === "screen" ? "SCREEN" : "CAM"} /></div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line px-2.5 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tile.progress > 80 ? "bg-success" : tile.progress > 40 ? "bg-amber" : "bg-alert"}`} title="Connection Status"></span>
            <p className="truncate text-[12px] font-medium">{tile.name}</p>
          </div>
          <p className="truncate font-mono text-[9px] text-ink-soft ml-3">{tile.roll} · {tile.status}{tile.status === "Writing" ? ` ${tile.progress}%` : ""}</p>
        </div>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: severityTone[tile.severity] }} title={severityLabel[tile.severity]} />
      </div>
    </button>
  );
}

function DetailPanel({ selected, feed, note, setNote, onSend, onPause, onEscalate, onForceSubmit, onFlag, onLogViolation, onExtend, onScreenshot, speaking, voiceBusy, onSpeak, log }: {
  selected: Tile | undefined; feed: RemoteFeed | null; note: string; setNote: (v: string) => void;
  onSend: () => void; onPause: () => void; onEscalate: () => void; onForceSubmit: () => void;
  onFlag: () => void; onLogViolation: () => void; onExtend: () => void; onScreenshot: () => void;
  speaking: boolean; voiceBusy: boolean; onSpeak: () => void;
  log: { time: string; text: string }[];
}) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  if (!selected) return <aside className="border border-line p-6 font-mono text-[11px] text-ink-soft">No candidate selected.</aside>;
  return (
    <aside className="space-y-4">
      <div className="border border-line bg-paper">
        <div className="border-b border-line px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Focused candidate</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="min-w-0"><h2 className="truncate font-serif text-lg font-semibold">{selected.name}</h2><p className="font-mono text-[10px] text-ink-soft">{selected.roll} · {selected.status} · {selected.progress}%</p></div>
            <span className="shrink-0 font-mono text-[10px] uppercase" style={{ color: severityTone[selected.severity] }}>{severityLabel[selected.severity]}</span>
          </div>
        </div>
        <div ref={feedRef} className="space-y-px bg-line p-px relative group">
          <div className="aspect-video bg-paper relative"><FeedVideo el={feed?.camera ?? null} initials={selected.initials} label="CAMERA" /></div>
          <div className="aspect-video bg-paper relative"><FeedVideo el={feed?.screen ?? null} initials="⧉ screen" label="SCREEN SHARE" /></div>
          <div className="absolute top-2 right-2 flex gap-2">
            <button
              onClick={() => {
                const el = feedRef.current;
                if (!el) return;
                if (document.fullscreenElement) void document.exitFullscreen();
                else void el.requestFullscreen().catch(() => undefined);
              }}
              className="bg-ink/80 text-paper px-2 py-1 font-mono text-[9px] hover:bg-ink transition-colors"
            >
              {document.fullscreenElement ? "⛶ Exit" : "⛶ Fullscreen"}
            </button>
            <button
              onClick={() => {
                const track = feed?.audioTrack;
                if (!track?.mediaStreamTrack) return;
                const next = !audioOn;
                track.mediaStreamTrack.enabled = next;
                setAudioOn(next);
              }}
              disabled={!feed?.audioTrack}
              className="bg-ink/80 text-paper px-2 py-1 font-mono text-[9px] hover:bg-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              {audioOn ? "🔊 Audio on" : "🔇 Unmute Audio"}
            </button>
          </div>
        </div>
        <div className="border-t border-line px-4 py-3 text-[12px] text-ink-soft">{selected.reason ?? "No active proctoring flags. All checks passing."}</div>
      </div>

      <div className="border border-line p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Intervention Tools</p>
        
        {/* Chat / Warning */}
        <div className="mt-3 flex gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSend(); }} placeholder="Type a warning or note…" className="min-w-0 flex-1 border border-line-strong bg-paper px-3 py-2 text-[12px] outline-none focus:border-ink" />
          <button onClick={onSend} disabled={!note.trim()} className="border border-forest bg-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft">Send</button>
          <button
            onClick={onSpeak}
            disabled={voiceBusy}
            className={`px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:opacity-50 ${
              speaking ? "border border-alert bg-alert text-paper" : "border border-forest text-forest hover:bg-forest/5"
            }`}
            title="Talk to this candidate — they hear you live"
          >
            {speaking ? "■ Stop speaking" : voiceBusy ? "Mic…" : "🎙 Speak"}
          </button>
        </div>

        {/* Action Grid */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={onFlag} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Flag Activity</button>
          <button onClick={onLogViolation} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Log Violation</button>
          <button onClick={onExtend} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Extend (+5m)</button>
          <button onClick={onScreenshot} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Screenshot</button>
        </div>

        {/* Critical Actions */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            onClick={onPause}
            disabled={selected.status === "Submitted" || selected.status === "Not started"}
            className="border border-amber py-2 font-mono text-[9px] uppercase tracking-wider text-amber hover:bg-amber/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {selected.status === "Paused" ? "Resume" : "Block / Pause"}
          </button>
          <button onClick={onEscalate} disabled={selected.status === "Submitted"} className="border border-alert py-2 font-mono text-[9px] uppercase tracking-wider text-alert hover:bg-alert/[0.06] disabled:cursor-not-allowed disabled:opacity-40">Escalate</button>
          <button
            onClick={() => { if (window.confirm(`Force submit ${selected.name}'s exam?`)) onForceSubmit(); }}
            disabled={selected.status === "Submitted" || selected.status === "Not started"}
            className="border border-alert py-2 font-mono text-[9px] uppercase tracking-wider text-paper bg-alert hover:bg-alert/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Force Submit
          </button>
        </div>
      </div>

      <div className="border border-line p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctor action log</p>
        <div className="mt-3 space-y-2">
          {log.length === 0 && <p className="font-mono text-[10px] text-ink-soft">No actions yet this session.</p>}
          {log.map((e, i) => (
            <div key={i} className="flex gap-3 border-l-2 border-line pl-3"><span className="font-mono text-[10px] text-ink-soft">{e.time}</span><p className="text-[12px]">{e.text}</p></div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function ProctorReports({ examId, examName, onShowRecordings }: { examId: string; examName: string; onShowRecordings: () => void }) {
  const [liveRows, setLiveRows] = useState<LiveAttempt[]>([]);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [expandedRoll, setExpandedRoll] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;
    let alive = true;
    void listLiveAttempts(examId)
      .then((rows) => { if (alive) setLiveRows(rows); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [examId]);

  const reportRows: ReportRow[] = useMemo(
    () =>
      liveRows.map((a) => ({
        name: a.student?.full_name ?? "Unknown",
        roll: a.student?.roll ?? "—",
        state: a.state === "submitted" ? "Submitted" : a.state === "paused" ? "Paused" : a.state === "in_progress" ? "Writing" : "Not started",
        progress: a.total ? Math.round((a.answered / a.total) * 100) : 0,
        violations: (a.violations ?? []).map((v) => ({
          description: v.description || v.violation_type,
          type: v.violation_type,
          severity: v.severity,
          offset_seconds: v.offset_seconds,
          created_at: v.created_at,
        })),
      })),
    [liveRows],
  );

  const flagged = reportRows.filter((r) => r.violations.length > 0);
  const totalFlags = flagged.reduce((t, r) => t + r.violations.length, 0);
  const submitted = reportRows.filter((r) => r.state === "Submitted").length;
  const integrity =
    reportRows.length === 0 ? 100 : Math.max(0, Math.round((1 - flagged.length / reportRows.length) * 100));

  const runExportPdf = () => {
    setExporting("pdf");
    window.setTimeout(() => {
      downloadSessionReportPdf(examName, examId, reportRows);
      setExporting(null);
    }, 50);
  };
  const runExportCsv = () => {
    setExporting("csv");
    window.setTimeout(() => {
      downloadSessionReportCsv(examId, reportRows);
      setExporting(null);
    }, 50);
  };

  const liveByRoll = useMemo(() => new Map(liveRows.map((a) => [a.student?.roll ?? "", a])), [liveRows]);

  return (
    <div className="mt-8 space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total students" value={String(reportRows.length)} sub="attempts in this session" />
        <StatCard label="Submitted" value={String(submitted)} sub="papers received" />
        <StatCard label="Flags raised" value={String(totalFlags)} sub={`Across ${flagged.length} candidate(s)`} alert={totalFlags > 0} />
        <StatCard label="Integrity Score" value={`${integrity}%`} sub="session confidence" />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-8">
          <div className="border border-line bg-paper p-6">
            <h2 className="font-serif text-xl font-semibold">High-Risk Candidates</h2>
            <p className="mt-1 text-[13px] text-ink-soft">Candidates with active violation events. Click an incident to replay the recording with red markers.</p>
            <div className="mt-4 space-y-2">
              {flagged.length === 0 && (
                <p className="border border-dashed border-line-strong p-6 text-center font-mono text-[11px] text-ink-soft">No candidates are currently flagged.</p>
              )}
              {flagged.map((r) => (
                <div key={r.roll} className="border border-line p-3 hover:border-line-strong">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{r.name} ({r.roll})</p>
                      <p className="font-mono text-[10px] text-ink-soft">
                        {r.violations.filter((v) => v.severity === "critical" || v.severity === "high").length} critical · {r.violations.length} total
                      </p>
                    </div>
                    <button onClick={() => setExpandedRoll(expandedRoll === r.roll ? null : r.roll)} className="shrink-0 border border-alert/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/10">
                      {expandedRoll === r.roll ? "Hide review" : "Review recording"}
                    </button>
                  </div>
                  {expandedRoll === r.roll && (
                    <div className="mt-4 border-t border-line pt-4">
                      <RecordingReviewer
                        examId={examId}
                        roll={r.roll}
                        name={r.name}
                        violations={liveByRoll.get(r.roll)?.violations ?? []}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border border-line bg-paper p-6">
            <h2 className="font-serif text-xl font-semibold">Violation Summary</h2>
            {flagged.length === 0 ? (
              <p className="mt-3 text-[12px] text-ink-soft">No violation events recorded for this exam.</p>
            ) : (
              <div className="mt-4 overflow-hidden border border-line">
                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-line font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                    <tr><th className="px-3 py-2">Candidate</th><th className="px-3 py-2">Violation</th><th className="px-3 py-2">Severity</th><th className="px-3 py-2">Time</th></tr>
                  </thead>
                  <tbody>
                    {flagged.map((r) =>
                      r.violations.map((v, vi) => (
                        <tr key={`${r.roll}-${vi}`} className="border-b border-line last:border-0">
                          <td className="px-3 py-2">{r.name}</td>
                          <td className="px-3 py-2 text-alert">{v.description || v.type}</td>
                          <td className="px-3 py-2 font-mono text-[10px] uppercase">{v.severity}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-ink-soft">
                            {v.offset_seconds != null ? `@ ${v.offset_seconds}s` : new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exports & Evidence</p>
            <div className="mt-4 grid gap-2">
              <button onClick={runExportPdf} className="flex w-full items-center justify-between border border-forest bg-forest px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">
                <span>{exporting === "pdf" ? "Generating…" : "Session Report (PDF)"}</span> <span>↓</span>
              </button>
              <button onClick={onShowRecordings} className="flex w-full items-center justify-between border border-line-strong px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">
                <span>Review recordings</span> <span>▶</span>
              </button>
              <button onClick={runExportCsv} className="flex w-full items-center justify-between border border-line-strong px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">
                <span>{exporting === "csv" ? "Exporting…" : "Proctor Activity Log (CSV)"}</span> <span>↓</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type RecordingRow = {
  id: string;
  name: string;
  roll: string;
  status: string;
  violations: ViolationEvent[];
};

function ProctorRecordings({ examId, tiles }: { examId: string; tiles: Tile[] }) {
  const [rows, setRows] = useState<LiveAttempt[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;
    let alive = true;
    void listLiveAttempts(examId)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setSelectedId((cur) => (cur && r.some((x) => x.id === cur) ? cur : r[0]?.id ?? null));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [examId]);

  const items: RecordingRow[] = useMemo(() => {
    if (supabaseConfigured && rows) {
      return rows.map((a) => ({
        id: a.id,
        name: a.student?.full_name ?? "Unknown",
        roll: a.student?.roll ?? "—",
        status: a.state === "submitted" ? "Submitted" : a.state === "paused" ? "Paused" : a.state === "in_progress" ? "Writing" : "Not started",
        violations: a.violations ?? [],
      }));
    }
    // No mock data: without a live roster there is nothing to archive.
    return [];
  }, [rows, tiles]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = !q ? items : items.filter((i) => i.name.toLowerCase().includes(q) || i.roll.toLowerCase().includes(q));
    return [...list].sort((a, b) => Number(b.violations.length > 0) - Number(a.violations.length > 0));
  }, [items, search]);

  const selected = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="mt-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-4">
        <div>
          <h2 className="font-serif text-xl font-semibold">Session Recordings Archive</h2>
          <p className="mt-1 text-[13px] text-ink-soft">
            Recordings and flagged snapshots stream from Cloudflare R2. Red markers on the timeline show each violation's timestamp — click to jump.
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name/ID..."
          className="w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest sm:w-64"
        />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2 border border-line bg-paper">
          {visible.length === 0 && (
            <p className="p-6 text-center font-mono text-[11px] text-ink-soft">No candidates found.</p>
          )}
          {visible.map((item) => {
            const isSelected = selected?.id === item.id;
            const flaggedCount = item.violations.length;
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`flex w-full items-center justify-between border-l-2 p-3 text-left hover:bg-paper-raised ${isSelected ? "border-forest bg-paper-raised" : "border-transparent"}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">{item.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-ink-soft">
                    {item.roll} · {item.status}
                  </p>
                </div>
                {flaggedCount > 0 && (
                  <span className="ml-2 flex items-center gap-1 rounded-full bg-alert px-2 py-0.5 font-mono text-[9px] text-paper">
                    <span className="h-1 w-1 rounded-full bg-paper" /> {flaggedCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="min-w-0 border border-line bg-paper">
          <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Currently playing</p>
              <h3 className="truncate font-serif text-lg font-semibold">
                {selected ? `${selected.name} · ${selected.roll}` : "Select a candidate"}
              </h3>
            </div>
            {selected && selected.violations.length > 0 && (
              <span className="shrink-0 border border-alert/40 bg-alert/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert">
                {selected.violations.length} violation marker(s)
              </span>
            )}
          </div>
          <div className="p-5">
            {selected ? (
              <RecordingReviewer
                key={selected.id}
                examId={examId}
                roll={selected.roll}
                name={selected.name}
                violations={selected.violations}
              />
            ) : (
              <p className="py-16 text-center font-mono text-[11px] text-ink-soft">Waiting for candidates to join the session…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


