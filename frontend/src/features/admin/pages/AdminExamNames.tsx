import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminOverview } from "@/shared/data/api/admin";
import {
  addAcademicType, deleteAcademicType, hasNaming, listAcademicTypes, renameAcademicType, setAcademicTypeActive, type AcademicType,
} from "@/shared/data/api/examNaming";
import { Empty, Panel, Table, Td } from "@/features/admin/components/AdminUI";

const inputCls = "border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest";
const linkCls = "font-mono text-[10px] uppercase tracking-wider text-forest hover:underline disabled:opacity-40";

export default function AdminExamNames({ data, notify, onChanged }: { data: AdminOverview; notify: (m: string) => void; onChanged: () => void }) {
  const [types, setTypes] = useState<AcademicType[] | null>(null);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [missingOnly, setMissingOnly] = useState(true);

  const load = useCallback(async () => setTypes(await listAcademicTypes({ includeRetired: true })), []);
  useEffect(() => {
    let active = true;
    void listAcademicTypes({ includeRetired: true }).then((rows) => { if (active) setTypes(rows); });
    return () => { active = false; };
  }, []);

  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.exams) if (e.academic_type) m.set(e.academic_type, (m.get(e.academic_type) ?? 0) + 1);
    return m;
  }, [data.exams]);
  const missing = data.exams.filter((e) => !hasNaming(e));
  const shown = missingOnly ? missing : data.exams;

  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    if (busy) return;
    setBusy(true);
    const res = await action();
    setBusy(false);
    if (!res.ok) { notify(res.error); return; }
    notify(done);
    setEditing(null);
    await load();
    onChanged();
  };

  const add = () => {
    const nextOrder = Math.max(0, ...(types ?? []).map((t) => t.sort_order)) + 10;
    void run(() => addAcademicType(adding, nextOrder), `Added “${adding.trim()}”.`).then(() => setAdding(""));
  };

  return (
    <div className="space-y-6">
      <Panel
        title="Academic types"
        count={types?.filter((t) => t.active).length}
        note="Teachers pick one of these first when they create an exam. Renaming a type renames every exam that uses it. A type in use can't be deleted; retire it so it can't be picked for new exams."
      >
        <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="block text-[12px] text-soft">New academic type
            <input value={adding} onChange={(e) => setAdding(e.target.value)} maxLength={60} placeholder="e.g. Supplementary Exam" className={`mt-1 block w-72 ${inputCls}`} />
          </label>
          <button type="submit" disabled={busy || !adding.trim()} className="border border-forest bg-forest px-5 py-2 font-mono text-[10px] uppercase tracking-wider text-paper disabled:opacity-40">Add</button>
        </form>
        {types === null ? <Empty>Loading…</Empty> : types.length === 0 ? <Empty>No academic types yet. Teachers can't create exams until you add one.</Empty> : (
          <Table head={["Academic type", "Exams", "Status", ""]}>
            {types.map((t) => (
              <tr key={t.name}>
                <Td>
                  {editing?.from === t.name ? (
                    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => renameAcademicType(t.name, editing.to), `Renamed to “${editing.to.trim()}”.`); }}>
                      <input autoFocus aria-label={`New name for ${t.name}`} value={editing.to} maxLength={60} onChange={(e) => setEditing({ from: t.name, to: e.target.value })} className={inputCls} />
                      <button type="submit" disabled={busy || !editing.to.trim()} className={linkCls}>Save</button>
                      <button type="button" onClick={() => setEditing(null)} className={linkCls}>Cancel</button>
                    </form>
                  ) : t.name}
                </Td>
                <Td className="tabular-nums">{used.get(t.name) ?? 0}</Td>
                <Td className={t.active ? "text-success" : "text-soft"}>{t.active ? "Offered" : "Retired"}</Td>
                <Td className="whitespace-nowrap text-right">
                  <span className="inline-flex gap-4">
                    <button type="button" disabled={busy} onClick={() => setEditing({ from: t.name, to: t.name })} className={linkCls}>Rename</button>
                    <button type="button" disabled={busy} onClick={() => void run(() => setAcademicTypeActive(t.name, !t.active), t.active ? `Retired “${t.name}”.` : `“${t.name}” is offered again.`)} className={linkCls}>
                      {t.active ? "Retire" : "Restore"}
                    </button>
                    <button type="button" disabled={busy || (used.get(t.name) ?? 0) > 0} title={(used.get(t.name) ?? 0) > 0 ? "Exams use this type" : undefined} onClick={() => void run(() => deleteAcademicType(t.name), `Deleted “${t.name}”.`)} className={`${linkCls} text-alert`}>Delete</button>
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Exam names"
        count={missing.length}
        tone={missing.length ? "amber" : "ok"}
        note="Exams created before academic types were added may be missing a type, semester, academic year, subject code or subject name. The owner fills them in from the exam's paper builder."
        action={
          <label className="flex items-center gap-2 text-[12px] text-soft">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} className="accent-forest" />
            Only exams that need fixing
          </label>
        }
      >
        {shown.length === 0 ? <Empty>{missingOnly ? "Every exam has its academic type, semester, academic year, subject code and subject name." : "No exams yet."}</Empty> : (
          <Table head={["Exam", "Owner", "Academic type", "Semester", "Academic year", "Attempt", "Subject code", "Subject name"]}>
            {shown.map((e) => (
              <tr key={e.id}>
                <Td><span className="block">{e.name}</span><span className="font-mono text-[10px] text-soft">{e.id}</span></Td>
                <Td>{e.owner ?? "—"}</Td>
                <Td className={e.academic_type ? "" : "text-amber"}>{e.academic_type ?? "Missing"}</Td>
                <Td className={e.semester ? "tabular-nums" : "text-amber"}>{e.semester ?? "Missing"}</Td>
                <Td className={e.academic_year ? "tabular-nums" : "text-amber"}>{e.academic_year ?? "Missing"}</Td>
                <Td>{e.attempt_label ?? "Regular"}</Td>
                <Td className={e.subject_code ? "font-mono" : "text-amber"}>{e.subject_code ?? "Missing"}</Td>
                <Td className={e.subject_name ? "" : "text-amber"}>{e.subject_name ?? "Missing"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
