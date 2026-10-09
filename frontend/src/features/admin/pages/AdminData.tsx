import { useEffect, useState } from "react";
import { loadAdminStorage, loadAdminSystem, type AdminOverview, type AdminStorage, type AdminSystem } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Empty, NotTracked, Panel, Stat, Table, Td, ago, bytes, examLabel, studentLabel, when } from "@/features/admin/components/AdminUI";

export default function AdminData({ data }: { data: AdminOverview }) {
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [backups, setBackups] = useState<AdminSystem["backups"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const [s, sys] = await Promise.all([loadAdminStorage(), loadAdminSystem()]);
    setLoading(false);
    if (s.ok) setStorage(s.data); else setError(s.error);
    if (sys.ok) setBackups(sys.data.backups);
  };
  useEffect(() => { void load(); }, []);

  const r2 = storage?.r2;
  const bucketBytes = storage?.buckets.reduce((t, b) => t + b.bytes, 0) ?? 0;
  const due = r2?.exams.filter((g) => g.dueSoonObjects > 0) ?? [];

  return (
    <>
      {error && <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Evidence storage (R2)" value={r2 ? bytes(r2.totalBytes) : "…"} detail={r2 ? `${r2.totalObjects.toLocaleString("en-IN")} files${r2.truncated ? " (first 50,000)" : ""}` : undefined} />
        <Stat label="File storage (Supabase)" value={storage ? bytes(bucketBytes) : "…"} detail={storage ? `${storage.buckets.length} bucket(s)` : undefined} />
        <Stat label="Database" value={storage ? bytes(storage.databaseBytes) : "…"} />
        <Stat label="Deleted within 7 days" value={r2 ? bytes(r2.dueSoonBytes) : "…"} detail={r2 ? `${r2.dueSoonObjects} files, ${r2.retentionDays}-day retention` : undefined} tone={r2?.dueSoonObjects ? "text-amber" : ""} />
      </div>

      <Panel
        title="Storage per exam"
        count={r2?.exams.length}
        note={r2 ? `Recordings, snapshots, reports and phone uploads in R2. Everything is deleted ${r2.retentionDays} days after upload by the bucket's retention rule.` : undefined}
        action={<Button size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Counting…" : "Recount"}</Button>}
      >
        {!r2 ? <Empty>{loading ? "Listing the bucket…" : "Not loaded."}</Empty>
          : !r2.configured ? <Empty>R2 isn't configured for the server functions.</Empty>
          : r2.exams.length === 0 ? <Empty>The evidence bucket is empty.</Empty> : (
            <Table head={["Folder", "Exam", "Size", "Files", "Oldest file", "Next deletion"]}>
              {r2.exams.map((g) => (
                <tr key={g.folder}>
                  <Td className="font-mono text-[11px]">{g.folder}</Td>
                  <Td>{g.examName ?? <span className="text-soft">No matching exam</span>}{g.examIds.length > 1 && <span className="text-soft"> (+{g.examIds.length - 1} with the same name)</span>}</Td>
                  <Td className="tabular-nums">{bytes(g.bytes)}</Td>
                  <Td className="tabular-nums">{g.objects}</Td>
                  <Td className="text-soft">{when(g.oldest)}</Td>
                  <Td className={g.dueSoonObjects ? "text-amber" : "text-soft"}>{g.nextDeletion ? `${when(g.nextDeletion)} (${ago(g.nextDeletion)})` : "—"}</Td>
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

        <Panel title="Last backup" tone={backups?.available ? (backups.latest ? "ok" : "alert") : undefined}>
          {!backups ? <Empty>…</Empty> : !backups.available ? (
            <NotTracked>
              {backups.reason === "not_connected"
                ? "The console isn't connected to the Supabase management API, so it can't read the backup list. Add a SUPABASE_MANAGEMENT_TOKEN secret to the admin-dashboard function to show it here."
                : `The backup list couldn't be read (${backups.reason}).`}
            </NotTracked>
          ) : backups.latest ? (
            <p className="text-[13px]">{when(backups.latest.at)} ({ago(backups.latest.at)}) · <span className="font-mono text-[11px] uppercase">{backups.latest.status}</span> · {backups.count} backup(s) kept{backups.pitr ? " · point-in-time recovery on" : ""}</p>
          ) : (
            <p className="text-[13px] text-alert">Supabase reports no backups for this project. Daily backups need a paid plan.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
