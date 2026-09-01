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
  return { id: a.id, name, roll, initials: initialsOf(name), severity: "none", status, progress: pct, studentId: a.student?.id };
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
    const list = filter === "flagged" ? tiles.filter((t) => t.severity !== "none")
      : filter === "submitted" ? tiles.filter((t) => t.status === "Submitted")
      : tiles;
    return [...list].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  }, [tiles, filter]);

  const pushLog = (text: string) => setLog((l) => [{ time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), text }, ...l].slice(0, 6));
  const sendMessage = () => { if (!note.trim() || !selected) return; pushLog(`Message to ${selected.name}: “${note.trim()}”`); setNote(""); };
  const pauseCandidate = () => { if (selected) pushLog(`Paused ${selected.name}'s session`); };
  const escalate = () => { if (selected) pushLog(`Escalated ${selected.name} to teacher`); };

  const connLabel = !live ? "Demo mode" : viewerState === "connected" ? `${cameraCount} cam · ${screenCount} screen` : "DB synced · feeds off";
  const connTone = live ? (viewerState === "connected" ? "text-success" : "text-amber") : "text-ink-soft";

  return (
    <RoleLayout role="Proctor" name="R. Anitha Kumari" subtitle="Invigilator · Hall B" tone={TONE} items={NAV} status={live ? "Live monitoring active" : "Demo mode"}>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctor console / Live monitoring</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">Live proctoring</h1>
          <p className="mt-2 text-[13px] text-ink-soft">Data Structures &amp; Algorithms · {EXAM_ID} · Hall B · Slot 2</p>
        </div>
        <span className="flex items-center gap-2 border border-alert/30 bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-alert" /> Session live</span>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active candidates" value={String(activeCount)} sub={`of ${tiles.length} in room`} />
        <StatCard label="Clear" value={String(tiles.length - flaggedCount)} sub="no active flags" />
        <StatCard label="Needs attention" value={String(flaggedCount)} sub="flagged candidates" alert={flaggedCount > 0} />
        <StatCard label="Submitted" value={String(submittedCount)} sub="papers received" />
      </div>

      <div className="mt-8 flex flex-col justify-between gap-4 border-b border-line pb-3 sm:flex-row sm:items-center">
        <div className="flex gap-1">
          {(["split", "camera", "screen"] as ViewMode[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider ${view === v ? "text-ink" : "border-transparent text-ink-soft hover:text-ink"}`} style={view === v ? { borderColor: TONE, color: TONE } : undefined}>
              {v === "split" ? "Camera + screen" : v === "camera" ? "Camera wall" : "Screen wall"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono text-[10px] ${connTone}`}>● {connLabel}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="border border-line-strong bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
            <option value="all">All candidates</option>
            <option value="flagged">Flagged only</option>
            <option value="submitted">Submitted</option>
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
        <section>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          <p className="truncate text-[12px] font-medium">{tile.name}</p>
          <p className="truncate font-mono text-[9px] text-ink-soft">{tile.roll} · {tile.status}{tile.status === "Writing" ? ` ${tile.progress}%` : ""}</p>
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
        <div className="space-y-px bg-line p-px">
          <div className="aspect-video bg-paper"><FeedVideo el={feed?.camera ?? null} initials={selected.initials} label="CAMERA" /></div>
          <div className="aspect-video bg-paper"><FeedVideo el={feed?.screen ?? null} initials="⧉ screen" label="SCREEN SHARE" /></div>
        </div>
        <div className="border-t border-line px-4 py-3 text-[12px] text-ink-soft">{selected.reason ?? "No active proctoring flags. All checks passing."}</div>
      </div>

      <div className="border border-line p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Message candidate</p>
        <div className="mt-3 flex gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSend(); }} placeholder="Type a warning or note…" className="min-w-0 flex-1 border border-line-strong bg-paper px-3 py-2 text-[12px] outline-none focus:border-ink" />
          <button onClick={onSend} disabled={!note.trim()} className="border border-forest bg-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft">Send</button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={onPause} className="border border-amber py-2 font-mono text-[10px] uppercase tracking-wider text-amber hover:bg-amber/[0.06]">Pause session</button>
          <button onClick={onEscalate} className="border border-alert py-2 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/[0.06]">Escalate</button>
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


