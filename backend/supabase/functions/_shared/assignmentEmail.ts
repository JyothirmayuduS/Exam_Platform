// Who the proctor and evaluator assignment emails may go to. The caller must be
// signed in and able to manage the exam (checked on their own session); only
// staff ids already assigned (proctor) or delegated (evaluator, by exam or by
// one of its attempts) on that exam are emailed, at the address on their staff
// record. Raw addresses in the request are ignored, and no address is ever
// returned to the caller. A request that would email someone takes a
// rate-limit slot once its recipients are known.
// deno-lint-ignore-file no-explicit-any

export type AssignmentKind = "proctor" | "evaluator";
export type Recipient = { id: string; name: string; email: string; count?: number };
export type Outcome = { id: string | null; status: "sent" | "failed" | "skipped" | "refused" };
export type Gate =
  | { ok: true; recipients: Recipient[]; outcomes: Outcome[] }
  | { ok: false; status: number; error: string };

/** At most this many emailing requests per caller, exam and kind in the window. */
export const EMAIL_RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function gateAssignmentEmail(opts: {
  user: any | null;
  admin: any;
  kind: AssignmentKind;
  examId: unknown;
  requested: unknown;
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
  const assigned = await admin.rpc("assignment_email_staff", { p_exam: examId, p_kind: kind, p_ids: ids });
  if (assigned.error) return { ok: false, status: 500, error: "could not read the exam's assignments" };
  const onExam = new Set<string>((assigned.data ?? []).map((id: unknown) => String(id).toLowerCase()));

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

  if (recipients.length > 0) {
    const slot = await admin.rpc("take_assignment_email_slot", {
      p_caller: callerId, p_exam: examId, p_kind: kind,
      p_max: EMAIL_RATE_LIMIT.max, p_window_seconds: Math.round(EMAIL_RATE_LIMIT.windowMs / 1000),
    });
    if (slot.error) return { ok: false, status: 500, error: "could not check the email rate limit" };
    if (slot.data !== true) {
      return { ok: false, status: 429, error: "too many assignment emails for this exam; try again in a few minutes" };
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
