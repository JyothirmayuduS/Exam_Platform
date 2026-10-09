import type { AdminOverview } from "@/shared/data/api/admin";
import { Dot, Empty, Panel, Stat, Table, Td, ago, examLabel, seconds, studentLabel, when } from "@/features/admin/components/AdminUI";

export default function AdminLive({ data }: { data: AdminOverview }) {
  const live = data.live.reduce(
    (t, l) => ({ writing: t.writing + l.counts.writing, submitted: t.submitted + l.counts.submitted, notStarted: t.notStarted + l.counts.notStarted, disconnected: t.disconnected + l.counts.disconnected }),
    { writing: 0, submitted: 0, notStarted: 0, disconnected: 0 },
  );
  const lost = data.connections.filter((c) => c.state === "lost").length;
  const weak = data.connections.length - lost;
  const notReady = data.upcoming.filter((u) => !u.ready).length;
  const busy = (c: AdminOverview["live"][number]["counts"]) => c.writing + c.disconnected + c.paused;
  const active = data.live.filter((l) => busy(l.counts) > 0).sort((a, b) => busy(b.counts) - busy(a.counts));
  const idle = data.live.filter((l) => busy(l.counts) === 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Live sittings" value={active.length} detail={`${data.totals.live} open`} tone={active.length ? "text-success" : ""} />
        <Stat label="Writing now" value={live.writing} />
        <Stat label="Submitted" value={live.submitted} detail="in live sittings" />
        <Stat label="Not started" value={live.notStarted} detail="in live sittings" />
        <Stat label="Disconnected" value={live.disconnected} tone={live.disconnected ? "text-alert" : ""} />
        <Stat label="Upcoming" value={data.totals.upcoming} detail={notReady ? `${notReady} not ready` : "all ready"} tone={notReady ? "text-amber" : ""} />
      </div>

      <Panel title="Live sittings" count={active.length} tone={active.length ? "ok" : undefined} note="Exams open right now with someone writing, paused or disconnected. Exams without a start time stay open until the teacher closes them.">
        {active.length === 0 ? <Empty>Nobody is writing an exam right now.</Empty> : (
          <Table head={["Exam", "Teacher", "Enrolled", "Writing", "Weak link", "Disconnected", "Paused", "Submitted", "Not started"]}>
            {active.map(({ exam, counts: c }) => (
              <tr key={exam.id}>
                <Td><span className="font-medium">{exam.name}</span><span className="block font-mono text-[10px] text-soft">{exam.batch ?? exam.id}</span></Td>
                <Td>{exam.owner ?? "—"}</Td>
                <Td className="tabular-nums">{c.enrolled}</Td>
                <Td className="tabular-nums text-success">{c.writing}</Td>
                <Td className={`tabular-nums ${c.weak ? "text-amber" : ""}`}>{c.weak}</Td>
                <Td className={`tabular-nums ${c.disconnected ? "font-semibold text-alert" : ""}`}>{c.disconnected}</Td>
                <Td className="tabular-nums">{c.paused}</Td>
                <Td className="tabular-nums">{c.submitted}</Td>
                <Td className="tabular-nums">{c.notStarted}</Td>
              </tr>
            ))}
          </Table>
        )}
        {idle.length > 0 && (
          <details className="mt-3 text-[12px] text-soft">
            <summary className="cursor-pointer">{idle.length} other open exam{idle.length === 1 ? "" : "s"} with nobody writing</summary>
            <p className="mt-2 leading-relaxed">{idle.map(({ exam, counts: c }) => `${exam.name} (${c.submitted}/${c.enrolled} submitted)`).join(" · ")}</p>
          </details>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Weak or lost connections"
          count={data.connections.length}
          tone={lost ? "alert" : weak ? "amber" : undefined}
          note="From the exam page's 15-second heartbeat and autosaves: quiet for over 45 s is a weak link, over 2 minutes is lost."
        >
          {data.connections.length === 0 ? <Empty>Every candidate who is writing is connected.</Empty> : (
            <ul className="divide-y divide-line">
              {data.connections.slice(0, 40).map((c) => (
                <li key={c.attemptId} className="flex items-center gap-3 py-2 text-[12.5px]">
                  <Dot ok={false} warn={c.state === "weak"} />
                  <span className="min-w-0 flex-1 truncate">{studentLabel(c.student)} <span className="text-soft">· {examLabel(c.exam)}</span></span>
                  <span className={`font-mono text-[10px] uppercase ${c.state === "lost" ? "text-alert" : "text-amber"}`}>{c.state === "lost" ? "Lost" : "Weak"}</span>
                  <span className="w-28 text-right font-mono text-[10px] text-soft">quiet {seconds(c.silentSeconds)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent flags" count={data.recentFlags.length} note="Warnings and above in the last 24 hours, from every exam.">
          {data.recentFlags.length === 0 ? <Empty>No flags in the last 24 hours.</Empty> : (
            <ul className="divide-y divide-line">
              {data.recentFlags.slice(0, 25).map((f) => (
                <li key={f.id} className="flex items-start gap-3 py-2 text-[12.5px]">
                  <span className={`mt-0.5 w-16 shrink-0 font-mono text-[10px] uppercase ${f.severity === "critical" ? "text-alert" : f.severity === "high" ? "text-alert/80" : "text-amber"}`}>{f.severity}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.violation_type}</span>
                    <span className="block truncate text-[11px] text-soft">{studentLabel(f.student)} · {examLabel(f.exam)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-soft">{ago(f.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Upcoming sittings" count={data.upcoming.length} tone={notReady ? "amber" : data.upcoming.length ? "ok" : undefined} note="A sitting is ready when it has a start time and duration, a question paper and enrolled students. Proctors and a Moodle link are advised.">
        {data.upcoming.length === 0 ? <Empty>No sittings are scheduled.</Empty> : (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.upcoming.map((u) => (
              <div key={u.exam.id} className={`border p-4 ${u.ready ? "border-line" : "border-amber/60 bg-amber/5"}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium">{u.exam.name}</p>
                  <span className={`font-mono text-[10px] uppercase ${u.ready ? "text-success" : "text-amber"}`}>{u.ready ? "Ready" : "Not ready"}</span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-soft">{when(u.startsAt)} · {ago(u.startsAt)} · {u.exam.owner ?? "No teacher"}</p>
                <ul className="mt-3 space-y-1">
                  {u.checks.map((c) => (
                    <li key={c.key} className="flex items-center gap-2 text-[12px]">
                      <Dot ok={c.ok} warn={!c.required} />
                      <span className="w-36 shrink-0">{c.label}{!c.required && <span className="text-soft"> (advised)</span>}</span>
                      <span className="text-soft">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Proctor assignments" count={data.proctorAssignments.length} note="Live and upcoming sittings. Teachers assign proctors from their Proctoring page.">
        {data.proctorAssignments.length === 0 ? <Empty>No live or upcoming sittings.</Empty> : (
          <Table head={["Exam", "When", "Proctors"]}>
            {data.proctorAssignments.map((p) => (
              <tr key={p.exam.id}>
                <Td><span className="font-medium">{p.exam.name}</span><span className="block text-[11px] text-soft">{p.exam.owner ?? "—"}</span></Td>
                <Td><span className={`font-mono text-[10px] uppercase ${p.phase === "live" ? "text-success" : "text-soft"}`}>{p.phase}</span></Td>
                <Td>
                  {p.assignees.length === 0
                    ? <span className="text-amber">Nobody assigned</span>
                    : p.assignees.map((a) => <span key={a.name} className="mr-2 inline-block border border-line px-1.5 py-0.5 text-[11.5px]">{a.name} <span className="text-soft">({a.role})</span></span>)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
