import { useEffect, useState } from "react";
import { loadAdminUploads, loadRegistrationPhotos, resetRegistrationPhoto, type AdminOverview, type AdminUploads, type StudentRef, type UploadState } from "@/shared/data/api/admin";
import { Button } from "@/features/teacher/components/PageChrome";
import { Empty, Section, TabBar, Table, Td, ago, examLabel, studentLabel, useAdminTab, when, type AdminTab } from "@/features/admin/components/AdminUI";

const KIND: Record<string, string> = { staff: "Staff", student: "Student", unlinked: "Not linked to anyone" };

const UPLOAD: Record<UploadState, { label: string; cls: string }> = {
  complete: { label: "Complete", cls: "text-success" },
  uploading: { label: "Still uploading", cls: "text-soft" },
  partial: { label: "Partial: no recording", cls: "text-amber" },
  missing: { label: "Nothing uploaded", cls: "text-alert" },
};

function UploadsTab() {
  const [data, setData] = useState<AdminUploads | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    const res = await loadAdminUploads();
    setLoading(false);
    if (res.ok) { setData(res.data); setError(null); } else setError(res.error);
  };
  useEffect(() => { void load(); }, []);

  if (error) return <p role="alert" className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>;
  if (!data) return <p className="py-6 text-center font-mono text-[11px] uppercase tracking-widest text-soft">Checking evidence storage…</p>;
  const k = data.kiosk, p = data.phone;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-soft">
          Last 30 days: <span className="font-medium text-ink tabular-nums">{k.checked}</span> kiosk sittings checked, <span className="tabular-nums text-success">{k.complete}</span> complete,{" "}
          <span className="tabular-nums">{k.uploading}</span> still uploading, <span className="tabular-nums text-amber">{k.partial}</span> partial, <span className="tabular-nums text-alert">{k.missing}</span> with nothing uploaded.
        </p>
        <Button size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Check again"}</Button>
      </div>

      <Section note={<>Submitted exam-browser sittings compared with what reached evidence storage (R2). A sitting is complete once its recording has arrived; the first 30 minutes after submit count as still uploading.{k.truncated ? " Storage listing stopped at 50,000 files, so some sittings may look incomplete." : ""}</>}>
        {!k.configured ? <Empty>Evidence storage (R2) is not configured on the server.</Empty>
          : k.error ? <Empty>{k.error}</Empty>
          : k.items.length === 0 ? <Empty>Every kiosk sitting from the last 30 days has its recording.</Empty> : (
            <Table head={["Student", "Exam", "Submitted", "Received", "Status"]}>
              {k.items.map((i) => (
                <tr key={i.attemptId}>
                  <Td>{studentLabel(i.student)}</Td>
                  <Td>{examLabel(i.exam)}<span className="block font-mono text-[10px] text-soft">v{i.version}</span></Td>
                  <Td className="whitespace-nowrap text-soft">{when(i.submittedAt)}</Td>
                  <Td className="text-soft">{i.files ? `${i.files} file${i.files === 1 ? "" : "s"} · ${i.kinds.join(", ")}` : "—"}{i.lastUpload && <span className="block text-[11px]">last {ago(i.lastUpload)}</span>}</Td>
                  <Td className={`font-mono text-[10px] uppercase ${UPLOAD[i.state].cls}`}>{UPLOAD[i.state].label}</Td>
                </tr>
              ))}
            </Table>
          )}
      </Section>

      <Section note={<>Handwritten answers sent from a phone by QR code. In the last 30 days {p.completed} finished; these were opened but never finished. <span className="tabular-nums">{p.open}</span> are still open, <span className="tabular-nums">{p.abandoned}</span> expired without an upload.</>}>
        {p.items.length === 0 ? <Empty>No unfinished phone uploads.</Empty> : (
          <Table head={["Student", "Exam", "Question", "Opened", "Status"]}>
            {p.items.map((i) => (
              <tr key={i.id}>
                <Td>{studentLabel(i.student)}</Td>
                <Td>{i.exam ? i.exam.name : <span className="text-soft">Opened before the sitting started</span>}</Td>
                <Td className="font-mono text-[11px]">{i.question ?? "—"}</Td>
                <Td className="whitespace-nowrap text-soft">{when(i.createdAt)}</Td>
                <Td className={`font-mono text-[10px] uppercase ${i.open ? "text-soft" : "text-amber"}`}>{i.open ? `Open, expires ${ago(i.expiresAt)}` : "Expired, no upload"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

type TabId = "norole" | "roletag" | "browsers" | "photos" | "uploads";

function PhotosTab({ photos, notify, onChanged }: { photos: AdminOverview["accounts"]["photos"]; notify: (m: string) => void; onChanged: () => void }) {
  const [taken, setTaken] = useState<{ student: StudentRef; capturedAt: string; url: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const res = await loadRegistrationPhotos();
    if (res.ok) { setTaken(res.data.photos); setError(null); } else setError(res.error);
  };
  useEffect(() => { void load(); }, []);

  const reset = async (s: StudentRef) => {
    if (!window.confirm(`Delete the registration photo of ${studentLabel(s)}? They will be asked to take a new one before their next exam.`)) return;
    setBusy(s.id);
    const res = await resetRegistrationPhoto(s.id);
    setBusy(null);
    if (!res.ok) { notify(res.error); return; }
    notify("Photo deleted. The student will retake it.");
    void load();
    onChanged();
  };

  return (
    <div className="space-y-5">
      <Section note={`Students take one webcam photo before their first exam. ${photos.taken} of ${photos.taken + photos.missingTotal} have one. The ones below haven't signed in since this started, or have no camera.`}>
        {photos.missing.length === 0 ? <Empty>Every student has a registration photo.</Empty> : (
          <Table head={["Roll", "Name"]}>
            {photos.missing.map((s) => <tr key={s.id}><Td className="font-mono">{s.roll || "—"}</Td><Td>{s.full_name ?? "—"}</Td></tr>)}
          </Table>
        )}
        {photos.missingTotal > photos.missing.length && <p className="mt-2 text-[11px] text-soft">Showing {photos.missing.length} of {photos.missingTotal}.</p>}
      </Section>

      <Section note="Photos already taken. View links last 10 minutes. Delete one to make the student retake it, for example if it's blurred or the wrong person.">
        {error ? <Empty>{error}</Empty> : !taken ? <Empty>Loading…</Empty> : taken.length === 0 ? <Empty>No photos yet.</Empty> : (
          <Table head={["Student", "Taken", "", ""]}>
            {taken.map((p) => (
              <tr key={p.student.id}>
                <Td>{studentLabel(p.student)}</Td>
                <Td className="whitespace-nowrap text-soft">{when(p.capturedAt)}</Td>
                <Td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="underline">View</a> : "—"}</Td>
                <Td><Button size="sm" onClick={() => void reset(p.student)} disabled={busy === p.student.id}>{busy === p.student.id ? "Deleting…" : "Allow retake"}</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

export default function AdminAccounts({ data, notify, onChanged }: { data: AdminOverview; notify: (m: string) => void; onChanged: () => void }) {
  const a = data.accounts;
  const v = data.versions;
  const outdated = v.inUse.filter((x) => x.outdated);
  const outdatedStudents = outdated.reduce((t, x) => t + x.students, 0);
  const moodleRisk = a.missingAppRole.filter((x) => x.kind === "student").length;
  const admins = data.staff.filter((s) => s.admin).length;

  const tabs: AdminTab<TabId>[] = [
    { id: "norole", label: "No role", count: a.unlinked.length, tone: "alert" },
    { id: "roletag", label: "Missing role tag", count: a.missingAppRole.length, tone: moodleRisk ? "amber" : undefined },
    { id: "browsers", label: "Exam browsers", count: outdatedStudents, tone: "amber" },
    { id: "photos", label: "Registration photos", count: a.photos.missingTotal, tone: "amber" },
    { id: "uploads", label: "Uploads" },
  ];
  const [tab, pick] = useAdminTab(tabs, "browsers");

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] text-soft">
        <span className="font-medium text-ink tabular-nums">{data.totals.students}</span> students ({a.studentsWithoutLogin} without a login) ·{" "}
        <span className="font-medium text-ink tabular-nums">{data.totals.staff}</span> staff ({admins} admin{admins === 1 ? "" : "s"})
      </p>

      <TabBar tabs={tabs} active={tab} onPick={pick} label="Students and devices" />

      {tab === "norole" && (
        <Section note="Sign-in accounts that belong to no student and no staff member. The app treats them as students with no exams.">
          {a.unlinked.length === 0 ? <Empty>Every sign-in account belongs to a student or a staff member.</Empty> : (
            <Table head={["Email", "Created", "Last sign-in"]}>
              {a.unlinked.map((u) => (
                <tr key={u.id}><Td>{u.email ?? u.id}</Td><Td className="text-soft">{when(u.created_at)}</Td><Td className="text-soft">{ago(u.last_sign_in_at)}</Td></tr>
              ))}
            </Table>
          )}
        </Section>
      )}

      {tab === "roletag" && (
        <Section note={`Accounts whose sign-in record carries no role tag. Moodle refuses students without the "student" tag${moodleRisk ? `, so ${moodleRisk} student(s) can't open exams from Moodle` : ""}. Accounts made by student provisioning get the tag automatically.`}>
          {a.missingAppRole.length === 0 ? <Empty>Every account has a role tag.</Empty> : (
            <Table head={["Email", "Belongs to"]}>
              {a.missingAppRole.slice(0, 100).map((u) => <tr key={u.id}><Td>{u.email ?? u.id}</Td><Td className="text-soft">{KIND[u.kind]}</Td></tr>)}
            </Table>
          )}
          {a.missingAppRole.length > 100 && <p className="mt-2 text-[11px] text-soft">Showing 100 of {a.missingAppRole.length}.</p>}
        </Section>
      )}

      {tab === "browsers" && (
        <Section note={`From sittings in the last 30 days. Latest release: ${v.latest ? `v${v.latest}` : "unknown"}. Sittings from older builds that don't report a version aren't counted.`}>
          {v.inUse.length === 0 ? <Empty>No sittings from the exam browser in the last 30 days.</Empty> : (
            <Table head={["Version", "Students", "Sittings", "Last seen", ""]}>
              {v.inUse.map((x) => (
                <tr key={x.version}>
                  <Td className="font-mono">{x.version === "web" ? "Web browser" : `v${x.version}`}</Td>
                  <Td className="tabular-nums">{x.students}</Td>
                  <Td className="tabular-nums">{x.attempts}</Td>
                  <Td className="text-soft">{ago(x.lastSeen)}</Td>
                  <Td>{x.outdated ? <span className="font-mono text-[10px] uppercase text-amber">Update needed</span> : x.version === v.latest ? <span className="font-mono text-[10px] uppercase text-success">Latest</span> : null}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      )}

      {tab === "photos" && <PhotosTab photos={a.photos} notify={notify} onChanged={onChanged} />}

      {tab === "uploads" && <UploadsTab />}
    </div>
  );
}
