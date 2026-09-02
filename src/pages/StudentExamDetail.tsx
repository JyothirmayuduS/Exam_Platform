import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import ExamCountdown from "../components/ExamCountdown";
import SystemCheckPage from "../components/SystemCheckPage";
import { loadExamForStudent, type ExamRecord } from "../lib/examApi";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";

const NAV = [
  { label: "Overview", to: "/student", end: true },
  { label: "My exams", to: "/student/exams" },
  { label: "Results", to: "/student/results" },
  { label: "Help & support", to: "/student/help" },
];

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
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#7A1F2B" items={NAV}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam details</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">{exam?.name ?? "Loading..."}</h1>
        </div>
        <ExamCountdown startAt={exam?.scheduled_at ?? null} durationMinutes={exam?.duration_minutes ?? 0} />
      </div>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Overview</p>
          <p className="mt-3 text-[13px] text-ink-soft">{exam?.description ?? "No description available."}</p>
          <ul className="mt-4 space-y-2 text-[13px] text-ink-soft">
            <li>Name: {exam?.name ?? "-"}</li>
            <li>Date & time: {exam?.scheduled_at ? new Date(exam.scheduled_at).toLocaleString() : "Available now"}</li>
            <li>Duration: {exam?.duration_minutes ?? 0} minutes</li>
            <li>Total marks: {exam?.total_marks ?? 0}</li>
            <li>Questions: {questionCount}</li>
            <li>Batch: {exam?.batch ?? "-"}</li>
          </ul>
        </div>

        <div className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Instructions & rules</p>
          <p className="mt-3 whitespace-pre-wrap text-[13px] text-ink-soft">
            {exam?.instructions ?? "Follow invigilation rules. Keep camera and microphone enabled throughout the exam."}
          </p>
          <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-ink-soft">Syllabus / topics covered</p>
          <p className="mt-2 text-[13px] text-ink-soft">
            {(exam?.settings?.topics as string | undefined) ?? "Topics are available from your teacher announcement."}
          </p>
          {exam?.resources_url && (
            <a href={exam.resources_url} className="mt-4 inline-block border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">
              Download resources (PDF) →
            </a>
          )}
        </div>
      </section>

      <section className="mt-6 border border-line bg-paper p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">FAQ</p>
        <div className="mt-3 space-y-2">
          {(exam?.faq ?? [
            { question: "Can I rejoin if internet disconnects?", answer: "Yes, rejoin immediately using the same exam link." },
            { question: "Can I use practice mode before exam?", answer: "Yes, practice mode is available at all times." },
          ]).map((item) => (
            <details key={item.question} className="border border-line p-3">
              <summary className="cursor-pointer font-medium">{item.question}</summary>
              <p className="mt-2 text-[13px] text-ink-soft">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <SystemCheckPage />
        <section className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Practice</p>
          <p className="mt-3 text-[13px] text-ink-soft">Try sample questions before starting the real exam.</p>
          <Link to={`/student/exams/${examId}/practice`} className="mt-4 inline-block border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">
            Open practice mode →
          </Link>

          {startVisible && (
            <Link to={`/student/exam?examId=${encodeURIComponent(examId)}`} className="mt-4 block border border-maroon bg-maroon px-4 py-3 text-center font-mono text-[10px] uppercase tracking-wider text-paper">
              Start Exam
            </Link>
          )}
        </section>
      </div>
    </RoleLayout>
  );
}
