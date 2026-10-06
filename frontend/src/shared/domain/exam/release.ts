import { examPhase } from "./phase";

/**
 * When candidates may see their score and the answer key.
 *
 * Two independent things are released:
 *  - results:    the candidate's score
 *  - answer key: correct answers next to their responses (implies results)
 *
 * Each is released either manually (the teacher presses Release) or
 * automatically, as soon as the candidate submits or once the exam closes.
 * A score that hasn't been graded yet is never shown, whatever the setting.
 */

export type ReleaseTiming = "manual" | "on_submit" | "on_close";

/** Release fields stored in `exams.settings`. Older keys are still read. */
export type ReleaseSettings = {
  results_published?: boolean;
  answer_key_published?: boolean;
  release_timing?: ReleaseTiming | "submit" | "close";
  /** Legacy Exam Studio toggle: "show report to test-taker after test finishes". */
  showReportToTaker?: boolean;
  /** Legacy Answers & results tab. */
  release_mode?: "auto" | "manual";
};

export type Visibility = {
  score: boolean;
  answerKey: boolean;
  /** Short reason for the candidate when something is hidden. */
  note: string | null;
};

export function releaseTiming(s: ReleaseSettings | null | undefined): ReleaseTiming {
  const t = s?.release_timing;
  if (t === "on_submit" || t === "submit") return s?.release_mode === "manual" ? "manual" : "on_submit";
  if (t === "on_close" || t === "close") return s?.release_mode === "manual" ? "manual" : "on_close";
  if (t === "manual") return "manual";
  if (s?.showReportToTaker) return "on_submit";
  if (s?.release_mode === "auto") return "on_close";
  return "manual";
}

export function visibilityFor(
  s: ReleaseSettings | null | undefined,
  ctx: { examClosed: boolean; graded: boolean },
): Visibility {
  const timing = releaseTiming(s);
  const auto = timing === "on_submit" || (timing === "on_close" && ctx.examClosed);
  const answerKey = s?.answer_key_published === true || auto;
  const resultsOn = s?.results_published === true || answerKey;
  const score = resultsOn && ctx.graded;

  let note: string | null = null;
  if (!resultsOn) {
    note = timing === "on_close" ? "Results appear when the exam closes." : "Your teacher hasn't released results yet.";
  } else if (!ctx.graded) {
    note = "Your paper is still being evaluated.";
  }
  return { score, answerKey: answerKey && ctx.graded, note };
}

/** Exam is over for everyone: closed status or past its scheduled window. */
export function examClosed(exam: { status?: string | null; scheduled_at?: string | null; duration_minutes?: number | null }, now = Date.now()): boolean {
  return examPhase(exam, now) === "completed";
}
