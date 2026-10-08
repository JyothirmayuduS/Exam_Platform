import { useEffect, useRef } from "react";
import { saveAnswers, submitAttempt } from "@/shared/data/examApi";
import { supabaseConfigured } from "@/shared/data/env";
import { clearPending, listPending, readPending } from "@/features/student/domain/resume";

const STALE_AUTOSAVE_MS = 24 * 60 * 60 * 1000;

type Opts = {
  /** The exam open on this page, if it is being taken: its autosave owns the
   *  queue, and replaying an older copy here could overwrite newer answers. */
  activeExamId?: string | null;
  retryMs?: number;
  onSynced?: (examId: string, wasSubmit: boolean) => void;
};

/** Push answers queued on this device (`pending_sync_*`) when the network
 *  returns, and keep retrying on a timer: the `online` event does not fire
 *  when Wi-Fi stays up but the internet is down. */
export default function useOfflineSync(studentId: string | null, opts: Opts = {}) {
  const { activeExamId = null, retryMs = 15_000 } = opts;
  const onSyncedRef = useRef(opts.onSynced);
  onSyncedRef.current = opts.onSynced;

  useEffect(() => {
    if (!supabaseConfigured || !studentId) return;
    let running = false;
    let alive = true;

    const flush = async () => {
      if (running) return;
      running = true;
      try {
        for (const [examId, entry] of listPending()) {
          if (!alive) return;
          if (examId === activeExamId) continue;
          if (entry.studentId && entry.studentId !== studentId) continue;
          // An autosave copy that still cannot land a day later belongs to an
          // exam that has closed; the attempt row already has what counted.
          if (!entry.isSubmit && entry.savedAt && Date.now() - entry.savedAt > STALE_AUTOSAVE_MS) {
            clearPending(examId);
            continue;
          }
          try {
            const ok = entry.isSubmit
              ? (await submitAttempt({
                  examId,
                  studentId,
                  answers: entry.answers,
                  answered: entry.answered,
                  minutesUsed: entry.minutesUsed,
                  sessionId: entry.sessionId,
                })).ok
              : await saveAnswers({
                  examId,
                  studentId,
                  answers: entry.answers,
                  answered: entry.answered,
                  minutesUsed: entry.minutesUsed,
                  sessionId: entry.sessionId,
                  resume: entry.resume,
                  savedAt: entry.savedAt,
                });
            // Only drop the entry we pushed; a newer one may have been queued meanwhile.
            if (ok && readPending(examId)?.savedAt === entry.savedAt) {
              clearPending(examId);
              onSyncedRef.current?.(examId, entry.isSubmit);
            }
          } catch (e) {
            console.error("Failed to sync offline answers", e);
          }
        }
      } finally {
        running = false;
      }
    };

    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    const id = window.setInterval(() => void flush(), retryMs);
    void flush();
    return () => {
      alive = false;
      window.removeEventListener("online", onOnline);
      window.clearInterval(id);
    };
  }, [studentId, activeExamId, retryMs]);
}
