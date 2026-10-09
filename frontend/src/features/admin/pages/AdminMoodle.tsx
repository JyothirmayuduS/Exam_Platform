import { useState } from "react";
import { resendMoodleGrades, type AdminOverview, type GradePostState } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Dot, Empty, Panel, Stat, Table, Td, ago, examLabel, studentLabel, when } from "@/features/admin/components/AdminUI";

const STATE: Record<GradePostState, { label: string; tone: string }> = {
  posted: { label: "Posted", tone: "text-success" },
  queued: { label: "Queued", tone: "text-soft" },
  retrying: { label: "Retrying", tone: "text-amber" },
  gave_up: { label: "Gave up", tone: "text-alert" },
  no_gradebook: { label: "No Moodle grade item", tone: "text-alert" },
};

export default function AdminMoodle({ data, notify, onChanged }: { data: AdminOverview; notify: (m: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const m = data.moodle;
  const job = m.retryJob;
  const resendable = m.failed.filter((f) => f.state !== "no_gradebook");
  const exams = [...new Map(resendable.filter((f) => f.exam).map((f) => [f.exam!.id, f.exam!])).values()];

  const resend = async (examId?: string) => {
    setBusy(examId ?? "all");
    const res = await resendMoodleGrades(examId);
    setBusy(null);
    if (!res.ok) { notify(res.error); return; }
    notify(res.data.queued ? `${res.data.queued} grade(s) queued; the retry job posts them within 5 minutes` : "Nothing to resend");
    onChanged();
  };

  const jobOk = !!job?.active && job.last_run?.status === "succeeded" && Date.now() - Date.parse(job.last_run.started_at) < 15 * 60_000;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Failed grade posts" value={m.failed.length} tone={m.failed.length ? "text-alert" : ""} />
        <Stat label="Queued to post" value={m.queued} />
        <Stat label="Posted to Moodle" value={m.posted} />
        <Stat label="Students to confirm" value={m.pendingUsers.length} tone={m.pendingUsers.length ? "text-amber" : ""} />
      </div>

      <Panel
        title="Failed Moodle grade posts"
        count={m.failed.length}
        tone={m.failed.length ? "alert" : "ok"}
        note="Resend puts the grade back in the queue; the retry job posts it within 5 minutes. A missing Moodle grade item has to be fixed in the Moodle activity settings first."
        action={resendable.length > 0 && <Button size="sm" primary onClick={() => void resend()} disabled={!!busy}>{busy === "all" ? "Queuing…" : `Resend all (${resendable.length})`}</Button>}
      >
        {m.failed.length === 0 ? <Empty>Every Moodle grade has been posted or is queued.</Empty> : (
          <>
            {exams.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {exams.map((e) => <Button key={e.id} size="sm" onClick={() => void resend(e.id)} disabled={!!busy}>{busy === e.id ? "Queuing…" : `Resend ${e.name}`}</Button>)}
              </div>
            )}
            <Table head={["Student", "Exam", "Score", "State", "Tries", "Last error", "Next try"]}>
              {m.failed.map((f) => (
                <tr key={`${f.linkId}-${f.student?.id}`}>
                  <Td>{studentLabel(f.student)}</Td>
                  <Td>{examLabel(f.exam)}</Td>
                  <Td className="tabular-nums">{f.pendingScore ?? "—"}</Td>
                  <Td className={`font-mono text-[10px] uppercase ${STATE[f.state].tone}`}>{STATE[f.state].label}</Td>
                  <Td className="tabular-nums">{f.attempts}</Td>
                  <Td className="max-w-[260px] truncate text-soft" >{f.lastError ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-soft">{f.nextAttemptAt ? ago(f.nextAttemptAt) : "—"}</Td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Panel>

      <Panel title="Moodle users pending confirmation" count={m.pendingUsers.length} tone={m.pendingUsers.length ? "amber" : "ok"} note="Students who opened an exam from Moodle but could not be matched to a roll number. The course's teacher confirms them from the Moodle panel on the exam.">
        {m.pendingUsers.length === 0 ? <Empty>Nobody is waiting.</Empty> : (
          <Table head={["Name", "Email / username", "Moodle ID", "Course", "Last tried"]}>
            {m.pendingUsers.map((u) => (
              <tr key={u.id}>
                <Td>{u.name ?? "—"}</Td>
                <Td className="text-soft">{u.email ?? u.username ?? "—"}</Td>
                <Td className="font-mono text-[11px]">{u.sourced_id ?? "—"}</Td>
                <Td>{u.context_title ?? "—"}</Td>
                <Td className="text-soft">{ago(u.last_launch_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Moodle retry job" tone={jobOk ? "ok" : "alert"} count={jobOk ? "running" : job ? "check" : "missing"}>
        {!job ? (
          <p className="text-[12.5px] text-alert">The lti-grade-retry job is not scheduled, so failed grades are never retried. See docs/moodle-lti.md to schedule it.</p>
        ) : (
          <ul className="space-y-1.5 text-[12.5px]">
            <li className="flex items-center gap-2"><Dot ok={job.active} /> {job.active ? "Scheduled" : "Paused"} <span className="font-mono text-[11px] text-soft">({job.schedule})</span></li>
            <li className="flex items-center gap-2"><Dot ok={job.last_run?.status === "succeeded"} /> Last run {job.last_run ? `${when(job.last_run.started_at)} (${ago(job.last_run.started_at)}), ${job.last_run.status}` : "never"}</li>
            <li className="flex items-center gap-2"><Dot ok={job.failures_24h === 0} /> {job.failures_24h} failed run(s) in the last 24 hours</li>
          </ul>
        )}
      </Panel>
    </>
  );
}
