import { useEffect, useState } from "react";
import { onLockdownNotice, type LockdownNotice } from "../lib/lockdownBridge";

/**
 * Full-screen notice shown when the Vignan lockdown shell detects a blocked
 * condition (VM, prohibited app). The shell no longer force-exits — the student
 * sees WHY the exam cannot continue, and the exam stays locked until the issue
 * is resolved (the shell re-checks every 3 s and the notice clears itself).
 */
export default function LockdownNotice() {
  const [notice, setNotice] = useState<LockdownNotice | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onLockdownNotice((n) => {
      if (alive) setNotice(n);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  if (!notice) return null;

  const isVm = notice.kind === "vm-detected";
  const title = isVm ? "Virtual machine detected" : "Prohibited application detected";
  const detail = isVm
    ? "The Vignan Exam Browser cannot run inside a virtual machine. Please start the exam on a physical computer."
    : `Close the following application(s) to continue the exam: ${notice.kind === "prohibited-apps" ? notice.apps : ""}. The exam will remain locked until they are closed.`;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md border border-maroon bg-raised p-6 text-center">
        <p className="font-mono text-[10px] uppercase tracking-widest text-maroon">Vignan Exam Browser</p>
        <h1 className="mt-2 font-serif text-xl font-semibold text-ink">{title}</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{detail}</p>
        {!isVm && (
          <button
            onClick={() => setNotice(null)}
            className="mt-5 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper hover:bg-maroon/90"
          >
            I've closed it — resume check
          </button>
        )}
      </div>
    </div>
  );
}
