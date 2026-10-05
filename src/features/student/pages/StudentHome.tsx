import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import ExamCountdown from "@/features/student/components/ExamCountdown";
import ExamCountdownBanner from "@/features/student/components/ExamCountdownBanner";
import { listEnrolledExamsForAuthUser, type ExamRecord } from "@/shared/data/examApi";
import { useAuth } from "@/features/auth/auth";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { STUDENT_NAV, STUDENT_TONE } from "@/features/student/pages/StudentExams";

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

function getStatus(exam: ExamRecord): ViewStatus {
  if (exam.my_attempt_state === "submitted") return "completed";
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

const statusTone: Record<ViewStatus, string> = {
  live: "border-forest/40 bg-forest/5 text-forest",
  upcoming: "border-amber/40 bg-amber/5 text-amber",
  completed: "border-line bg-paper-raised text-ink-soft",
};

export default function StudentHome() {
  const { user } = useAuth();
  const { profile } = useCurrentProfile();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ViewStatus>("all");

  const { data: rows = [], isLoading: loading } = useQuery({
    queryKey: ["enrolledExams", user?.id],
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

  const liveCount = rows.filter((r) => r.status === "live").length;
  const upcomingCount = rows.filter((r) => r.status === "upcoming").length;

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone={STUDENT_TONE} items={STUDENT_NAV}>
      <section className="border border-line bg-paper">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-5 py-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student workspace</p>
            <h1 className="mt-2 font-serif text-3xl font-semibold">Overview</h1>
            <p className="mt-2 max-w-xl text-[13px] text-ink-soft">
              Your enrolled papers, readiness checks, and join links — in one place.
            </p>
          </div>
          <Link to="/student/exams" className="border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90">
            Open my exams
          </Link>
        </div>
        <div className="grid gap-0 sm:grid-cols-3">
          {[
            [String(rows.length), "Enrolled"],
            [String(liveCount), "Open now"],
            [String(upcomingCount), "Upcoming"],
          ].map(([value, label], i) => (
            <div key={label} className={`px-5 py-4 ${i > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}>
              <p className="font-serif text-3xl font-semibold">{value}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <ExamCountdownBanner
        exams={rows
          .filter((row) => row.status === "upcoming")
          .map((row) => ({ id: row.id, name: row.name, startAt: row.scheduledAt }))}
      />

      <section className="mt-4 border border-line bg-paper">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or batch"
            className="min-w-[220px] flex-1 border border-line bg-paper-raised px-3 py-2 text-[13px] outline-none focus:border-forest"
          />
          {(["all", "upcoming", "live", "completed"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${
                filter === value ? "border-forest bg-forest text-paper" : "border-line bg-paper-raised text-ink-soft hover:border-forest hover:text-forest"
              }`}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="divide-y divide-line">
          {filtered.map((row) => (
            <article key={row.id} className="flex flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-serif text-lg font-semibold">{row.name}</h2>
                  <span className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${statusTone[row.status]}`}>
                    {row.status}
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-ink-soft">
                  {row.batch} · {row.duration} min · {row.totalMarks} marks
                </p>
                <ExamCountdown startAt={row.scheduledAt} durationMinutes={row.duration} className="mt-2 block" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to={`/student/exams/${row.id}`} className="border border-line bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
                  Details
                </Link>
                <Link to={`/student/exams/${row.id}/practice`} className="border border-line bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
                  Practice
                </Link>
                <Link to={`/student/exams/${row.id}/system-check`} className="border border-line bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
                  System check
                </Link>
                {row.status === "live" ? (
                  <Link
                    to={`/student/exam?examId=${encodeURIComponent(row.id)}`}
                    className="border border-forest bg-forest px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
                  >
                    Join exam
                  </Link>
                ) : (
                  row.status === "completed" ? (
                    <Link to="/student/results" className="border border-line bg-paper-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
                      View result
                    </Link>
                  ) : (
                    <span className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                      Not open yet
                    </span>
                  )
                )}
              </div>
            </article>
          ))}

          {!loading && filtered.length === 0 && (
            <div className="px-5 py-12 text-center text-[13px] text-ink-soft">No matching exams found.</div>
          )}
          {loading && (
            <div className="space-y-0">
              {[0, 1].map((i) => (
                <div key={i} className="h-24 border-b border-line bg-paper-raised/60" />
              ))}
            </div>
          )}
        </div>
      </section>
    </RoleLayout>
  );
}
