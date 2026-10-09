// Column layout of the ERP results export. The layout itself lives in
// erp-columns.json so headers and order can follow the ERP template without
// code changes; this module only checks that the file makes sense.
import raw from "./erp-columns.json" with { type: "json" };

/** Every value a column can show. */
export const RESULT_FIELDS = [
  "roll",
  "name",
  "programme",
  "semester",
  "course_code",
  "exam_name",
  "exam_id",
  "batch",
  "mcq_marks",
  "descriptive_marks",
  "total",
  "maximum",
  "percentage",
  "result_status",
  "attempt_date",
] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export type ResultStatus = "pass" | "fail" | "absent" | "withheld";
export const RESULT_STATUSES: ResultStatus[] = ["pass", "fail", "absent", "withheld"];

export const DATE_FORMATS = ["DD-MM-YYYY", "DD/MM/YYYY", "YYYY-MM-DD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export type ExportConfig = {
  sheetName: string;
  dateFormat: DateFormat;
  columns: { field: ResultField; header: string }[];
  status: Record<ResultStatus, string>;
};

/** Validate a column config; throws with every problem found. */
export function parseExportConfig(input: unknown): ExportConfig {
  const problems: string[] = [];
  const c = (input ?? {}) as Record<string, unknown>;

  const sheetName = typeof c.sheetName === "string" && c.sheetName.trim() ? c.sheetName.trim() : "Results";
  if (sheetName.length > 31 || /[\\/?*[\]:]/.test(sheetName)) problems.push("sheetName must be at most 31 characters, without \\ / ? * [ ] :");

  const dateFormat = (c.dateFormat ?? "DD-MM-YYYY") as DateFormat;
  if (!DATE_FORMATS.includes(dateFormat)) problems.push(`dateFormat must be one of ${DATE_FORMATS.join(", ")}`);

  const columns: ExportConfig["columns"] = [];
  if (!Array.isArray(c.columns) || c.columns.length === 0) {
    problems.push("columns must be a non-empty list");
  } else {
    const seenFields = new Set<string>();
    const seenHeaders = new Set<string>();
    c.columns.forEach((col, i) => {
      const { field, header } = (col ?? {}) as { field?: unknown; header?: unknown };
      if (typeof field !== "string" || !RESULT_FIELDS.includes(field as ResultField)) {
        problems.push(`columns[${i}].field "${String(field)}" is not one of ${RESULT_FIELDS.join(", ")}`);
        return;
      }
      if (typeof header !== "string" || !header.trim()) {
        problems.push(`columns[${i}].header is empty`);
        return;
      }
      if (seenFields.has(field)) problems.push(`columns[${i}].field "${field}" appears twice`);
      if (seenHeaders.has(header.trim().toLowerCase())) problems.push(`columns[${i}].header "${header}" appears twice`);
      seenFields.add(field);
      seenHeaders.add(header.trim().toLowerCase());
      columns.push({ field: field as ResultField, header: header.trim() });
    });
  }

  const statusIn = (c.status ?? {}) as Record<string, unknown>;
  const status = {} as Record<ResultStatus, string>;
  for (const s of RESULT_STATUSES) {
    const label = statusIn[s];
    if (typeof label !== "string" || !label.trim()) problems.push(`status.${s} is missing`);
    else status[s] = label.trim();
  }

  if (problems.length) throw new Error(`Invalid ERP column config:\n- ${problems.join("\n- ")}`);
  return { sheetName, dateFormat, columns, status };
}

export const ERP_EXPORT_CONFIG: ExportConfig = parseExportConfig(raw);
