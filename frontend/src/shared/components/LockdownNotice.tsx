import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isScreenCaptureExcluded, onLockdownNotice, type LockdownNotice } from "@/shared/platform/lockdownBridge";
import { isTauri } from "@/shared/platform/platform";

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

  // Screenshot-exclusion diagnostic: the shell applies NSWindowSharingNone /
  // WDA_EXCLUDEFROMCAPTURE when an exam locks the window down and emits
  // lockdown:capture-visible if that fails. This mount check covers a reload
  // while already locked down; outside lockdown the shell reports success.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void isScreenCaptureExcluded().then((excluded) => {
      if (alive && !excluded) setNotice({ kind: "capture-visible" });
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!notice) return null;

  if (notice.kind === "quit-attempted") {
    // Transient toast: quitting is locked while the exam is running.
    return (
      <div className="pointer-events-none fixed inset-x-0 top-6 z-[9999] flex justify-center px-6">
        <div className="border border-maroon bg-raised px-5 py-3 text-center shadow-lg">
          <p className="font-mono text-[11px] uppercase tracking-widest text-maroon">Quitting is locked</p>
          <p className="mt-1 text-[12px] text-ink-soft">The exam window cannot be closed during the exam. Use the exit control on the final screen.</p>
        </div>
      </div>
    );
  }

  if (notice.kind === "capture-visible") {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md border border-alert bg-raised p-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Vignan Exam Browser</p>
          <h1 className="mt-2 font-serif text-xl font-semibold text-ink">Screenshot protection unavailable</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
            The operating system refused to hide this window from screen capture. The exam cannot start without it — please restart the Vignan Exam Browser and try again.
          </p>
          {/* Quitting is locked during the exam, so this gate needs its own
              sanctioned exit or a failed capture check would trap the student. */}
          <button
            onClick={() => void invoke("exit_app")}
            className="mt-5 w-full border border-alert bg-alert/10 py-3 font-mono text-[12px] uppercase tracking-widest text-alert hover:bg-alert/20"
          >
            Exit Vignan Exam Browser
          </button>
        </div>
      </div>
    );
  }

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
