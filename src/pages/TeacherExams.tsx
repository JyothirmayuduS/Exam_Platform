// My Tests — Mettl-style assessment cards: each test shows its question count,
// duration, and real enrolled test-taker count, with a status badge and one
// click through to the exam workspace. All numbers come from Supabase.

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "../lib/supabase";
import type { ExamRecord } from "../lib/examApi";
import { PageHeading, Button } from "./TeacherDashboard";
import CreateTestModal from "../components/teacher/CreateTestModal";

type ExamCard = {
  id: string;
  name: string;
  batch: string;
  state: string; // UI state label (Draft / Scheduled / Live)
  status: string; // DB status
  tone: string;
  count: string; // "N questions"
  questionCount: number;
  duration: number;
  mode: string;
  schedule?: string;
  takers: number;
};

const STATUS_ORDER = ["Live", "Scheduled", "Draft"];

export default function TeacherExams({
  navigate,
  exams,
  notify,
  autoCreate = false,
  onCreate,
}: {
  notify: (s: string) => void;
  navigate: (s: string) => void;
  exams: any[];
  autoCreate?: boolean;
  onCreate?: (exam: ExamRecord) => void;
}) {
  const [takers, setTakers] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("All exams");
  const [view, setView] = useState<"cards" | "list">("cards");
  const [showCreate, setShowCreate] = useState(autoCreate);

  useEffect(() => { setShowCreate(autoCreate); }, [autoCreate]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const db = getSupabase();
      if (!db) return;
      const { data } = await db.from("enrollments").select("exam_id, student_id");
      if (!active || !data) return;
      const counts: Record<string, number> = {};
      for (const r of data as { exam_id?: string }[]) {
        if (r.exam_id) counts[r.exam_id] = (counts[r.exam_id] ?? 0) + 1;
      }
      setTakers(counts);
    })();
    return () => { active = false; };
  }, []);

  const cards: ExamCard[] = useMemo(
    () =>
      exams.map((e: any) => {
        const q = parseInt(e.count) || e.questionCount || 0;
        return {
          id: e.id,
          name: e.name,
          batch: e.batch,
          state: e.state,
          status: e.status ?? e.state?.toLowerCase?.() ?? "",
          tone: e.tone,
          count: `${q} questions`,
          questionCount: q,
          duration: e.duration ?? e.duration_minutes ?? 0,
          mode: e.mode,
          schedule: e.schedule,
          takers: takers[e.id] ?? 0,
        };
      }),
    [exams, takers],
  );

  const filtered = useMemo(() => {
    const list = filter === "All exams" ? cards : cards.filter((c) => c.state === filter);
    return [...list].sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a.state);
      const ib = STATUS_ORDER.indexOf(b.state);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
    });
  }, [cards, filter]);

  const live = cards.filter((c) => c.state === "Live").length;
  const scheduled = cards.filter((c) => c.state === "Scheduled").length;
  const drafts = cards.filter((c) => c.state === "Draft").length;

  return (
    <div>
      <PageHeading
        eyebrow="Faculty console / Exams"
        title="My tests"
        detail="Create exam papers, add questions, set schedules, and publish — every test card below is a live assessment."
        action={<Button primary onClick={() => setShowCreate(true)}>+ Create new test</Button>}
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <MiniStat label="Published" value={String(live)} detail="Currently live" tone="text-forest" onClick={() => setFilter("Live")} />
        <MiniStat label="Scheduled" value={String(scheduled)} detail="Upcoming assessments" tone="text-amber" onClick={() => setFilter("Scheduled")} />
        <MiniStat label="Drafts" value={String(drafts)} detail="Need your attention" tone="text-ink" onClick={() => setFilter("Draft")} />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 border border-line bg-paper-raised p-1">
          {["All exams", "Live", "Scheduled", "Draft"].map((item) => (
            <button key={item} onClick={() => setFilter(item)} className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${filter === item ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"}`}>
              {item}
            </button>
          ))}
        </div>
        <div className="flex border border-line bg-paper-raised p-1">
          <button onClick={() => setView("cards")} className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${view === "cards" ? "bg-forest text-paper" : "text-ink-soft"}`}>▦ Cards</button>
          <button onClick={() => setView("list")} className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${view === "list" ? "bg-forest text-paper" : "text-ink-soft"}`}>≡ List</button>
        </div>
      </div>

      {view === "cards" ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((exam) => (
            <div key={exam.id} className="group relative flex flex-col border border-line bg-paper transition hover:-translate-y-0.5 hover:border-forest hover:shadow-md">
              {/* dog-ear */}
              <span className="absolute right-0 top-0 h-0 w-0 border-l-[22px] border-t-[22px] border-l-paper border-t-line" />
              <div className="px-5 pt-5">
                <div className="flex items-start justify-between gap-3 pr-3">
                  <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">{exam.id}</p>
                  <span className={`font-mono text-[9px] uppercase tracking-wider ${exam.tone}`}>{exam.state}</span>
                </div>
                <h3 className="mt-3 font-serif text-lg font-semibold leading-snug group-hover:text-forest">{exam.name}</h3>
                <p className="mt-1 text-[11px] text-ink-soft">{exam.batch}</p>
              </div>
              <div className="mt-6 grid grid-cols-3 border-t border-line px-5 py-4">
                <CardStat label="Questions" value={exam.questionCount ? String(exam.questionCount) : "—"} />
                <CardStat label="Duration" value={exam.duration ? `${exam.duration}m` : "—"} />
                <CardStat label="Test takers" value={String(exam.takers)} />
              </div>
              <button
                onClick={() => navigate(exam.state === "Draft" ? `/teacher/exams/${exam.id}/build` : `/teacher/exams/${exam.id}`)}
                className="mt-auto border-t border-line px-5 py-3 text-left font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-success/5"
              >
                {exam.state === "Draft" ? "Continue setup →" : "Open test →"}
              </button>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full border border-dashed border-line-strong p-12 text-center sm:col-span-2 xl:col-span-4">
              <p className="font-serif text-xl">No tests here yet</p>
              <p className="mt-2 text-[13px] text-ink-soft">Create your first exam — it will appear as a card here.</p>
              <button onClick={() => setShowCreate(true)} className="mt-5 border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">
                Create your first test
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto border border-line bg-paper">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                <th className="px-5 py-3">Test</th>
                <th className="px-5 py-3">Course &amp; batch</th>
                <th className="px-5 py-3">Questions</th>
                <th className="px-5 py-3">Duration</th>
                <th className="px-5 py-3">Test takers</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((exam) => (
                <tr key={exam.id} className="border-b border-line last:border-0 hover:bg-paper-raised">
                  <td className="px-5 py-4">
                    <p className="font-medium">{exam.name}</p>
                    <p className="mt-1 font-mono text-[9px] text-ink-soft">{exam.id}</p>
                  </td>
                  <td className="px-5 py-4 text-ink-soft">{exam.batch}</td>
                  <td className="px-5 py-4">{exam.questionCount}</td>
                  <td className="px-5 py-4">{exam.duration ? `${exam.duration} min` : "—"}</td>
                  <td className="px-5 py-4">{exam.takers}</td>
                  <td className="px-5 py-4"><span className={`font-mono text-[10px] uppercase ${exam.tone}`}>{exam.state}</span></td>
                  <td className="px-5 py-4 text-right">
                    <button onClick={() => navigate(exam.state === "Draft" ? `/teacher/exams/${exam.id}/build` : `/teacher/exams/${exam.id}`)} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">{exam.state === "Draft" ? "Continue setup →" : "Open →"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showCreate && (
        <CreateTestModal
          onClose={() => setShowCreate(false)}
          notify={notify}
          onCreate={(exam) => {
            setShowCreate(false);
            onCreate?.(exam);
            navigate(`/teacher/exams/${exam.id}/build`);
          }}
        />
      )}
    </div>
  );
}

function MiniStat({ label, value, detail, tone, onClick }: { label: string; value: string; detail: string; tone: string; onClick: () => void }) {
  return (
    <div onClick={onClick} className="cursor-pointer border border-line bg-paper-raised p-5 transition hover:border-forest">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p>
      <p className={`mt-2 font-serif text-3xl ${tone}`}>{value}</p>
      <p className="mt-1 text-[12px] text-ink-soft">{detail}</p>
    </div>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pr-2">
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
      <p className="mt-1 text-[13px] font-medium">{value}</p>
    </div>
  );
}