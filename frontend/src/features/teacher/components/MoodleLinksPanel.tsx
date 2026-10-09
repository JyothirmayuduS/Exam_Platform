import { useEffect, useState } from "react";
import { Button } from "@/features/teacher/components/PageChrome";
import { listMoodleLinks, mapMoodleLink, type MoodleLink } from "@/shared/data/examApi";

/** Map Moodle activities (LTI resource links) to this exam. A student who
 *  opens a mapped activity in Moodle lands on this exam already signed in,
 *  and their score is sent back to that activity. */
export default function MoodleLinksPanel({ examId, notify }: { examId: string; notify: (s: string) => void }) {
  const [links, setLinks] = useState<MoodleLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listMoodleLinks().then((list) => { if (active) setLinks(list); });
    return () => { active = false; };
  }, [examId]);

  const change = async (link: MoodleLink, target: string | null) => {
    setBusy(link.id);
    const res = await mapMoodleLink(link.id, target);
    setLinks(await listMoodleLinks());
    setBusy(null);
    notify(res.error ?? (target ? `“${link.activity || "Moodle activity"}” now opens this exam.` : `“${link.activity || "Moodle activity"}” unlinked.`));
  };

  const mine = (links ?? []).filter((l) => l.examId === examId);
  const open = (links ?? []).filter((l) => !l.examId);
  const taken = (links ?? []).filter((l) => l.examId && l.examId !== examId);

  return (
    <section className="mt-6 border border-line p-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Moodle links</p>
      <h3 className="mt-1 font-serif text-lg font-semibold">Open this exam from Moodle</h3>
      <p className="mt-1 text-[12px] text-soft">
        Add the exam platform as an external tool activity in your Moodle course and open it once yourself; it then appears here.
        Students who open a linked activity are signed in as their Moodle account and land on this exam. Scores go to that activity's grade column.
      </p>
      <div className="mt-4 divide-y divide-line border border-line">
        {links === null && <p className="px-4 py-6 text-center text-[12px] text-soft">Loading Moodle activities…</p>}
        {links !== null && !mine.length && !open.length && !taken.length && (
          <p className="px-4 py-6 text-center text-[12px] text-soft">No Moodle activities yet. Open the activity in Moodle once as a teacher.</p>
        )}
        {[...mine, ...open, ...taken].map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-4 px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px]">{l.activity || "Untitled activity"}</p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-soft">{[l.site, l.course].filter(Boolean).join(" · ")}</p>
            </div>
            {l.examId === examId ? (
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-success">Linked</span>
                <Button disabled={busy === l.id} onClick={() => void change(l, null)}>Unlink</Button>
              </div>
            ) : l.examId ? (
              <span className="font-mono text-[10px] uppercase tracking-wider text-soft">Linked to {l.examId}</span>
            ) : (
              <Button primary disabled={busy === l.id} onClick={() => void change(l, examId)}>Link to this exam</Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
