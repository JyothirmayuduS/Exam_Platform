import { useState } from "react";
import { getSupabase } from "@/shared/data/supabase";
import type { AutoGradeResult } from "@/shared/domain/exam";

/** Instant result shown on the submitted screen when the exam releases on submit. */
export function InstantReport({ grade, onOpenReport }: { grade: AutoGradeResult; onOpenReport: () => void }) {
  const final = grade.score != null;
  const shown = final ? grade.score! : grade.objectiveScore;
  const outOf = final ? grade.max : grade.objectiveMax;
  const pct = outOf > 0 ? Math.round((shown / outOf) * 100) : 0;
  return (
    <section className="mt-6 border border-line bg-paper text-left">
      <div className="flex items-end justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-widest text-soft">{final ? "Your score" : "Objective questions"}</p>
          <p className="mt-1 font-serif text-3xl font-semibold tabular-nums">
            {shown}<span className="text-[15px] font-normal text-soft"> / {outOf}</span>
          </p>
        </div>
        <span className="font-serif text-2xl tabular-nums text-forest">{pct}%</span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-line border-b border-line font-mono text-[11px]">
        <Stat label="Correct" value={grade.correct} tone="text-success" />
        <Stat label="Wrong" value={grade.wrong} tone={grade.wrong ? "text-alert" : "text-ink"} />
        <Stat label="Skipped" value={grade.unanswered} tone="text-soft" />
      </div>
      {!final && (
        <p className="border-b border-line px-5 py-3 text-[12px] text-soft">
          {grade.manual} written answer{grade.manual === 1 ? " is" : "s are"} being evaluated by your teacher. Your final score will appear in Results.
        </p>
      )}
      <button onClick={onOpenReport} className="block w-full px-5 py-3 text-left font-mono text-[11px] uppercase tracking-wider text-forest hover:bg-raised">
        View question-by-question report →
      </button>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="px-4 py-3">
      <span className="block text-[9px] uppercase tracking-widest text-soft">{label}</span>
      <span className={`text-[15px] tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

/** One-question feedback form; disabled per exam with the skipFeedback setting. */
export function ExamFeedback({ examId, attemptId, studentId, onDone }: {
  examId: string; attemptId: string | null; studentId: string; onDone: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "sent" | "skipped" | "error">("idle");

  const send = async () => {
    const db = getSupabase();
    if (!db || !rating) return;
    setState("saving");
    const { error } = await db.from("exam_feedback").insert({
      exam_id: examId, attempt_id: attemptId, student_id: studentId, rating, comment: comment.trim() || null,
    });
    if (error && error.code !== "23505") {
      setState("error");
      return;
    }
    setState("sent");
    onDone();
  };

  if (state === "skipped") return null;
  if (state === "sent") {
    return <p className="mt-6 border border-success/40 bg-success/5 px-4 py-3 text-left text-[12.5px] text-success">Thanks — your feedback was sent to your teacher.</p>;
  }

  return (
    <section className="mt-6 border border-line bg-paper px-5 py-4 text-left">
      <p className="font-mono text-[9px] uppercase tracking-widest text-soft">Feedback</p>
      <p className="mt-1 text-[13.5px] font-medium">How was this exam?</p>
      <div className="mt-3 flex gap-1.5" role="radiogroup" aria-label="Rating out of 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            role="radio"
            aria-checked={rating === n}
            onClick={() => setRating(n)}
            className={`h-9 w-9 border font-mono text-[13px] tabular-nums transition ${n <= rating ? "border-forest bg-forest text-paper" : "border-line text-soft hover:border-forest"}`}
          >
            {n}
          </button>
        ))}
        <span className="ml-2 self-center text-[11.5px] text-soft">{["", "Poor", "Fair", "Good", "Very good", "Excellent"][rating]}</span>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, 2000))}
        rows={2}
        placeholder="Anything that went wrong or could be better? (optional)"
        className="mt-3 block w-full resize-none border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest"
      />
      {state === "error" && <p className="mt-2 text-[12px] text-alert">Couldn't send feedback. Check your connection and try again.</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => { setState("skipped"); onDone(); }} className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-soft hover:text-ink">Skip</button>
        <button onClick={() => void send()} disabled={!rating || state === "saving"} className="border border-forest bg-forest px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper disabled:opacity-40">
          {state === "saving" ? "Sending…" : "Send feedback"}
        </button>
      </div>
    </section>
  );
}
