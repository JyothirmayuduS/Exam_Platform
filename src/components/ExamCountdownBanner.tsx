import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";

type BannerExam = {
  id: string;
  name: string;
  startAt: string | null;
};

type ExamCountdownBannerProps = {
  exams: BannerExam[];
};

export default function ExamCountdownBanner({ exams }: ExamCountdownBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  const upcoming = useMemo(() => {
    return exams
      .filter((exam) => !!exam.startAt)
      .map((exam) => ({ ...exam, startsIn: new Date(exam.startAt as string).getTime() - now }))
      .filter((exam) => exam.startsIn > 0)
      .sort((a, b) => a.startsIn - b.startsIn)[0];
  }, [exams, now]);

  if (!upcoming) return null;

  const minutes = Math.ceil(upcoming.startsIn / 60000);

  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border border-maroon/30 bg-maroon/5 p-4">
      <p className="font-mono text-[11px] uppercase tracking-wider text-maroon">
        Exam starts in {minutes} minute{minutes === 1 ? "" : "s"}: {upcoming.name}
      </p>
      <Link
        to={`/student/exams/${upcoming.id}/practice`}
        className="border border-maroon px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-maroon hover:bg-maroon hover:text-paper"
      >
        Open practice mode →
      </Link>
    </div>
  );
}
