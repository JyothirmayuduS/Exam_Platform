// The exam's name, asked in order: academic type, subject code, subject name.
// Tells the teacher as they type when another exam of that type already uses
// the code or the subject name; the database refuses it either way.

import { useEffect, useState } from "react";
import {
  conflictMessage, findExamNamingConflict, listAcademicTypes, normalizeNaming, SUBJECT_CODE_MAX, SUBJECT_NAME_MAX,
  type AcademicType, type ExamNaming, type NamingField,
} from "@/shared/data/api/examNaming";

export type NamingCheck = { conflict: NamingField | null; checking: boolean };

const CHECK_DELAY_MS = 350;

export default function ExamNamingFields({
  value,
  onChange,
  examId,
  onCheck,
  autoFocus,
  idPrefix = "exam-naming",
}: {
  value: ExamNaming;
  onChange: (next: ExamNaming) => void;
  /** The exam being edited, so it doesn't clash with itself. */
  examId?: string;
  onCheck?: (check: NamingCheck) => void;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const [types, setTypes] = useState<AcademicType[] | null>(null);
  const [conflict, setConflict] = useState<NamingField | null>(null);

  useEffect(() => {
    let active = true;
    void listAcademicTypes().then((rows) => { if (active) setTypes(rows); });
    return () => { active = false; };
  }, []);

  const { academic_type, subject_code, subject_name } = normalizeNaming(value);
  useEffect(() => {
    let active = true;
    if (!academic_type || (!subject_code && !subject_name)) {
      setConflict(null);
      onCheck?.({ conflict: null, checking: false });
      return;
    }
    onCheck?.({ conflict: null, checking: true });
    const t = window.setTimeout(() => {
      void findExamNamingConflict({ academic_type, subject_code, subject_name }, examId).then((field) => {
        if (!active) return;
        setConflict(field);
        onCheck?.({ conflict: field, checking: false });
      });
    }, CHECK_DELAY_MS);
    return () => { active = false; window.clearTimeout(t); };
    // onCheck is a callback from the parent; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academic_type, subject_code, subject_name, examId]);

  const options = types && value.academic_type && !types.some((t) => t.name === value.academic_type)
    ? [...types, { name: value.academic_type, sort_order: 0, active: false }]
    : types ?? [];
  const field = "mt-1 block w-full border bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-soft/60 focus:border-forest";
  const border = (f: NamingField) => (conflict === f ? "border-alert" : "border-line-strong");
  const message = conflict ? conflictMessage(conflict, value) : null;

  return (
    <div className="space-y-4">
      <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-type`}>
        <span className="font-medium text-ink">Academic type</span><span className="text-alert"> *</span>
        <select
          id={`${idPrefix}-type`}
          autoFocus={autoFocus}
          value={value.academic_type}
          onChange={(e) => onChange({ ...value, academic_type: e.target.value })}
          className={`${field} border-line-strong`}
        >
          <option value="" disabled>{types === null ? "Loading…" : types.length ? "Select the academic type" : "No academic types yet — ask an admin"}</option>
          {options.map((t) => <option key={t.name} value={t.name} disabled={!t.active}>{t.name}{t.active ? "" : " (retired)"}</option>)}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-code`}>
          <span className="font-medium text-ink">Subject code</span><span className="text-alert"> *</span>
          <input
            id={`${idPrefix}-code`}
            value={value.subject_code}
            onChange={(e) => onChange({ ...value, subject_code: e.target.value.toUpperCase() })}
            maxLength={SUBJECT_CODE_MAX}
            disabled={!value.academic_type}
            placeholder="e.g. MBA101"
            aria-invalid={conflict === "subject_code"}
            className={`${field} ${border("subject_code")} font-mono uppercase disabled:bg-line/20`}
          />
        </label>
        <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-subject`}>
          <span className="font-medium text-ink">Subject name</span><span className="text-alert"> *</span>
          <input
            id={`${idPrefix}-subject`}
            value={value.subject_name}
            onChange={(e) => onChange({ ...value, subject_name: e.target.value })}
            maxLength={SUBJECT_NAME_MAX}
            disabled={!value.academic_type}
            placeholder="e.g. Business Economics"
            aria-invalid={conflict === "subject_name"}
            className={`${field} ${border("subject_name")} disabled:bg-line/20`}
          />
        </label>
      </div>
      {message && <p role="alert" className="border border-alert/40 bg-alert/5 px-4 py-3 text-[12px] text-alert">{message}</p>}
    </div>
  );
}
