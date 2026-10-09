import { useEffect, useState } from "react";
import { loadAdminAudit, type AdminAuditEntry, type AdminOverview } from "@/shared/data/api/admin";
import { auditActionLabel } from "@/features/teacher/pages/AuditLog";
import { Button } from "@/features/teacher/components/PageChrome";
import { Empty, Panel, Table, Td, when } from "@/features/admin/components/AdminUI";

const ACTIONS = [
  { label: "All actions", value: "" },
  { label: "Marks", value: "attempt.score" },
  { label: "Submissions", value: "attempt.submitted" },
  { label: "Force submits", value: "attempt.force" },
  { label: "Time & pauses", value: "attempt.time" },
  { label: "Accommodations", value: "enrollment." },
  { label: "Publishing", value: "exam." },
  { label: "Results & ERP", value: "result" },
  { label: "Moodle", value: "lti." },
  { label: "Admin actions", value: "admin." },
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export default function AdminAudit({ data }: { data: AdminOverview }) {
  const [actorId, setActorId] = useState("");
  const [examId, setExamId] = useState("");
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const examName = new Map(data.exams.map((e) => [e.id, e.name]));

  useEffect(() => {
    let live = true;
    setEntries(null);
    void loadAdminAudit({ actorId: actorId || undefined, examId: examId || undefined, action: action || undefined, limit: 300 }).then((res) => {
      if (!live) return;
      if (res.ok) { setEntries(res.data.entries); setError(null); } else setError(res.error);
    });
    return () => { live = false; };
  }, [actorId, examId, action]);

  const examOf = (e: AdminAuditEntry) => {
    const id = (e.meta?.exam_id as string | undefined) ?? (e.target_type === "exam" ? e.target_id : null);
    return id ? examName.get(id) ?? id : "";
  };

  const download = () => {
    if (!entries?.length) return;
    const head = ["When", "Who", "Role", "Action", "Exam", "Target", "Details"];
    const lines = entries.map((e) => [e.created_at, e.actor_name ?? e.actor_id ?? "", e.actor_role ?? "", e.action, examOf(e), `${e.target_type ?? ""}:${e.target_id ?? ""}`, e.meta ?? {}].map(csvCell).join(","));
    const blob = new Blob(["\ufeff" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-log_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const select = "mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink";

  return (
    <Panel
      title="Audit log"
      count={entries?.length}
      action={<Button size="sm" onClick={download} disabled={!entries?.length}>Download CSV</Button>}
    >
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <label className="text-[12px] text-soft">Person
          <select value={actorId} onChange={(e) => setActorId(e.target.value)} className={select}>
            <option value="">Everyone</option>
            {data.staff.map((s) => <option key={s.auth_id} value={s.auth_id}>{s.name}{s.admin ? " (admin)" : s.role === "proctor" ? " (proctor)" : ""}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-soft">Exam
          <select value={examId} onChange={(e) => setExamId(e.target.value)} className={select}>
            <option value="">All exams</option>
            {data.exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-soft">Action
          <select value={action} onChange={(e) => setAction(e.target.value)} className={select}>
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-[12.5px] text-alert">{error}</p>}
      {!entries ? <Empty>Loading…</Empty> : entries.length === 0 ? <Empty>No entries match.</Empty> : (
        <Table head={["When", "Who", "Action", "Exam", "Details"]}>
          {entries.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-soft">{when(e.created_at)}</Td>
              <Td>{e.actor_name ?? <span className="text-soft">{e.actor_role ?? "system"}</span>}</Td>
              <Td>{auditActionLabel(e.action)}</Td>
              <Td>{examOf(e) || <span className="text-soft">—</span>}</Td>
              <Td className="max-w-[320px] truncate font-mono text-[10.5px] text-soft">{e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : ""}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}
