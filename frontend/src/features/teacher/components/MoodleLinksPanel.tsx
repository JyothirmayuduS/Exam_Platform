import { useCallback, useEffect, useState } from "react";
import { Button } from "@/features/teacher/components/PageChrome";
import {
  confirmMoodleStudent,
  getMoodleOverview,
  mapMoodleLink,
  resendMoodleGrades,
  type MoodleLink,
  type MoodleOverview,
  type MoodleWaitingStudent,
} from "@/shared/data/examApi";

/** Map Moodle activities from the teacher's own Moodle courses to this exam,
 *  confirm Moodle students the platform could not match, and resend grades. */
export default function MoodleLinksPanel({ examId, notify }: { examId: string; notify: (s: string) => void }) {
  const [overview, setOverview] = useState<MoodleOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rolls, setRolls] = useState<Record<string, string>>({});

  const reload = useCallback(async () => setOverview(await getMoodleOverview()), []);
  useEffect(() => {
    let active = true;
    void getMoodleOverview().then((o) => { if (active) setOverview(o); });
    return () => { active = false; };
  }, [examId]);

  const run = async (id: string, action: () => Promise<{ error?: string }>, done: string) => {
    setBusy(id);
    const res = await action();
    await reload();
    setBusy(null);
    notify(res.error ?? done);
  };

  const map = (link: MoodleLink, target: string | null) => {
    const name = link.activity || "Moodle activity";
    void run(link.id, () => mapMoodleLink(link.id, target), target ? `“${name}” now opens this exam.` : `“${name}” unlinked.`);
  };
  const confirm = (s: MoodleWaitingStudent, roll: string | null) =>
    void run(s.id, () => confirmMoodleStudent(s.id, roll), roll ? `${s.name || "Student"} linked to ${roll}.` : `${s.name || "Student"} added as a new student.`);
  const resend = async () => {
    setBusy("resend");
    const res = await resendMoodleGrades(examId);
    setBusy(null);
    notify(res.error ?? (res.queued
      ? `${res.posted} grade(s) sent; ${res.queued} could not reach Moodle and will be retried automatically.`
      : `${res.posted} grade(s) sent to Moodle.`));
  };

  const links = overview?.links ?? [];
  const ordered = [...links.filter((l) => l.examId === examId), ...links.filter((l) => !l.examId), ...links.filter((l) => l.examId && l.examId !== examId)];
  const linkedHere = links.some((l) => l.examId === examId);

  return (
    <section className="mt-6 border border-line p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Moodle links</p>
          <h3 className="mt-1 font-serif text-lg font-semibold">Open this exam from Moodle</h3>
          <p className="mt-1 max-w-2xl text-[12px] text-soft">
            Open the external tool activity in your Moodle course once as its teacher, then link it here. Students who open it in Moodle
            land on this exam signed in as themselves; their scores go to that activity's grade column.
          </p>
        </div>
        {linkedHere && <Button disabled={busy === "resend"} onClick={() => void resend()}>{busy === "resend" ? "Sending…" : "Resend grades to Moodle"}</Button>}
      </div>

      <div className="mt-4 divide-y divide-line border border-line">
        {overview === null && <p className="px-4 py-6 text-center text-[12px] text-soft">Loading Moodle activities…</p>}
        {overview && !overview.connected && (
          <p className="px-4 py-6 text-center text-[12px] text-soft">
            No Moodle courses yet. Open the activity in Moodle as its teacher and choose “Link my Moodle course” on the page that opens.
          </p>
        )}
        {overview?.connected && !ordered.length && <p className="px-4 py-6 text-center text-[12px] text-soft">No activities in your Moodle courses yet.</p>}
        {ordered.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-4 px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px]">{l.activity || "Untitled activity"}</p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-soft">{l.course || "Moodle course"}</p>
            </div>
            {l.examId === examId ? (
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-success">Linked</span>
                <Button disabled={busy === l.id} onClick={() => map(l, null)}>Unlink</Button>
              </div>
            ) : l.examId ? (
              <span className="font-mono text-[10px] uppercase tracking-wider text-soft">Linked to {l.examId}</span>
            ) : (
              <Button primary disabled={busy === l.id} onClick={() => map(l, examId)}>Link to this exam</Button>
            )}
          </div>
        ))}
      </div>

      {!!overview?.waiting.length && (
        <div className="mt-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Moodle students waiting to be linked</p>
          <p className="mt-1 text-[12px] text-soft">
            Their Moodle ID number did not match a roll number, so they were not signed in. Name, email and username come from Moodle and can be
            changed by the student; check them before linking.
          </p>
          <div className="mt-3 divide-y divide-line border border-line">
            {overview.waiting.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px]">{s.name || s.username || "Moodle user"}</p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-soft">
                    {[s.email, s.username && `user ${s.username}`, s.idNumber && `ID ${s.idNumber}`, s.course].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={rolls[s.id] ?? ""}
                    onChange={(e) => setRolls((r) => ({ ...r, [s.id]: e.target.value }))}
                    placeholder="Roll number"
                    aria-label={`Roll number for ${s.name || s.username}`}
                    className="w-36 border border-line bg-paper px-2 py-1.5 text-[12px] outline-none focus:border-forest"
                  />
                  <Button primary disabled={busy === s.id || !(rolls[s.id] ?? "").trim()} onClick={() => confirm(s, (rolls[s.id] ?? "").trim())}>Link</Button>
                  <Button disabled={busy === s.id} onClick={() => confirm(s, null)}>New student</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
