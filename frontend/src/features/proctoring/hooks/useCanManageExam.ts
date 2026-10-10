import { useEffect, useState } from "react";
import { canManageExam } from "@/shared/data/examApi";

/** Whether the signed-in user owns this exam, is delegated to it, or is an
 *  admin. Proctors and other teachers get false; the database enforces the
 *  same rule. */
export default function useCanManageExam(examId: string | null | undefined): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    setCan(false);
    if (!examId) return;
    let active = true;
    void canManageExam(examId).then((v) => { if (active) setCan(v); });
    return () => { active = false; };
  }, [examId]);
  return can;
}
