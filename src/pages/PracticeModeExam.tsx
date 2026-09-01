import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { loadExamBundle, type DBQuestion } from "../lib/examApi";

type AnswerMap = Record<string, string>;

const NAV = [
  { label: "Overview", to: "/student", end: true },
  { label: "My exams", to: "/student/exams" },
  { label: "Results", to: "/student/results" },
  { label: "Help & support", to: "/student/help" },
];

const FALLBACK: DBQuestion[] = [
  {
    id: "P1",
    exam_id: "practice",
    title: "Binary search complexity on sorted array?",
    type: "mcq",
    unit: "Algorithms",
    difficulty: "easy",
    marks: 1,
    options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"],
    answer: "O(log n)",
  },
];

export default function PracticeModeExam() {
  const { examId = "" } = useParams();
  const [title, setTitle] = useState("Practice Mode");
  const [questions, setQuestions] = useState<DBQuestion[]>(FALLBACK);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    void loadExamBundle(examId).then(({ exam, questions: rows }) => {
      if (!active) return;
      if (exam?.name) setTitle(`${exam.name} · Practice Mode`);
      if (rows.length > 0) {
        setQuestions(rows);
      }
    });
    return () => {
      active = false;
    };
  }, [examId]);

  const score = useMemo(() => {
    const total = questions.filter((q) => q.answer).length;
    const correct = questions.filter((q) => {
      const expected = (q.answer ?? "").trim().toLowerCase();
      const actual = (answers[q.id] ?? "").trim().toLowerCase();
      return !!expected && expected === actual;
    }).length;
    return { correct, total };
  }, [answers, questions]);

  return (
    <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={NAV}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">No grading · no timer · no proctoring</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">{title}</h1>
        </div>
        <Link to={`/student/exams/${examId}`} className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">
          Back to exam details
        </Link>
      </div>

      <div className="mt-6 space-y-4">
        {questions.map((q, index) => (
          <section key={q.id} className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question {index + 1}</p>
            <p className="mt-2 font-medium">{q.title}</p>

            {(q.options ?? []).length > 0 ? (
              <div className="mt-3 space-y-2">
                {(q.options ?? []).map((option) => (
                  <label key={option} className="flex items-center gap-2 text-[13px] text-ink-soft">
                    <input
                      type="radio"
                      name={q.id}
                      checked={answers[q.id] === option}
                      onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: option }))}
                    />
                    {option}
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                className="mt-3 h-24 w-full border border-line bg-paper-raised p-2 text-[13px]"
                placeholder="Type your practice answer"
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              />
            )}

            {submitted && (
              <div className="mt-3 border border-line bg-paper-raised p-3 text-[13px] text-ink-soft">
                <p>Correct answer: {(q.answer ?? "N/A") || "N/A"}</p>
                {q.answer && (
                  <p className={answers[q.id]?.trim().toLowerCase() === q.answer.trim().toLowerCase() ? "text-success" : "text-alert"}>
                    {answers[q.id]?.trim().toLowerCase() === q.answer.trim().toLowerCase()
                      ? "Great! Your answer is correct."
                      : "Review this concept and try once more."}
                  </p>
                )}
              </div>
            )}
          </section>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setSubmitted(true)}
          className="border border-maroon bg-maroon px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
        >
          Show answers
        </button>
        {submitted && (
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">
            Score (practice): {score.correct}/{score.total}
          </p>
        )}
      </div>
    </RoleLayout>
  );
}
