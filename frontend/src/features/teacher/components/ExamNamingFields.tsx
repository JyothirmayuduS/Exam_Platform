// The exam's name, asked in order: academic type, semester, academic year,
// attempt, subject code, subject name. Tells the teacher as they type when
// another exam of the same type, semester, year and attempt already uses the
// code or the subject name; the database refuses it either way.

import { useEffect, useState } from "react";
import {
  academicYearOptions, ATTEMPT_LABELS, conflictMessage, findExamNamingConflict, listAcademicTypes, normalizeNaming, SEMESTERS,
  SUBJECT_CODE_MAX, SUBJECT_NAME_MAX, type AcademicType, type ExamNaming, type NamingField,
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

  const { academic_type, semester, academic_year, attempt_label, subject_code, subject_name } = normalizeNaming(value);
  useEffect(() => {
    let active = true;
    if (!academic_type || !semester || !academic_year || (!subject_code && !subject_name)) {
      setConflict(null);
      onCheck?.({ conflict: null, checking: false });
      return;
    }
    onCheck?.({ conflict: null, checking: true });
    const t = window.setTimeout(() => {
      void findExamNamingConflict({ academic_type, semester, academic_year, attempt_label, subject_code, subject_name }, examId).then((field) => {
        if (!active) return;
        setConflict(field);
        onCheck?.({ conflict: field, checking: false });
      });
    }, CHECK_DELAY_MS);
    return () => { active = false; window.clearTimeout(t); };
    // onCheck is a callback from the parent; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academic_type, semester, academic_year, attempt_label, subject_code, subject_name, examId]);

  const options = types && value.academic_type && !types.some((t) => t.name === value.academic_type)
    ? [...types, { name: value.academic_type, sort_order: 0, active: false }]
    : types ?? [];
  const field = "mt-1 block w-full border bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-soft/60 focus:border-forest";
  const border = (f: NamingField) => (conflict === f ? "border-alert" : "border-line-strong");
  const message = conflict ? conflictMessage(conflict, value) : null;
  const years = academicYearOptions();
  if (value.academic_year && !years.includes(value.academic_year)) years.unshift(value.academic_year);
  const termReady = !!(value.academic_type && value.semester && value.academic_year);

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
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-semester`}>
          <span className="font-medium text-ink">Semester</span><span className="text-alert"> *</span>
          <select
            id={`${idPrefix}-semester`}
            value={value.semester}
            onChange={(e) => onChange({ ...value, semester: e.target.value })}
            disabled={!value.academic_type}
            className={`${field} border-line-strong disabled:bg-line/20`}
          >
            <option value="" disabled>Select</option>
            {SEMESTERS.map((n) => <option key={n} value={n}>Semester {n}</option>)}
          </select>
        </label>
        <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-year`}>
          <span className="font-medium text-ink">Academic year</span><span className="text-alert"> *</span>
          <select
            id={`${idPrefix}-year`}
            value={value.academic_year}
            onChange={(e) => onChange({ ...value, academic_year: e.target.value })}
            disabled={!value.academic_type}
            className={`${field} border-line-strong disabled:bg-line/20`}
          >
            <option value="" disabled>Select</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <fieldset className="text-[12px] text-ink-soft" disabled={!value.academic_type}>
          <legend className="font-medium text-ink">Attempt</legend>
          <div className="mt-1 grid grid-cols-2" role="radiogroup" aria-label="Attempt">
            {ATTEMPT_LABELS.map((label) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={value.attempt_label === label}
                onClick={() => onChange({ ...value, attempt_label: label })}
                className={`border px-2 py-2.5 text-[12px] disabled:opacity-50 ${value.attempt_label === label ? "border-forest bg-forest text-paper" : "border-line-strong bg-paper text-ink hover:border-forest"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="block text-[12px] text-ink-soft" htmlFor={`${idPrefix}-code`}>
          <span className="font-medium text-ink">Subject code</span><span className="text-alert"> *</span>
          <input
            id={`${idPrefix}-code`}
            value={value.subject_code}
            onChange={(e) => onChange({ ...value, subject_code: e.target.value.toUpperCase() })}
            maxLength={SUBJECT_CODE_MAX}
            disabled={!termReady}
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
            disabled={!termReady}
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
