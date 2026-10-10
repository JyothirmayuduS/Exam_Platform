// POST /results-export
//   { scope: "exam", examId, format: "csv" | "xlsx" }
//   { scope: "programme", programme, semester, format: "csv" | "xlsx" }
// -> { filename, mime, encoding, content, summary }
//
// Teachers export exams they own; staff admins export any exam. Only exams
// whose results are released are exported, and every export is written to the
// audit log before the file is returned.
import type { DBQuestion } from "../exam/types.ts";
import { ERP_EXPORT_CONFIG, type ExportConfig } from "./columns.ts";
import { toCsv, toTable, toXlsx } from "./formats.ts";
import { buildExamRows, resultsReleased, type ExportAttempt, type ExportExam, type ExportStudent, type ResultRow } from "./rows.ts";

export type Actor = { authId: string; isAdmin: boolean };

export type ExamData = { pool: DBQuestion[]; enrolled: string[]; attempts: ExportAttempt[]; heldAttemptIds: Set<string> };

export interface ResultsStore {
  examById(id: string): Promise<ExportExam | null>;
  /** Exams whose ERP programme and semester match, ignoring case and spacing. */
  examsForProgramme(programme: string, semester: string): Promise<ExportExam[]>;
  examData(examId: string): Promise<ExamData>;
  students(ids: string[]): Promise<Map<string, ExportStudent>>;
  /** Must throw when the entry could not be written. */
  audit(entry: { actorId: string; action: string; targetType: string; targetId: string; meta: Record<string, unknown> }): Promise<void>;
}

export type ResultsDeps = {
  store: ResultsStore;
  actor: (req: Request) => Promise<Actor | null>;
  now: () => number;
  config?: ExportConfig;
};

export type ExportSummary = {
  rows: number;
  pending: number;
  absent: number;
  withheld: number;
  exams: { id: string; name: string; rows: number; pending: number }[];
  skipped: { id: string; name: string; reason: "not_released" }[];
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "results";

export function canExport(actor: Actor, exam: ExportExam): boolean {
  return actor.isAdmin || exam.created_by === actor.authId;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function createResultsExportHandler(deps: ResultsDeps) {
  const config = deps.config ?? ERP_EXPORT_CONFIG;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const actor = await deps.actor(req);
      if (!actor) return json({ error: "teachers_only" }, 401);

      let body: Record<string, unknown> = {};
      try { body = (await req.json()) ?? {}; } catch { /* empty body */ }
      const format = body.format === "xlsx" ? "xlsx" : body.format === "csv" ? "csv" : null;
      if (!format) return json({ error: "bad_format" }, 400);

      let exams: ExportExam[];
      let target: { type: string; id: string; name: string };
      if (body.scope === "exam") {
        const exam = await deps.store.examById(text(body.examId));
        if (!exam) return json({ error: "exam_not_found" }, 404);
        if (!canExport(actor, exam)) return json({ error: "not_your_exam" }, 403);
        exams = [exam];
        target = { type: "exam", id: exam.id, name: (text(exam.settings?.courseCode) || exam.id) };
      } else if (body.scope === "programme") {
        const programme = text(body.programme);
        const semester = text(body.semester);
        if (!programme || !semester) return json({ error: "programme_and_semester_required" }, 400);
        exams = (await deps.store.examsForProgramme(programme, semester)).filter((e) => canExport(actor, e));
        if (!exams.length) return json({ error: "no_exams" }, 404);
        target = { type: "programme", id: `${programme}|${semester}`, name: `${programme}_sem${semester}` };
      } else {
        return json({ error: "bad_scope" }, 400);
      }

      const now = deps.now();
      const summary: ExportSummary = { rows: 0, pending: 0, absent: 0, withheld: 0, exams: [], skipped: [] };
      const rows: ResultRow[] = [];
      for (const exam of exams) {
        if (!resultsReleased(exam, now)) {
          summary.skipped.push({ id: exam.id, name: exam.name, reason: "not_released" });
          continue;
        }
        const data = await deps.store.examData(exam.id);
        const students = await deps.store.students(Array.from(new Set([...data.enrolled, ...data.attempts.map((a) => a.student_id)])));
        const built = buildExamRows({ exam, ...data, students, now });
        rows.push(...built.rows);
        summary.exams.push({ id: exam.id, name: exam.name, rows: built.rows.length, pending: built.pending });
        summary.pending += built.pending;
      }
      if (!summary.exams.length) return json({ error: "not_released", summary }, 409);
      summary.rows = rows.length;
      summary.absent = rows.filter((r) => r.result_status === "absent").length;
      summary.withheld = rows.filter((r) => r.result_status === "withheld").length;

      await deps.store.audit({
        actorId: actor.authId,
        action: "results.exported",
        targetType: target.type,
        targetId: target.id,
        meta: {
          format,
          admin: actor.isAdmin,
          exam_ids: summary.exams.map((e) => e.id),
          skipped_exam_ids: summary.skipped.map((e) => e.id),
          rows: summary.rows,
          pending: summary.pending,
          absent: summary.absent,
          withheld: summary.withheld,
          columns: config.columns.map((c) => c.field),
        },
      });

      const table = toTable(rows, config);
      const date = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
      const filename = `results_${slug(target.name)}_${date}.${format}`;
      return format === "csv"
        ? json({ filename, mime: "text/csv;charset=utf-8", encoding: "utf8", content: toCsv(table), summary })
        : json({
          filename,
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          encoding: "base64",
          content: base64(toXlsx(table, config.sheetName)),
          summary,
        });
    } catch (err) {
      console.error("results-export", err);
      return json({ error: "server_error" }, 500);
    }
  };
}
