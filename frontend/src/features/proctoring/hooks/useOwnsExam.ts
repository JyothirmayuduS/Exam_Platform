import { useEffect, useState } from "react";
import { ownsExam } from "@/shared/data/examApi";

/** Whether the signed-in user is the teacher who owns this exam. Proctors and
 *  other teachers get false; the database enforces the same rule. */
export default function useOwnsExam(examId: string | null | undefined): boolean {
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    setOwns(false);
    if (!examId) return;
    let active = true;
    void ownsExam(examId).then((v) => { if (active) setOwns(v); });
    return () => { active = false; };
  }, [examId]);
  return owns;
}
