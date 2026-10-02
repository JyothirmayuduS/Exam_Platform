import { useEffect, type RefObject } from "react";
import { FiDownload } from "react-icons/fi";
import Seal from "@/shared/components/Seal";
import { openStudentSide } from "@/shared/platform/lockdownBridge";
import { detectOS, isTauri } from "@/shared/platform/platform";

export type CheckResult = { label: string; ok: boolean; detail: string };

type Installer = "checking" | "ready" | "release" | "missing";

export function DownloadGateScreen({
  examName,
  installer,
  os,
  href,
  downloadFilename,
  onDoneInstall,
  onPreview,
}: {
  examName: string;
  installer: Installer;
  os: string;
  href: string;
  downloadFilename: string;
  onDoneInstall: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-lg">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-soft">Vignan University · Secure exam platform</p>
        <h1 className="mb-1 font-serif text-2xl font-semibold">Install Vignan Exam Browser</h1>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        <div className="border border-line bg-raised p-5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-soft">Detected OS: {os}</p>
          {installer === "checking" && <div className="mt-4 border border-line py-3 text-center font-mono text-[12px] uppercase tracking-widest text-soft">Locating installer…</div>}
          {installer === "ready" && <a href={href} download={downloadFilename} className="mt-4 flex w-full items-center justify-center gap-2 border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper"><FiDownload aria-hidden /> Download</a>}
          {installer === "release" && <a href={href} target="_blank" rel="noreferrer" className="mt-4 block w-full border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper">Open download page /</a>}
          {installer === "missing" && <p className="mt-4 text-[12px] text-soft">Installer unavailable for this OS.</p>}
        </div>
        <div className="mt-4 flex flex-col gap-3">
          {(installer === "ready" || installer === "release") && <button onClick={onDoneInstall} className="w-full border border-success bg-success/10 py-3 font-mono text-[12px] uppercase tracking-widest text-success">✓ Done — I've installed it</button>}
          <button onClick={onPreview} className="font-mono text-[10px] text-soft underline">Preview exam flow (dev bypass)</button>
        </div>
      </div>
    </div>
  );
}

/**
 * macOS Gatekeeper guidance: the kiosk is ad-hoc signed (no Apple Developer
 * ID / notarization), so a downloaded copy is quarantined and macOS shows
 * "Apple could not verify …" with no way past it in the dialog itself.
 * Give the student the two sanctioned unblock paths instead of a dead end.
 */
export function GatekeeperHelp() {
  if (detectOS() !== "macos") return null;
  return (
    <div className="mt-4 border border-amber/50 bg-amber/5 p-4 text-left">
      <p className="font-mono text-[10px] uppercase tracking-wider text-amber">macOS blocked the app? ("Apple could not verify")</p>
      <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-ink-soft">
        <li>
          Open <span className="font-medium text-ink">System Settings → Privacy &amp; Security</span>, scroll to Security and click
          <span className="font-medium text-ink"> Open Anyway</span> next to "Vignan Exam Browser", then Allow.
        </li>
        <li>
          Or in Terminal: <code className="border border-line bg-paper px-1 font-mono text-[11px]">xattr -dr com.apple.quarantine "/Applications/Vignan Exam Browser.app"</code>
        </li>
      </ol>
    </div>
  );
}

export function InstalledScreen({
  examName,
  deepLinkTried,
  deepLinkFailed,
  onEnter,
  onTryAgain,
  onBack,
  downloadHref,
  downloadFilename,
  onPreview,
}: {
  examName: string;
  deepLinkTried: boolean;
  deepLinkFailed: boolean;
  onEnter: () => void;
  onTryAgain: () => void;
  onBack: () => void;
  downloadHref: string;
  downloadFilename: string;
  onPreview?: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="mt-5 font-serif text-2xl font-semibold">Vignan Exam Browser installed!</h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        {!deepLinkTried ? (
          <button onClick={onEnter} className="mt-6 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper hover:bg-maroon/90">Enter exam /</button>
        ) : deepLinkFailed ? (
          <div className="mt-4 space-y-3">
            <button onClick={onTryAgain} className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper hover:bg-maroon/90">Try again /</button>
            {onPreview && (
              <button
                onClick={onPreview}
                className="block w-full border border-forest bg-forest/10 py-3 text-center font-mono text-[11px] uppercase tracking-widest text-forest hover:bg-forest/20"
              >
                ⚡ Continue in browser (Demo / Bypass mode) /
              </button>
            )}
            <a href={downloadHref} download={downloadFilename} className="flex w-full items-center justify-center gap-2 border border-line py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink hover:bg-raised"><FiDownload aria-hidden /> Download again</a>
            <GatekeeperHelp />
          </div>
        ) : (
          <div className="mt-5 font-mono text-[11px] text-soft">Launching Vignan Exam Browser…</div>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button onClick={onBack} className="font-mono text-[10px] text-soft underline hover:text-ink">← Back</button>
          {onPreview && (
            <>
              <span className="text-[10px] text-line-strong">·</span>
              <button onClick={onPreview} className="font-mono text-[10px] text-forest underline hover:text-forest/80">Continue in browser (demo)</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SystemCheckScreen({ examName, checks, checkIndex, checksDone, checksPassed, onContinue, onRecheck, onExit }: {
  examName: string;
  checks: CheckResult[];
  checkIndex: number;
  checksDone: boolean;
  checksPassed: boolean;
  onContinue: () => void;
  onRecheck: () => void;
  onExit?: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-soft">Pre-exam · Step 1 of 3</p>
        <h1 className="mb-1 font-serif text-2xl font-semibold">System readiness check</h1>
        <p className="mb-8 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        <div className="space-y-3 border border-line bg-raised p-5">
          {checks.map((c, i) => (
            <div key={c.label} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[13.5px]">
                <span className={i < checkIndex ? "text-ink" : "text-soft"}>{c.label}</span>
                <span className={`font-mono text-[11px] ${i < checkIndex ? (c.ok ? "text-success" : "text-alert") : "text-soft"}`}>{i < checkIndex ? (c.ok ? "PASS" : "FAIL") : "—"}</span>
              </div>
              {i < checkIndex && !c.ok && c.detail && (
                <div className="text-[11px] text-alert opacity-90">{c.detail}</div>
              )}
            </div>
          ))}
        </div>
        {checksDone && checksPassed && <button onClick={onContinue} className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Continue</button>}
        {checksDone && !checksPassed && (
          <div className="mt-6 flex flex-col gap-3">
            <button onClick={onRecheck} className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Re-check Environment</button>
            {onExit && <button onClick={onExit} className="w-full border border-line py-3 font-mono text-[12px] uppercase tracking-widest text-ink hover:bg-raised">Exit to Desktop</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function DeviceAccessScreen({ cam, mic, screen, requesting, devicesReady, previewRef, onRequest, onContinue }: {
  cam: "idle" | "granted" | "denied";
  mic: "idle" | "granted" | "denied";
  screen: "idle" | "granted" | "denied";
  requesting: boolean;
  devicesReady: boolean;
  previewRef: RefObject<HTMLVideoElement | null>;
  onRequest: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-lg">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-soft">Pre-exam · Step 2 of 3</p>
        <h1 className="mb-2 font-serif text-2xl font-semibold">Grant camera, mic & screen</h1>
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="overflow-hidden border border-line bg-ink"><video ref={previewRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" /></div>
          <div className="space-y-2"><AccessRow label="Camera" state={cam} /><AccessRow label="Microphone" state={mic} /><AccessRow label="Screen sharing" state={screen} /></div>
        </div>
        <button onClick={onRequest} disabled={requesting} className="mt-6 w-full border border-line py-3 font-mono text-[11px] uppercase tracking-wider text-ink">{requesting ? "Requesting access…" : "Allow camera, microphone & screen"}</button>
        <button disabled={!devicesReady} onClick={onContinue} className="mt-3 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60">Continue</button>
      </div>
    </div>
  );
}

export function RulesScreen({ examName, durationMin, questionsLength, agreed, onAgree, onStart }: {
  examName: string;
  durationMin: number;
  questionsLength: number;
  agreed: boolean;
  onAgree: (value: boolean) => void;
  onStart: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-lg">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-soft">Pre-exam · Step 3 of 3</p>
        <h1 className="mb-4 font-serif text-2xl font-semibold">{examName}</h1>
        <p className="text-[13px] text-soft">Duration: {durationMin} min · Questions: {questionsLength}</p>
        <label className="mt-5 flex items-start gap-3 text-[13px]"><input type="checkbox" checked={agreed} onChange={(e) => onAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-maroon" /><span>I have read the rules and consent to monitoring for this exam.</span></label>
        <button disabled={!agreed} onClick={onStart} className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60">Start exam</button>
      </div>
    </div>
  );
}

export function SubmittedScreen({ answeredCount, totalQuestions, studentName, studentRoll, violationsCount, examId, attemptId, uploadState, uploadDetail, submitFailed }: {
  answeredCount: number;
  totalQuestions: number;
  studentName: string;
  studentRoll: string;
  violationsCount: number;
  examId: string;
  attemptId?: string | null;
  /** Where the exam recording/evidence landed after submit (storage status). */
  uploadState?: "uploading" | "stored" | "partial" | "failed";
  uploadDetail?: string;
  /** True when the final answer-submit DB write failed (answers saved locally). */
  submitFailed?: boolean;
}) {
  // Real attempt id from the DB (short-displayed). Falls back to the exam id
  // when the attempt row hasn't been created yet — never a random fake.
  const receiptId = attemptId && attemptId.length > 8 ? attemptId.slice(0, 8).toUpperCase() : (attemptId || examId || "—");
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = new Date().toLocaleDateString();

  const backToDashboard = () => {
    window.location.assign("/student/exams");
  };

  const closeExamWindow = () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<unknown> } };
    // Inside the Vignan lockdown desktop app, ask Rust to exit the app itself.
    if (w.__TAURI_INTERNALS__?.invoke) {
      void openStudentSide("/student/exams").finally(() => {
        void w.__TAURI_INTERNALS__!.invoke!("exit_app").catch(() => {
          try { window.close(); } catch { /* ignore */ }
          backToDashboard();
        });
      });
      return;
    }
    // Browsers silently refuse window.close() for tabs the script didn't open,
    // so after attempting it, back out to the student dashboard — the button
    // always does something visible instead of being a dead control.
    try { window.close(); } catch { /* ignore */ }
    window.setTimeout(backToDashboard, 350);
  };

  useEffect(() => {
    if (isTauri()) {
      const id = window.setTimeout(closeExamWindow, 5000);
      return () => window.clearTimeout(id);
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 text-ink pb-20 pt-12 overflow-y-auto">
      <div className="w-full max-w-md text-center">
        <Seal label="Submitted" sublabel="Receipt recorded" tone="forest" size={100} />
        
        <h1 className="mt-6 font-serif text-3xl font-semibold text-success">Exam Complete</h1>
        <p className="mt-2 text-[13.5px] text-soft">Your answers have been securely submitted.</p>
        
        {submitFailed && (
          <div className="mt-6 border border-alert/40 bg-alert/5 px-4 py-3 text-left text-[12px] text-alert">
            <p className="font-mono text-[9px] uppercase tracking-widest opacity-80">Answers not yet stored</p>
            <p className="mt-1">Your answers were saved on this device and will upload automatically when the connection returns. Please keep this window open, or tell the invigilator before leaving.</p>
          </div>
        )}

        {/* Upload status — hidden in the Tauri kiosk to avoid showing
            infrastructure details ("Cloudflare", "R2") to students. The kiosk
            auto-exits after submit; the recording upload is crash-proof.
            In non-kiosk browser mode, show the status for transparency. */}
        {uploadState && !isTauri() && (
          <div className={`mt-6 border px-4 py-3 text-left text-[12px] ${uploadState === "stored" ? "border-success/40 bg-success/5 text-success" : uploadState === "uploading" ? "border-amber/40 bg-amber/5 text-amber" : uploadState === "partial" ? "border-amber/40 bg-amber/5 text-amber" : "border-alert/40 bg-alert/5 text-alert"}`}>
            <p className="font-mono text-[9px] uppercase tracking-widest opacity-80">Exam recording</p>
            <p className="mt-1">
              {uploadState === "stored" && <>Your exam recording has been secured. You may close this window.</>}
              {uploadState === "uploading" && <>Securing your exam evidence…</>}
              {uploadState === "partial" && <>{uploadDetail ?? "Some exam evidence is still pending. Keep the app open and inform your invigilator."}</>}
              {uploadState === "failed" && <>Your answers are submitted. Please tell the invigilator before leaving so your recording can be verified.</>}
            </p>
          </div>
        )}

        {/* Tauri kiosk: simple auto-closing message instead of upload details */}
        {isTauri() && (
          <div className="mt-6 border border-success/40 bg-success/5 px-4 py-3 text-left text-[12px] text-success">
            <p className="font-mono text-[9px] uppercase tracking-widest opacity-80">Status</p>
            <p className="mt-1">Your exam has been submitted successfully. This window will close shortly.</p>
          </div>
        )}

        <div className="mt-8 border border-line bg-raised text-left font-mono text-[11px] text-soft">
          <div className="border-b border-line px-5 py-3">
            <span className="block uppercase tracking-widest text-[9px] mb-1">Candidate</span>
            <span className="text-ink text-[13px]">{studentName} ({studentRoll})</span>
          </div>
          
          <div className="flex border-b border-line">
            <div className="flex-1 border-r border-line px-5 py-3">
              <span className="block uppercase tracking-widest text-[9px] mb-1">Attempt ID</span>
              <span className="text-ink text-[12px]">{receiptId}</span>
            </div>
            <div className="flex-1 px-5 py-3">
              <span className="block uppercase tracking-widest text-[9px] mb-1">Submitted at</span>
              <span className="text-ink text-[12px]">{time}, {date}</span>
            </div>
          </div>

          <div className="flex border-b border-line">
            <div className="flex-1 border-r border-line px-5 py-3">
              <span className="block uppercase tracking-widest text-[9px] mb-1">Answered</span>
              <span className="text-ink text-[12px]">{answeredCount} / {totalQuestions}</span>
            </div>
            <div className="flex-1 px-5 py-3">
              <span className="block uppercase tracking-widest text-[9px] mb-1">Violations</span>
              <span className={`text-[12px] ${violationsCount > 0 ? 'text-amber' : 'text-ink'}`}>{violationsCount}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 space-y-4">
          <p className="text-[13px] text-soft leading-relaxed px-4">
            You may now close this secure browser window. Detailed results and Analytics will be available on your dashboard once grading is complete.
          </p>

          <a 
            href="/student/results" 
            className="block w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90"
          >
            Go to Results Hub /
          </a>
          
          <button 
            onClick={closeExamWindow} 
            className="block w-full border border-line py-3 font-mono text-[12px] uppercase tracking-widest text-ink transition-colors hover:bg-raised"
          >
            Close Exam Window
          </button>
        </div>
      </div>
    </div>
  );
}

function AccessRow({ label, state }: { label: string; state: "idle" | "granted" | "denied" }) {
  const tone = state === "granted" ? "text-success" : state === "denied" ? "text-alert" : "text-soft";
  const text = state === "granted" ? "GRANTED" : state === "denied" ? "BLOCKED" : "NOT REQUESTED";
  const dot = state === "granted" ? "bg-success" : state === "denied" ? "bg-alert" : "bg-line";
  return <div className="flex items-center justify-between border border-line px-3 py-2.5 text-[13px]"><span className="flex items-center gap-2"><span className={`h-2 w-2 ${dot}`} />{label}</span><span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>{text}</span></div>;
}
