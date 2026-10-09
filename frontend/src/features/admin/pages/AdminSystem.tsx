import { useEffect, useState } from "react";
import { loadAdminSystem, type AdminSystem as SystemData } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Dot, Empty, Panel, Table, Td, ago, when } from "@/features/admin/components/AdminUI";

export default function AdminSystem() {
  const [data, setData] = useState<SystemData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await loadAdminSystem();
    setLoading(false);
    if (res.ok) { setData(res.data); setError(null); } else setError(res.error);
  };
  useEffect(() => { void load(); }, []);

  const down = data?.health.filter((h) => !h.ok).length ?? 0;

  return (
    <>
      {error && <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>}
      <Panel
        title="System health"
        count={data ? (down ? `${down} problem${down === 1 ? "" : "s"}` : "all good") : undefined}
        tone={data ? (down ? "alert" : "ok") : undefined}
        note="Checked from the server when you open this page."
        action={<Button size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Check again"}</Button>}
      >
        {!data ? <Empty>{loading ? "Checking every service…" : "Not checked yet."}</Empty> : (
          <ul className="divide-y divide-line">
            {data.health.map((h) => (
              <li key={h.key} className="flex items-center gap-3 py-2.5 text-[13px]">
                <Dot ok={h.ok} />
                <span className="w-52 shrink-0 font-medium">{h.label}</span>
                <span className={`min-w-0 flex-1 truncate ${h.ok ? "text-soft" : "text-alert"}`}>{h.detail}</span>
                <span className="w-16 text-right font-mono text-[10px] text-soft">{h.ms !== null ? `${h.ms} ms` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Latest exam browser release">
          {!data ? <Empty>…</Empty> : !data.release ? <Empty>Couldn't read the release list from GitHub.</Empty> : (
            <div className="text-[13px]">
              <p className="font-serif text-2xl">v{data.release.version ?? data.release.tag}</p>
              <p className="mt-1 text-soft">Published {when(data.release.publishedAt)} ({ago(data.release.publishedAt)})</p>
              {data.release.url && <a href={data.release.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-forest underline">Release notes and installers</a>}
            </div>
          )}
        </Panel>

        <Panel title="Scheduled jobs" count={data?.jobs.length}>
          {!data ? <Empty>…</Empty> : !data.cronInstalled ? <Empty>The pg_cron extension isn't installed in this database, so nothing runs on a schedule (Moodle grade retries included).</Empty> : data.jobs.length === 0 ? <Empty>No scheduled jobs.</Empty> : (
            <Table head={["Job", "Schedule", "Last run", "Failures (24 h)"]}>
              {data.jobs.map((j) => (
                <tr key={j.name}>
                  <Td><span className="flex items-center gap-2"><Dot ok={j.active && j.last_run?.status === "succeeded"} /> <span className="font-mono text-[11px]">{j.name}</span></span></Td>
                  <Td className="font-mono text-[11px] text-soft">{j.schedule}{!j.active && " (paused)"}</Td>
                  <Td className="text-soft">{j.last_run ? `${ago(j.last_run.started_at)}, ${j.last_run.status}` : "never"}</Td>
                  <Td className={`tabular-nums ${j.failures_24h ? "text-alert" : ""}`}>{j.failures_24h}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
