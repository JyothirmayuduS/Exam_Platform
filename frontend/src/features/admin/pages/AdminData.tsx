import { useEffect, useState } from "react";
import { loadAdminStorage, loadAdminSystem, recountStorageFolder, type AdminOverview, type AdminStorage, type Backups, type BackupRun } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Empty, NotTracked, Panel, Stat, Table, Td, ago, bytes, examLabel, studentLabel, when } from "@/features/admin/components/AdminUI";

const backupStale = (run: BackupRun) => Date.now() - Date.parse(run.finished_at ?? run.started_at) > 2 * 86_400_000;

function BackupLine({ label, run }: { label: string; run: BackupRun }) {
  const at = run.finished_at ?? run.started_at;
  const tone = run.status === "failed" ? "text-alert" : run.status === "running" ? "text-amber" : "text-forest";
  return (
    <p>
      <span className="text-soft">{label}:</span> {when(at)} ({ago(at)}) · <span className={`font-mono text-[11px] uppercase ${tone}`}>{run.status}</span>
      {run.size_bytes !== null && <> · {bytes(run.size_bytes)}</>}
      {run.location && <> · <span className="font-mono text-[11px]">{run.location}</span></>}
      {run.message && <span className="block text-[12px] text-soft">{run.message}</span>}
    </p>
  );
}

export default function AdminData({ data }: { data: AdminOverview }) {
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [counting, setCounting] = useState<{ folder: string; listed: number; left: number } | null>(null);

  const load = async () => {
    setLoading(true);
    const [s, sys] = await Promise.all([loadAdminStorage(), loadAdminSystem()]);
    setLoading(false);
    if (s.ok) setStorage(s.data); else setError(s.error);
    if (sys.ok) setBackups(sys.data.backups);
  };
  useEffect(() => { void load(); }, []);

  const count = async (folders: string[]) => {
    setError(null);
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      setCounting({ folder, listed: 0, left: folders.length - i - 1 });
      const res = await recountStorageFolder(folder, (listed) => setCounting({ folder, listed, left: folders.length - i - 1 }));
      if (!res.ok) { setError(`${folder}: ${res.error}`); break; }
    }
    setCounting(null);
    const s = await loadAdminStorage();
    if (s.ok) setStorage(s.data);
  };

  const r2 = storage?.r2;
  const bucketBytes = storage?.buckets.reduce((t, b) => t + b.bytes, 0) ?? 0;
  const due = r2?.exams.filter((g) => g.dueSoonObjects > 0) ?? [];
  const partial = !!r2 && r2.uncounted.length > 0;
  const coverage = r2 ? (partial ? ` · ${r2.countedFolders} of ${r2.folders} folders counted` : "") : "";

  return (
    <>
      {error && <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Evidence storage (R2)" value={r2 ? bytes(r2.totalBytes) : "…"} detail={r2 ? `${r2.totalObjects.toLocaleString("en-IN")} files${coverage}` : undefined} tone={partial ? "text-amber" : ""} />
        <Stat label="File storage (Supabase)" value={storage ? bytes(bucketBytes) : "…"} detail={storage ? `${storage.buckets.length} bucket(s)` : undefined} />
        <Stat label="Database" value={storage ? bytes(storage.databaseBytes) : "…"} />
        <Stat label="Deleted within 7 days" value={r2 ? bytes(r2.dueSoonBytes) : "…"} detail={r2 ? `${r2.dueSoonObjects} files, ${r2.retentionDays}-day retention` : undefined} tone={r2?.dueSoonObjects ? "text-amber" : ""} />
      </div>

      <Panel
        title="Storage per exam"
        count={r2?.exams.length}
        tone={partial ? "amber" : undefined}
        note={r2 ? <>
          Recordings, snapshots, reports and phone uploads in R2, deleted {r2.retentionDays} days after upload by the bucket's retention rule.
          Each exam folder is counted on request and the figures are kept, so this page never lists the whole bucket.
          {partial && <> <strong>{r2.uncounted.length} folder(s) have not been counted yet, so the totals leave them out.</strong></>}
        </> : undefined}
        action={
          <div className="flex gap-2">
            {partial && <Button size="sm" onClick={() => void count(r2!.uncounted)} disabled={!!counting}>Count {r2!.uncounted.length} not counted</Button>}
            <Button size="sm" onClick={() => void load()} disabled={loading || !!counting}>{loading ? "Loading…" : "Refresh"}</Button>
          </div>
        }
      >
        {counting && (
          <p role="status" className="mb-2 text-[12px] text-soft">
            Counting <span className="font-mono">{counting.folder}</span>: {counting.listed.toLocaleString("en-IN")} files so far{counting.left ? `, ${counting.left} more folder(s) after this` : ""}…
          </p>
        )}
        {!r2 ? <Empty>{loading ? "Loading…" : "Not loaded."}</Empty>
          : !r2.configured ? <Empty>R2 isn't configured for the server functions.</Empty>
          : r2.exams.length === 0 ? <Empty>The evidence bucket is empty.</Empty> : (
            <Table head={["Folder", "Exam", "Size", "Files", "Oldest file", "Next deletion", "Counted", ""]}>
              {r2.exams.map((g) => (
                <tr key={g.folder}>
                  <Td className="font-mono text-[11px]">{g.folder}</Td>
                  <Td>{g.examName ?? <span className="text-soft">No matching exam</span>}{g.examIds.length > 1 && <span className="text-soft"> (+{g.examIds.length - 1} with the same name)</span>}</Td>
                  <Td className="tabular-nums">{g.countedAt ? bytes(g.bytes) : "—"}</Td>
                  <Td className="tabular-nums">{g.countedAt ? g.objects.toLocaleString("en-IN") : "—"}</Td>
                  <Td className="text-soft">{when(g.oldest)}</Td>
                  <Td className={g.dueSoonObjects ? "text-amber" : "text-soft"}>{g.nextDeletion ? `${when(g.nextDeletion)} (${ago(g.nextDeletion)})` : "—"}</Td>
                  <Td className={g.countedAt ? "text-soft" : "text-amber"}>{g.countedAt ? ago(g.countedAt) : "Not counted"}</Td>
                  <Td>
                    <button type="button" className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline disabled:opacity-40" disabled={!!counting} onClick={() => void count([g.folder])}>
                      {g.countedAt ? "Recount" : "Count"}
                    </button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        {r2?.error && <p className="mt-2 text-[11px] text-alert">{r2.error}</p>}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Due for deletion this week" count={due.length} tone={due.length ? "amber" : "ok"} note="Download anything you need to keep from the teacher's Evidence page before then.">
          {!r2 ? <Empty>…</Empty> : due.length === 0 ? <Empty>Nothing is due for deletion in the next 7 days.</Empty> : (
            <Table head={["Exam", "Files", "Size", "First deletion"]}>
              {due.map((g) => (
                <tr key={g.folder}><Td>{g.examName ?? g.folder}</Td><Td className="tabular-nums">{g.dueSoonObjects}</Td><Td className="tabular-nums">{bytes(g.dueSoonBytes)}</Td><Td className="text-soft">{when(g.nextDeletion)}</Td></tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Holds" count={data.holds.length} note="Results withheld for malpractice review. Holds don't stop evidence from being deleted after the retention period.">
          {data.holds.length === 0 ? <Empty>No results are on hold.</Empty> : (
            <Table head={["Student", "Exam", "Since"]}>
              {data.holds.map((h) => <tr key={h.attemptId}><Td>{studentLabel(h.student)}</Td><Td>{examLabel(h.exam)}</Td><Td className="text-soft">{when(h.heldAt)}</Td></tr>)}
            </Table>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Supabase buckets" count={storage?.buckets.length}>
          {!storage ? <Empty>…</Empty> : storage.buckets.length === 0 ? <Empty>No files.</Empty> : (
            <Table head={["Bucket", "Files", "Size"]}>
              {storage.buckets.map((b) => <tr key={b.bucket}><Td className="font-mono text-[11px]">{b.bucket}</Td><Td className="tabular-nums">{b.objects}</Td><Td className="tabular-nums">{bytes(b.bytes)}</Td></tr>)}
            </Table>
          )}
        </Panel>

        <Panel
          title="Last backup"
          tone={!backups ? undefined : !backups.last_success || backupStale(backups.last_success) || backups.latest?.status === "failed" ? "alert" : "ok"}
          note="Reported by the backup job itself, one row per run in the backup_runs table (README, Backups)."
        >
          {!backups ? <Empty>…</Empty> : !backups.latest ? (
            <NotTracked>No backup has reported yet. Have the backup job call record_backup_run after each run; see Backups in the README.</NotTracked>
          ) : (
            <div className="space-y-1 text-[13px]">
              <BackupLine label="Latest run" run={backups.latest} />
              {backups.last_success && backups.last_success.id !== backups.latest.id && <BackupLine label="Last good backup" run={backups.last_success} />}
              {!backups.last_success && <p className="text-alert">No backup has succeeded yet.</p>}
              {backups.last_success && backupStale(backups.last_success) && <p className="text-alert">The last good backup is more than two days old.</p>}
              {backups.failures_7d > 0 && <p className="text-amber">{backups.failures_7d} failed run(s) in the last 7 days.</p>}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
