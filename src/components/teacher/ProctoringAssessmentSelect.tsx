// Proctoring assessment selector — the entry screen before the live command
// center. Lists every exam with REAL per-exam stats (candidates, active,
// flagged) aggregated from Supabase in two queries. Faculty tick the
// assessments they want to proctor, then enter the live room.

import { useEffect, useMemo, useState } from "react";
import { FiVideo, FiUsers, FiActivity, FiAlertTriangle, FiCheckCircle, FiClock, FiSearch } from "react-icons/fi";
import { listExams, listProctoringStats } from "../../lib/examApi";
import { Button, Badge, EmptyState } from "../ui";

type ExamRow = {
  id: string;
  name: string;
  batch: string | null;
  status: string;
  scheduled_at: string | null;
  stats: { candidates: number; active: number; submitted: number; paused: number; flagged: number };
};

export default function ProctoringAssessmentSelect({
  onStart,
}: {
  onStart: (examId: string) => void;
}) {
  const [rows, setRows] = useState<ExamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("All");

  useEffect(() => {
    let active = true;
    void (async () => {
      const [exams, stats] = await Promise.all([listExams(), listProctoringStats()]);
      if (!active) return;
      const list = (exams ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        batch: e.batch ?? null,
        status: e.status,
        scheduled_at: e.scheduled_at ?? null,
        stats: stats[e.id] ?? { candidates: 0, active: 0, submitted: 0, paused: 0, flagged: 0 },
      }));
      setRows(list);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesTerm = !term || `${r.name} ${r.batch ?? ""} ${r.id}`.toLowerCase().includes(term);
      const matchesStatus = statusFilter === "All" || r.status === statusFilter;
      return matchesTerm && matchesStatus;
    });
  }, [rows, search, statusFilter]);

  const statuses = useMemo(() => ["All", ...Array.from(new Set(rows.map((r) => r.status)))], [rows]);
  const totals = useMemo(() => rows.reduce(
    (acc, r) => ({ candidates: acc.candidates + r.stats.candidates, active: acc.active + r.stats.active, flagged: acc.flagged + r.stats.flagged, submitted: acc.submitted + r.stats.submitted }),
    { candidates: 0, active: 0, flagged: 0, submitted: 0 },
  ), [rows]);

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col justify-between gap-5 border-b border-line pb-6 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Proctoring</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">Proctoring centre</h1>
          <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">
            Select the assessments you want to proctor, then open the live command centre — video wall, voice warnings,
            pause / escalate / force-submit and violation logs, all in one room.
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          icon={<FiVideo />}
          disabled={selected.size === 0}
          title={selected.size === 0 ? "Tick at least one assessment to begin" : undefined}
          onClick={() => { const first = rows.find((r) => selected.has(r.id)); if (first) onStart(first.id); }}
        >
          Start live monitoring
        </Button>
      </div>

      {/* Totals */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={<FiUsers />} label="Total candidates" value={totals.candidates} detail="Across all assessments" />
        <SummaryCard icon={<FiActivity />} label="Active right now" value={totals.active} detail="In-progress + not started" tone="text-forest" />
        <SummaryCard icon={<FiAlertTriangle />} label="Flagged" value={totals.flagged} detail="Violation events logged" tone={totals.flagged > 0 ? "text-alert" : "text-ink"} />
        <SummaryCard icon={<FiCheckCircle />} label="Submitted" value={totals.submitted} detail="Papers closed" tone="text-success" />
      </div>

      {/* Search + filter */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border border-line bg-paper-raised p-3">
        <div className="relative min-w-[240px] flex-1">
          <FiSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assessment, batch or exam ID…"
            className="w-full border border-line-strong bg-paper py-2.5 pl-9 pr-3 text-[13px] outline-none focus:border-forest"
          />
        </div>
        <div className="flex gap-1 border border-line bg-paper p-1">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                statusFilter === s ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Assessment list */}
      {loading ? (
        <div className="mt-6 border border-line bg-paper p-14 text-center font-mono text-[11px] uppercase tracking-widest text-ink-soft">Loading assessments…</div>
      ) : visible.length === 0 ? (
        <div className="mt-6 border border-line bg-paper">
          <EmptyState
            title={rows.length === 0 ? "No assessments to proctor" : "No assessments match"}
            detail={rows.length === 0
              ? "Create and publish a test first — it will appear here with its live candidate stats."
              : "Change the search or status filter to see more tests."}
          />
        </div>
      ) : (
        <div className="mt-6 divide-y divide-line border border-line bg-paper">
          {visible.map((r) => {
            const checked = selected.has(r.id);
            const hasFlags = r.stats.flagged > 0;
            return (
              <div
                key={r.id}
                className={`flex flex-wrap items-center gap-4 px-5 py-4 transition-colors ${checked ? "bg-forest/[0.04]" : "hover:bg-paper-raised/60"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(r.id)}
                  aria-label={`Select ${r.name}`}
                  className="h-4 w-4 shrink-0 cursor-pointer accent-forest"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-serif text-[15px] font-medium">{r.name}</p>
                    <Badge tone={r.status === "draft" ? "amber" : r.status === "scheduled" ? "blue" : "green"}>{r.status}</Badge>
                    {hasFlags && <Badge tone="red"><FiAlertTriangle /> flagged</Badge>}
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-ink-soft">{r.id} · {r.batch ?? "No batch"} {r.scheduled_at ? `· ${new Date(r.scheduled_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</p>
                </div>
                <div className="flex shrink-0 items-center gap-5">
                  <MiniStat icon={<FiUsers />} value={r.stats.candidates} label="Candidates" />
                  <MiniStat icon={<FiActivity />} value={r.stats.active} label="Active" tone="text-forest" />
                  <MiniStat icon={<FiClock />} value={r.stats.submitted + r.stats.paused} label="Closed" tone="text-ink-soft" />
                  <MiniStat icon={<FiAlertTriangle />} value={r.stats.flagged} label="Flagged" tone={hasFlags ? "text-alert" : "text-ink-soft"} />
                </div>
                <Button
                  size="sm"
                  variant={checked ? "primary" : "secondary"}
                  icon={<FiVideo />}
                  onClick={() => onStart(r.id)}
                >
                  Monitor
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-[11px] text-ink-soft">
        Statistics refresh live from Supabase — the command centre for a selected assessment stays open while you work.
      </p>
    </div>
  );
}

function SummaryCard({ icon, label, value, detail, tone = "text-ink" }: { icon: React.ReactNode; label: string; value: number; detail: string; tone?: string }) {
  return (
    <div className="border border-line bg-paper-raised p-5">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
        <span className="text-forest">{icon}</span>{label}
      </div>
      <p className={`mt-2 font-serif text-3xl ${tone}`}>{value}</p>
      <p className="mt-1 text-[12px] text-ink-soft">{detail}</p>
    </div>
  );
}

function MiniStat({ icon, value, label, tone = "text-ink" }: { icon: React.ReactNode; value: number; label: string; tone?: string }) {
  return (
    <div className="text-center">
      <p className={`flex items-center justify-center gap-1 font-serif text-xl ${tone}`}><span className="text-[13px] text-ink-soft">{icon}</span>{value}</p>
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
    </div>
  );
}