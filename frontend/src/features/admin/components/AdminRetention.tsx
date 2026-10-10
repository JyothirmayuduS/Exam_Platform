import { useEffect, useState } from "react";
import {
  loadAdminRetention, runRetention, setLegalHold, setRetentionDays,
  type AdminOverview, type AdminRetention as Retention, type RetentionRun, type RetentionRunRow,
} from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Empty, Panel, Stat, Table, Td, ago, examLabel, periodLabel, studentLabel, when } from "@/features/admin/components/AdminUI";

const inputCls = "border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest";
const KINDS: Record<string, string> = { attempts: "Results and marks", violation_events: "Violation records", audit_logs: "Audit log entries" };
const HELD: Record<string, string> = {
  malpractice_hold: "malpractice hold", legal_hold: "legal hold", appeal: "open appeal", under_review: "flag not reviewed",
  no_upload_date: "no upload date", unchecked: "holds not checked",
};
const n = (v: number) => v.toLocaleString("en-IN");

const fileTotal = (r: RetentionRun, key: "deleted" | "skipped" | "failed") => Object.values(r.files).reduce((t, s) => t + s[key], 0);
const dbTotal = (r: RetentionRun, key: "deleted" | "skipped" | "failed") => Object.values(r.database).reduce((t, s) => t + s[key], 0);
const runTone = (s: RetentionRun["status"]) => (s === "succeeded" ? "text-forest" : s === "running" ? "text-amber" : "text-alert");
const runKind = (r: RetentionRunRow) => (r.dryRun ? "Dry run" : r.trigger === "schedule" ? "Scheduled" : "Admin run");

function RunCounts({ run }: { run: RetentionRun }) {
  const held = Object.values(run.files).reduce<Record<string, number>>((m, s) => {
    for (const [k, v] of Object.entries(s.held)) m[k] = (m[k] ?? 0) + v;
    return m;
  }, {});
  const verb = run.dryRun ? "Would delete" : "Deleted";
  return (
    <div className="space-y-1 text-[13px]">
      <p>
        {verb} <strong>{n(fileTotal(run, "deleted"))}</strong> evidence file(s) and <strong>{n(dbTotal(run, "deleted"))}</strong> database row(s);
        kept {n(run.skipped)} on hold{run.failed ? <>; <span className="text-alert">{n(run.failed)} failed</span></> : null}.
      </p>
      <p className="text-[12px] text-soft">
        {Object.entries(KINDS).map(([k, label]) => `${label}: ${n(run.database[k]?.deleted ?? 0)}`).join(" · ")}
      </p>
      {Object.keys(held).length > 0 && (
        <p className="text-[12px] text-soft">Files kept: {Object.entries(held).map(([k, v]) => `${n(v)} ${HELD[k] ?? k}`).join(", ")}</p>
      )}
      {!run.complete && <p className="text-[12px] text-amber">The run stopped at its time limit; the next run carries on from there.</p>}
      {run.errors.length > 0 && (
        <ul className="list-disc pl-5 text-[12px] text-alert">{run.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
    </div>
  );
}

export default function AdminRetention({ data, notify }: { data: AdminOverview; notify: (msg: string) => void }) {
  const [info, setInfo] = useState<Retention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState("");
  const [dry, setDry] = useState<RetentionRun | null>(null);
  const [hold, setHold] = useState<{ type: "exam" | "student"; examId: string; roll: string; reason: string }>({ type: "exam", examId: "", roll: "", reason: "" });

  const load = async () => {
    const res = await loadAdminRetention();
    if (res.ok) { setInfo(res.data); setDays(String(res.data.days)); setError(null); } else setError(res.error);
  };
  useEffect(() => { void load(); }, []);

  const act = async <T,>(key: string, run: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => void) => {
    setBusy(key);
    setError(null);
    const res = await run();
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    done(res.data);
    await load();
  };

  const savePeriod = () => {
    if (!info) return;
    const next = Number(days);
    if (!Number.isInteger(next) || next < info.min || next > info.max) { setError(`Choose a retention period between ${info.min} and ${info.max} days.`); return; }
    if (next === info.days) return;
    if (next < info.days && !window.confirm(`Shorten retention from ${periodLabel(info.days)} to ${periodLabel(next)}? Evidence and results older than ${next} days become due for deletion on the next run (held items stay).`)) return;
    void act("period", () => setRetentionDays(next), () => { setDry(null); notify(`Retention period set to ${periodLabel(next)}.`); });
  };

  const dryRun = () => void act("dry", () => runRetention(true), (d) => setDry(d.run));
  const realRun = () => {
    if (!dry) return;
    const files = fileTotal(dry, "deleted"), rows = dbTotal(dry, "deleted");
    if (!window.confirm(`Permanently delete about ${n(files)} evidence file(s) and ${n(rows)} database row(s) older than ${periodLabel(dry.retentionDays)}? Held items are kept. This cannot be undone.`)) return;
    void act("real", () => runRetention(false, dry.id), (d) => { setDry(null); notify(`Retention run finished: ${n(d.run.deleted)} deleted, ${n(d.run.skipped)} kept on hold, ${n(d.run.failed)} failed.`); });
  };

  const placeHold = () => {
    const reason = hold.reason.trim();
    if (!reason) { setError("Give a reason for the legal hold."); return; }
    const target = hold.type === "exam" ? { targetId: hold.examId } : { roll: hold.roll.trim() };
    if (!(target.targetId || target.roll)) { setError(hold.type === "exam" ? "Choose an exam to hold." : "Enter the student's roll number."); return; }
    void act("hold", () => setLegalHold({ targetType: hold.type, on: true, reason, ...target }), (d) => {
      setHold({ ...hold, examId: "", roll: "", reason: "" });
      notify(d.changed ? "Legal hold placed." : "That legal hold was already in place.");
    });
  };
  const liftHold = (h: Retention["holds"][number]) => {
    const label = h.targetType === "exam" ? examLabel(h.exam) : studentLabel(h.student);
    if (!window.confirm(`Lift the legal hold on ${label}? Retention then counts from the original upload dates, so anything older than the period is deleted on the next run.`)) return;
    void act(`lift-${h.id}`, () => setLegalHold({ targetType: h.targetType, targetId: h.targetId, on: false }), () => notify("Legal hold lifted."));
  };

  const due = info?.dueWeek;
  const dueRows = due ? Object.values(due.database).reduce((t, v) => t + v, 0) : 0;
  const last = info?.runs.find((r) => !r.dryRun) ?? null;
  const conflicts = info?.lifecycle.conflicts ?? [];

  return (
    <>
      {error && <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Retention period" value={info ? periodLabel(info.days) : "…"} detail={info?.updatedBy ? `Set by ${info.updatedBy}${info.updatedAt ? `, ${ago(info.updatedAt)}` : ""}` : undefined} />
        <Stat label="Results due this week" value={due ? n(dueRows) : "…"} detail="Database rows, holds excluded" tone={dueRows ? "text-amber" : ""} />
        <Stat label="Files due this week" value={due ? (due.files === null ? "—" : n(due.files)) : "…"} detail={due?.filesCountedAt ? `Counted ${ago(due.filesCountedAt)}` : "Run a dry run to count"} tone={due?.files ? "text-amber" : ""} />
        <Stat label="Last deletion run" value={last ? ago(last.finishedAt ?? last.startedAt) : info ? "Never" : "…"} detail={last ? `${last.status} · ${n(last.deleted)} deleted` : undefined} tone={last && last.status !== "succeeded" ? "text-alert" : ""} />
      </div>

      {conflicts.length > 0 && (
        <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">
          The R2 bucket has a lifecycle rule that deletes evidence before the app's retention period, ignoring holds:{" "}
          {conflicts.map((r) => `"${r.id}" after ${r.days} days`).join(", ")}. Remove it or set it longer than {info?.days} days in the Cloudflare dashboard (docs/retention.md).
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Retention"
          note={<>Recordings, snapshots, answer sheets, violation frames, results, marks and audit logs are kept for this period, then deleted by the daily job.
            Nothing is deleted for an attempt on a malpractice hold, an exam or student on a legal hold, an open appeal, or a serious flag not yet reviewed.</>}
        >
          {!info ? <Empty>Loading…</Empty> : (
            <div className="space-y-4 text-[13px]">
              <label className="block text-[12px] text-soft">
                Keep for (days, {info.min}–{info.max})
                <span className="mt-1 flex gap-2">
                  <input type="number" min={info.min} max={info.max} value={days} onChange={(e) => setDays(e.target.value)} className={`w-32 ${inputCls}`} />
                  <Button size="sm" onClick={savePeriod} disabled={!!busy || Number(days) === info.days}>{busy === "period" ? "Saving…" : "Save"}</Button>
                </span>
              </label>
              <p className="text-[12px] text-soft">
                Daily job: {!info.cronInstalled ? "pg_cron is not installed." : info.job
                  ? <>{info.job.active ? "scheduled" : "paused"} ({info.job.schedule} UTC){info.job.last_run && <>, last called {ago(info.job.last_run.started_at)} ({info.job.last_run.status})</>}</>
                  : "not scheduled."}
                {" "}R2 lifecycle: {!info.lifecycle.configured ? "R2 not configured." : info.lifecycle.error ? `couldn't read (${info.lifecycle.error}).`
                  : info.lifecycle.rules.length === 0 ? "no rule, so only the app deletes." : info.lifecycle.rules.map((r) => `${r.id} ${r.enabled ? "" : "(disabled) "}${r.days ?? "—"} days`).join(", ")}
              </p>
              <div className="border-t border-line pt-3">
                <p className="mb-2 text-[12px] text-soft">Count what is past the period now, then confirm to delete it. A dry run deletes nothing.</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={dryRun} disabled={!!busy}>{busy === "dry" ? "Counting…" : "Dry run"}</Button>
                  {dry && <Button size="sm" variant="danger" onClick={realRun} disabled={!!busy}>{busy === "real" ? "Deleting…" : "Confirm and delete"}</Button>}
                </div>
                {dry && <div className="mt-3"><RunCounts run={dry} /></div>}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Legal holds" count={info?.holds.length} note="Holding an exam or a student keeps all of their evidence and results until the hold is lifted. Both actions are recorded in the audit log.">
          <div className="mb-3 flex flex-wrap items-end gap-2 text-[12px] text-soft">
            <label>Hold
              <select value={hold.type} onChange={(e) => setHold({ ...hold, type: e.target.value as "exam" | "student" })} className={`mt-1 block ${inputCls}`}>
                <option value="exam">Exam</option><option value="student">Student</option>
              </select>
            </label>
            {hold.type === "exam" ? (
              <label className="min-w-48 flex-1">Exam
                <select value={hold.examId} onChange={(e) => setHold({ ...hold, examId: e.target.value })} className={`mt-1 block w-full ${inputCls}`}>
                  <option value="">Choose…</option>
                  {data.exams.map((e) => <option key={e.id} value={e.id}>{examLabel(e)}</option>)}
                </select>
              </label>
            ) : (
              <label>Roll number
                <input value={hold.roll} onChange={(e) => setHold({ ...hold, roll: e.target.value })} maxLength={40} className={`mt-1 block w-40 ${inputCls}`} />
              </label>
            )}
            <label className="min-w-48 flex-1">Reason
              <input value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} maxLength={500} placeholder="e.g. University inquiry ref." className={`mt-1 block w-full ${inputCls}`} />
            </label>
            <Button size="sm" onClick={placeHold} disabled={!!busy}>{busy === "hold" ? "Placing…" : "Place hold"}</Button>
          </div>
          {!info ? <Empty>…</Empty> : info.holds.length === 0 ? <Empty>No legal holds.</Empty> : (
            <Table head={["On", "Reason", "Placed", ""]}>
              {info.holds.map((h) => (
                <tr key={h.id}>
                  <Td>{h.targetType === "exam" ? examLabel(h.exam) : studentLabel(h.student)}<span className="block font-mono text-[10px] uppercase text-soft">{h.targetType}</span></Td>
                  <Td>{h.reason ?? "—"}</Td>
                  <Td className="text-soft">{when(h.placedAt)}{h.placedBy ? ` · ${h.placedBy}` : ""}</Td>
                  <Td>
                    <button type="button" className="font-mono text-[10px] uppercase tracking-wider text-alert hover:underline disabled:opacity-40" disabled={!!busy} onClick={() => liftHold(h)}>
                      {busy === `lift-${h.id}` ? "Lifting…" : "Lift"}
                    </button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Retention runs" count={info?.runs.length} note="The last ten runs of the deletion job, scheduled or started here. Failures are logged and the job carries on.">
        {!info ? <Empty>…</Empty> : info.runs.length === 0 ? <Empty>The deletion job hasn't run yet.</Empty> : (
          <Table head={["Started", "Run", "Status", "Deleted", "Kept (held)", "Failed", "Notes"]}>
            {info.runs.map((r) => (
              <tr key={r.id}>
                <Td className="text-soft">{when(r.startedAt)}</Td>
                <Td>{runKind(r)}{r.by ? <span className="text-soft"> · {r.by}</span> : null}</Td>
                <Td className={`font-mono text-[11px] uppercase ${runTone(r.status)}`}>{r.status}{!r.complete && r.status !== "running" ? " · stopped early" : ""}</Td>
                <Td className="tabular-nums">{n(r.deleted)}{r.dryRun ? <span className="text-soft"> (would)</span> : null}</Td>
                <Td className="tabular-nums">{n(r.skipped)}</Td>
                <Td className={`tabular-nums ${r.failed ? "text-alert" : ""}`}>{n(r.failed)}</Td>
                <Td className="max-w-md text-[12px] text-soft">{r.errors[0] ?? `${periodLabel(r.retentionDays)}, before ${when(r.cutoff)}`}{r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ""}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
