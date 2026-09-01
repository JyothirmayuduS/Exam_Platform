import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import ExamCountdown from "../components/ExamCountdown";
import ExamCountdownBanner from "../components/ExamCountdownBanner";
import { listEnrolledExamsForAuthUser, type ExamRecord } from "../lib/examApi";
import { useAuth } from "../lib/auth";

type ViewStatus = "upcoming" | "live" | "completed";

type Row = {
  id: string;
  name: string;
  batch: string;
  duration: number;
  totalMarks: number;
  scheduledAt: string | null;
  status: ViewStatus;
};

const nav = [
  { label: "Overview", to: "/student", end: true },
  { label: "My exams", to: "/student/exams" },
  { label: "Results", to: "/student/results" },
  { label: "Help & support", to: "/student/help" },
];

function getStatus(exam: ExamRecord): ViewStatus {
  if (!exam.scheduled_at) return exam.status === "published" ? "live" : "upcoming";
  const start = new Date(exam.scheduled_at).getTime();
  const end = start + exam.duration_minutes * 60 * 1000;
  const now = Date.now();
  if (now < start) return "upcoming";
  if (now > end) return "completed";
  return "live";
}

function toRow(exam: ExamRecord): Row {
  return {
    id: exam.id,
    name: exam.name,
    batch: exam.batch,
    duration: exam.duration_minutes,
    totalMarks: exam.total_marks,
    scheduledAt: exam.scheduled_at,
    status: getStatus(exam),
  };
}

export default function StudentHome() {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ViewStatus>("all");

  const { data: rows = [], isLoading: loading } = useQuery({
    queryKey: ['enrolledExams', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const exams = await listEnrolledExamsForAuthUser(user.id);
      return (exams ?? []).map(toRow);
    },
    enabled: !!user?.id,
    refetchInterval: 60000,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = filter === "all" || row.status === filter;
      const matchesSearch =
        !q ||
        row.name.toLowerCase().includes(q) ||
        row.batch.toLowerCase().includes(q) ||
        row.id.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [filter, query, rows]);

  return (
    <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={nav}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student dashboard</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">My enrolled exams</h1>
        </div>
        <Link to="/student/exams" className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">
          View full exams page →
        </Link>
      </div>

      <ExamCountdownBanner
        exams={rows
          .filter((row) => row.status === "upcoming")
          .map((row) => ({ id: row.id, name: row.name, startAt: row.scheduledAt }))}
      />

      <section className="mt-6 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search exams"
          className="min-w-[220px] border border-line bg-paper p-2 text-[13px]"
        />
        {(["all", "upcoming", "live", "completed"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${
              filter === value ? "border-maroon bg-maroon text-paper" : "border-line text-ink-soft"
            }`}
          >
            {value}
          </button>
        ))}
      </section>

      <section className="mt-5 space-y-3">
        {filtered.map((row) => (
          <div key={row.id} className="flex flex-col gap-4 border border-line bg-paper p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-serif text-[17px] font-medium">{row.name}</p>
              <p className="mt-1 text-[12px] text-ink-soft">
                {row.batch} · {row.duration} minutes · {row.totalMarks} marks
              </p>
              <p className="mt-2 text-[12px] text-ink-soft">Exam ID: {row.id}</p>
              <ExamCountdown startAt={row.scheduledAt} durationMinutes={row.duration} className="mt-2 block" />
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                to={`/student/exams/${row.id}`}
                className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
              >
                Details
              </Link>
              <Link
                to={`/student/exams/${row.id}/practice`}
                className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
              >
                Practice mode
              </Link>
              {row.status === "live" ? (
                <Link
                  to={`/student/exam?examId=${encodeURIComponent(row.id)}`}
                  className="border border-maroon bg-maroon px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
                >
                  Join exam
                </Link>
              ) : (
                <span className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                  {row.status}
                </span>
              )}
            </div>
          </div>
        ))}

        {!loading && filtered.length === 0 && (
          <div className="border border-dashed border-line-strong p-8 text-center text-[13px] text-ink-soft">
            No matching exams found.
          </div>
        )}

        {loading && (
          <div className="animate-pulse space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 border border-line bg-paper-raised" />
            ))}
          </div>
        )}
      </section>
    </RoleLayout>
  );
}
