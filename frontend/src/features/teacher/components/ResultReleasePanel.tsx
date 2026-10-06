import { useEffect, useState } from "react";
import { updateExam, type ExamRecord } from "@/shared/data/examApi";
import { examClosed, releaseTiming, type ReleaseSettings, type ReleaseTiming } from "@/shared/domain/exam";

const TIMINGS: { key: ReleaseTiming; title: string; detail: string }[] = [
  { key: "manual", title: "Manually", detail: "Nothing is visible until you press Release below." },
  { key: "on_submit", title: "When each student submits", detail: "Graded scores and the answer key appear right after submitting." },
  { key: "on_close", title: "When the exam closes", detail: "Everything appears once the exam window has ended." },
];

type Props = {
  exam: Pick<ExamRecord, "id" | "status" | "scheduled_at" | "duration_minutes" | "settings">;
  /** Submitted and graded paper counts, for the status line. */
  submitted?: number;
  graded?: number;
  notify: (msg: string) => void;
  onSaved?: (settings: Record<string, unknown>) => void;
};

/** One place to decide when candidates see their score and the answer key. */
export default function ResultReleasePanel({ exam, submitted, graded, notify, onSaved }: Props) {
  const [settings, setSettings] = useState<ReleaseSettings>((exam.settings ?? {}) as ReleaseSettings);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => setSettings((exam.settings ?? {}) as ReleaseSettings), [exam.id, exam.settings]);

  const timing = releaseTiming(settings);
  const closed = examClosed(exam);
  const autoNow = timing === "on_submit" || (timing === "on_close" && closed);
  const keyOn = settings.answer_key_published === true || autoNow;
  const resultsOn = settings.results_published === true || keyOn;

  const save = async (label: string, patch: Record<string, unknown>, message: string) => {
    setSaving(label);
    const ok = await updateExam(exam.id, { settings: patch });
    setSaving(null);
    if (!ok) {
      notify("Could not save. Check your connection and try again.");
      return;
    }
    const next = { ...settings, ...patch } as ReleaseSettings;
    setSettings(next);
    onSaved?.(next as Record<string, unknown>);
    notify(message);
  };

  const setTiming = (t: ReleaseTiming) =>
    save("timing", { release_timing: t, release_mode: null, showReportToTaker: t === "on_submit" },
      t === "manual" ? "Release set to manual" : t === "on_submit" ? "Results will show as each student submits" : "Results will show when the exam closes");

  const ungraded = submitted != null && graded != null ? Math.max(0, submitted - graded) : 0;
  const studentView = !resultsOn
    ? "Students see “Results not released yet”."
    : keyOn
      ? "Students see their score and the correct answers next to their responses."
      : "Students see their score, but not the correct answers.";

  return (
    <section className="border border-line bg-paper">
      <div className="flex flex-col justify-between gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Result release</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">What can students see?</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Results" on={resultsOn} />
          <StatusChip label="Answer key" on={keyOn} />
        </div>
      </div>

      <div className="px-5 py-5">
        <p className="text-[12px] font-medium">When to release</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="When to release">
          {TIMINGS.map((t) => (
            <button
              key={t.key}
              role="radio"
              aria-checked={timing === t.key}
              disabled={saving !== null}
              onClick={() => timing !== t.key && void setTiming(t.key)}
              className={`border p-3 text-left transition ${timing === t.key ? "border-forest bg-forest/5" : "border-line hover:border-forest"}`}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <span className={`flex h-3.5 w-3.5 items-center justify-center border ${timing === t.key ? "border-forest" : "border-soft"}`}>
                  {timing === t.key && <span className="h-1.5 w-1.5 bg-forest" />}
                </span>
                {t.title}
              </span>
              <span className="mt-1 block text-[11.5px] leading-snug text-soft">{t.detail}</span>
            </button>
          ))}
        </div>
        {timing === "on_close" && !exam.scheduled_at && (
          <p className="mt-2 text-[11.5px] text-amber">This exam has no end time, so it never closes by itself. Use the buttons below or mark the exam completed.</p>
        )}

        <div className="mt-5 divide-y divide-line border border-line">
          <ReleaseRow
            title="Results"
            detail="Each student's own score. Papers still being graded stay hidden."
            on={resultsOn}
            locked={autoNow || settings.answer_key_published === true}
            lockedNote={autoNow ? "Released automatically" : "Included with the answer key"}
            busy={saving === "results"}
            onRelease={() => void save("results", { results_published: true }, "Results released to students")}
            onWithdraw={() => void save("results", { results_published: false }, "Results hidden from students")}
          />
          <ReleaseRow
            title="Answer key"
            detail="Correct answers shown next to each student's responses. Also releases results."
            on={keyOn}
            locked={autoNow}
            lockedNote="Released automatically"
            busy={saving === "key"}
            onRelease={() => void save("key", { answer_key_published: true, results_published: true }, "Answer key released to students")}
            onWithdraw={() => void save("key", { answer_key_published: false }, "Answer key hidden from students")}
          />
        </div>

        <p className="mt-4 border-l-2 border-forest bg-raised px-3 py-2.5 text-[12.5px]">
          <span className="font-medium">Right now: </span>{studentView}
          {resultsOn && ungraded > 0 && <span className="text-soft"> {ungraded} submitted paper{ungraded === 1 ? " is" : "s are"} not graded yet and stay hidden until graded.</span>}
        </p>
      </div>
    </section>
  );
}

function StatusChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${on ? "border-success bg-success/5 text-success" : "border-line text-soft"}`}>
      {label} · {on ? "Visible" : "Hidden"}
    </span>
  );
}

function ReleaseRow({ title, detail, on, locked, lockedNote, busy, onRelease, onWithdraw }: {
  title: string; detail: string; on: boolean; locked: boolean; lockedNote: string; busy: boolean;
  onRelease: () => void; onWithdraw: () => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[12px] text-soft">{detail}</p>
      </div>
      {locked ? (
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-success">{lockedNote}</span>
      ) : on ? (
        <button onClick={onWithdraw} disabled={busy} className="shrink-0 border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-soft transition hover:border-alert hover:text-alert disabled:opacity-50">
          {busy ? "Saving…" : "Hide again"}
        </button>
      ) : (
        <button onClick={onRelease} disabled={busy} className="shrink-0 border border-forest bg-forest px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-soft disabled:opacity-50">
          {busy ? "Saving…" : `Release ${title.toLowerCase()}`}
        </button>
      )}
    </div>
  );
}
