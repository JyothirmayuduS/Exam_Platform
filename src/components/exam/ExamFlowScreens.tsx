import type { RefObject } from "react";
import Seal from "../Seal";

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
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Vignan University · Secure exam platform</p>
        <h1 className="mb-1 font-serif text-2xl font-semibold">Install Vignan Exam Browser</h1>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        <div className="border border-line bg-paper-raised p-5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Detected OS: {os}</p>
          {installer === "checking" && <div className="mt-4 border border-line py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink-soft">Locating installer…</div>}
          {installer === "ready" && <a href={href} download={downloadFilename} className="mt-4 block w-full border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper">↓ Download</a>}
          {installer === "release" && <a href={href} target="_blank" rel="noreferrer" className="mt-4 block w-full border border-maroon bg-maroon py-3 text-center font-mono text-[12px] uppercase tracking-widest text-paper">Open download page →</a>}
          {installer === "missing" && <p className="mt-4 text-[12px] text-ink-soft">Installer unavailable for this OS.</p>}
        </div>
        <div className="mt-4 flex flex-col gap-3">
          {(installer === "ready" || installer === "release") && <button onClick={onDoneInstall} className="w-full border border-success bg-success/10 py-3 font-mono text-[12px] uppercase tracking-widest text-success">✓ Done — I've installed it</button>}
          <button onClick={onPreview} className="font-mono text-[10px] text-ink-soft underline">Preview exam flow (dev bypass)</button>
        </div>
      </div>
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
}: {
  examName: string;
  deepLinkTried: boolean;
  deepLinkFailed: boolean;
  onEnter: () => void;
  onTryAgain: () => void;
  onBack: () => void;
  downloadHref: string;
  downloadFilename: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="mt-5 font-serif text-2xl font-semibold">Vignan Exam Browser installed!</h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        {!deepLinkTried ? (
          <button onClick={onEnter} className="mt-6 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Enter exam →</button>
        ) : deepLinkFailed ? (
          <div className="mt-4 space-y-3">
            <button onClick={onTryAgain} className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Try again →</button>
            <a href={downloadHref} download={downloadFilename} className="block w-full border border-line-strong py-3 text-center font-mono text-[12px] uppercase tracking-widest text-ink">↓ Download again</a>
          </div>
        ) : (
          <div className="mt-5 font-mono text-[11px] text-ink-soft">Launching Vignan Exam Browser…</div>
        )}
        <button onClick={onBack} className="mt-4 font-mono text-[10px] text-ink-soft underline">← Back</button>
      </div>
    </div>
  );
}

export function SystemCheckScreen({ examName, checks, checkIndex, checksDone, checksPassed, onContinue, onRecheck }: {
  examName: string;
  checks: CheckResult[];
  checkIndex: number;
  checksDone: boolean;
  checksPassed: boolean;
  onContinue: () => void;
  onRecheck: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 1 of 3</p>
        <h1 className="mb-1 font-serif text-2xl font-semibold">System readiness check</h1>
        <p className="mb-8 font-mono text-[11px] uppercase tracking-wider text-maroon">{examName}</p>
        <div className="space-y-3 border border-line bg-paper-raised p-5">
          {checks.map((c, i) => (
            <div key={c.label} className="flex items-center justify-between text-[13.5px]">
              <span className={i < checkIndex ? "text-ink" : "text-ink-soft"}>{c.label}</span>
              <span className={`font-mono text-[11px] ${i < checkIndex ? (c.ok ? "text-success" : "text-alert") : "text-ink-soft"}`}>{i < checkIndex ? (c.ok ? "PASS" : "FAIL") : "—"}</span>
            </div>
          ))}
        </div>
        {checksDone && checksPassed && <button onClick={onContinue} className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Continue</button>}
        {checksDone && !checksPassed && <button onClick={onRecheck} className="mt-6 w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper">Re-check Environment</button>}
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
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 2 of 3</p>
        <h1 className="mb-2 font-serif text-2xl font-semibold">Grant camera, mic & screen</h1>
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="overflow-hidden border border-line-strong bg-ink"><video ref={previewRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" /></div>
          <div className="space-y-2"><AccessRow label="Camera" state={cam} /><AccessRow label="Microphone" state={mic} /><AccessRow label="Screen sharing" state={screen} /></div>
        </div>
        <button onClick={onRequest} disabled={requesting} className="mt-6 w-full border border-line-strong py-3 font-mono text-[11px] uppercase tracking-wider text-ink">{requesting ? "Requesting access…" : "Allow camera, microphone & screen"}</button>
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
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 3 of 3</p>
        <h1 className="mb-4 font-serif text-2xl font-semibold">{examName}</h1>
        <p className="text-[13px] text-ink-soft">Duration: {durationMin} min · Questions: {questionsLength}</p>
        <label className="mt-5 flex items-start gap-3 text-[13px]"><input type="checkbox" checked={agreed} onChange={(e) => onAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-maroon" /><span>I have read the rules and consent to monitoring for this exam.</span></label>
        <button disabled={!agreed} onClick={onStart} className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60">Start exam</button>
      </div>
    </div>
  );
}

export function SubmittedScreen({ answeredCount, totalQuestions, studentName, studentRoll, violationsCount }: {
  answeredCount: number;
  totalQuestions: number;
  studentName: string;
  studentRoll: string;
  violationsCount: number;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md text-center">
        <Seal label="Submitted" sublabel="Receipt recorded" tone="forest" size={100} />
        <h1 className="mt-6 font-serif text-2xl font-semibold text-success">Student Completed</h1>
        <p className="mt-2 text-[13.5px] text-ink-soft">{answeredCount} of {totalQuestions} questions answered.</p>
        <div className="mt-6 border border-line bg-paper-raised p-4 text-left font-mono text-[11px] text-ink-soft">
          <div className="flex justify-between"><span>Candidate</span><span className="text-ink">{studentName}</span></div>
          <div className="mt-1 flex justify-between"><span>Roll No.</span><span className="text-ink">{studentRoll}</span></div>
          <div className="mt-1 flex justify-between"><span>Violations logged</span><span className="text-ink">{violationsCount}</span></div>
        </div>
      </div>
    </div>
  );
}

function AccessRow({ label, state }: { label: string; state: "idle" | "granted" | "denied" }) {
  const tone = state === "granted" ? "text-success" : state === "denied" ? "text-alert" : "text-ink-soft";
  const text = state === "granted" ? "GRANTED" : state === "denied" ? "BLOCKED" : "NOT REQUESTED";
  const dot = state === "granted" ? "bg-success" : state === "denied" ? "bg-alert" : "bg-line-strong";
  return <div className="flex items-center justify-between border border-line px-3 py-2.5 text-[13px]"><span className="flex items-center gap-2"><span className={`h-2 w-2 ${dot}`} />{label}</span><span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>{text}</span></div>;
}
