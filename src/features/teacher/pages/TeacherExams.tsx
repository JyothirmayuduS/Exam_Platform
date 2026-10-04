// My Tests — Mettl-style assessment cards: each test shows its question count,
// duration, and real enrolled test-taker count, with a status badge and one
// click through to the exam workspace. All numbers come from Supabase.

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/shared/data/supabase";
import type { ExamRecord } from "@/shared/data/examApi";
import { deleteExam, getExamDeletionSafety, type ExamDeletionSafety } from "@/shared/data/examApi";
import { PageHeading, Button } from "@/features/teacher/pages/TeacherDashboard";
import { PlusIcon, ArrowRightIcon } from "@/shared/components/ui";
import { FiTrash2 } from "react-icons/fi";
import CreateTestModal from "@/features/teacher/components/teacher/CreateTestModal";
import "./teacherSurfaces.css";

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
  onDeleted,
}: {
  notify: (s: string) => void;
  navigate: (s: string) => void;
  exams: any[];
  autoCreate?: boolean;
  onCreate?: (exam: ExamRecord) => void;
  onDeleted?: (examId: string) => void;
}) {
  const [takers, setTakers] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("All exams");
  const [showCreate, setShowCreate] = useState(autoCreate);
  const [deleting, setDeleting] = useState<ExamCard | null>(null);

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
    <div className="sheet">
      <header className="sheet-top">
        <div>
          <h1>My tests</h1>
          <p>{live} live, {scheduled} scheduled, {drafts} still in draft.</p>
        </div>
        <Button primary icon={<PlusIcon />} onClick={() => setShowCreate(true)}>Create new test</Button>
      </header>

      <nav className="sheet-filters" aria-label="Filter tests">
        {[
          ["All exams", cards.length],
          ["Live", live],
          ["Scheduled", scheduled],
          ["Draft", drafts],
        ].map(([item, count]) => (
          <button key={String(item)} type="button" onClick={() => setFilter(String(item))} className={filter === item ? "is-on" : ""}>
            {item === "Draft" ? "Drafts" : item} {count}
          </button>
        ))}
      </nav>

      {filtered.length === 0 ? (
        <div className="sheet-block">
          <p className="sheet-empty">Nothing in this list.</p>
          <Button primary onClick={() => setShowCreate(true)}>Create a test</Button>
        </div>
      ) : (
        <ul className="sheet-list">
          {filtered.map((exam) => (
            <li key={exam.id} className="sheet-row" style={{ cursor: "default" }}>
              <span className="sheet-row-main">
                <strong>{exam.name}</strong>
                <em>
                  {exam.batch}
                  {" · "}
                  {exam.questionCount ? `${exam.questionCount} questions` : "No questions yet"}
                  {" · "}
                  {exam.duration ? `${exam.duration} min` : "No duration"}
                  {" · "}
                  {exam.takers} sitting
                </em>
              </span>
              <span className={`sheet-status ${exam.tone}`}>{exam.state}</span>
              <Button
                size="sm"
                onClick={() => navigate(exam.state === "Draft" ? `/teacher/exams/${exam.id}/build` : `/teacher/exams/${exam.id}`)}
                iconRight={<ArrowRightIcon />}
              >
                {exam.state === "Draft" ? "Continue" : "Open"}
              </Button>
              <button
                type="button"
                onClick={() => setDeleting(exam)}
                aria-label={`Delete ${exam.name}`}
                title="Delete this test"
                className="q-links"
                style={{ width: 36, height: 36, justifyContent: "center", color: "inherit" }}
              >
                <FiTrash2 aria-hidden />
              </button>
            </li>
          ))}
        </ul>
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
      {deleting && (
        <DeleteExamDialog
          exam={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(id) => {
            setDeleting(null);
            onDeleted?.(id);
            notify(`Test "${deleting.name}" deleted.`);
          }}
        />
      )}
    </div>
  );
}

// ── Delete dialog with safety conditions ────────────────────────────────────
//
// Deletion is REFUSED when the exam has real attempt rows: in-progress means
// students are sitting the paper right now; submitted means permanent student
// records exist. Only untouched exams (no attempts, or merely enrolled
// students who never started) can be removed.
function DeleteExamDialog({ exam, onClose, onDeleted }: {
  exam: ExamCard;
  onClose: () => void;
  onDeleted: (examId: string) => void;
}) {
  const [safety, setSafety] = useState<ExamDeletionSafety | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getExamDeletionSafety(exam.id).then((s) => { if (active) setSafety(s); });
    return () => { active = false; };
  }, [exam.id]);

  const blocked = !!safety && (safety.inProgress > 0 || safety.submitted > 0);
  const totalAttempts = safety ? safety.inProgress + safety.submitted + safety.notStarted : 0;

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await deleteExam(exam.id);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onDeleted(exam.id);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Delete test">
      <div className="w-full max-w-md border border-line-strong bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <h2 className="font-serif text-2xl font-semibold">Delete test</h2>
            <p className="mt-1 text-[12px] text-ink-soft">{exam.name} · {exam.id}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-ink-soft transition hover:text-ink">×</button>
        </div>

        <div className="space-y-3 px-6 py-5 text-[13px]">
          {!safety && <p className="py-6 text-center text-ink-soft">Checking attempts for this test…</p>}

          {safety?.unavailable && (
            <p className="border border-alert/40 bg-alert/5 px-4 py-3 text-alert">
              The database could not be reached, so attempt safety could not be verified. Deletion is disabled — try again when online.
            </p>
          )}

          {safety && !safety.unavailable && blocked && (
            <div className="space-y-3">
              <p className="border border-alert/40 bg-alert/5 px-4 py-3 text-alert">
                <span className="font-medium">This test cannot be deleted.</span>
              </p>
              {safety.inProgress > 0 && (
                <p className="border border-line bg-paper-raised px-4 py-3">
                  ● <span className="font-medium">{safety.inProgress} student{plural(safety.inProgress)} taking this exam right now.</span> Deleting it would dump them out of the paper mid-attempt. The exam stays locked until the session ends.
                </p>
              )}
              {safety.submitted > 0 && (
                <p className="border border-line bg-paper-raised px-4 py-3">
                  ● <span className="font-medium">{safety.submitted} submitted answer sheet{plural(safety.submitted)} recorded.</span> Deleting would permanently destroy student answer records, scores and evidence. Exams with submissions are kept for audit reasons.
                </p>
              )}
              <p className="text-[12px] text-ink-soft">If you truly need to remove this test, clear its attempts first (or contact the administrator).</p>
            </div>
          )}

          {safety && !safety.unavailable && !blocked && (
            <>
              <p>Permanently delete this test{totalAttempts > 0 ? ` and its ${totalAttempts} not-started enrollment row${plural(totalAttempts)}` : ""}?</p>
              <ul className="space-y-1 border border-line bg-paper-raised px-4 py-3 text-[12px] text-ink-soft">
                <li>• The exam, its schedule and join link</li>
                <li>• Question pool links for this exam</li>
                <li>• Enrollment rows for batch students</li>
                <li>• Questions created inside this test (bank questions written separately stay)</li>
              </ul>
              <p className="text-[12px] text-ink-soft">No student has started this test, so no attempt data will be lost.</p>
            </>
          )}

          {error && <p className="border border-alert/40 bg-alert/5 px-4 py-3 text-[12px] text-alert">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-5">
          <button onClick={onClose} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-ink">Cancel</button>
          {!blocked && safety && !safety.unavailable && (
            <button
              onClick={() => void confirmDelete()}
              disabled={busy}
              className="border border-alert bg-alert px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
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