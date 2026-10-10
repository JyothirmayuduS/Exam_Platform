// Staff pickers in the browser carry no email addresses. Assignment emails
// look up each assignee's address here, by staff id, with the service role.

type Recipient = { id?: string | null; email?: string | null };
type TeachersReader = {
  from(table: "teachers"): {
    select(cols: string): { in(col: string, values: string[]): PromiseLike<{ data: { id: string; email: string | null }[] | null }> };
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fills each recipient's email from their staff record; recipients without a
 *  staff id keep the address they came with. */
export async function withStaffEmails<T extends Recipient>(db: TeachersReader, list: T[]): Promise<T[]> {
  const ids = [...new Set(list.map((r) => r.id).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (ids.length === 0) return list;
  const { data } = await db.from("teachers").select("id, email").in("id", ids);
  const byId = new Map((data ?? []).map((t) => [t.id, t.email]));
  return list.map((r) => (r.id && byId.has(r.id) ? { ...r, email: byId.get(r.id) ?? null } : r));
}
