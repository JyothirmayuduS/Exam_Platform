import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import ExamCountdown from "@/features/student/components/ExamCountdown";
import SystemCheckPage from "@/shared/components/SystemCheckPage";
import { loadExamForStudent, type ExamRecord } from "@/shared/data/examApi";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { STUDENT_NAV, STUDENT_TONE } from "@/features/student/pages/StudentExams";

function canStartExam(exam: ExamRecord | null): boolean {
  if (!exam) return false;
  if (!exam.scheduled_at) return exam.status === "published";
  const start = new Date(exam.scheduled_at).getTime();
  const end = start + exam.duration_minutes * 60 * 1000;
  const now = Date.now();
  return now >= start - 15 * 60 * 1000 && now <= end;
}

export default function StudentExamDetail() {
  const { examId = "" } = useParams();
  const { profile } = useCurrentProfile();
  const [exam, setExam] = useState<ExamRecord | null>(null);
  const [questionCount, setQuestionCount] = useState(0);

  useEffect(() => {
    let active = true;
    void loadExamForStudent(examId).then((res) => {
      if (!active) return;
      setExam(res.exam);
      setQuestionCount(res.questionCount);
    });
    return () => {
      active = false;
    };
  }, [examId]);

  const startVisible = useMemo(() => canStartExam(exam), [exam]);

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone={STUDENT_TONE} items={STUDENT_NAV}>
      <section className="border border-line bg-paper">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam details</p>
            <h1 className="mt-2 font-serif text-3xl font-semibold">{exam?.name ?? "Loading…"}</h1>
            <p className="mt-2 text-[13px] text-ink-soft">{exam?.batch ?? "—"} · {exam?.duration_minutes ?? 0} min · {exam?.total_marks ?? 0} marks</p>
          </div>
          <ExamCountdown startAt={exam?.scheduled_at ?? null} durationMinutes={exam?.duration_minutes ?? 0} />
        </div>
        <div className="grid gap-0 md:grid-cols-2">
          <div className="border-b border-line px-5 py-5 md:border-b-0 md:border-r">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Overview</p>
            <p className="mt-3 text-[13px] text-ink-soft">{exam?.description ?? "No description available."}</p>
            <dl className="mt-4 space-y-2 text-[13px]">
              <div className="flex justify-between gap-4 border-b border-line py-2">
                <dt className="text-ink-soft">Schedule</dt>
                <dd>{exam?.scheduled_at ? new Date(exam.scheduled_at).toLocaleString() : "Available now"}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-line py-2">
                <dt className="text-ink-soft">Questions</dt>
                <dd>{questionCount}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-ink-soft">Batch</dt>
                <dd>{exam?.batch ?? "—"}</dd>
              </div>
            </dl>
          </div>
          <div className="px-5 py-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Instructions</p>
            <p className="mt-3 whitespace-pre-wrap text-[13px] text-ink-soft">
              {exam?.instructions ?? "Follow invigilation rules. Keep camera and microphone enabled throughout the exam."}
            </p>
            <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Topics</p>
            <p className="mt-2 text-[13px] text-ink-soft">
              {(exam?.settings?.topics as string | undefined) ?? "Topics are shared by your teacher."}
            </p>
            {exam?.resources_url && (
              <a
                href={exam.resources_url}
                className="mt-4 inline-block border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest"
              >
                Download resources
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="mt-4 border border-line bg-paper px-5 py-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">FAQ</p>
        <div className="mt-3 space-y-2">
          {(exam?.faq ?? [
            { question: "Can I rejoin if internet disconnects?", answer: "Yes — rejoin immediately using the same exam link." },
            { question: "Can I use practice mode before exam?", answer: "Yes. Practice mode is available at all times." },
          ]).map((item) => (
            <details key={item.question} className="border border-line bg-paper-raised p-3">
              <summary className="cursor-pointer font-medium">{item.question}</summary>
              <p className="mt-2 text-[13px] text-ink-soft">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SystemCheckPage />
        <section className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Ready to begin</p>
          <p className="mt-3 text-[13px] text-ink-soft">Practice first, then start when the window opens.</p>
          <Link
            to={`/student/exams/${examId}/practice`}
            className="mt-4 inline-block border border-line bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest"
          >
            Open practice mode
          </Link>
          {startVisible && (
            <Link
              to={`/student/exam?examId=${encodeURIComponent(examId)}`}
              className="mt-3 block border border-forest bg-forest px-4 py-3 text-center font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90"
            >
              Start exam
            </Link>
          )}
        </section>
      </div>
    </RoleLayout>
  );
}
