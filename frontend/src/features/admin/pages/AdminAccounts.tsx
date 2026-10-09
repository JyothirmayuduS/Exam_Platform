import type { AdminOverview } from "@/shared/data/api/admin";
import { Empty, NotTracked, Panel, Stat, Table, Td, ago, when } from "@/features/admin/components/AdminUI";

const KIND: Record<string, string> = { staff: "Staff", student: "Student", unlinked: "Not linked to anyone" };

export default function AdminAccounts({ data }: { data: AdminOverview }) {
  const a = data.accounts;
  const v = data.versions;
  const outdated = v.inUse.filter((x) => x.outdated);
  const moodleRisk = a.missingAppRole.filter((x) => x.kind === "student").length;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Students" value={data.totals.students} detail={`${a.studentsWithoutLogin} without a login`} />
        <Stat label="Staff" value={data.totals.staff} detail={`${data.staff.filter((s) => s.admin).length} admin(s)`} />
        <Stat label="Accounts with no role" value={a.unlinked.length} tone={a.unlinked.length ? "text-alert" : ""} />
        <Stat label="Old exam browsers" value={outdated.reduce((t, x) => t + x.students, 0)} detail="students, last 30 days" tone={outdated.length ? "text-amber" : ""} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Accounts with no role" count={a.unlinked.length} tone={a.unlinked.length ? "alert" : "ok"} note="Sign-in accounts that belong to no student and no staff member. The app treats them as students with no exams.">
          {a.unlinked.length === 0 ? <Empty>Every sign-in account belongs to a student or a staff member.</Empty> : (
            <Table head={["Email", "Created", "Last sign-in"]}>
              {a.unlinked.map((u) => (
                <tr key={u.id}><Td>{u.email ?? u.id}</Td><Td className="text-soft">{when(u.created_at)}</Td><Td className="text-soft">{ago(u.last_sign_in_at)}</Td></tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel
          title="Accounts without a role tag"
          count={a.missingAppRole.length}
          tone={moodleRisk ? "amber" : "ok"}
          note={`Accounts whose sign-in record carries no role tag. Moodle refuses students without the "student" tag${moodleRisk ? `, so ${moodleRisk} student(s) can't open exams from Moodle` : ""}. Accounts made by student provisioning get the tag automatically.`}
        >
          {a.missingAppRole.length === 0 ? <Empty>Every account has a role tag.</Empty> : (
            <Table head={["Email", "Belongs to"]}>
              {a.missingAppRole.slice(0, 100).map((u) => <tr key={u.id}><Td>{u.email ?? u.id}</Td><Td className="text-soft">{KIND[u.kind]}</Td></tr>)}
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Exam browser versions in use" count={v.inUse.length} tone={outdated.length ? "amber" : "ok"} note={`From sittings in the last 30 days. Latest release: ${v.latest ? `v${v.latest}` : "unknown"}.`}>
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
        <p className="mt-3 text-[11px] text-soft">Sittings from older builds that don't report a version aren't counted.</p>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Students without a registration photo">
          <NotTracked>The platform doesn't collect a registration photo for students. The optional photo-ID check before an exam takes a picture on the device but doesn't store it, so there is nothing to compare against.</NotTracked>
        </Panel>
        <Panel title="Exam browsers still uploading or partial">
          <NotTracked>The exam browser keeps unsent recordings and snapshots on the device and finishes uploading on its own, but it doesn't report that progress to the server yet. Teachers see missing pieces when they open a student's evidence.</NotTracked>
        </Panel>
      </div>
    </>
  );
}
