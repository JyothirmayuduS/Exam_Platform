// Examiner Dashboard — mirrors the Mettl "Test Administrator Dashboard"
// pattern: metric cards (Total tests / test takers / evaluators), a daily
// progress chart, Test / Evaluator / Due-date tabs, and the allocation table
// with the "Auto-assign Test Reports" flow (role → evaluators → due date →
// per-evaluator distribution confirmation → real grading_delegations rows).
// Everything is read from Supabase; nothing is hard-coded demo data.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiFileText, FiFolder, FiUsers, FiSettings, FiCalendar, FiX, FiCheck, FiPlus, FiArrowLeft, FiArrowRight } from "react-icons/fi";
import {
  loadExaminerDashboard,
  assignEvaluators,
  listFaculty,
  type ExaminerExamRow,
  type FacultyMember,
} from "../lib/examApi";
import { sendEvaluatorAssignmentEmail } from "../lib/emailApi";
import { PageHeading, Button } from "./TeacherDashboard";

type Row = Awaited<ReturnType<typeof loadExaminerDashboard>>;
type DailyBucket = Row["daily"][number];

const allocBadge = (r: ExaminerExamRow) => {
  const a = r.allocation;
  const allocated = a?.status === "allocated";
  return {
    allocated,
    label: allocated ? `Allocated · ${a?.evaluators?.length ?? 0}` : "Not Allocated",
    role: a?.role ?? "Evaluator",
    due: a?.due_date ?? null,
    assigned: a?.assigned ?? 0,
    total: a?.total ?? r.submitted,
    evaluators: a?.evaluators ?? [],
  };
};

export default function ExaminerDashboard({
  notify,
  navigate,
}: {
  notify: (message: string) => void;
  navigate: (path: string) => void;
}) {
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState("All programs");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [tab, setTab] = useState<"tests" | "evaluators" | "due">("tests");
  const [faculty, setFaculty] = useState<FacultyMember[]>([]);
  const [assignExam, setAssignExam] = useState<ExaminerExamRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [dash, people] = await Promise.all([loadExaminerDashboard(), listFaculty()]);
    setData(dash);
    setFaculty(people);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exams = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.exams ?? []).filter((e) => {
      const matchesTerm = !term || `${e.name} ${e.id}`.toLowerCase().includes(term);
      const matchesBatch = batchFilter === "All programs" || e.batch === batchFilter;
      const matchesStatus = statusFilter === "All statuses" || e.status === statusFilter;
      return matchesTerm && matchesBatch && matchesStatus;
    });
  }, [data, search, batchFilter, statusFilter]);

  const batches = useMemo(
    () => Array.from(new Set((data?.exams ?? []).map((e) => e.batch))),
    [data],
  );

  const maxDaily = useMemo(
    () => Math.max(1, ...(data?.daily ?? []).map((d) => d.submitted)),
    [data],
  );

  const evaluatorRows = useMemo(() => {
    const map = new Map<string, { name: string; email: string; exams: Set<string>; reports: number; due: string | null }>();
    for (const e of data?.exams ?? []) {
      const { evaluators, due } = allocBadge(e);
      for (const ev of evaluators) {
        const key = ev.email ?? ev.id;
        let row = map.get(key);
        if (!row) {
          row = { name: ev.name, email: ev.email ?? "", exams: new Set<string>(), reports: 0, due: null };
          map.set(key, row);
        }
        row.exams.add(e.name);
        row.reports += ev.count;
        if (due) {
          const d = new Date(due);
          if (!row.due || d < new Date(row.due)) row.due = due;
        }
      }
    }
    return Array.from(map.values()).map((r) => ({
      name: r.name,
      email: r.email,
      exams: r.exams.size,
      reports: r.reports,
      due: r.due,
    }));
  }, [data]);

  const dueRows = useMemo(() => {
    return (data?.exams ?? [])
      .filter((e) => e.allocation?.due_date)
      .map((e) => {
        const due = new Date(e.allocation!.due_date as string);
        const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
        return {
          exam: e.name,
          id: e.id,
          due,
          reports: e.allocation?.assigned ?? 0,
          status: days < 0 ? "Overdue" : days === 0 ? "Due today" : "Upcoming",
          days,
        };
      })
      .sort((a, b) => a.due.getTime() - b.due.getTime());
  }, [data]);

  return (
    <div>
      <div className="flex flex-col justify-between gap-4 border-b border-line pb-6 md:flex-row md:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Examiner / Test Administrator Dashboard</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">Examiner dashboard</h1>
          <p className="mt-2 text-[13px] text-ink-soft">Test allocation and evaluation at a glance — assign submitted reports to evaluators, set due dates, and track grading.</p>
        </div>
        <Button primary onClick={() => navigate("/teacher/exams/new")}>+ Create new test</Button>
      </div>

      {/* Metric cards (TOTAL TESTS / TEST TAKERS / EVALUATORS) */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <DashMetric label="Total tests" value={String(data?.exams.length ?? 0)} detail="Across all programs" onClick={() => { setTab("tests"); setStatusFilter("All statuses"); }} />
        <DashMetric label="Total test takers" value={String(data?.totalTestTakers ?? 0)} detail="Enrolled candidates" onClick={() => navigate("/teacher/students")} />
        <DashMetric label="Total evaluators" value={String(data?.totalEvaluators ?? 0)} detail="Assignees with reports" onClick={() => setTab("evaluators")} />
        <DashMetric label="Reports allocated" value={String((data?.exams ?? []).reduce((s, e) => s + (e.allocation?.assigned ?? 0), 0))} detail="Across all exams" onClick={() => setTab("due")} />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]">
        {/* Progress chart */}
        <section className="border border-line bg-paper p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Progress chart</p>
              <h2 className="mt-1 font-serif text-lg font-semibold">Submissions — last 14 days</h2>
            </div>
            <div className="flex items-center gap-4 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-forest" /> Graded</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-amber" /> Not graded</span>
            </div>
          </div>
          {loading ? (
            <div className="flex h-40 items-center justify-center text-[12px] text-ink-soft">Loading…</div>
          ) : (data?.daily ?? []).every((d) => d.submitted === 0) ? (
            <div className="flex h-40 flex-col items-center justify-center text-center">
              <p className="font-serif text-lg">No submissions yet</p>
              <p className="mt-1 text-[12px] text-ink-soft">Published exams will appear here as candidates submit.</p>
            </div>
          ) : (
            <div className="mt-6 flex h-40 items-end gap-2">
              {(data?.daily ?? []).map((d: DailyBucket, i: number) => {
                const h = Math.max(2, Math.round((d.submitted / maxDaily) * 130));
                const gradedH = d.submitted ? Math.max(0, Math.round((d.graded / d.submitted) * h)) : 0;
                return (
                  <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" title={`${d.label}: ${d.submitted} submitted, ${d.graded} graded`}>
                    <div className="flex w-full flex-col-reverse justify-end overflow-hidden border border-line/40 bg-line/40" style={{ height: 140 }}>
                      <div className="w-full bg-amber/70" style={{ height: h - gradedH }} />
                      <div className="w-full bg-forest" style={{ height: gradedH }} />
                    </div>
                    {i % 2 === 0 ? <span className="font-mono text-[8px] text-ink-soft">{d.label}</span> : <span className="h-[10px]" />}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Quick allocation list */}
        <section className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Allocation queue</p>
          <h2 className="mt-1 font-serif text-lg font-semibold">Awaiting evaluators</h2>
          <div className="mt-4 space-y-3">
            {(data?.exams ?? []).filter((e) => e.unassigned > 0).length === 0 && (
              <p className="border border-dashed border-line-strong p-6 text-center text-[12px] text-ink-soft">Nothing pending — submitted reports are all allocated or auto-graded.</p>
            )}
            {(data?.exams ?? [])
              .filter((e) => e.unassigned > 0)
              .slice(0, 5)
              .map((e) => (
                <div key={e.id} className="border border-line bg-paper-raised p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{e.name}</p>
                      <p className="mt-0.5 font-mono text-[9px] text-ink-soft">{e.batch} · {e.unassigned} unassigned</p>
                    </div>
                    <button onClick={() => { setAssignExam(e); }} className="shrink-0 border border-forest px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wider text-forest hover:bg-forest hover:text-paper">
                      Auto-assign
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      </div>

      {/* Search + filters */}
      <div className="mt-8 flex flex-wrap items-end gap-3 border border-line bg-paper-raised p-4">
        <label className="min-w-[220px] flex-1 text-[11px] text-ink-soft">
          Search by Test Name / ID
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. D24MC001 or Probability and Statistics" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest" />
        </label>
        <label className="text-[11px] text-ink-soft">
          Program
          <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)} className="mt-1 block border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none">
            <option>All programs</option>
            {batches.map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-ink-soft">
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="mt-1 block border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none">
            <option>All statuses</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
          </select>
        </label>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div className="flex gap-6">
          {([
            ["tests", "Test Information", exams.length],
            ["evaluators", "Evaluator Information", evaluatorRows.length],
            ["due", "Due Date Information", dueRows.length],
          ] as const).map(([key, label, count]) => (
            <button key={key} onClick={() => setTab(key)} className={`border-b-2 px-1 pb-3 font-mono text-[11px] uppercase tracking-wider ${tab === key ? "border-forest text-forest" : "border-transparent text-ink-soft hover:text-ink"}`}>
              {label} <span className="ml-1 rounded-full bg-paper-raised px-1.5 py-0.5 text-[9px]">{count}</span>
            </button>
          ))}
        </div>
        <Button onClick={() => void load()}>Reload data</Button>
      </div>

      {/* Test Information table */}
      {tab === "tests" && (
        <div className="mt-6 overflow-x-auto border border-line bg-paper">
          <table className="w-full min-w-[980px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper-raised font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-3">Test name</th>
                <th className="px-4 py-3">Allocation</th>
                <th className="px-4 py-3">Evaluators</th>
                <th className="px-4 py-3">Test taker</th>
                <th className="px-4 py-3">Unassigned</th>
                <th className="px-4 py-3">Assigned</th>
                <th className="px-4 py-3">Cancelled</th>
                <th className="px-4 py-3">Auto-graded</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="p-10 text-center text-[12px] text-ink-soft">Loading…</td></tr>
              ) : exams.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center">
                  <p className="font-serif text-lg">No tests match</p>
                  <p className="mt-1 text-[12px] text-ink-soft">Create a test to see it here.</p>
                </td></tr>
              ) : exams.map((e) => {
                const badge = allocBadge(e);
                const cancels = 0; // cancelled state not yet in the attempt lifecycle
                return (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-paper-raised">
                    <td className="px-4 py-4">
                      <p className="font-medium leading-snug">{e.name}</p>
                      <p className="mt-1 font-mono text-[9px] text-ink-soft">{e.id} · {e.pool_count} questions · {e.duration_minutes} min · {e.status}</p>
                    </td>
                    <td className="px-4 py-4">
                      {badge.allocated ? (
                        <span className="inline-flex items-center gap-1 border border-forest/40 bg-success/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-forest">
                          <span className="h-1 w-1 rounded-full bg-forest" /> {badge.label}
                        </span>
                      ) : (
                        <span className="border border-forest/50 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-forest">Not Allocated</span>
                      )}
                      <button onClick={() => setAssignExam(e)} className="mt-1.5 block font-mono text-[9px] uppercase tracking-wider text-ink-soft underline-offset-2 hover:text-forest hover:underline">
                        ↻ Auto-assign Test Reports
                      </button>
                    </td>
                    <td className="px-4 py-4">{e.delegates || (badge.allocated ? badge.evaluators.length : 0)}</td>
                    <td className="px-4 py-4">{e.roster_count}</td>
                    <td className="px-4 py-4">
                      {e.unassigned > 0 ? <span className="font-mono text-[12px] text-amber">{e.unassigned}</span> : <span className="font-mono text-[12px] text-ink-soft">0</span>}
                    </td>
                    <td className="px-4 py-4">{badge.assigned}</td>
                    <td className="px-4 py-4 font-mono text-[12px] text-ink-soft">{cancels}</td>
                    <td className="px-4 py-4">{e.auto_graded}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => navigate(`/teacher/exams/${e.id}`)} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">Open →</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Evaluator Information */}
      {tab === "evaluators" && (
        <div className="mt-6 overflow-x-auto border border-line bg-paper">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper-raised font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-3">Evaluator</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Tests</th>
                <th className="px-4 py-3">Reports assigned</th>
                <th className="px-4 py-3">Next due date</th>
              </tr>
            </thead>
            <tbody>
              {evaluatorRows.length === 0 ? (
                <tr><td colSpan={5} className="p-10 text-center">
                  <p className="font-serif text-lg">No evaluators yet</p>
                  <p className="mt-1 text-[12px] text-ink-soft">Use Auto-assign Test Reports on a test to bring evaluators here.</p>
                </td></tr>
              ) : evaluatorRows.map((r) => (
                <tr key={r.email} className="border-b border-line last:border-0 hover:bg-paper-raised">
                  <td className="px-4 py-4 font-medium">{r.name}</td>
                  <td className="px-4 py-4 font-mono text-[11px] text-ink-soft">{r.email}</td>
                  <td className="px-4 py-4">{r.exams}</td>
                  <td className="px-4 py-4">{r.reports}</td>
                  <td className="px-4 py-4">{r.due ? new Date(r.due).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Due Date Information */}
      {tab === "due" && (
        <div className="mt-6 overflow-x-auto border border-line bg-paper">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper-raised font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-3">Test name</th>
                <th className="px-4 py-3">Due date</th>
                <th className="px-4 py-3">Reports assigned</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {dueRows.length === 0 ? (
                <tr><td colSpan={4} className="p-10 text-center">
                  <p className="font-serif text-lg">No due dates set</p>
                  <p className="mt-1 text-[12px] text-ink-soft">Set a due date when you auto-assign test reports.</p>
                </td></tr>
              ) : dueRows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper-raised">
                  <td className="px-4 py-4">
                    <p className="font-medium">{r.exam}</p>
                    <p className="mt-0.5 font-mono text-[9px] text-ink-soft">{r.id}</p>
                  </td>
                  <td className="px-4 py-4">{r.due.toLocaleDateString()}</td>
                  <td className="px-4 py-4">{r.reports}</td>
                  <td className="px-4 py-4">
                    <span className={`px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${r.status === "Overdue" ? "bg-alert/10 text-alert" : r.status === "Due today" ? "bg-amber/10 text-amber" : "bg-success/10 text-success"}`}>
                      {r.status}{r.status === "Upcoming" ? ` · ${r.days}d left` : r.status === "Overdue" ? ` · ${Math.abs(r.days)}d late` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignExam && (
        <AutoAssignPanel
          exam={assignExam}
          faculty={faculty}
          notify={notify}
          onClose={() => setAssignExam(null)}
          onDone={() => { setAssignExam(null); void load(); }}
        />
      )}
    </div>
  );
}

function DashMetric({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`border border-line bg-paper-raised p-5 ${onClick ? "cursor-pointer transition hover:border-forest" : ""}`}>
      <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">{label}</p>
      <p className="mt-2 font-serif text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-[11px] text-ink-soft">{detail}</p>
    </div>
  );
}

// ── Auto-assign Test Reports (Mettl right-panel flow) ─────────────────────────
function AutoAssignPanel({
  exam,
  faculty,
  notify,
  onClose,
  onDone,
}: {
  exam: ExaminerExamRow;
  faculty: FacultyMember[];
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const badge = allocBadge(exam);
  const available = exam.unassigned;
  // Only faculty with a real teachers.id can receive delegations.
  const pickable = faculty.filter((f): f is FacultyMember & { id: string } => Boolean(f.id));
  const [step, setStep] = useState<1 | 2>(1);
  const [role, setRole] = useState("Evaluator");
  const [selected, setSelected] = useState<(FacultyMember & { id: string })[]>([]);
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (f: FacultyMember & { id: string }) => {
    setSelected((cur) => (cur.some((x) => x.id === f.id) ? cur.filter((x) => x.id !== f.id) : [...cur, f]));
  };

  const goConfirm = () => {
    if (selected.length === 0) return;
    // Initial distribution: split the available reports evenly.
    const per = Math.floor(available / selected.length);
    const rem = available % selected.length;
    const next: Record<string, number> = {};
    selected.forEach((f, i) => { next[f.id] = per + (i < rem ? 1 : 0); });
    setCounts(next);
    setStep(2);
  };

  const setCount = (id: string, raw: number) => {
    setCounts((cur) => {
      const others = Object.entries(cur).filter(([k]) => k !== id).reduce((s, [, v]) => s + v, 0);
      return { ...cur, [id]: Math.max(0, Math.min(raw, available - others)) };
    });
  };

  const totalCount = Object.values(counts).reduce((s, v) => s + v, 0);

  const assign = async () => {
    if (totalCount === 0) return;
    setBusy(true);
    const evaluators = selected.map((f) => ({ id: f.id, name: f.name, email: f.email, count: counts[f.id] ?? 0 }));
    const res = await assignEvaluators({ examId: exam.id, role, dueDate: dueDate || null, evaluators });
    if (res.ok) {
      notify(`Assigned ${res.assigned ?? 0} report(s) to ${evaluators.filter((e) => e.count > 0).length} evaluator(s) for ${exam.name}`);
      await sendEvaluatorAssignmentEmail(exam.id, evaluators.filter((e) => e.count > 0), dueDate || null, res.assigned ?? 0);
      onDone();
    } else {
      notify(`Assignment failed: ${res.error ?? "unknown error"}`);
      setBusy(false);
    }
  };

  const summary = [
    { icon: <FiFileText />, label: "Test Name", value: exam.name },
    { icon: <FiFolder />, label: "Test Reports Selected", value: `${available} report(s)` },
    { icon: <FiUsers />, label: "Evaluators Selected", value: `${selected.length}` },
    { icon: <FiSettings />, label: "Evaluator Role Selected", value: role },
    { icon: <FiCalendar />, label: "Due Date Selected", value: dueDate ? new Date(dueDate + "T00:00:00").toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "Not set" },
  ];

  return (
    <div className="fixed inset-0 z-[90] bg-ink/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="fixed right-0 top-0 flex h-full w-full max-w-[520px] flex-col bg-paper shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              {step === 1 ? "Allocation" : "Assignment Confirmation"}
            </p>
            <h2 className="mt-1 font-serif text-2xl font-semibold">{step === 1 ? "Auto-assign Test Reports" : "Confirm assignment"}</h2>
            <p className="mt-1 text-[12px] text-ink-soft">
              {step === 1 ? "Test reports will be randomly assigned to new evaluator(s)." : "Review the distribution and assign the reports."}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-ink-soft transition hover:text-ink"><FiX size={18} /></button>
        </div>

        {step === 1 ? (
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
            <div className="border border-line bg-paper-raised p-4 text-[12px] text-ink-soft">
              Target: <strong className="text-ink">{exam.name}</strong> · {exam.batch} · {available} unassigned report(s)
            </div>

            <label className="block text-[13px]">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Select Evaluator Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest">
                <option>Evaluator</option>
                <option>Senior Evaluator</option>
                <option>Reviewer</option>
              </select>
            </label>

            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Select Evaluators</p>
              <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto border border-line p-2">
                {pickable.length === 0 && (
                  <p className="p-4 text-center text-[12px] text-ink-soft">No faculty found in the teachers directory.</p>
                )}
                {pickable.map((f) => {
                  const on = selected.some((x) => x.id === f.id);
                  return (
                    <button key={f.id} onClick={() => toggle(f)} className={`flex w-full items-center justify-between gap-3 border px-3 py-2.5 text-left text-[13px] transition ${on ? "border-forest bg-success/5 text-ink" : "border-line text-ink-soft hover:border-line-strong"}`}>
                      <span className="min-w-0">
                        <span className="block font-medium">{f.name}</span>
                        <span className="block truncate font-mono text-[10px] text-ink-soft">{f.email ?? "no email on file"}</span>
                      </span>
                      <span className={`font-mono text-[11px] ${on ? "text-forest" : "text-ink-soft"}`}>{on ? <FiCheck /> : <FiPlus />}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block text-[13px]">
              <span className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                <span>Select a new Due Date</span>
                <button type="button" onClick={() => setDueDate(new Date().toISOString().slice(0, 10))} className="normal-case text-forest hover:underline">Set to current date</button>
              </span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest" />
            </label>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="border border-line">
              {summary.map((row) => (
                <div key={row.label} className="flex items-start gap-3 border-b border-line px-4 py-3 text-[13px] last:border-0">
                  <span className="text-ink-soft">{row.icon}</span>
                  <div className="min-w-0">
                    <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{row.label}</p>
                    <p className="mt-0.5 break-words font-medium">{row.value}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Distribution details of Test Reports among selected Evaluators</p>
            <p className="mt-1 text-[12px] text-ink-soft">You may change the count of test reports assigned to each evaluator. Total: {available} report(s).</p>
            <div className="mt-3 divide-y divide-line border border-line">
              {selected.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">{f.name}</p>
                    <p className="truncate font-mono text-[10px] text-ink-soft">{f.email ?? ""}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={0} max={available}
                      value={counts[f.id] ?? 0}
                      onChange={(e) => setCount(f.id, parseInt(e.target.value) || 0)}
                      className="w-20 border border-line-strong bg-paper px-2 py-1.5 text-right font-mono text-[13px] outline-none focus:border-forest"
                    />
                    <span className="font-mono text-[10px] text-ink-soft">report(s)</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Total Test Report</p>
              <p className="font-mono text-[13px]">
                <span className={totalCount === available ? "text-forest" : "text-alert"}>{totalCount}</span>
                <span className="text-ink-soft"> / {available} report(s)</span>
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-2 border-t border-line px-6 py-5">
          {step === 2 && <Button icon={<FiArrowLeft />} onClick={() => setStep(1)}>Back</Button>}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {step === 1 ? (
            <Button primary iconRight={<FiArrowRight />} onClick={goConfirm} disabled={selected.length === 0}>Next</Button>
          ) : (
            <Button primary onClick={() => void assign()} disabled={busy || totalCount === 0}>
              {busy ? "Assigning…" : totalCount === available ? "Assign Test Reports" : `Assign ${totalCount}/${available}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}