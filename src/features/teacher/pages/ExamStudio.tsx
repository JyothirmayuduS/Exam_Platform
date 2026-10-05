// ExamStudio — the Mettl-style paper builder for one test, in the Vignan theme.
// One page holds everything for building a test: search & add questions from
// the bank, a live composition table with metrics, duration, ADVANCE OPTIONS
// (Test options / Section options / Candidate registration fields dialogs),
// Save & exit, and Publish & share. Every number is computed from Supabase —
// no demo data.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiUpload, FiEdit3, FiEye, FiSettings, FiSearch, FiX, FiChevronDown, FiChevronRight, FiClock, FiLock, FiMail } from "react-icons/fi";
import PageLoader from "@/shared/components/PageLoader";
import "./ExamStudio.css";
import { Button, NumberField } from "@/shared/components/ui";
import {
  NEGATIVE_DEFAULTS,
  sectionOf,
  summarizeSections,
  type NegativeMode,
  type QuestionKind,
  type SectionSummary,
} from "@/shared/domain/exam";
import { NegativeMarkingFields, SectionList, SectionTimingFields } from "@/features/teacher/components/exam-studio/AdvancedFields";
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
} from "@/shared/data/examApi";

type S = {
  perStudent: number; randomSelect: boolean; shuffleOrder: boolean; shuffleOptions: boolean;
  autoSubmit: boolean; mode: "practice" | "lockdown"; attempts: number;
  negative: boolean; calculator: boolean; instantFeedback: boolean;
  photoId: boolean; violationLimitEnabled: boolean; violationLimit: number; violationAction: "warn" | "submit";
  releaseDate: string; ipWhitelist: string; sections: boolean; sectionTiming: boolean;
  autoClose: boolean; durationLock: boolean;
  language?: string; purpose?: string; assessmentType?: "timed" | "deadline"; deadline?: string;
  showReportToTaker?: boolean; commentsMandatory?: boolean; skipFeedback?: boolean; redirectAfter?: string;
  watermarkText?: string; fixedSectionOrder?: boolean; scratchpad?: boolean;
  allowQrUpload?: boolean; showMarksInTest?: boolean; showMarks?: boolean;
  regEmail?: boolean; regName?: boolean; regUsn?: boolean; regTerms?: boolean;
  negativeMode: NegativeMode; negativeMarks: number; negativeFraction: number; negativeKinds: QuestionKind[];
  sectionMinutes: Record<string, number>;
};

const DEFAULTS: S = {
  perStudent: 5, randomSelect: true, shuffleOrder: true, shuffleOptions: true, autoSubmit: true,
  mode: "lockdown", attempts: 1, negative: false, calculator: false, instantFeedback: false,
  photoId: false, violationLimitEnabled: false, violationLimit: 3, violationAction: "submit", releaseDate: "", ipWhitelist: "",
  sections: false, sectionTiming: false, autoClose: false, durationLock: true,
  language: "English", purpose: "Academic exam", assessmentType: "timed", deadline: "",
  showReportToTaker: false, commentsMandatory: false, skipFeedback: false, redirectAfter: "",
  watermarkText: "", fixedSectionOrder: false, scratchpad: false, allowQrUpload: false,
  showMarksInTest: true, showMarks: true, regEmail: true, regName: true, regUsn: true, regTerms: true,
  ...NEGATIVE_DEFAULTS, sectionMinutes: {},
};

const inputCls = "border border-line bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-soft/60 focus:border-forest";

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
  const titleRef = useRef<HTMLInputElement>(null);

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
  const sections = useMemo(() => summarizeSections(questions), [questions]);
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

  const showBankResults = search.trim() !== "";

  const bankMatches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return bank
      .filter((q) => !inPool.has(q.id))
      .filter((q) => (term ? `${q.id} ${q.title} ${q.unit ?? ""} ${q.exam_name ?? ""}`.toLowerCase().includes(term) : true))
      .filter((q) => (typeFilter === "All" || q.type === typeFilter))
      .filter((q) => (diffFilter === "All" || (q.difficulty || "Medium") === diffFilter))
      .slice(0, 10);
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

  if (loading) return <PageLoader label="Loading paper builder" />;
  if (!exam) return <div className="border border-dashed border-line p-14 text-center"><p className="font-serif text-xl">Test not found</p><p className="mt-2 text-[13px] text-soft">It may have been deleted.</p></div>;

  return (
    <div className="exam-build">
      <header className="exam-build-header">
        <div className="exam-build-title">
          <Button size="sm" variant="ghost" icon={<FiArrowLeft />} onClick={() => navigate(`/teacher/exams/${examId}`)}>Back to test</Button>
          <div className="exam-build-title-row">
            <span className="shrink-0 border border-line bg-raised px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-soft">{exam.id}</span>
            <input
              ref={titleRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Test name"
              className="border border-transparent bg-transparent px-1 font-serif text-[1.5rem] font-semibold leading-none tracking-tight text-ink outline-none hover:border-line focus:border-forest"
            />
            <button
              type="button"
              aria-label="Rename test"
              title="Rename test"
              onClick={() => { titleRef.current?.focus(); titleRef.current?.select(); }}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-soft hover:bg-raised hover:text-forest"
            >
              <FiEdit3 size={14} aria-hidden />
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-none text-soft">
            {exam.batch} · {String(s.language ?? "English")} · {String(s.purpose ?? "")} ·{" "}
            <span className={exam.status === "draft" ? "text-amber" : "text-success"}>{exam.status}</span>
          </p>
        </div>
        <div className="exam-build-header-actions">
          <Button size="sm" variant="secondary" onClick={() => void saveAndExit()} disabled={saving} icon={<FiCheck />}>
            {saving ? "Saving…" : "Save & exit"}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setShareOpen(true)} iconRight={<FiArrowRight />}>
            Publish &amp; share
          </Button>
        </div>
      </header>

      <section className="exam-build-toolbar" aria-label="Add questions">
        <div className="exam-build-toolbar-top">
          <label htmlFor="question-bank-search" className="text-[13px] font-medium text-ink">Search and add questions</label>
          <span className="font-mono text-[9px] uppercase tracking-widest text-soft">Question bank</span>
        </div>
        <div className="exam-build-search">
          <FiSearch className="exam-build-search-icon" size={15} aria-hidden />
          <input
            id="question-bank-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a question, ID, unit or the test it came from…"
            className={inputCls}
          />
          {showBankResults && (
            <div className="exam-build-search-panel" onMouseDown={(e) => e.preventDefault()}>
              {bankMatches.length === 0 ? (
                <p className="px-4 py-3 text-[12px] text-soft">No matching questions in your bank.</p>
              ) : (
                bankMatches.map((q) => (
                  <button
                    type="button"
                    key={q.id}
                    onClick={() => { addToPool(q.id); setSearch(""); }}
                    className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-raised"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-soft">{q.id}</span>
                        <span className="bg-raised px-1.5 py-0.5 font-mono text-[9px] text-soft">{q.type}</span>
                        <span className={`font-mono text-[9px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>
                          {q.difficulty ?? "Medium"}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-snug">{q.title}</p>
                    </div>
                    <span className="shrink-0 border border-forest px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-forest">Add</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="exam-build-bar">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className="exam-build-select">
            <option value="All">All types</option>
            <option>MCQ</option><option>MSQ</option><option>Numerical</option><option>True / False</option><option>Subjective</option><option>Coding</option>
          </select>
          <select value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)} aria-label="Filter by difficulty" className="exam-build-select">
            <option value="All">All levels</option>
            <option>Easy</option><option>Medium</option><option>Hard</option>
          </select>
          <Button size="sm" icon={<FiEdit3 />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>
            Write new question
          </Button>
          <Button size="sm" variant="secondary" icon={<FiUpload />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&bulk=1&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>
            Import CSV
          </Button>
          <span className="exam-build-grow" aria-hidden />
          <label className="exam-build-duration">
            <span>Duration (min)</span>
            <NumberField value={duration} onChange={setDuration} min={1} max={600} fallback={duration} aria-label="Test duration in minutes" />
          </label>
          <Button size="sm" variant="secondary" icon={<FiEye />} onClick={() => setPreviewOpen(true)}>Preview</Button>
          <div className="exam-build-menu">
            <Button size="sm" variant="secondary" icon={<FiSettings />} iconRight={<FiChevronDown />} onClick={() => setMenuOpen((o) => !o)}>
              Advanced options
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full z-30 mt-1 w-72 border border-line bg-paper py-1 shadow-xl">
                  {([
                    ["test", "Test Options", "Duration, mode, marking, results & calculator"],
                    ["sections", "Section Options", "Random draw, shuffle, section order & timing"],
                    ["registration", "Candidate Registration Fields", "What candidates fill in before the test"],
                  ] as const).map(([key, label, detail]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => { setMenuOpen(false); setDialog(key); }}
                      className="flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left hover:bg-raised"
                    >
                      <span>
                        <span className="block text-[13px] font-medium">{label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-soft">{detail}</span>
                      </span>
                      <FiChevronRight className="mt-0.5 shrink-0 text-soft" aria-hidden />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="exam-build-metrics" role="group" aria-label="Paper summary">
        <BuildMetric value={String(sections.length)} label="Sections" detail={sections.length ? sections.map((x) => x.name).join(" · ") : "none yet"} />
        <BuildMetric value={String(topics.size)} label="Topics / skills" detail={topics.size ? Array.from(topics).slice(0, 3).join(" · ") : "none yet"} />
        <BuildMetric value={String(questions.length)} label="Questions" detail={questions.length ? `${perStudent} per student` : "add some above"} highlight />
        <BuildMetric value={String(totalMarks)} label="Marks" detail={s.negative ? "negative marking on" : "no negative marking"} highlight />
      </div>

      <div className="exam-build-table-wrap">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <thead>
            <tr>
              <th>Section</th>
              <th>Question</th>
              <th className="hidden md:table-cell">Skill / Unit</th>
              <th className="hidden lg:table-cell">Source</th>
              <th>Level</th>
              <th className="hidden sm:table-cell">Q-Type</th>
              <th className="text-right">Marks</th>
              <th className="w-24 text-right" />
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id} className="border-b border-line last:border-0 hover:bg-raised/50">
                <td>
                  <span className="inline-block bg-forest/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-forest">{sectionOf(q)}</span>
                </td>
                <td className="max-w-[360px]">
                  <span className="font-mono text-[10px] text-soft">{q.id}</span>
                  <p className="mt-0.5 line-clamp-2">{q.title}</p>
                </td>
                <td className="hidden text-soft md:table-cell">{q.unit || "General"}</td>
                <td className="hidden font-mono text-[10px] uppercase text-soft lg:table-cell">Self</td>
                <td>
                  <span className={`font-mono text-[10px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>{q.difficulty ?? "Medium"}</span>
                </td>
                <td className="hidden font-mono text-[10px] text-soft sm:table-cell">{q.type}</td>
                <td className="text-right tabular-nums">{q.marks || 1}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<FiEdit3 />} onClick={() => navigate(`/teacher/questions/new?exam=${examId}&edit=${q.id}&back=${encodeURIComponent(`/teacher/exams/${examId}/build`)}`)}>Edit</Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${q.id}`} className="text-alert hover:bg-alert/10" onClick={() => removeFromPool(q.id)} icon={<FiX />} />
                  </div>
                </td>
              </tr>
            ))}
            {questions.length === 0 && (
              <tr>
                <td colSpan={8} className="py-10 text-center">
                  <p className="font-serif text-lg text-forest">Your paper is empty</p>
                  <p className="mx-auto mt-1.5 max-w-md text-[12px] text-soft">Search your question bank above, write a new question, or import a CSV. Section rows appear here as you add them.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="exam-build-table-foot">
          <p className="font-mono text-[9px] uppercase tracking-widest text-soft">Tip: rows are grouped by section — questions of the same type form one section for candidates.</p>
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
          sections={sections}
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
          <div className="w-full max-w-xl border border-line bg-paper shadow-2xl">
            <div className={`px-8 py-10 text-center ${result.status === "draft" ? "" : "bg-success/5"}`}>
              <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-none text-paper ${result.status === "scheduled" ? "bg-amber" : "bg-success"}`}>{result.status === "scheduled" ? <FiClock size={24} /> : <FiCheck size={24} />}</span>
              <h2 className="mt-4 font-serif text-3xl font-semibold">{result.status === "scheduled" ? "Test scheduled" : result.status === "draft" ? "Draft saved" : "Test published"}</h2>
              <p className="mt-2 text-[13px] text-soft">{result.status === "scheduled" ? `${name} opens on ${result.when}.` : result.status === "draft" ? `Draft of ${name} saved.` : `${name} is live now for ${exam.batch}.`}</p>
            </div>
            <div className="border-t border-line px-6 py-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Candidate join link</p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <code className="min-w-0 flex-1 truncate border border-line bg-raised px-3 py-3 font-mono text-[12px]">{result.link}</code>
                <button onClick={() => { navigator.clipboard?.writeText(result.link).catch(() => undefined); notify("Join link copied"); }} className="border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-soft">Copy link</button>
              </div>
              {typeof result.notified === "number" && result.notified > 0 && <p className="mt-3 border border-forest bg-success/5 px-4 py-3 text-[12px]">Join link emailed to {result.notified} students.</p>}
              {typeof result.notified === "number" && result.notified === 0 && <p className="mt-3 border border-line bg-raised px-4 py-3 text-[12px] text-soft">No email sent — share the join link above.</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-6 py-5">
              <button onClick={() => { setResult(null); navigate(`/teacher/exams/${examId}`); }} className="border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-soft transition hover:border-forest hover:text-forest">Done — test overview</button>
              <button onClick={() => setResult(null)} className="border border-forest bg-forest px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-soft">Keep building</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BuildMetric({ value, label, detail, highlight }: { value: string; label: string; detail: string; highlight?: boolean }) {
  return (
    <div className="exam-build-metric">
      <p className={`exam-build-metric-value ${highlight ? "is-accent" : ""}`}>{value}</p>
      <div className="exam-build-metric-copy">
        <p className="exam-build-metric-label">{label}</p>
        <p className="exam-build-metric-detail" title={detail}>{detail}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings dialog (Advance options / Test / Section / Registration fields)
// ─────────────────────────────────────────────────────────────────────────────
function SettingsDialog({ dialog, s, patch, duration, setDuration, examName, sections, onClose, onSave }: {
  dialog: "test" | "sections" | "registration";
  s: S; patch: <K extends keyof S>(k: K, v: S[K]) => void;
  duration: number; setDuration: (n: number) => void; examName: string;
  sections: SectionSummary[];
  onClose: () => void; onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl border border-line bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <h2 className="font-serif text-2xl font-semibold">{dialog === "test" ? "Test Options" : dialog === "sections" ? "Section Options" : "Candidate Registration Fields"}</h2>
            <p className="mt-1 text-[12px] text-soft">for {examName}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-soft transition hover:text-ink">×</button>
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto px-6 py-4">
          {dialog === "test" && (
            <>
              <Group label="Exam mode">
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["practice", "lockdown"] as const).map((m) => (
                    <button key={m} onClick={() => patch("mode", m)} className={`border p-3 text-left ${s.mode === m ? "border-forest bg-success/5" : "border-line hover:border-line"}`}>
                      <span className="block text-[13px] font-medium capitalize">{m}</span>
                      <span className="mt-0.5 block text-[11px] text-soft">{m === "lockdown" ? "Proctored, single attempt" : "Relaxed, retakes allowed"}</span>
                    </button>
                  ))}
                </div>
              </Group>
              <Group label="Duration">
                <label className="mt-2 block text-[12px] text-soft">Minutes
                  <NumberField value={duration} onChange={setDuration} min={1} max={600} fallback={duration} aria-label="Minutes" className="mt-1 block w-28 border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
              </Group>
              <Group label="Test options">
                <Check label="Provide on-screen calculator & rough sheet to test-takers" detail="A basic calculator and scratch pad are shown in the exam." checked={!!s.calculator} onChange={(v) => patch("calculator", v)} />
                <Check label="Show marks in test" detail="Candidates see the marks of each question while answering." checked={s.showMarksInTest !== false && s.showMarks !== false} onChange={(v) => { patch("showMarksInTest", v); patch("showMarks", v); }} />
                <Check label="Fixed section order for test-takers" detail="Sections always appear in the same order — no shuffling between candidates." checked={!!s.fixedSectionOrder} onChange={(v) => patch("fixedSectionOrder", v)} />
                <Check label="Enable negative marking (incorrect grade)" detail="Deduct marks for a wrong auto-graded answer." checked={!!s.negative} onChange={(v) => patch("negative", v)} />
                {s.negative && (
                  <NegativeMarkingFields
                    value={{ negativeMode: s.negativeMode, negativeMarks: s.negativeMarks, negativeFraction: s.negativeFraction, negativeKinds: s.negativeKinds }}
                    onChange={(p) => (Object.keys(p) as (keyof typeof p)[]).forEach((k) => patch(k, p[k] as S[typeof k]))}
                  />
                )}
                <Check label="Auto-submit when time runs out" checked={!!s.autoSubmit} onChange={(v) => patch("autoSubmit", v)} />
                <Check label="Auto-close at deadline" detail="Force-submit when the scheduled window ends." checked={!!s.autoClose} onChange={(v) => patch("autoClose", v)} />
              </Group>
              <Group label="Results & watermark">
                <Check label="Show report to test-taker after test finishes" detail="Auto-release the score + answer key once submitted (overrides manual release)." checked={!!s.showReportToTaker} onChange={(v) => patch("showReportToTaker", v)} />
                <Check label="Make comments mandatory for manual evaluation" detail="Evaluators must leave a comment when grading descriptive answers." checked={!!s.commentsMandatory} onChange={(v) => patch("commentsMandatory", v)} />
                <Check label="Don't ask for feedback post test completion" checked={!!s.skipFeedback} onChange={(v) => patch("skipFeedback", v)} />
                <label className="mt-3 block text-[12px] text-soft">Custom watermark text (optional)
                  <input value={s.watermarkText ?? ""} onChange={(e) => patch("watermarkText", e.target.value)} placeholder="e.g. {registration number} · {name} — do not share" className="mt-1 block w-full border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                  <span className="mt-1.5 block text-[11px] leading-snug text-soft">
                    Placeholders are filled with each candidate's own details and tiled across their exam screen. Supported: <code className="bg-raised px-1">{"{"}name{"}"}</code> <code className="bg-raised px-1">{"{"}registration number{"}"}</code> <code className="bg-raised px-1">{"{"}email{"}"}</code> <code className="bg-raised px-1">{"{"}exam{"}"}</code> <code className="bg-raised px-1">{"{"}date{"}"}</code>. Example: <code className="bg-raised px-1">{"{"}registration number{"}"} {"{"}name{"}"}</code> / <span className="whitespace-nowrap">221FA12345 · Ravi Teja</span>.
                  </span>
                </label>
                <label className="mt-3 block text-[12px] text-soft">Redirect test-takers after finish (optional URL)
                  <input value={s.redirectAfter ?? ""} onChange={(e) => patch("redirectAfter", e.target.value)} placeholder="https://…" className="mt-1 block w-full border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
              </Group>
              <Group label="Security & access">
                <Check label="Require Photo ID verification" detail="Students capture their face and ID card before starting." checked={!!s.photoId} onChange={(v) => patch("photoId", v)} />
                <Check
                  label="Take action after a number of proctoring flags"
                  detail="Off: flags are only recorded. On: when a candidate crosses the flag limit below, warn them or auto-submit the exam."
                  checked={!!s.violationLimitEnabled}
                  onChange={(v) => patch("violationLimitEnabled", v)}
                />
                <div className={`mt-3 grid gap-3 sm:grid-cols-2 ${s.violationLimitEnabled ? "" : "pointer-events-none opacity-40"}`} aria-disabled={!s.violationLimitEnabled}>
                  <label className="block text-[12px] text-soft">Max flags before action
                    <NumberField value={Number(s.violationLimit) || 3} onChange={(n) => patch("violationLimit", n)} min={1} max={20} fallback={Number(s.violationLimit) || 3} aria-label="Max flags before action" className="mt-1 block w-full border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                  </label>
                  <label className="block text-[12px] text-soft">When threshold is met
                    <select value={s.violationAction} onChange={(e) => patch("violationAction", e.target.value as S["violationAction"])} className="mt-1 block w-full border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest">
                      <option value="warn">Warn student only</option><option value="submit">Auto-submit exam</option>
                    </select>
                  </label>
                </div>
                {!s.violationLimitEnabled && <p className="mt-2 text-[11px] text-soft">Tick the checkbox above to enable the flag limit — until then proctoring flags are logged but never trigger an action.</p>}
              </Group>
            </>
          )}

          {dialog === "sections" && (
            <>
              <Group label="Question delivery">                  <label className="mt-2 block text-[12px] text-soft">Questions per student
                  <NumberField value={Number(s.perStudent) || 1} onChange={(n) => patch("perStudent", n)} min={1} max={500} fallback={Number(s.perStudent) || 1} aria-label="Questions per student" className="mt-1 block w-28 border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest" />
                </label>
                <Check label="Randomly select questions" detail="Each candidate gets a different set drawn from the pool." checked={!!s.randomSelect} onChange={(v) => patch("randomSelect", v)} />
                <Check label="Shuffle question order" checked={!!s.shuffleOrder} onChange={(v) => patch("shuffleOrder", v)} />
                <Check label="Shuffle answer options" checked={!!s.shuffleOptions} onChange={(v) => patch("shuffleOptions", v)} />
              </Group>
              <Group label="Sections">
                <Check label="Enable sections / groups" detail="Questions are grouped into one section per question type." checked={!!s.sections} onChange={(v) => { patch("sections", v); if (!v) patch("sectionTiming", false); }} />
                {s.sections && <SectionList sections={sections} />}
                {s.sections && <Check label="Enforce section time limits" detail="Each section gets its own countdown. When it ends the candidate moves on and cannot go back." checked={!!s.sectionTiming} onChange={(v) => patch("sectionTiming", v)} />}
                {s.sections && s.sectionTiming && <SectionTimingFields sections={sections} minutes={s.sectionMinutes ?? {}} duration={duration} onChange={(m) => patch("sectionMinutes", m)} />}
                <Check label="Duration lock (strict)" detail="Prevent time-extension requests during the exam." checked={!!s.durationLock} onChange={(v) => patch("durationLock", v)} />
              </Group>
            </>
          )}

          {dialog === "registration" && (
            <div>
              <p className="text-[12px] leading-relaxed text-soft">Fields below appear on the registration screen every candidate sees before the test. Fields marked required block the start until filled.</p>
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
          <button onClick={onClose} className="border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-soft transition hover:border-forest hover:text-ink">Cancel</button>
          <button onClick={onSave} className="border border-forest bg-forest px-6 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-soft">Save</button>
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
      <span><span className="block text-[13px] font-medium">{label}</span>{detail && <span className="mt-0.5 block text-[11px] leading-snug text-soft">{detail}</span>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-forest" />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview dialog
// ─────────────────────────────────────────────────────────────────────────────
function PreviewDialog({ exam, sections, questions, duration, perStudent, s, onClose }: {
  exam: ExamRecord; sections: SectionSummary[];
  questions: DBQuestion[]; duration: number; perStudent: number; s: S; onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? questions : questions.slice(0, 6);
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl border border-line bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div><h2 className="font-serif text-2xl font-semibold">Preview — {exam.name}</h2><p className="mt-1 text-[12px] text-soft">{exam.id} · {sections.length} section{sections.length === 1 ? "" : "s"} · {questions.length} questions · {duration} min</p></div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-soft hover:text-ink">×</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
            {sections.map((sec) => (
              <div key={sec.name} className="bg-paper px-4 py-3">
                <p className="font-serif text-xl text-forest">{sec.count}</p>
                <p className="font-mono text-[9px] uppercase tracking-wider text-soft">{sec.name}</p>
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
                <div className="flex items-center gap-2"><span className="font-mono text-[10px] text-soft">{i + 1}</span><span className="bg-raised px-1.5 py-0.5 font-mono text-[9px] text-soft">{q.type}</span><span className={`px-1.5 py-0.5 font-mono text-[9px] ${q.difficulty === "Easy" ? "text-success" : q.difficulty === "Hard" ? "text-alert" : "text-amber"}`}>{q.difficulty}</span><span className="ml-auto font-mono text-[10px] text-soft">{q.marks || 1} mark{q.marks === 1 ? "" : "s"}</span></div>
                <p className="mt-1.5 text-[13px] leading-relaxed">{q.title}</p>
              </div>
            ))}
          </div>
          {!showAll && questions.length > shown.length && (
            <button onClick={() => setShowAll(true)} className="mt-3 w-full border border-line px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-soft transition hover:border-forest hover:text-forest">Show all {questions.length} questions</button>
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
      <div className="w-full max-w-2xl border border-line bg-paper shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div><h2 className="font-serif text-2xl font-semibold">Publish &amp; share — {name}</h2><p className="mt-1 text-[12px] text-soft">{exam.id} · {exam.batch} · {pool} questions · {duration} min</p></div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-soft hover:text-ink">×</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{pool}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Questions</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{perStudent}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Per student</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{totalMarks}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Marks</p></div>
            <div className="bg-paper px-4 py-3"><p className="font-serif text-xl">{s.mode === "lockdown" ? <FiLock /> : <FiEdit3 />}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">{s.mode}</p></div>
          </div>

          <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-forest">Who will take this test?</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <button onClick={() => setMode("all")} className={`border p-4 text-left ${mode === "all" ? "border-forest bg-success/5" : "border-line hover:border-line"}`}>
              <span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-none border ${mode === "all" ? "border-forest" : "border-line"}`}>{mode === "all" && <span className="h-2 w-2 rounded-none bg-forest" />}</span><span className="text-[13px] font-medium">Entire {exam.batch} batch</span></span>
              <span className="mt-1 block pl-6 text-[11px] text-soft">{loading ? "Loading roster…" : `${roster.length} students in this program`}</span>
            </button>
            <button onClick={() => setMode("manual")} className={`border p-4 text-left ${mode === "manual" ? "border-forest bg-success/5" : "border-line hover:border-line"}`}>
              <span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-none border ${mode === "manual" ? "border-forest" : "border-line"}`}>{mode === "manual" && <span className="h-2 w-2 rounded-none bg-forest" />}</span><span className="text-[13px] font-medium">Hand-pick candidates</span></span>
              <span className="mt-1 block pl-6 text-[11px] text-soft">Select specific students below</span>
            </button>
          </div>

          {mode === "manual" && (
            <div className="mt-3 border border-line p-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[9px] uppercase tracking-wider text-soft">{selected.length} selected</p>
                <button onClick={() => setSelected(allSelected ? [] : roster.map((r) => r.roll))} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">{allSelected ? "Deselect all" : "Select all"}</button>
              </div>
              <div className="mt-2 max-h-44 space-y-0.5 overflow-y-auto">
                {roster.length === 0 && !loading && <p className="py-3 text-[12px] text-soft">No students found in this batch yet — add candidates from the Students page first.</p>}
                {roster.map((st) => (
                  <label key={st.roll} className="flex cursor-pointer items-center gap-3 px-2 py-1.5 transition hover:bg-raised">
                    <input type="checkbox" checked={selected.includes(st.roll)} onChange={() => setSelected((cur) => cur.includes(st.roll) ? cur.filter((r) => r !== st.roll) : [...cur, st.roll])} className="accent-forest" />
                    <span className="text-[13px]">{st.full_name} <span className="text-soft">({st.roll})</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex items-start justify-between gap-4 border border-line bg-raised px-4 py-4">
            <div>
              <p className="text-[13px] font-medium">Email the join link</p>
              <p className="mt-0.5 text-[11px] text-soft">{notifyStudents ? `An email goes to ${emails.length} candidate${emails.length === 1 ? "" : "s"} when you publish.` : "No email is sent — share the link yourself."}</p>
            </div>
            <button role="switch" aria-checked={notifyStudents} onClick={() => setNotifyStudents((v) => !v)} className={`mt-1 flex h-6 w-11 shrink-0 items-center rounded-none border transition ${notifyStudents ? "justify-end border-forest bg-forest" : "justify-start border-line bg-paper"}`}><span className="mx-0.5 h-4 w-4 rounded-none bg-paper" /></button>
          </div>
          {notifyStudents && emails.length > 0 && (
            <div className="mt-3 border border-line px-4 py-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-soft">Recipients preview</p>
              <div className="mt-1.5 space-y-0.5">
                {visibleEmails.map((e) => <p key={e} className="truncate font-mono text-[11px] text-soft">{e}</p>)}
                {!expanded && emails.length > 5 && <button onClick={() => setExpanded(true)} className="font-mono text-[11px] text-forest hover:underline">+ {emails.length - 5} more…</button>}
              </div>
            </div>
          )}
          {notifyStudents && emails.length === 0 && <p className="mt-3 border border-amber/40 bg-amber/5 px-4 py-3 text-[12px] text-soft">No student emails found for this batch — publish without email, then share the join link.</p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-soft">Or schedule:
              <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="ml-1 border border-line bg-paper px-2 py-2 text-[12px] outline-none focus:border-forest" />
              <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="ml-1 border border-line bg-paper px-2 py-2 text-[12px] outline-none focus:border-forest" />
            </label>
            <button onClick={() => { if (schedDate && schedTime) void publish("scheduled", new Date(`${schedDate}T${schedTime}`).toISOString(), `${schedDate} · ${schedTime}`); }} disabled={!ready || !schedDate || !schedTime || busy} className={`border px-4 py-3 font-mono text-[10px] uppercase tracking-wider ${ready && schedDate && schedTime && !busy ? "border-line text-soft hover:border-forest hover:text-forest" : "cursor-not-allowed border-line text-soft/40"}`}>◷ Schedule</button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-soft transition hover:border-forest hover:text-ink">Cancel</button>
            <button onClick={() => void publish("published", null)} disabled={!ready || busy} className={`inline-flex items-center justify-center gap-2 border px-6 py-3 font-mono text-[10px] uppercase tracking-wider ${ready && !busy ? "border-forest bg-forest text-paper hover:bg-forest-soft" : "cursor-not-allowed border-line bg-line/30 text-soft"}`}>{busy ? "Publishing…" : notifyStudents && emails.length > 0 ? <><FiMail /> Publish &amp; email {emails.length}</> : <><FiCheck /> Publish now</>}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
