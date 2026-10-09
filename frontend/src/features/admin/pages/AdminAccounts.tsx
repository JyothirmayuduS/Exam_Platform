import type { AdminOverview } from "@/shared/data/api/admin";
import { Empty, NotTracked, Section, TabBar, Table, Td, ago, useAdminTab, when, type AdminTab } from "@/features/admin/components/AdminUI";

const KIND: Record<string, string> = { staff: "Staff", student: "Student", unlinked: "Not linked to anyone" };

type TabId = "norole" | "roletag" | "browsers" | "photos" | "uploads";

export default function AdminAccounts({ data }: { data: AdminOverview }) {
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
    { id: "photos", label: "Registration photos" },
    { id: "uploads", label: "Kiosk uploads" },
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

      {tab === "photos" && (
        <NotTracked>The platform doesn't collect a registration photo for students. The optional photo-ID check before an exam takes a picture on the device but doesn't store it, so there is nothing to compare against.</NotTracked>
      )}

      {tab === "uploads" && (
        <NotTracked>The exam browser keeps unsent recordings and snapshots on the device and finishes uploading on its own, but it doesn't report that progress to the server yet. Teachers see missing pieces when they open a student's evidence.</NotTracked>
      )}
    </div>
  );
}
