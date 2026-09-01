import { useEffect, useMemo, useRef, useState } from "react";
import RoleLayout from "../components/RoleLayout";
import { supabaseConfigured } from "../lib/env";
import { listLiveAttempts, subscribeToAttempts, type LiveAttempt } from "../lib/examApi";
import { startProctorViewing, identityLabel, type RemoteFeed, type ViewerState } from "../lib/proctorViewer";

// Proctor console — a live monitoring dashboard for one exam. It mirrors the
// attempt roster from the DB (realtime) and subscribes to the LiveKit room so
// every candidate's camera AND screen share appear as soon as they begin.
// Falls back to demo candidates when no backend is configured so the prototype
// still demonstrates the full flow end-to-end.
const EXAM_ID = "EXAM-2026-014";
const ROOM = EXAM_ID; // must match the student's ProctorCamera room
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

const DEMO: Tile[] = [
  { id: "c1", name: "B. Priya Nikitha", roll: "21VGN0142", severity: "none", initials: "PN", status: "Writing", progress: 68 },
  { id: "c2", name: "K. Rohan Teja", roll: "21VGN0158", severity: "high", reason: "Second face detected in frame", time: "2m ago", initials: "RT", status: "Writing", progress: 92 },
  { id: "c3", name: "M. Sai Charan", roll: "21VGN0163", severity: "none", initials: "SC", status: "Submitted", progress: 100 },
  { id: "c4", name: "A. Deepika Reddy", roll: "21VGN0171", severity: "low", reason: "Gaze away from screen (8s)", time: "40s ago", initials: "DR", status: "Writing", progress: 35 },
  { id: "c5", name: "S. Vamsi Krishna", roll: "21VGN0184", severity: "none", initials: "VK", status: "Writing", progress: 51 },
  { id: "c6", name: "N. Harika Sree", roll: "21VGN0191", severity: "low", reason: "Tab-switch attempt blocked", time: "1m ago", initials: "HS", status: "Writing", progress: 47 },
  { id: "c7", name: "T. Yashwanth", roll: "21VGN0203", severity: "none", initials: "TY", status: "Writing", progress: 60 },
  { id: "c8", name: "P. Meghana", roll: "21VGN0217", severity: "high", reason: "Prohibited software: AnyDesk", time: "just now", initials: "PM", status: "Paused", progress: 54 },
];

function initialsOf(name: string): string {
  return name.split(" ").map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function attemptToTile(a: LiveAttempt): Tile {
  const name = a.student?.full_name ?? "Unknown candidate";
  const roll = a.student?.roll ?? "—";
  const pct = a.total ? Math.round((a.answered / a.total) * 100) : 0;
  const status = a.state === "submitted" ? "Submitted" : a.state === "in_progress" ? "Writing" : "Not started";
  
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
  const [tiles, setTiles] = useState<Tile[]>(DEMO);
  const [live, setLive] = useState(false);
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);
  const [viewerState, setViewerState] = useState<ViewerState | "off">("off");
  const [selectedId, setSelectedId] = useState<string>(DEMO[1].id);
  const [view, setView] = useState<ViewMode>("split");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [autoFocus, setAutoFocus] = useState(true);
  const [size, setSize] = useState<"S"|"M"|"L">("M");
  const [mainTab, setMainTab] = useState<"live"|"reports"|"recordings">("live");
  const [note, setNote] = useState("");
  const [log, setLog] = useState<{ time: string; text: string }[]>([]);

  // DB roster (live attempts) — realtime refresh on any attempt change.
  useEffect(() => {
    if (!supabaseConfigured) return;
    let active = true;
    const load = async () => {
      const rows = await listLiveAttempts(EXAM_ID);
      if (!active) return;
      setLive(true);
      const mapped = rows.map(attemptToTile);
      setTiles(mapped);
      setSelectedId((cur) => (mapped.some((t) => t.id === cur) ? cur : mapped[0]?.id ?? cur));
    };
    void load();
    const unsub = subscribeToAttempts(EXAM_ID, () => void load());
    return () => { active = false; unsub(); };
  }, []);

  // Live camera + screen viewer — subscribe to the room and collect remote feeds.
  useEffect(() => {
    let handle: Awaited<ReturnType<typeof startProctorViewing>> | null = null;
    let cancelled = false;
    (async () => {
      handle = await startProctorViewing({ room: ROOM, onState: setViewerState, onFeeds: setFeeds });
      if (cancelled) { handle?.stop(); return; }
      if (handle) setViewerState((s) => (s === "off" ? "connecting" : s));
    })();
    return () => { cancelled = true; handle?.stop(); };
  }, []);

  // Map a tile → its live feed (matched by student uuid embedded in identity).
  const feedFor: FeedLookup = useMemo(() => {
    const byId = new Map<string, RemoteFeed>();
    for (const f of feeds) byId.set(identityLabel(f.identity), f);
    return (t: Tile) => (t.studentId ? byId.get(t.studentId) ?? null : null);
  }, [feeds]);

  const selected = tiles.find((t) => t.id === selectedId) ?? tiles[0];
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
  const sendMessage = () => { if (!note.trim() || !selected) return; pushLog(`Message to ${selected.name}: “${note.trim()}”`); setNote(""); };

  const exportPDF = async () => {
    try {
      const { data: { session } } = await (await import("../lib/supabase")).getSupabase()!.auth.getSession();
      const res = await fetch(`https://xdwhftrierzxsppindfj.supabase.co/functions/v1/generate-pdf-report?exam_id=${EXAM_ID}`, {
        headers: { Authorization: `Bearer ${session?.access_token}` }
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Session_Report_${EXAM_ID}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to export PDF: " + e);
    }
  };

  const exportCSV = async () => {
    try {
      const { data: { session } } = await (await import("../lib/supabase")).getSupabase()!.auth.getSession();
      const res = await fetch(`https://xdwhftrierzxsppindfj.supabase.co/functions/v1/export-csv-log?exam_id=${EXAM_ID}`, {
        headers: { Authorization: `Bearer ${session?.access_token}` }
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `proctor_log_${EXAM_ID}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to export CSV: " + e);
    }
  };

  const pauseCandidate = () => { if (selected) pushLog(`Paused ${selected.name}'s session`); };
  const escalate = () => { if (selected) pushLog(`Escalated ${selected.name} to teacher`); };

  const connLabel = !live ? "Demo mode" : viewerState === "connected" ? `${cameraCount} cam · ${screenCount} screen` : "DB synced · feeds off";
  const connTone = live ? (viewerState === "connected" ? "text-success" : "text-amber") : "text-ink-soft";

  return (
    <RoleLayout role="Proctor" name="R. Anitha Kumari" subtitle="Invigilator · Hall B" tone={TONE} items={NAV} status={live ? "Live monitoring active" : "Demo mode"}>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctor console / {mainTab === "live" ? "Live monitoring" : "Dashboard & Reports"}</p>
          <div className="mt-2 flex items-center gap-4">
            <h1 className="font-serif text-3xl font-semibold">Live proctoring</h1>
            <div className="flex border border-line bg-paper">
              <button onClick={() => setMainTab("live")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider ${mainTab === "live" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Live Grid</button>
              <button onClick={() => setMainTab("reports")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider border-l border-line ${mainTab === "reports" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Reports & Dashboard</button>
              <button onClick={() => setMainTab("recordings")} className={`px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider border-l border-line ${mainTab === "recordings" ? "bg-forest text-paper" : "text-ink-soft hover:bg-paper-raised"}`}>Recordings</button>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-ink-soft">Data Structures &amp; Algorithms · {EXAM_ID} · Hall B · Slot 2</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => alert("Broadcast message modal opened")} className="border border-forest text-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-forest/5">Broadcast to all</button>
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

            <DetailPanel selected={selected} feed={selected ? feedFor(selected) : null} note={note} setNote={setNote} onSend={sendMessage} onPause={pauseCandidate} onEscalate={escalate} log={log} />
          </div>
        </>
      ) : mainTab === "reports" ? (
        <ProctorReports />
      ) : (
        <ProctorRecordings />
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

function DetailPanel({ selected, feed, note, setNote, onSend, onPause, onEscalate, log }: { selected: Tile | undefined; feed: RemoteFeed | null; note: string; setNote: (v: string) => void; onSend: () => void; onPause: () => void; onEscalate: () => void; log: { time: string; text: string }[] }) {
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
        <div className="space-y-px bg-line p-px relative group">
          <div className="aspect-video bg-paper relative"><FeedVideo el={feed?.camera ?? null} initials={selected.initials} label="CAMERA" /></div>
          <div className="aspect-video bg-paper relative"><FeedVideo el={feed?.screen ?? null} initials="⧉ screen" label="SCREEN SHARE" /></div>
          <div className="absolute top-2 right-2 flex gap-2">
            <button onClick={() => alert("Full screen mode activated")} className="bg-ink/80 text-paper px-2 py-1 font-mono text-[9px] hover:bg-ink transition-colors">⛶ Fullscreen</button>
            <button onClick={() => alert("Audio toggled")} className="bg-ink/80 text-paper px-2 py-1 font-mono text-[9px] hover:bg-ink transition-colors">🔇 Unmute Audio</button>
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
          <button onClick={() => alert("Verbal warning activated (mic live)")} className="border border-forest text-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-forest/5" title="Verbal Warning (Audio)">🎤</button>
        </div>

        {/* Action Grid */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={() => alert("Flagged for suspicious activity")} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Flag Activity</button>
          <button onClick={() => alert("Manual violation logged")} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Log Violation</button>
          <button onClick={() => alert("Extended time by 5 minutes")} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Extend (+5m)</button>
          <button onClick={() => alert("Screenshot taken")} className="border border-line-strong py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Screenshot</button>
        </div>

        {/* Critical Actions */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button onClick={onPause} className="border border-amber py-2 font-mono text-[9px] uppercase tracking-wider text-amber hover:bg-amber/[0.06]">Block / Pause</button>
          <button onClick={onEscalate} className="border border-alert py-2 font-mono text-[9px] uppercase tracking-wider text-alert hover:bg-alert/[0.06]">Escalate</button>
          <button onClick={() => alert("Force submitted exam")} className="border border-alert py-2 font-mono text-[9px] uppercase tracking-wider text-paper bg-alert hover:bg-alert/90">Force Submit</button>
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

function ProctorReports() {
  return (
    <div className="mt-8 space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total students" value="124" sub="Enrolled in session" />
        <StatCard label="Flags raised" value="18" sub="Across 12 candidates" />
        <StatCard label="Session duration" value="02:15:00" sub="Started 09:00 AM" />
        <StatCard label="Integrity Score" value="94%" sub="Session confidence" />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-8">
          <div className="border border-line bg-paper p-6">
            <h2 className="font-serif text-xl font-semibold">High-Risk Candidates</h2>
            <p className="mt-1 text-[13px] text-ink-soft">Candidates with multiple critical violations.</p>
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between border border-line p-3 hover:border-line-strong">
                <div>
                  <p className="text-[13px] font-medium">K. Rohan Teja (21VGN0158)</p>
                  <p className="font-mono text-[10px] text-ink-soft">3 critical flags · 2 warnings</p>
                </div>
                <button onClick={() => alert("Opened incident report")} className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">Incident Report</button>
              </div>
              <div className="flex items-center justify-between border border-line p-3 hover:border-line-strong">
                <div>
                  <p className="text-[13px] font-medium">P. Meghana (21VGN0217)</p>
                  <p className="font-mono text-[10px] text-ink-soft">1 critical flag · 4 warnings</p>
                </div>
                <button onClick={() => alert("Opened incident report")} className="border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">Incident Report</button>
              </div>
            </div>
          </div>

          <div className="border border-line bg-paper p-6">
            <h2 className="font-serif text-xl font-semibold">Violation Summary</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div className="border border-line-strong p-4"><p className="font-mono text-[10px] text-ink-soft">Second Face</p><p className="mt-1 text-xl font-semibold">4</p></div>
              <div className="border border-line-strong p-4"><p className="font-mono text-[10px] text-ink-soft">Tab Switch</p><p className="mt-1 text-xl font-semibold">12</p></div>
              <div className="border border-line-strong p-4"><p className="font-mono text-[10px] text-ink-soft">Audio anomaly</p><p className="mt-1 text-xl font-semibold">2</p></div>
            </div>
            
            <h3 className="mt-6 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Performance Anomalies</h3>
            <p className="mt-2 text-[13px] text-ink-soft border-l-2 border-amber pl-3">System detected unusual answering speed from 2 candidates compared to their historical baseline.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exports & Evidence</p>
            <div className="mt-4 grid gap-2">
              <button onClick={exportPDF} className="flex w-full items-center justify-between border border-forest bg-forest px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">
                <span>Session Report (PDF)</span> <span>↓</span>
              </button>
              <button onClick={() => alert("Downloading evidence clips...")} className="flex w-full items-center justify-between border border-line-strong px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">
                <span>Export Evidence (Video)</span> <span>↓</span>
              </button>
              <button onClick={exportCSV} className="flex w-full items-center justify-between border border-line-strong px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised">
                <span>Proctor Activity Log (CSV)</span> <span>↓</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProctorRecordings() {
  const [selectedVideo, setSelectedVideo] = useState<string | null>("K. Rohan Teja (21VGN0158)");
  return (
    <div className="mt-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-4">
        <div>
          <h2 className="font-serif text-xl font-semibold">Session Recordings Archive</h2>
          <p className="mt-1 text-[13px] text-ink-soft">Retention policy: Auto-delete after 30 days. <button className="text-forest hover:underline">Change policy</button></p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">System Load</p>
          <p className="mt-1 text-[13px] text-ink-soft">1 / 5 concurrent streams active</p>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[280px_1fr]">
        <div className="space-y-4">
          <input type="text" placeholder="Search by name/ID..." className="w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
          <div className="space-y-2 border border-line bg-paper">
            {["K. Rohan Teja (21VGN0158)", "P. Meghana (21VGN0217)", "A. Deepika Reddy (21VGN0171)"].map((student) => (
              <button 
                key={student} 
                onClick={() => setSelectedVideo(student)}
                className={`flex w-full items-center justify-between border-l-2 p-3 text-left hover:bg-paper-raised ${selectedVideo === student ? "border-forest bg-paper-raised" : "border-transparent"}`}
              >
                <div>
                  <p className="text-[13px] font-medium text-ink">{student}</p>
                  <p className="font-mono text-[10px] text-ink-soft">02:15:40 · 1.2GB</p>
                </div>
                {student.includes("Rohan") && <span className="h-1.5 w-1.5 rounded-full bg-alert"></span>}
              </button>
            ))}
          </div>
        </div>

        <div className="border border-line bg-paper">
          <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Currently playing</p>
              <h3 className="font-serif text-lg font-semibold">{selectedVideo}</h3>
            </div>
            <div className="flex gap-2">
              <button className="border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:border-forest hover:text-forest">📸 Screenshot</button>
              <button className="border border-forest bg-forest px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">↓ Export MP4</button>
            </div>
          </div>
          
          <div className="relative flex aspect-video flex-col justify-between bg-[#1F231D] p-4">
            <div className="absolute inset-0 grid grid-cols-2 gap-px bg-black">
              <div className="flex items-center justify-center bg-[#2a2e28] font-serif text-2xl text-paper/30">CAMERA</div>
              <div className="flex items-center justify-center bg-[#2a2e28] font-serif text-2xl text-paper/30">SCREEN SHARE</div>
            </div>

            <div className="absolute right-4 top-4 rounded bg-ink/80 px-2 py-1 font-mono text-[10px] text-paper">REC 00:45:12</div>

            <div className="absolute bottom-4 left-4 right-4 bg-ink/90 p-3 text-paper">
              <div className="relative mb-3 h-2 w-full cursor-pointer bg-paper/20">
                <div className="absolute left-0 top-0 h-full w-1/3 bg-forest"></div>
                <div className="absolute left-[20%] top-0 h-full w-1 bg-alert" title="Tab switch attempt"></div>
                <div className="absolute left-[30%] top-0 h-full w-1 bg-alert" title="Second face detected"></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <button className="hover:text-forest">▶ Play</button>
                  <span className="font-mono text-[10px]">00:45:12 / 02:15:40</span>
                  <button className="font-mono text-[10px] hover:text-forest">🔊 Audio on</button>
                </div>
                <div className="flex items-center gap-4">
                  <select className="bg-transparent font-mono text-[10px] outline-none hover:text-forest">
                    <option className="text-ink">1x Speed</option>
                    <option className="text-ink">1.5x Speed</option>
                    <option className="text-ink">2x Speed</option>
                  </select>
                  <select className="bg-transparent font-mono text-[10px] outline-none hover:text-forest">
                    <option className="text-ink">1080p</option>
                    <option className="text-ink">720p</option>
                    <option className="text-ink">480p (Data Saver)</option>
                  </select>
                  <button className="font-mono text-[10px] hover:text-forest">⛶ Fullscreen</button>
                </div>
              </div>
            </div>
          </div>
          
          <div className="p-5">
            <h4 className="mb-3 font-serif text-base font-semibold">Violation Log</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between border-l-2 border-alert bg-alert/5 p-3">
                <div>
                  <p className="text-[13px] font-medium">Second face detected</p>
                  <p className="font-mono text-[10px] text-ink-soft">Confidence: 94%</p>
                </div>
                <button className="border border-alert/30 px-3 py-1 font-mono text-[10px] text-alert hover:bg-alert/10">Jump to 00:30:15</button>
              </div>
              <div className="flex items-center justify-between border-l-2 border-alert bg-alert/5 p-3">
                <div>
                  <p className="text-[13px] font-medium">Tab switch attempt</p>
                  <p className="font-mono text-[10px] text-ink-soft">Focus lost for 12 seconds</p>
                </div>
                <button className="border border-alert/30 px-3 py-1 font-mono text-[10px] text-alert hover:bg-alert/10">Jump to 00:20:00</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


