import RoleLayout from "../components/RoleLayout";
import { STUDENT_NAV } from "./StudentExams";

type Result = {
  name: string;
  code: string;
  date: string;
  score: number;
  outOf: number;
  status: "published" | "under-review";
};

const RESULTS: Result[] = [
  { name: "Operating Systems", code: "EXAM-2025-088", date: "12 Mar 2026", score: 84, outOf: 100, status: "published" },
  { name: "Database Management", code: "EXAM-2025-072", date: "28 Feb 2026", score: 76, outOf: 100, status: "published" },
  { name: "Computer Networks", code: "EXAM-2025-061", date: "14 Feb 2026", score: 91, outOf: 100, status: "published" },
  { name: "Data Structures & Algorithms", code: "EXAM-2026-014", date: "Awaiting evaluation", score: 0, outOf: 70, status: "under-review" },
];

function grade(pct: number) {
  if (pct >= 90) return "O";
  if (pct >= 80) return "A+";
  if (pct >= 70) return "A";
  if (pct >= 60) return "B+";
  return "B";
}

export default function StudentResults() {
  const published = RESULTS.filter((r) => r.status === "published");
  const avg = published.length ? Math.round(published.reduce((s, r) => s + (r.score / r.outOf) * 100, 0) / published.length) : 0;

  return (
    <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={STUDENT_NAV}>
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
          <p className="mt-2 font-serif text-3xl text-amber">{RESULTS.length - published.length}</p>
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
            {RESULTS.map((r) => {
              const pct = Math.round((r.score / r.outOf) * 100);
              return (
                <tr key={r.code} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-5 py-4">
                    <p className="font-serif text-[15px] font-medium text-ink hover:underline">
                      {r.status === "published" ? (
                        <a href={`/student/results/${r.code}`}>{r.name}</a>
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
                        <a href={`/student/results/${r.code}`} className="font-mono text-[9px] uppercase tracking-wider text-ink hover:underline">View Details →</a>
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
