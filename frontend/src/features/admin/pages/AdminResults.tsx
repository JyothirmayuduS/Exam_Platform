import { useState } from "react";
import { Link } from "react-router-dom";
import { reviewFlag, type AdminOverview } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import ErpExportPanel from "@/features/teacher/components/ErpExportPanel";
import { Empty, Section, TabBar, Table, Td, ago, examLabel, studentLabel, useAdminTab, when, type AdminTab } from "@/features/admin/components/AdminUI";

const TIMING: Record<string, string> = { manual: "Released by the teacher", on_submit: "On submit", on_close: "When the exam closes" };

type TabId = "marking" | "unreleased" | "flags" | "holds" | "export" | "history";

export default function AdminResults({ data, notify, onChanged }: { data: AdminOverview; notify: (m: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const exportable = data.exams.filter((e) => e.status !== "draft");
  const [examId, setExamId] = useState(exportable[0]?.id ?? "");
  const selected = exportable.find((e) => e.id === examId);
  const waitingTotal = data.marking.reduce((t, m) => t + m.waiting, 0);

  const tabs: AdminTab<TabId>[] = [
    { id: "marking", label: "To mark", count: waitingTotal, tone: "amber" },
    { id: "unreleased", label: "Not released", count: data.unreleased.length, tone: "amber" },
    { id: "flags", label: "Flags to review", count: data.flagsWaitingTotal, tone: "alert" },
    { id: "holds", label: "Withheld", count: data.holds.length, tone: "amber" },
    { id: "export", label: "ERP export" },
    { id: "history", label: "Export history", count: data.erpHistory.length },
  ];

  const [tab, pick] = useAdminTab(tabs, "export");

  const markReviewed = async (id: string) => {
    setBusy(id);
    const res = await reviewFlag(id, notes[id]?.trim() || undefined);
    setBusy(null);
    if (!res.ok) { notify(res.error); return; }
    notify("Flag marked as reviewed");
    onChanged();
  };

  return (
    <div className="space-y-5">
      <TabBar tabs={tabs} active={tab} onPick={pick} label="Marking and results" />

      {tab === "marking" && (
        <Section note={<>Submitted papers with written or coding answers and no final mark. Teachers mark them from <Link className="underline" to="/teacher/evaluate">Evaluate</Link>.</>}>
          {data.marking.length === 0 ? <Empty>Nothing is waiting to be marked.</Empty> : (
            <Table head={["Exam", "Teacher", "Waiting", "Oldest"]}>
              {data.marking.map((m) => (
                <tr key={m.exam.id}>
                  <Td className="font-medium">{m.exam.name}</Td>
                  <Td>{m.exam.owner ?? "—"}</Td>
                  <Td className="tabular-nums">{m.waiting}</Td>
                  <Td className="text-soft">{ago(m.oldest)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}

      {tab === "unreleased" && (
        <Section note="Exams that are over or have submissions, where students still can't see their scores.">
          {data.unreleased.length === 0 ? <Empty>Every finished exam has released results.</Empty> : (
            <Table head={["Exam", "Teacher", "Graded", "Release"]}>
              {data.unreleased.map((u) => (
                <tr key={u.exam.id}>
                  <Td><span className="font-medium">{u.exam.name}</span><span className="block font-mono text-[10px] uppercase text-soft">{u.phase}</span></Td>
                  <Td>{u.exam.owner ?? "—"}</Td>
                  <Td className="tabular-nums">{u.graded} / {u.submitted}</Td>
                  <Td className="text-soft">{TIMING[u.timing] ?? u.timing}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}

      {tab === "flags" && (
        <Section note="High and critical flags from the last 30 days that nobody has marked as reviewed. Reviewing a flag doesn't change the student's result; withhold the result from the evaluation screen if needed.">
          {data.flagsWaiting.length === 0 ? <Empty>No serious flags are waiting.</Empty> : (
            <ul className="divide-y divide-line">
              {data.flagsWaiting.map((f) => (
                <li key={f.id} className="py-4 text-[13px]">
                  <p>
                    <span className={`mr-2 border px-1.5 py-px font-mono text-[10px] uppercase ${f.severity === "critical" ? "border-alert bg-alert text-paper" : "border-alert text-alert"}`}>{f.severity}</span>
                    <span className="font-medium">{f.violation_type}</span>
                  </p>
                  <p className="mt-1 text-[12px] text-soft">{studentLabel(f.student)} · {examLabel(f.exam)} · {when(f.created_at)}{f.source ? ` · ${f.source}` : ""}</p>
                  <div className="mt-2.5 flex max-w-2xl gap-2">
                    <input
                      aria-label="Review note"
                      placeholder="Note (optional)"
                      value={notes[f.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [f.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && busy !== f.id) void markReviewed(f.id); }}
                      className="min-w-0 flex-1 border border-line bg-paper px-3 py-2 text-[12.5px] outline-none focus:border-forest"
                    />
                    <Button size="sm" onClick={() => void markReviewed(f.id)} disabled={busy === f.id}>{busy === f.id ? "Saving…" : "Mark reviewed"}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.flagsWaitingTotal > data.flagsWaiting.length && <p className="mt-2 text-[11px] text-soft">Showing the latest {data.flagsWaiting.length} of {data.flagsWaitingTotal}.</p>}
        </Section>
      )}

      {tab === "holds" && (
        <Section note="Withheld students appear as WITHHELD, without marks, in the ERP export until the hold is released from the evaluation screen.">
          {data.holds.length === 0 ? <Empty>No results are withheld.</Empty> : (
            <Table head={["Student", "Exam", "Reason", "Held by", "Since"]}>
              {data.holds.map((h) => (
                <tr key={h.attemptId}>
                  <Td>{studentLabel(h.student)}</Td>
                  <Td>{examLabel(h.exam)}</Td>
                  <Td className="text-soft">{h.reason ?? "—"}</Td>
                  <Td>{h.heldBy ?? "—"}</Td>
                  <Td className="text-soft">{when(h.heldAt)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}

      {tab === "export" && (
        <div>
          <label className="block max-w-xl text-[12px] text-soft">Exam for a single-exam export
            <select value={examId} onChange={(e) => setExamId(e.target.value)} className="mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink">
              {exportable.map((e) => <option key={e.id} value={e.id}>{e.name}{e.owner ? ` — ${e.owner}` : ""}</option>)}
            </select>
          </label>
          <ErpExportPanel exams={exportable} selectedExam={selected} notify={(m) => { notify(m); onChanged(); }} />
        </div>
      )}

      {tab === "history" && (
        <Section note="The last 50 downloads, from the audit log.">
          {data.erpHistory.length === 0 ? <Empty>Nobody has exported results yet.</Empty> : (
            <Table head={["When", "Who", "What", "Format", "Rows"]}>
              {data.erpHistory.map((h) => (
                <tr key={h.id}>
                  <Td className="whitespace-nowrap text-soft">{when(h.at)}</Td>
                  <Td>{h.by ?? "—"}</Td>
                  <Td>{h.scope === "programme" ? `${(h.target ?? "").replace("|", " · Semester ")} (${h.exams.length} exam${h.exams.length === 1 ? "" : "s"})` : h.exams[0] ?? h.target}</Td>
                  <Td className="font-mono text-[11px] uppercase">{h.format ?? "—"}</Td>
                  <Td className="tabular-nums">{h.rows ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}
    </div>
  );
}
