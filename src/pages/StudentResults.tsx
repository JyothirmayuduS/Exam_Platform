import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { STUDENT_NAV } from "./StudentExams";
import { useAuth } from "../lib/auth";
import { getSupabase } from "../lib/supabase";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";

type Result = {
  name: string;
  code: string;
  date: string;
  score: number;
  outOf: number;
  status: "published" | "under-review";
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
    queryKey: ['studentResults', user?.id],
    queryFn: async () => {
      const db = getSupabase();
      if (!db || !user?.id) return [];

      const { data: student } = await db
        .from("students")
        .select("id")
        .eq("auth_id", user.id)
        .maybeSingle();
        
      if (!student) return [];

      const { data, error } = await db
        .from("attempts")
        .select("state, score, submitted_at, exam:exams(id, name, total_marks)")
        .eq("student_id", student.id)
        .eq("state", "submitted");

      if (error || !data) return [];

      return data.map((a: any) => ({
        name: a.exam?.name || "Unknown Exam",
        code: a.exam?.id || "N/A",
        date: a.submitted_at ? new Date(a.submitted_at).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : "N/A",
        score: a.score ?? 0,
        outOf: a.exam?.total_marks ?? 100,
        // If score is null it means not fully evaluated (e.g. subjective pending)
        status: a.score === null ? "under-review" : "published"
      })) as Result[];
    },
    enabled: !!user?.id,
  });

  const published = results.filter((r) => r.status === "published");
  const avg = published.length ? Math.round(published.reduce((s, r) => s + (r.score / r.outOf) * 100, 0) / published.length) : 0;

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#7A1F2B" items={STUDENT_NAV}>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Performance</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Results</h1>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="border border-line bg-paper-raised p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Published</p>
          <p className="mt-2 font-serif text-3xl">{published.length}</p>
          <p className="mt-1 text-[12px] text-ink-soft">graded assessments</p>
        </div>
        <div className="border border-line bg-paper-raised p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Average score</p>
          <p className="mt-2 font-serif text-3xl text-success">{avg}%</p>
          <p className="mt-1 text-[12px] text-ink-soft">across published results</p>
        </div>
        <div className="border border-line bg-paper-raised p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Awaiting</p>
          <p className="mt-2 font-serif text-3xl text-amber">{results.length - published.length}</p>
          <p className="mt-1 text-[12px] text-ink-soft">under evaluation</p>
        </div>
      </div>

      <div className="mt-8 overflow-x-auto border border-line">
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
                <td colSpan={4} className="p-8 text-center text-[13px] text-ink-soft">
                  <div className="animate-pulse flex space-x-4 justify-center">
                    <div className="h-4 bg-line rounded w-3/4"></div>
                  </div>
                </td>
              </tr>
            )}
            {!isLoading && results.length === 0 && (
              <tr>
                <td colSpan={4} className="p-10 text-center text-[13px] text-ink-soft border-t border-line border-dashed">
                  No submitted exams found. Once you complete an exam, the results will appear here.
                </td>
              </tr>
            )}
            {results.map((r) => {
              const pct = Math.round((r.score / r.outOf) * 100);
              return (
                <tr key={r.code} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-5 py-4">
                    <p className="font-serif text-[15px] font-medium text-ink hover:underline">
                      {r.status === "published" ? (
                        <Link to={`/student/results/${r.code}`}>{r.name}</Link>
                      ) : (
                        r.name
                      )}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-ink-soft">{r.code}</p>
                  </td>
                  <td className="px-5 py-4 text-ink-soft">{r.date}</td>
                  <td className="px-5 py-4">
                    {r.status === "published" ? (
                      <span className="font-serif text-[16px]">{r.score}<span className="text-ink-soft">/{r.outOf}</span></span>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-amber">Under review</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {r.status === "published" ? (
                      <div className="flex items-center justify-between">
                        <span className="border border-success/50 bg-success/10 px-2 py-1 font-mono text-[11px] text-success">{grade(pct)}</span>
                        <Link to={`/student/results/${r.code}`} className="font-mono text-[9px] uppercase tracking-wider text-ink hover:underline">View Details →</Link>
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
      </div>
    </RoleLayout>
  );
}
