import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import { STUDENT_NAV, STUDENT_TONE } from "@/features/student/navigation";
import { useAuth } from "@/features/auth/auth";
import { getSupabase } from "@/shared/data/supabase";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { examClosed, visibilityFor, type ReleaseSettings } from "@/shared/domain/exam";
import { loadResultStates } from "@/shared/data/api/studentResults";

type Result = {
  name: string;
  code: string;
  date: string;
  score: number;
  outOf: number;
  status: "published" | "under-review" | "withheld";
  note: string | null;
};

function grade(pct: number) {
  if (pct >= 90) return "O";
  if (pct >= 80) return "A+";
  if (pct >= 70) return "A";
  if (pct >= 60) return "B+";
  return "B";
}

export default function StudentResults() {
  const { user } = useAuth();
  const { profile } = useCurrentProfile();

  const { data: results = [], isLoading } = useQuery({
    queryKey: ["studentResults", user?.id],
    queryFn: async () => {
      const db = getSupabase();
      if (!db || !user?.id) return [];

      const { data: student } = await db
        .from("students")
        .select("id")
        .eq("auth_id", user.id)
        .maybeSingle();

      if (!student) return [];

      const [{ data, error }, states] = await Promise.all([
        db
          .from("attempts")
          .select("state, submitted_at, exam:exams(id, name, total_marks, settings, status, scheduled_at, duration_minutes)")
          .eq("student_id", student.id)
          .eq("state", "submitted")
          .order("submitted_at", { ascending: false, nullsFirst: false }),
        loadResultStates(),
      ]);

      if (error || !data) return [];

      return data.map((a: any) => {
        const st = a.exam?.id ? states.get(String(a.exam.id)) : undefined;
        const v = visibilityFor((a.exam?.settings ?? {}) as ReleaseSettings, {
          examClosed: a.exam ? examClosed(a.exam) : false,
          graded: !!st?.graded,
          held: !!st?.held,
        });
        const shown = v.score && st?.score !== null && st?.score !== undefined;
        return {
        name: a.exam?.name || "Unknown Exam",
        code: a.exam?.id || "N/A",
        date: a.submitted_at
          ? new Date(a.submitted_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })
          : "N/A",
        score: shown ? st!.score! : 0,
        outOf: a.exam?.total_marks ?? 100,
        status: shown ? "published" : !st?.graded && !st?.held ? "under-review" : "withheld",
        note: v.note,
      };
      }) as Result[];
    },
    enabled: !!user?.id,
  });

  const published = results.filter((r) => r.status === "published");
  const avg = published.length
    ? Math.round(published.reduce((s, r) => s + (r.score / r.outOf) * 100, 0) / published.length)
    : 0;

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone={STUDENT_TONE} items={STUDENT_NAV}>
      <section className="border border-line bg-paper">
        <div className="border-b border-line px-5 py-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Performance</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">Results</h1>
          <p className="mt-2 text-[13px] text-ink-soft">Scores appear here once your teacher releases them.</p>
        </div>
        <div className="grid gap-0 sm:grid-cols-3">
          {[
            [String(published.length), "Published"],
            [avg ? `${avg}%` : "—", "Average score"],
            [String(results.length - published.length), "Not released yet"],
          ].map(([value, label], i) => (
            <div key={label} className={`px-5 py-4 ${i > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}>
              <p className="font-serif text-3xl font-semibold">{value}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 overflow-x-auto border border-line bg-paper">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">
              <th className="px-5 py-3">Assessment</th>
              <th className="px-5 py-3">Date</th>
              <th className="px-5 py-3">Score</th>
              <th className="px-5 py-3">Grade</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-ink-soft">Loading results…</td>
              </tr>
            )}
            {!isLoading && results.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-12 text-center text-ink-soft">
                  No submitted exams yet. Completed papers appear here after you finish.
                </td>
              </tr>
            )}
            {results.map((r) => {
              const pct = Math.round((r.score / r.outOf) * 100);
              return (
                <tr key={r.code} className="border-b border-line last:border-0">
                  <td className="px-5 py-4">
                    <p className="font-serif text-[15px] font-medium">
                      {r.status === "published" ? (
                        <Link to={`/student/results/${r.code}`} className="hover:text-forest">
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-ink-soft">{r.code}</p>
                  </td>
                  <td className="px-5 py-4 text-ink-soft">{r.date}</td>
                  <td className="px-5 py-4">
                    {r.status === "published" ? (
                      <span className="font-serif text-[16px]">
                        {r.score}
                        <span className="text-ink-soft">/{r.outOf}</span>
                      </span>
                    ) : (
                      <span className="block max-w-[220px]">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-amber">{r.status === "under-review" ? "Being evaluated" : "Not released"}</span>
                        {r.note && <span className="mt-0.5 block text-[11px] text-ink-soft">{r.note}</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {r.status === "published" ? (
                      <div className="flex items-center gap-3">
                        <span className="border border-forest/40 bg-forest/5 px-2 py-1 font-mono text-[11px] text-forest">
                          {grade(pct)}
                        </span>
                        <Link
                          to={`/student/results/${r.code}`}
                          className="font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:text-forest"
                        >
                          Details
                        </Link>
                      </div>
                    ) : (
                      <span className="text-ink-soft">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </RoleLayout>
  );
}
