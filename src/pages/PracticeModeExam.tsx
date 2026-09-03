import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { loadExamBundle, type DBQuestion } from "../lib/examApi";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";
import SubjectiveQRBlock from "../components/exam/SubjectiveQRBlock";

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
  const { profile } = useCurrentProfile();
  const [title, setTitle] = useState("Practice Mode");
  const [questions, setQuestions] = useState<DBQuestion[]>(FALLBACK);
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    const saved = sessionStorage.getItem(`practice_answers_${examId}`);
    try {
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    sessionStorage.setItem(`practice_answers_${examId}`, JSON.stringify(answers));
  }, [answers, examId]);

  const [submitted, setSubmitted] = useState(false);

  const [attemptId, setAttemptId] = useState<string | undefined>(() => {
    return sessionStorage.getItem(`practice_attempt_${examId}`) || undefined;
  });

  useEffect(() => {
    let active = true;
    void loadExamBundle(examId).then(({ exam, questions: rows }) => {
      if (!active) return;
      if (exam?.name) setTitle(`${exam.name} · Practice Mode`);
      if (rows.length > 0) {
        setQuestions(rows);
      }
    });

    const initPracticeAttempt = async () => {
      if (attemptId) return; // Use existing from session
      const studentId = profile?.id ?? "175741ff-ad12-4c01-aea3-8df6b55d1e74";
      const db = (await import("../lib/supabase")).getSupabase();
      if (db) {
        const id = await (await import("../lib/examApi")).startAttempt({
          examId: examId || "EXAM-2026-014",
          studentId: studentId,
          total: questions.length || 1
        });
        
        if (!id) {
          console.error("PracticeMode: Failed to initialize dummy attempt for student:", studentId);
        }
        
        if (id && active) {
          setAttemptId(id);
          sessionStorage.setItem(`practice_attempt_${examId}`, id);
        }
      }
    };
    initPracticeAttempt();

    return () => {
      active = false;
    };
  }, [examId, profile?.id]);

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
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#7A1F2B" items={NAV}>
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
            ) : answers[q.id]?.startsWith("[Uploaded answer:") ? (
              <div className="mt-3 space-y-4">
                <div className="border border-line bg-paper-raised p-4">
                  <div className="flex justify-between items-center mb-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-bold">✓ Handwritten Answer Uploaded</p>
                    <button 
                      onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: "" }))}
                      className="border border-alert text-alert px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-alert/10"
                    >
                      Remove & Retake
                    </button>
                  </div>
                  <iframe 
                    src={`${answers[q.id].replace("[Uploaded answer: ", "").replace("]", "")}#toolbar=0`} 
                    className="w-full h-[500px] border border-line bg-ink" 
                    title="Uploaded Answer"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                {(!q.subjective_mode || q.subjective_mode === "both" || q.subjective_mode === "textbox") && (
                  <div>
                    <label className="block font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-1.5">
                      {q.subjective_mode === "both" ? "Option 1: Type answer directly" : "Type your answer"}
                    </label>
                    <textarea
                      className="h-24 w-full border border-line bg-paper-raised p-2 text-[13px] outline-none focus:border-forest"
                      placeholder="Type your practice answer"
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  </div>
                )}

                {(!q.subjective_mode || q.subjective_mode === "both" || q.subjective_mode === "qr") && (
                  <div>
                    <label className="block font-mono text-[10px] uppercase tracking-wider text-ink-soft mb-1.5">
                      {q.subjective_mode === "both"
                        ? "Option 2: Scan QR & upload handwritten answer from mobile phone"
                        : "Scan QR & upload handwritten answer from mobile phone"}
                    </label>
                    <SubjectiveQRBlock
                      examId={examId || "EXAM-2026-014"}
                      attemptId={attemptId}
                      questionId={q.id}
                      questionIndex={index + 1}
                      studentId={profile?.id ?? "175741ff-ad12-4c01-aea3-8df6b55d1e74"}
                      studentName={profile?.full_name ?? "Prototype Student"}
                      examName={title.replace(" · Practice Mode", "")}
                      questionText={q.title}
                      onAnswerUploaded={(url) => {
                        setAnswers((prev) => ({ ...prev, [q.id]: `[Uploaded answer: ${url}]` }));
                      }}
                    />
                  </div>
                )}
              </div>
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
