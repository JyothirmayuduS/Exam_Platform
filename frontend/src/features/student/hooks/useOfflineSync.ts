import { useEffect } from "react";
import { saveAnswers, submitAttempt } from "@/shared/data/examApi";
import { supabaseConfigured } from "@/shared/data/env";

export default function useOfflineSync(studentId: string | null) {
  useEffect(() => {
    if (!supabaseConfigured || !studentId) return;

    const handleOnline = async () => {
      // Find any keys in localStorage starting with 'pending_sync_'
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("pending_sync_")) {
          const examId = key.replace("pending_sync_", "");
          try {
            const raw = localStorage.getItem(key);
            if (raw) {
              const data = JSON.parse(raw);
              let ok: boolean;
              if (data.isSubmit) {
                ok = (await submitAttempt({
                  examId,
                  studentId,
                  answers: data.answers,
                  answered: data.answered,
                  minutesUsed: data.minutesUsed,
                  sessionId: data.sessionId,
                })).ok;
              } else {
                ok = await saveAnswers({
                  examId,
                  studentId,
                  answers: data.answers,
                  answered: data.answered,
                  minutesUsed: data.minutesUsed,
                  sessionId: data.sessionId,
                });
              }
              if (ok) localStorage.removeItem(key);
            }
          } catch (e) {
            console.error("Failed to sync offline answers", e);
          }
        }
      }
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [studentId]);
}
