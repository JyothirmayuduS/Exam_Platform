// ExamStudio — the Mettl-style paper builder for one test, in the Vignan theme.
// One page holds everything for building a test: search & add questions from
// the bank, a live composition table with metrics, duration, ADVANCE OPTIONS
// (Test options / Section options / Candidate registration fields dialogs),
// Save & exit, and Publish & share. Every number is computed from Supabase —
// no demo data.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiUpload, FiEdit3, FiEye, FiSettings, FiLink, FiSearch, FiX, FiChevronDown, FiChevronRight, FiClock, FiLock, FiMail } from "react-icons/fi";
import { Button, Badge } from "../components/ui";
import {
  listExamsForTeacher,
  listQuestionsForExam,
  listAllQuestions,
  linkQuestionsToExam,
  unlinkQuestionFromExam,
  listStudentsByBatch,
  getExamRoster,
  publishExam,
  triggerExamEmail,
  type ExamRecord,
  type DBQuestion,
} from "../lib/examApi";

type S = {
  perStudent: number; randomSelect: boolean; shuffleOrder: boolean; shuffleOptions: boolean;
  autoSubmit: boolean; mode: "practice" | "lockdown"; attempts: number;
  negative: boolean; calculator: boolean; instantFeedback: boolean;
  photoId: boolean; violationLimit: number; violationAction: "warn" | "submit";
  releaseDate: string; ipWhitelist: string; sections: boolean; sectionTiming: boolean;
  autoClose: boolean; durationLock: boolean;
  language?: string; purpose?: string; assessmentType?: "timed" | "deadline"; deadline?: string;
  showReportToTaker?: boolean; commentsMandatory?: boolean; skipFeedback?: boolean; redirectAfter?: string;
  watermarkText?: string; fixedSectionOrder?: boolean; scratchpad?: boolean;
  allowQrUpload?: boolean; showMarksInTest?: boolean; showMarks?: boolean;
  regEmail?: boolean; regName?: boolean; regUsn?: boolean; regTerms?: boolean;
};

const DEFAULTS: S = {
  perStudent: 5, randomSelect: true, shuffleOrder: true, shuffleOptions: true, autoSubmit: true,
  mode: "lockdown", attempts: 1, negative: false, calculator: false, instantFeedback: false,
  photoId: false, violationLimit: 3, violationAction: "submit", releaseDate: "", ipWhitelist: "",
  sections: false, sectionTiming: false, autoClose: false, durationLock: true,
  language: "English", purpose: "Academic exam", assessmentType: "timed", deadline: "",
  showReportToTaker: false, commentsMandatory: false, skipFeedback: false, redirectAfter: "",
  watermarkText: "", fixedSectionOrder: false, scratchpad: false, allowQrUpload: false,
  showMarksInTest: true, showMarks: true, regEmail: true, regName: true, regUsn: true, regTerms: true,
};

const TYPE_LABEL: Record<string, string> = {
  MCQ: "MCQ", MSQ: "MSQ", "True / False": "True / False", Numerical: "Numerical",
  Subjective: "Descriptive", Coding: "Coding", LONG_ANSV: "Descriptive",
};

const inputCls = "border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-soft/60 focus:border-forest";

export default function ExamStudio({
  examId, notify, navigate, onSaved,
}: {
  examId: string; notify: (msg: string) => void; navigate: (p: string) => void;
  onSaved?: (exam: ExamRecord) => void;
}) {
  const [exam, setExam] = useState<ExamRecord | null>(null);
  const [questions, setQuestions] = useState<DBQuestion[]>([]);
  const [bank, setBank] = useState<(DBQuestion & { exam_name: string | null })[]>([]);
  const [enrolled, setEnrolled] = useState(0);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(45);
  const [s, setS] = useState<S>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [diffFilter, setDiffFilter] = useState("All");

  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "test" | "sections" | "registration">(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [result, setResult] = useState<null | { status: string; when?: string; link: string; notified?: number }>(null);

  const reload = useCallback(async () => {
    const [exams, qs, allQ] = await Promise.all([
      listExamsForTeacher(), listQuestionsForExam(examId), listAllQuestions(),
    ]);
    const row = exams.find((e) => e.id === examId) ?? null;
    setExam(row);
    setQuestions(qs);
    setBank(allQ);
    if (row) {
      setName(row.name);
      setDuration(row.duration_minutes || 45);
      setS({ ...DEFAULTS, ...(row.settings ?? {}) } as S);
      const roster = await getExamRoster(examId);
      setEnrolled(roster.length);
    }
    setLoading(false);
  }, [examId]);

  useEffect(() => { void reload(); }, [reload]);

  const inPool = useMemo(() => new Set(questions.map((q) => q.id)), [questions]);
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
  const sections = useMemo(() => {
    const map = new Map<string, { type: string; count: number; marks: number }>();
    for (const q of questions) {
      const t = TYPE_LABEL[q.type] ?? q.type ?? "Question";
      const cur = map.get(t) ?? { type: t, count: 0, marks: 0 };
      cur.count += 1; cur.marks += q.marks || 1; map.set(t, cur);
    }
    return Array.from(map.values());
  }, [questions]);
  const topics = useMemo(() => new Set(questions.map((q) => q.unit || "General")), [questions]);
  const perStudent = Math.min(Number(s.perStudent) || 1, Math.max(1, questions.length));
  const studentLink = () => `https://vignan.exam/join/${examId.toLowerCase()}`;

  const patch = <K extends keyof S,>(k: K, v: S[K]) => setS((cur) => ({ ...cur, [k]: v }));

  // ── Pool actions (DB-persisted through the exam_questions join) ────────────
  const addToPool = (qid: string) => {
    if (inPool.has(qid)) return;
    const q = bank.find((b) => b.id === qid);
    if (!q) return;
    setQuestions((cur) => [...cur, q as DBQuestion]);
    void linkQuestionsToExam(examId, [qid]).then((r) => {
      if (!r.ok) { setQuestions((cur) => cur.filter((x) => x.id !== qid)); notify("Could not add the question — database unavailable"); }
    });
  };
  const removeFromPool = (qid: string) => {
    setQuestions((cur) => cur.filter((x) => x.id !== qid));
    void unlinkQuestionFromExam(examId, qid).then((ok) => { if (!ok) notify("Removed locally, but the change could not reach the database."); });
  };

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return bank
      .filter((q) => !inPool.has(q.id))
      .filter((q) => (term ? `${q.id} ${q.title} ${q.unit ?? ""} ${q.exam_name ?? ""}`.toLowerCase().includes(term) : true))
      .filter((q) => (typeFilter === "All" || q.type === typeFilter))
      .filter((q) => (diffFilter === "All" || (q.difficulty || "Medium") === diffFilter))
      .slice(0, 8);
  }, [bank, inPool, search, typeFilter, diffFilter]);

  // ── Save the whole test (name, duration, settings, pool counts) ───────────
  const saveAll = async (): Promise<ExamRecord | null> => {
    if (!exam) return null;
    const rec: ExamRecord = {
      ...exam,
      name: name.trim() || exam.name,
      duration_minutes: duration,
      per_student: perStudent,
      pool_count: questions.length,
      total_marks: totalMarks,
      settings: { ...s } as unknown as Record<string, unknown>,
    };
    const res = await publishExam(rec);
    if (!res.ok) { notify("Save failed: " + res.error); return null; }
    onSaved?.(rec);
    return rec;
  };
  const saveAndExit = async () => {
    if (saving) return;
    setSaving(true);
    const rec = await saveAll();
    setSaving(false);
    if (rec) { notify(`Changes to "${rec.name}" saved.`); navigate(`/teacher/exams/${examId}`); }
  };
  const persistSettings = async () => {
    if (!exam) return;
    const rec: ExamRecord = {
      ...exam,
      name: name.trim() || exam.name,
      duration_minutes: duration,
      per_student: perStudent,
      pool_count: questions.length,
      total_marks: totalMarks,
      settings: { ...s } as unknown as Record<string, unknown>,
    };
    const ok = await publishExam(rec);
    if (ok.ok) { setExam(rec); onSaved?.(rec); notify("Options saved to this test"); }
    else notify("Could not save options — database unavailable");
  };

  if (loading) return <div className="p-14 text-center font-mono text-[11px] uppercase tracking-widest text-ink-soft">Loading paper builder…</div>;
  if (!exam) return <div className="border border-dashed border-line-strong p-14 text-center"><p className="font-serif text-xl">Test not found</p><p className="mt-2 text-[13px] text-ink-soft">It may have been deleted.</p></div>;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-5 border-b border-line pb-6">
        <div>
          <Button size="sm" variant="ghost" icon={<FiArrowLeft />} onClick={() => navigate(`/teacher/exams/${examId}`)}>Back to test</Button>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="border border-line-strong bg-paper-raised px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft">{exam.id}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Test name" className="min-w-0 flex-1 border border-transparent bg-transparent px-1 font-serif text-3xl font-semibold tracking-tight text-ink outline-none transition hover:border-line-strong focus:border-forest sm:min-w-[280px]" />
            <span className="flex h-8 w-8 items-center justify-center text-ink-soft" aria-hidden><FiEdit3 /></span>
          </div>
          <p className="mt-1 text-[12px] text-ink-soft">{exam.batch} · {String(s.language ?? "English")} · {String(s.purpose ?? "")} · <span className={exam.status === "draft" ? "text-amber" : "text-success"}>{exam.status}</span></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={() => void saveAndExit()} disabled={saving} icon={<FiCheck />}>{saving ? "Saving…" : "Save & exit"}</Button>
          <Button size="lg" variant="primary" onClick={() => setShareOpen(true)} iconRight={<FiArrowRight />}>Publish &amp; share</Button>
        </div>
      </div>

      {/* ── Toolbar: search & add, duration, preview, advance options ───────── */}
      <div className="mt-6 border border-line bg-paper p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-ink-soft">Search and add question to test</p>
            <div className="relative mt-1">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a question, ID, unit or the test it came from…" className={`block w-full ${inputCls}`} />
              {search.trim() !== "" && (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-y-auto border border-line-strong bg-paper shadow-xl">
                  {matches.length === 0 && <p className="px-4 py-3 text-[12px] text-ink-soft">No matching questions in your bank.</p>}
                  {matches.map((q) => (
                    <button key={q.id} onClick={() => { addToPool(q.id); setSearch(""); }} className="flex w-full items-start justify-between gap-4 border-b border-line px-4 py-3 text-left transition last:border-0 hover:bg-paper-raised">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[10px] text-ink-soft">{q.id}</span>
                          <span className="bg-paper-raised px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">{q.type}</span>
                          <span className={`px-1.5 py-0.5 font-mono text-[9px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>{q.difficulty ?? "Medium"}</span>
                          {q.exam_name && <span className="font-mono text-[9px] text-ink-soft">from {q.exam_name}</span>}
                        </div>
                        <p className="mt-1.5 truncate text-[13px]">{q.title}</p>
                      </div>
                      <span className="shrink-0 border border-forest px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-forest">+ Add</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className="border border-line-strong bg-paper px-2.5 py-1.5 text-[12px] outline-none focus:border-forest">
                <option>All</option><option>MCQ</option><option>MSQ</option><option>Numerical</option><option>True / False</option><option>Subjective</option><option>Coding</option>
              </select>
              <select value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)} aria-label="Filter by difficulty" className="border border-line-strong bg-paper px-2.5 py-1.5 text-[12px] outline-none focus:border-forest">
                <option>All</option><option>Easy</option><option>Medium</option><option>Hard</option>
              </select>
              <Button size="sm" icon={<FiEdit3 />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>Write new question</Button>
              <Button size="sm" variant="secondary" icon={<FiUpload />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&bulk=1&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>Import CSV</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Test duration (min)</span>
              <input type="number" min={1} max={600} step={5} value={duration} onChange={(e) => setDuration(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} className={`mt-1 block w-28 ${inputCls}`} />
            </label>
            <Button size="sm" variant="secondary" icon={<FiEye />} onClick={() => setPreviewOpen(true)}>Preview</Button>
            <div className="relative">
              <Button size="sm" variant="secondary" icon={<FiSettings />} iconRight={<FiChevronDown />} onClick={() => setMenuOpen((o) => !o)}>Advance options</Button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-30 mt-1 w-72 border border-line-strong bg-paper py-2 shadow-xl">
                    {([
                      ["test", "Test Options", "Duration, mode, marking, results & calculator"],
                      ["sections", "Section Options", "Random draw, shuffle, section order & timing"],
                      ["registration", "Candidate Registration Fields", "What candidates fill in before the test"],
                    ] as const).map(([key, label, detail]) => (
                      <button key={key} onClick={() => { setMenuOpen(false); setDialog(key); }} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-paper-raised">
                        <span><span className="block text-[13px] font-medium">{label}</span><span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{detail}</span></span>
                        <FiChevronRight className="shrink-0 text-ink-soft" aria-hidden />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Metric cards ───────────────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
        <Metric value={String(sections.length)} label="Sections" detail={sections.length ? sections.map((x) => x.type).join(" · ") : "none yet"} />
        <Metric value={String(topics.size)} label="Topics / skills" detail={topics.size ? Array.from(topics).slice(0, 3).join(" · ") : "none yet"} />
        <Metric value={String(questions.length)} label="Questions" detail={questions.length ? `${perStudent} per student` : "add some above"} tone="text-forest" />
        <Metric value={String(totalMarks)} label="Marks" detail={s.negative ? "negative marking on" : "no negative marking"} tone="text-forest" />
      </div>

      {/* ── Composition table ──────────────────────────────────────────────── */}
      <div className="mt-6 overflow-x-auto border border-line bg-paper">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">
              <th className="px-4 py-3">Section</th>
              <th className="px-4 py-3">Question</th>
              <th className="px-4 py-3">Skill / Unit</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Level</th>
              <th className="px-4 py-3">Q-Type</th>
              <th className="px-4 py-3 text-right">Marks</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id} className="group border-b border-line last:border-0 hover:bg-paper-raised/60">
                <td className="px-4 py-3">
                  <span className="bg-forest/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-forest">{TYPE_LABEL[q.type] ?? q.type}</span>
                </td>
                <td className="max-w-[380px] px-4 py-3">
                  <span className="font-mono text-[10px] text-ink-soft">{q.id}</span>
                  <p className="mt-0.5 truncate">{q.title}</p>
                </td>
                <td className="px-4 py-3 text-ink-soft">{q.unit || "General"}</td>
                <td className="px-4 py-3 font-mono text-[10px] uppercase text-ink-soft">Self</td>
                <td className="px-4 py-3">
                  <span className={`font-mono text-[10px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>{q.difficulty ?? "Medium"}</span>
                </td>
                <td className="px-4 py-3 font-mono text-[10px] text-ink-soft">{q.type}</td>
                <td className="px-4 py-3 text-right">{q.marks || 1}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 transition group-hover:opacity-100">
                    <Button size="sm" variant="ghost" icon={<FiEdit3 />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&edit=${q.id}&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>Edit</Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${q.id}`} className="text-alert hover:bg-alert/10" onClick={() => removeFromPool(q.id)} icon={<FiX />}>Remove</Button>
                  </div>
                </td>
              </tr>
            ))}
            {questions.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-14 text-center">
                <p className="font-serif text-xl">Your paper is empty</p>
                <p className="mt-2 text-[12px] text-ink-soft">Search your question bank above, write a new question, or import a CSV. Section rows appear here as you add them.</p>
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper-raised px-4 py-3">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Tip: rows are grouped by section — questions of the same type form one section for candidates.</p>
          <div className="flex flex-wrap gap-2">
            {["Easy", "Medium", "Hard"].map((d) => {
              const n = questions.filter((q) => (q.difficulty || "Medium") === d).length;
              if (n === 0) return null;
              return <span key={d} className={`font-mono text-[10px] ${d === "Easy" ? "text-success" : d === "Hard" ? "text-alert" : "text-amber"}`}>{d} · {n}</span>;
            })}
          </div>
        </div>
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}
      {dialog && (
        <SettingsDialog
          dialog={dialog}
          s={s}
          patch={patch}
          duration={duration}
          setDuration={setDuration}
          examName={name}
          onClose={() => setDialog(null)}
          onSave={() => { void persistSettings(); setDialog(null); }}
        />
      )}
      {previewOpen && (
        <PreviewDialog exam={exam} sections={sections} questions={questions} duration={duration} perStudent={perStudent} s={s} onClose={() => setPreviewOpen(false)} />
      )}
      {shareOpen && (
        <ShareDialog
          exam={exam}
          name={name.trim() || exam.name}
          duration={duration}
          perStudent={perStudent}
          pool={questions.length}
          totalMarks={totalMarks}
          s={s}
          studentLink={studentLink()}
          onClose={() => setShareOpen(false)}
          notify={notify}
          onResult={(r) => { setShareOpen(false); setResult(r); }}
        />
      )}
      {result && (
        <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-xl border border-line-strong bg-paper shadow-2xl">
            <div className={`px-8 py-10 text-center ${result.status === "draft" ? "" : "bg-success/5"}`}>
              <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-paper ${result.status === "scheduled" ? "bg-amber" : "bg-success"}`}>{result.status === "scheduled" ? <FiClock size={24} /> : <FiCheck size={24} />}</span>
              <h2 className="mt-4 font-serif text-3xl font-semibold">{result.status === "scheduled" ? "Test scheduled" : result.status === "draft" ? "Draft saved" : "Test published"}</h2>
              <p className="mt-2 text-[13px] text-ink-soft">{result.status === "scheduled" ? `${name} opens on ${result.when}.` : result.status === "draft" ? `Draft of ${name} saved.` : `${name} is live now for ${exam.batch}.`}</p>
            </div>
            <div className="border-t border-line px-6 py-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Candidate join link</p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <code className="min-w-0 flex-1 truncate border border-line bg-paper-raised px-3 py-3 font-mono text-[12px]">{result.link}</code>
                <button onClick={() => { navigator.clipboard?.writeText(result.link).catch(() => undefined); notify("Join link copied"); }} className="border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Copy link</button>
              </div>
              {typeof result.notified === "number" && result.notified > 0 && <p className="mt-3 border border-forest bg-success/5 px-4 py-3 text-[12px]">Join link emailed to {result.notified} students.</p>}
              {typeof result.notified === "number" && result.notified === 0 && <p className="mt-3 border border-line bg-paper-raised px-4 py-3 text-[12px] text-ink-soft">No email sent — share the join link above.</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-6 py-5">
              <button onClick={() => { setResult(null); navigate(`/teacher/exams/${examId}`); }} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-forest">Done — test overview</button>
              <button onClick={() => setResult(null)} className="border border-forest bg-forest px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-light">Keep building</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ value, label, detail, tone = "text-ink" }: { value: string; label: string; detail: string; tone?: string }) {
  return <div className="bg-paper px-5 py-4"><p className={`font-serif text-3xl ${tone}`}>{value}</p><p className="mt-1 text-[12px] font-medium">{label}</p><p className="mt-0.5 truncate text-[11px] text-ink-soft">{detail}</p></div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings dialog (Advance options → Test / Section / Registration fields)
// ─────────────────────────────────────────────────────────────────────────────
function SettingsDialog({ dialog, s, patch, duration, setDuration, examName, onClose, onSave }: {
  dialog: "test" | "sections" | "registration";
  s: S; patch: <K extends keyof S>(k: K, v: S[K]) => void;
  duration: number; setDuration: (n: number) => void; examName: string;
  onClose: () => void; onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl border border-line-strong bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <h2 className="font-serif text-2xl font-semibold">{dialog === "test" ? "Test Options" : dialog === "sections" ? "Section Options" : "Candidate Registration Fields"}</h2>
            <p className="mt-1 text-[12px] text-ink-soft">for {examName}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-ink-soft transition hover:text-ink">×</button>
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto px-6 py-4">
          {dialog === "test" && (
            <>
              <Group label="Exam mode">
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["practice", "lockdown"] as const).map((m) => (
                    <button key={m} onClick={() => patch("mode", m)} className={`border p-3 text-left ${s.mode === m ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}>
                      <span className="block text-[13px] font-medium capitalize">{m}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-soft">{m === "lockdown" ? "Proctored, single attempt" : "Relaxed, retakes allowed"}</span>
                    </button>
                  ))}
                </div>
              </Group>
              <Group label="Duration">
                <label className="mt-2 block text-[12px] text-ink-soft">Minutes
                  <input type="number" min={1} max={600} step={5} value={duration} onChange={(e) => setDuration(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} className="mt-1 block w-28 border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
              </Group>
              <Group label="Test options">
                <Check label="Provide on-screen calculator & rough sheet to test-takers" detail="A basic calculator and scratch pad are shown in the exam." checked={!!s.calculator} onChange={(v) => patch("calculator", v)} />
                <Check label="Show marks in test" detail="Candidates see the marks of each question while answering." checked={s.showMarksInTest !== false && s.showMarks !== false} onChange={(v) => { patch("showMarksInTest", v); patch("showMarks", v); }} />
                <Check label="Fixed section order for test-takers" detail="Sections always appear in the same order — no shuffling between candidates." checked={!!s.fixedSectionOrder} onChange={(v) => patch("fixedSectionOrder", v)} />
                <Check label="Enable negative marking (incorrect grade)" detail="Deduct the configured marks for a wrong auto-graded answer." checked={!!s.negative} onChange={(v) => patch("negative", v)} />
                <Check label="Auto-submit when time runs out" checked={!!s.autoSubmit} onChange={(v) => patch("autoSubmit", v)} />
                <Check label="Auto-close at deadline" detail="Force-submit when the scheduled window ends." checked={!!s.autoClose} onChange={(v) => patch("autoClose", v)} />
              </Group>
              <Group label="Results & watermark">
                <Check label="Show report to test-taker after test finishes" detail="Auto-release the score + answer key once submitted (overrides manual release)." checked={!!s.showReportToTaker} onChange={(v) => patch("showReportToTaker", v)} />
                <Check label="Make comments mandatory for manual evaluation" detail="Evaluators must leave a comment when grading descriptive answers." checked={!!s.commentsMandatory} onChange={(v) => patch("commentsMandatory", v)} />
                <Check label="Don't ask for feedback post test completion" checked={!!s.skipFeedback} onChange={(v) => patch("skipFeedback", v)} />
                <label className="mt-3 block text-[12px] text-ink-soft">Custom watermark text (optional)
                  <input value={s.watermarkText ?? ""} onChange={(e) => patch("watermarkText", e.target.value)} placeholder="e.g. Vignan Internal — do not share" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
                <label className="mt-3 block text-[12px] text-ink-soft">Redirect test-takers after finish (optional URL)
                  <input value={s.redirectAfter ?? ""} onChange={(e) => patch("redirectAfter", e.target.value)} placeholder="https://…" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
              </Group>
              <Group label="Security & access">
                <Check label="Require Photo ID verification" detail="Students capture their face and ID card before starting." checked={!!s.photoId} onChange={(v) => patch("photoId", v)} />
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block text-[12px] text-ink-soft">Max flags before action
                    <input type="number" min={1} max={20} value={s.violationLimit} onChange={(e) => patch("violationLimit", Math.max(1, Math.min(20, Number(e.target.value) || 3)))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                  </label>
                  <label className="block text-[12px] text-ink-soft">When threshold is met
                    <select value={s.violationAction} onChange={(e) => patch("violationAction", e.target.value as S["violationAction"])} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest">
                      <option value="warn">Warn student only</option><option value="submit">Auto-submit exam</option>
                    </select>
                  </label>
                </div>
              </Group>
            </>
          )}

          {dialog === "sections" && (
            <>
              <Group label="Question delivery">
                <label className="mt-2 block text-[12px] text-ink-soft">Questions per student
                  <input type="number" min={1} value={s.perStudent} onChange={(e) => patch("perStudent", Math.max(1, Number(e.target.value) || 1))} className="mt-1 block w-28 border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
                <Check label="Randomly select questions" detail="Each candidate gets a different set drawn from the pool." checked={!!s.randomSelect} onChange={(v) => patch("randomSelect", v)} />
                <Check label="Shuffle question order" checked={!!s.shuffleOrder} onChange={(v) => patch("shuffleOrder", v)} />
                <Check label="Shuffle answer options" checked={!!s.shuffleOptions} onChange={(v) => patch("shuffleOptions", v)} />
              </Group>
              <Group label="Sections">
                <Check label="Enable sections / groups" detail="Questions are grouped by type into sections on the paper." checked={!!s.sections} onChange={(v) => { patch("sections", v); if (!v) patch("sectionTiming", false); }} />
                {s.sections && <Check label="Enforce section time limits" detail="Individual countdown timers per section." checked={!!s.sectionTiming} onChange={(v) => patch("sectionTiming", v)} />}
                <Check label="Duration lock (strict)" detail="Prevent time-extension requests during the exam." checked={!!s.durationLock} onChange={(v) => patch("durationLock", v)} />
              </Group>
            </>
          )}

          {dialog === "registration" && (
            <div>
              <p className="text-[12px] leading-relaxed text-ink-soft">Fields below appear on the registration screen every candidate sees before the test. Fields marked required block the start until filled.</p>
              <div className="mt-4 space-y-1">
                <Check label="Email Address *" checked={s.regEmail !== false} onChange={(v) => patch("regEmail", v)} />
                <Check label="First & Last Name *" checked={s.regName !== false} onChange={(v) => patch("regName", v)} />
                <Check label="USN / Roll Number *" checked={s.regUsn !== false} onChange={(v) => patch("regUsn", v)} />
                <Check label="Terms & Conditions consent *" checked={s.regTerms !== false} onChange={(v) => patch("regTerms", v)} />
                <Check label="Photo ID verification" detail="Webcam capture of face + ID card (from Security & access)." checked={!!s.photoId} onChange={(v) => patch("photoId", v)} />
                <Check label="Allow QR-upload of answer images (mobile)" detail="Descriptive answers can be answered from the phone camera." checked={!!s.allowQrUpload} onChange={(v) => patch("allowQrUpload", v)} />
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-6 py-5">
          <button onClick={onClose} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-ink">Cancel</button>
          <button onClick={onSave} className="border border-forest bg-forest px-6 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-light">Save</button>
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="border-b border-line py-4 last:border-0"><p className="font-mono text-[10px] uppercase tracking-widest text-forest">{label}</p><div className="mt-2">{children}</div></div>;
}
function Check({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-3 flex cursor-pointer items-start justify-between gap-4 first:mt-0">
      <span><span className="block text-[13px] font-medium">{label}</span>{detail && <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{detail}</span>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-forest" />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview dialog
// ─────────────────────────────────────────────────────────────────────────────
function PreviewDialog({ exam, sections, questions, duration, perStudent, s, onClose }: {
  exam: ExamRecord; sections: { type: string; count: number; marks: number }[];
  questions: DBQuestion[]; duration: number; perStudent: number; s: S; onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? questions : questions.slice(0, 6);
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl border border-line-strong bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div><h2 className="font-serif text-2xl font-semibold">Preview — {exam.name}</h2><p className="mt-1 text-[12px] text-ink-soft">{exam.id} · {sections.length} section{sections.length === 1 ? "" : "s"} · {questions.length} questions · {duration} min</p></div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-ink-soft hover:text-ink">×</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
            {sections.map((sec) => (
              <div key={sec.type} className="bg-paper px-4 py-3">
                <p className="font-serif text-xl text-forest">{sec.count}</p>
                <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{sec.type}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 border border-forest bg-success/5 px-4 py-3 text-[12px] leading-relaxed">
            {s.randomSelect ? `Each candidate receives ${perStudent} questions drawn from the ${questions.length}-question pool, difficulty-balanced.` : `Each candidate receives the same ${perStudent} questions.`}
            {s.shuffleOrder ? " Question order is shuffled per candidate." : ""}{s.shuffleOptions ? " Options are shuffled too." : ""}
          </p>
          <div className="mt-4 divide-y divide-line border border-line">
            {shown.map((q, i) => (
              <div key={q.id} className="px-4 py-3">
                <div className="flex items-center gap-2"><span className="font-mono text-[10px] text-ink-soft">{i + 1}</span><span className="bg-paper-raised px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">{q.type}</span><span className={`px-1.5 py-0.5 font-mono text-[9px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>{q.difficulty}</span><span className="ml-auto font-mono text-[10px] text-ink-soft">{q.marks || 1} mark{q.marks === 1 ? "" : "s"}</span></div>
                <p className="mt-1.5 text-[13px] leading-relaxed">{q.title}</p>
              </div>
            ))}
          </div>
          {!showAll && questions.length > shown.length && (
            <button onClick={() => setShowAll(true)} className="mt-3 w-full border border-line-strong px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-forest">Show all {questions.length} questions</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish & share dialog
// ─────────────────────────────────────────────────────────────────────────────
function ShareDialog({ exam, name, duration, perStudent, pool, totalMarks, s, studentLink, onClose, notify, onResult }: {
  exam: ExamRecord; name: string; duration: number; perStudent: number; pool: number; totalMarks: number;
  s: S; studentLink: string; onClose: () => void; notify: (m: string) => void;
  onResult: (r: { status: string; when?: string; link: string; notified?: number }) => void;
}) {
  const [roster, setRoster] = useState<{ roll: string; full_name: string; email: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"all" | "manual">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [notifyStudents, setNotifyStudents] = useState(true);
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    void listStudentsByBatch(exam.batch).then((rows) => {
      if (!active) return;
      setRoster(rows.map((r) => ({ roll: r.roll, full_name: r.full_name, email: r.email })));
      setLoading(false);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam.id]);

  const allSelected = roster.length > 0 && selected.length === roster.length;
  const emails = mode === "all" ? roster.map((r) => r.email).filter(Boolean) : selected.map((roll) => roster.find((r) => r.roll === roll)?.email).filter((e): e is string => Boolean(e));
  const ready = pool > 0;

  const publish = async (status: "published" | "scheduled", whenIso: string | null, whenLabel?: string) => {
    if (busy) return;
    setBusy(true);
    const record: ExamRecord = {
      ...exam,
      name,
      status,
      duration_minutes: duration,
      per_student: perStudent,
      pool_count: pool,
      total_marks: totalMarks,
      scheduled_at: whenIso,
      join_link: studentLink,
      settings: { ...s } as unknown as Record<string, unknown>,
    };
    const res = await publishExam(record);
    let notified = 0;
    if (res.ok && notifyStudents && emails.length > 0) {
      const emailRes = await triggerExamEmail(exam.id);
      if (emailRes.ok) notified = emails.length;
    }
    setBusy(false);
    if (!res.ok) { notify("Publish failed: " + res.error); return; }
    notify(status === "scheduled" ? `Scheduled for ${whenLabel}` : notifyStudents && notified ? `Published — join link emailed to ${notified} students` : "Published — students can start now");
    onResult({ status, when: whenLabel, link: studentLink, notified: notifyStudents ? notified : 0 });
  };

  const visibleEmails = expanded ? emails : emails.slice(0, 5);

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl border border-line-strong bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div><h2 className="font-serif text-2xl font-semibold">Publish &amp; share — {name}</h2><p className="mt-1 text-[12px] text-ink-soft">{exam.id} · {exam.batch} · {pool} questions · {duration} min</p></div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-ink-soft hover:text-ink">×</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{pool}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Questions</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{perStudent}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Per student</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{totalMarks}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Marks</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{s.mode === "lockdown" ? <FiLock /> : <FiEdit3 />}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{s.mode}</p></div>
          </div>

          <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-forest">Who will take this test?</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <button onClick={() => setMode("all")} className={`border p-4 text-left ${mode === "all" ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}>
              <span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-full border ${mode === "all" ? "border-forest" : "border-line-strong"}`}>{mode === "all" && <span className="h-2 w-2 rounded-full bg-forest" />}</span><span className="text-[13px] font-medium">Entire {exam.batch} batch</span></span>
              <span className="mt-1 block pl-6 text-[11px] text-ink-soft">{loading ? "Loading roster…" : `${roster.length} students in this program`}</span>
            </button>
            <button onClick={() => setMode("manual")} className={`border p-4 text-left ${mode === "manual" ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}>
              <span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-full border ${mode === "manual" ? "border-forest" : "border-line-strong"}`}>{mode === "manual" && <span className="h-2 w-2 rounded-full bg-forest" />}</span><span className="text-[13px] font-medium">Hand-pick candidates</span></span>
              <span className="mt-1 block pl-6 text-[11px] text-ink-soft">Select specific students below</span>
            </button>
          </div>

          {mode === "manual" && (
            <div className="mt-3 border border-line p-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{selected.length} selected</p>
                <button onClick={() => setSelected(allSelected ? [] : roster.map((r) => r.roll))} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">{allSelected ? "Deselect all" : "Select all"}</button>
              </div>
              <div className="mt-2 max-h-44 space-y-0.5 overflow-y-auto">
                {roster.length === 0 && !loading && <p className="py-3 text-[12px] text-ink-soft">No students found in this batch yet — add candidates from the Students page first.</p>}
                {roster.map((st) => (
                  <label key={st.roll} className="flex cursor-pointer items-center gap-3 px-2 py-1.5 transition hover:bg-paper-raised">
                    <input type="checkbox" checked={selected.includes(st.roll)} onChange={() => setSelected((cur) => cur.includes(st.roll) ? cur.filter((r) => r !== st.roll) : [...cur, st.roll])} className="accent-forest" />
                    <span className="text-[13px]">{st.full_name} <span className="text-ink-soft">({st.roll})</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex items-start justify-between gap-4 border border-line bg-paper-raised px-4 py-4">
            <div>
              <p className="text-[13px] font-medium">Email the join link</p>
              <p className="mt-0.5 text-[11px] text-ink-soft">{notifyStudents ? `An email goes to ${emails.length} candidate${emails.length === 1 ? "" : "s"} when you publish.` : "No email is sent — share the link yourself."}</p>
            </div>
            <button role="switch" aria-checked={notifyStudents} onClick={() => setNotifyStudents((v) => !v)} className={`mt-1 flex h-6 w-11 shrink-0 items-center rounded-full border transition ${notifyStudents ? "justify-end border-forest bg-forest" : "justify-start border-line-strong bg-paper"}`}><span className="mx-0.5 h-4 w-4 rounded-full bg-paper" /></button>
          </div>
          {notifyStudents && emails.length > 0 && (
            <div className="mt-3 border border-line px-4 py-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Recipients preview</p>
              <div className="mt-1.5 space-y-0.5">
                {visibleEmails.map((e) => <p key={e} className="truncate font-mono text-[11px] text-ink-soft">{e}</p>)}
                {!expanded && emails.length > 5 && <button onClick={() => setExpanded(true)} className="font-mono text-[11px] text-forest hover:underline">+ {emails.length - 5} more…</button>}
              </div>
            </div>
          )}
          {notifyStudents && emails.length === 0 && <p className="mt-3 border border-amber/40 bg-amber/5 px-4 py-3 text-[12px] text-ink-soft">No student emails found for this batch — publish without email, then share the join link.</p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-ink-soft">Or schedule:
              <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="ml-1 border border-line-strong bg-paper px-2 py-2 text-[12px] outline-none focus:border-forest" />
              <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="ml-1 border border-line-strong bg-paper px-2 py-2 text-[12px] outline-none focus:border-forest" />
            </label>
            <button onClick={() => { if (schedDate && schedTime) void publish("scheduled", new Date(`${schedDate}T${schedTime}`).toISOString(), `${schedDate} · ${schedTime}`); }} disabled={!ready || !schedDate || !schedTime || busy} className={`border px-4 py-3 font-mono text-[10px] uppercase tracking-wider ${ready && schedDate && schedTime && !busy ? "border-line-strong text-ink-soft hover:border-forest hover:text-forest" : "cursor-not-allowed border-line text-ink-soft/40"}`}>◷ Schedule</button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-ink">Cancel</button>
            <button onClick={() => void publish("published", null)} disabled={!ready || busy} className={`inline-flex items-center justify-center gap-2 border px-6 py-3 font-mono text-[10px] uppercase tracking-wider ${ready && !busy ? "border-forest bg-forest text-paper hover:bg-forest-light" : "cursor-not-allowed border-line-strong bg-line/30 text-ink-soft"}`}>{busy ? "Publishing…" : notifyStudents && emails.length > 0 ? <><FiMail /> Publish &amp; email {emails.length}</> : <><FiCheck /> Publish now</>}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
