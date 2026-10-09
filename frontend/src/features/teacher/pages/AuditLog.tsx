import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeading, Button } from "@/features/teacher/components/PageChrome";
import { getSupabase } from "@/shared/data/supabase";
import { listAuditLogs, type AuditEntry } from "@/shared/data/examApi";
import { downloadCsv } from "@/shared/services/sessionReport";

const FILTERS: { label: string; prefix?: string }[] = [
  { label: "All" },
  { label: "Marks", prefix: "attempt.score" },
  { label: "Submissions", prefix: "attempt.submitted" },
  { label: "Force submits", prefix: "attempt.force" },
  { label: "Time & pauses", prefix: "attempt.time" },
  { label: "Accommodations", prefix: "enrollment." },
  { label: "Publishing", prefix: "exam." },
  { label: "Results & ERP", prefix: "result" },
];

const ACTION_LABEL: Record<string, string> = {
  "attempt.score_changed": "Changed marks",
  "attempt.force_submitted": "Force-submitted attempt",
  "attempt.submitted": "Submitted exam",
  "attempt.submitted_late": "Submitted after deadline (last autosave graded)",
  "attempt.time_extended": "Extended time",
  "attempt.paused": "Paused attempt",
  "attempt.resumed": "Resumed attempt",
  "enrollment.extra_minutes_changed": "Set accommodation time",
  "exam.published": "Published exam",
  "exam.email_sent": "Sent exam email",
  "grading.delegated": "Delegated grading",
  "student.provisioned": "Provisioned student accounts",
  "results.exported": "Exported results for ERP",
  "result.withheld": "Withheld result for malpractice review",
  "result.released_from_hold": "Released result from malpractice hold",
  "lti.link_mapped": "Linked a Moodle activity",
  "lti.link_unmapped": "Unlinked a Moodle activity",
  "lti.student_linked": "Confirmed a Moodle student",
  "admin.moodle_resend": "Resent failed Moodle grades",
  "admin.flag_reviewed": "Reviewed a proctoring flag",
};

export const auditActionLabel = (action: string) => ACTION_LABEL[action] ?? action;

type Who = { name: string; detail: string };

async function resolveActors(ids: string[]): Promise<Map<string, Who>> {
  const db = getSupabase();
  const out = new Map<string, Who>();
  if (!db || ids.length === 0) return out;
  const [teachers, students] = await Promise.all([
    db.from("teachers").select("auth_id, name, email").in("auth_id", ids),
    db.from("students").select("auth_id, full_name, roll").in("auth_id", ids),
  ]);
  for (const t of (teachers.data ?? []) as { auth_id: string; name?: string; email?: string }[]) {
    out.set(t.auth_id, { name: t.name || t.email || "Staff", detail: t.email ?? "" });
  }
  for (const s of (students.data ?? []) as { auth_id: string; full_name?: string; roll?: string }[]) {
    out.set(s.auth_id, { name: s.full_name || s.roll || "Student", detail: s.roll ?? "" });
  }
  return out;
}

function describeMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export default function AuditLog() {
  const [filter, setFilter] = useState(FILTERS[0]);
  const { data, isLoading } = useQuery({
    queryKey: ["auditLog", filter.label],
    queryFn: async () => {
      const entries = await listAuditLogs(300, filter.prefix);
      const actors = await resolveActors([...new Set(entries.map((e) => e.actor_id).filter((id): id is string => !!id))]);
      return { entries, actors };
    },
    refetchInterval: 30_000,
  });
  const entries: AuditEntry[] = useMemo(() => data?.entries ?? [], [data]);
  const actors = data?.actors ?? new Map<string, Who>();

  const exportCsv = () => {
    downloadCsv(
      `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Time", "Who", "Role", "Action", "Target", "Details"],
      entries.map((e) => [
        new Date(e.created_at).toISOString(),
        (e.actor_id && actors.get(e.actor_id)?.name) || e.actor_id || "",
        e.actor_role,
        ACTION_LABEL[e.action] ?? e.action,
        `${e.target_type}${e.target_id ? ` ${e.target_id}` : ""}`,
        describeMeta(e.meta),
      ]),
    );
  };

  return (
    <>
      <PageHeading
        eyebrow="Settings / Audit"
        title="Audit log"
        detail="Who changed marks, time, accommodations and submissions. Entries are append-only — nobody can edit or delete them."
        action={<Button onClick={exportCsv} disabled={!entries.length}>Export CSV</Button>}
      />
      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f)}
            className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${filter.label === f.label ? "border-forest bg-forest text-paper" : "border-line text-soft hover:border-forest hover:text-forest"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-6 overflow-x-auto border border-line">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-raised font-mono text-[10px] uppercase tracking-widest text-soft">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-soft">Loading…</td></tr>}
            {!isLoading && entries.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-soft">No entries yet.</td></tr>}
            {entries.map((e) => {
              const who = e.actor_id ? actors.get(e.actor_id) : undefined;
              return (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-soft">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <p>{who?.name ?? "Unknown"}</p>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-soft">{e.actor_role}{who?.detail ? ` · ${who.detail}` : ""}</p>
                  </td>
                  <td className="px-4 py-3">{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-soft">{e.target_type}{e.target_id ? ` · ${e.target_id}` : ""}</td>
                  <td className="px-4 py-3 text-soft">{describeMeta(e.meta)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
