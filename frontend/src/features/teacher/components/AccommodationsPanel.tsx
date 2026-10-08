import { useEffect, useMemo, useState } from "react";
import { NumberField } from "@/shared/components/ui";
import { Button } from "@/features/teacher/components/PageChrome";
import { listExamAccommodations, setExtraMinutes, type Accommodation } from "@/shared/data/examApi";

/** Per-student extra time for one exam (scribes, medical needs). Applied by the
 *  server to that student's deadline, so it survives reloads and kiosk restarts. */
export default function AccommodationsPanel({ examId, notify }: { examId: string; notify: (s: string) => void }) {
  const [rows, setRows] = useState<Accommodation[]>([]);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void listExamAccommodations(examId).then((list) => { if (active) { setRows(list); setDraft({}); } });
    return () => { active = false; };
  }, [examId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? rows.filter((r) => r.roll.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : rows;
    return [...list].sort((a, b) => (b.extraMinutes > 0 ? 1 : 0) - (a.extraMinutes > 0 ? 1 : 0));
  }, [rows, query]);

  const dirty = Object.entries(draft).filter(([id, m]) => rows.find((r) => r.studentId === id)?.extraMinutes !== m);

  const save = async () => {
    setSaving(true);
    let failed = 0;
    for (const [studentId, minutes] of dirty) {
      const res = await setExtraMinutes(examId, studentId, minutes);
      if (res.error) failed += 1;
    }
    const list = await listExamAccommodations(examId);
    setRows(list);
    setDraft({});
    setSaving(false);
    notify(failed ? `${failed} change(s) could not be saved — only the exam owner can set accommodations.` : "Accommodations saved.");
  };

  return (
    <section className="mt-6 border border-line p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Accommodations</p>
          <h3 className="mt-1 font-serif text-lg font-semibold">Extra time per student</h3>
          <p className="mt-1 text-[12px] text-soft">Added to that student's timer. Proctor "+5 min" extensions stack on top.</p>
        </div>
        <div className="flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search roll or name" className="border border-line bg-paper px-3 py-2 text-[12px] outline-none focus:border-forest" />
          <Button primary disabled={!dirty.length || saving} onClick={() => void save()}>{saving ? "Saving…" : `Save${dirty.length ? ` (${dirty.length})` : ""}`}</Button>
        </div>
      </div>
      <div className="mt-4 max-h-80 divide-y divide-line overflow-y-auto border border-line">
        {visible.length === 0 && <p className="px-4 py-6 text-center text-[12px] text-soft">No enrolled students.</p>}
        {visible.map((r) => (
          <div key={r.studentId} className="flex items-center justify-between gap-4 px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px]">{r.name || r.roll}</p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-soft">{r.roll}</p>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-soft">
              <NumberField
                value={draft[r.studentId] ?? r.extraMinutes}
                onChange={(n) => setDraft((d) => ({ ...d, [r.studentId]: n }))}
                min={0}
                max={600}
                fallback={0}
                aria-label={`Extra minutes for ${r.roll}`}
                className="w-20 border border-line bg-paper px-2 py-1 text-right text-[13px] outline-none focus:border-forest"
              />
              min
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}
