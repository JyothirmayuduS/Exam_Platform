// Who the proctor and evaluator assignment emails may go to. The caller must be
// signed in and able to manage the exam (checked on their own session); only
// staff ids already assigned (proctor) or delegated (evaluator) on that exam
// are emailed, at the address on their staff record. Raw addresses in the
// request are ignored, and no address is ever returned to the caller.
// deno-lint-ignore-file no-explicit-any

export type AssignmentKind = "proctor" | "evaluator";
export type Recipient = { id: string; name: string; email: string; count?: number };
export type Outcome = { id: string | null; status: "sent" | "failed" | "skipped" | "refused" };
export type Gate =
  | { ok: true; recipients: Recipient[]; outcomes: Outcome[] }
  | { ok: false; status: number; error: string };

/** At most this many email requests per caller, exam and kind in the window. */
export const EMAIL_RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function gateAssignmentEmail(opts: {
  user: any | null;
  admin: any;
  kind: AssignmentKind;
  examId: unknown;
  requested: unknown;
  now?: number;
}): Promise<Gate> {
  const { user, admin, kind } = opts;
  const { data: auth } = user ? await user.auth.getUser() : { data: null };
  const callerId: string | undefined = auth?.user?.id;
  if (!callerId) return { ok: false, status: 403, error: "forbidden: sign in to send assignment emails" };

  const examId = typeof opts.examId === "string" ? opts.examId.trim() : "";
  if (!examId) return { ok: false, status: 400, error: "examId is required" };

  const manage = await user.rpc("can_manage_exam", { p_exam: examId });
  if (manage.error) return { ok: false, status: 500, error: "could not check access to this exam" };
  if (manage.data !== true) {
    return { ok: false, status: 403, error: "forbidden: only the exam's owner, a delegated teacher or an admin can send these emails" };
  }

  const since = new Date((opts.now ?? Date.now()) - EMAIL_RATE_LIMIT.windowMs).toISOString();
  const recent = await admin.from("assignment_email_log").select("id", { count: "exact", head: true })
    .eq("caller_id", callerId).eq("exam_id", examId).eq("kind", kind).gte("created_at", since);
  if (recent.error) return { ok: false, status: 500, error: "could not check the email rate limit" };
  if ((recent.count ?? 0) >= EMAIL_RATE_LIMIT.max) {
    return { ok: false, status: 429, error: "too many assignment emails for this exam; try again in a few minutes" };
  }
  const logged = await admin.from("assignment_email_log").insert({ caller_id: callerId, exam_id: examId, kind });
  if (logged.error) return { ok: false, status: 500, error: "could not record this email request" };

  const entries = (Array.isArray(opts.requested) ? opts.requested : []) as Record<string, unknown>[];
  const outcomes: Outcome[] = [];
  const wanted = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    const id = typeof e?.id === "string" && UUID.test(e.id) ? e.id.toLowerCase() : null;
    if (!id) outcomes.push({ id: typeof e?.id === "string" ? e.id : null, status: "refused" });
    else if (!wanted.has(id)) wanted.set(id, e);
  }
  if (wanted.size === 0) return { ok: true, recipients: [], outcomes };

  const ids = [...wanted.keys()];
  const assigned = kind === "proctor"
    ? await admin.from("proctor_assignments").select("assignee_id").eq("exam_id", examId).in("assignee_id", ids)
    : await admin.from("grading_delegations").select("delegate_id").eq("exam_id", examId).in("delegate_id", ids);
  if (assigned.error) return { ok: false, status: 500, error: "could not read the exam's assignments" };
  const onExam = new Set<string>((assigned.data ?? []).map((r: { assignee_id?: string | null; delegate_id?: string | null }) =>
    String(r.assignee_id ?? r.delegate_id ?? "").toLowerCase()));

  const allowed = ids.filter((id) => onExam.has(id));
  const staff = allowed.length
    ? await admin.from("teachers").select("id, email, full_name, name").in("id", allowed)
    : { data: [], error: null };
  if (staff.error) return { ok: false, status: 500, error: "could not read staff records" };
  const byId = new Map<string, any>((staff.data ?? []).map((t: any) => [String(t.id).toLowerCase(), t]));

  const recipients: Recipient[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    const email = typeof t?.email === "string" ? t.email.trim() : "";
    if (!onExam.has(id)) outcomes.push({ id, status: "refused" });
    else if (!email) outcomes.push({ id, status: "skipped" });
    else {
      const count = Number(wanted.get(id)?.count);
      recipients.push({
        id,
        name: String(t.full_name || t.name || ""),
        email,
        ...(Number.isFinite(count) ? { count } : {}),
      });
    }
  }
  return { ok: true, recipients, outcomes };
}

/** The response body: counts plus each recipient's id and status, never an address. */
export function emailSummary(outcomes: Outcome[]) {
  const n = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  return {
    sent: n("sent"),
    skipped: n("skipped"),
    failed: n("failed"),
    refused: n("refused"),
    results: outcomes.map(({ id, status }) => ({ id, status })),
  };
}
