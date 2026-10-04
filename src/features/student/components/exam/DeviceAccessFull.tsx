import { useEffect, useRef, useState } from "react";
import { FiCheck, FiAlertTriangle, FiAlertOctagon, FiLock, FiArrowRight, FiRefreshCw } from "react-icons/fi";
import { useAudioTest, AudioBars, runDeviceDetection, useScreenShareTest, type DeviceRisk, type ScreenShareState } from "@/features/proctoring/services/proctorUtils";
import type { RefObject } from "react";
import MonitorQRPanel from "@/features/student/components/exam/MonitorQRPanel";

// ─────────────────────────────────────────────────────────────────────────────
// DeviceAccessScreen — replaces the basic one in ExamFlowScreens
// Full pre-exam proctoring setup: camera preview, audio meter, screen share
// test, device detection, and permission error handling.
// ─────────────────────────────────────────────────────────────────────────────

type AccessState = "idle" | "granted" | "denied";


type DeviceAccessFullProps = {
  attemptId?: string;
  cam: AccessState;
  mic: AccessState;
  screen: AccessState;
  requesting: boolean;
  devicesReady: boolean;
  /** True inside the Vignan Exam Browser: permission recovery is native, not browser settings. */
  inKiosk?: boolean;
  /** Ask the shell to re-trigger the native camera/mic permission prompt. */
  onReRequest?: () => void;
  /** Open the OS privacy pane for the blocked device. */
  onOpenMediaSettings?: (kind: "camera" | "microphone" | "screen") => void;
  previewRef: RefObject<HTMLVideoElement | null>;
  onRequest: () => void;
  onScreenGranted?: (stream: MediaStream) => void;
  onContinue: () => void;
  /** Let the user exit the lockdown browser completely to fix OS issues */
  onExit?: () => void;
};

export default function DeviceAccessFull({
  attemptId,
  cam,
  mic,
  screen,
  requesting,
  devicesReady,
  inKiosk = false,
  onReRequest,
  onOpenMediaSettings,
  previewRef,
  onRequest,
  onScreenGranted,
  onContinue,
  onExit,
}: DeviceAccessFullProps) {
  const audio = useAudioTest();
  const screenTest = useScreenShareTest();
  const [risks, setRisks] = useState<DeviceRisk[]>([]);
  const [scanDone, setScanDone] = useState(false);

  // Run device detection scan once cam is granted
  useEffect(() => {
    if (cam !== "granted" || scanDone) return;
    runDeviceDetection().then((r) => { setRisks(r); setScanDone(true); });
  }, [cam, scanDone]);

  const blockers = risks.filter((r) => r.detected && r.severity === "block");
  const warnings = risks.filter((r) => r.detected && r.severity === "warn");
  const canContinue = devicesReady && blockers.length === 0;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-soft">Pre-exam · Step 2 of 3</p>
          <h1 className="mt-1 font-serif text-2xl font-semibold">Grant camera, mic & screen</h1>
          <p className="mt-1 text-[13px] text-soft">Your camera, microphone, and screen must be active for proctoring. All feeds are monitored by AI and your invigilator.</p>
        </div>

        {/* ── Permission grant ── */}
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="overflow-hidden border border-line bg-ink">
            <video ref={previewRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" />
            <div className="flex items-center gap-2 border-t border-white/10 px-2 py-1.5">
              <span className={`h-1.5 w-1.5 rounded-none ${cam === "granted" ? "bg-success" : cam === "denied" ? "bg-alert" : "bg-amber animate-pulse"}`} />
              <span className="font-mono text-[9px] uppercase tracking-wider text-paper/70">
                {cam === "granted" ? "Camera on" : cam === "denied" ? "Blocked" : "Waiting"}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <AccessRow label="Camera" state={cam} />
            <AccessRow label="Microphone" state={mic} />
          <AccessRow label="Screen sharing" state={screen} screenShareState={screenTest.state} />

            {/* Permission error help — kiosk and browser recover differently */}
            {(cam === "denied" || mic === "denied") && (
              <div className="border border-alert/40 bg-alert/5 p-3 text-[12px]">
                {inKiosk ? (
                  <>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-alert mb-1">Camera / microphone blocked</p>
                    <p className="text-soft">
                      If you accidentally clicked "Block", click <strong>"Grant access again"</strong> to reload the exam and try again. If that doesn't work, the OS blocked it:
                    </p>
                    <ol className="list-decimal pl-4 space-y-0.5 text-soft mt-1.5 mb-3">
                      <li>Click <strong>"Open system settings"</strong> below</li>
                      <li>Find Vignan Exam Browser and toggle {cam === "denied" ? "Camera" : "Microphone"} to <strong>ON</strong></li>
                      <li>Return here and click <strong>"Grant access again"</strong></li>
                    </ol>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => onOpenMediaSettings?.(cam === "denied" ? "camera" : "microphone")}
                        className="border border-alert bg-alert/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/20"
                      >
                        Open system settings
                      </button>
                      {cam === "denied" && mic === "denied" && (
                        <button
                          onClick={() => onOpenMediaSettings?.("microphone")}
                          className="border border-alert bg-alert/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/20"
                        >
                          Open mic settings
                        </button>
                      )}
                      <button
                        onClick={onReRequest ?? onRequest}
                        disabled={requesting}
                        className="border border-forest bg-forest px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90 disabled:opacity-60"
                      >
                        {requesting ? "Checking…" : "Grant access again"}
                      </button>
                      {onExit && (
                        <button
                          onClick={onExit}
                          className="border border-line bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-raised ml-auto"
                        >
                          Exit Exam Browser
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-alert mb-1">How to fix permission errors</p>
                    <ol className="list-decimal pl-4 space-y-0.5 text-soft">
                      <li>Click the <FiLock className="inline" aria-hidden /> lock icon in your browser address bar</li>
                      <li>Set Camera and Microphone to "Allow"</li>
                      <li>Reload the page and click Grant again</li>
                    </ol>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={onRequest}
          disabled={requesting}
          className="w-full border border-line py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-raised disabled:opacity-60"
        >
          {requesting ? "Requesting access…" : "Allow camera, microphone & screen"}
        </button>

        {/* ── Audio level test ── */}
        {mic === "granted" && (
          <section className="border border-line p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Microphone test</p>
              <div className="flex gap-2">
                {audio.state === "idle" && (
                  <button onClick={() => void audio.startTest()} className="border border-line px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-raised">
                    Test mic
                  </button>
                )}
                {audio.state === "testing" && (
                  <button onClick={audio.startRecording} className="border border-success bg-success/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-success">
                    ⏺ Record sample
                  </button>
                )}
                {audio.state === "recording" && (
                  <button onClick={audio.stopRecording} className="border border-alert bg-alert/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-alert animate-pulse">
                    ⏹ Stop recording
                  </button>
                )}
              </div>
            </div>

            {(audio.state === "testing" || audio.state === "recording") && (
              <div>
                <AudioBars level={audio.level} />
                <p className="mt-1 font-mono text-[9px] text-soft">
                  {audio.level < 0.05 ? "No audio detected — speak or make noise" : "Audio detected ✓"}
                </p>
              </div>
            )}

            {audio.state === "done" && audio.sampleUrl && (
              <div className="space-y-2">
                <p className="font-mono text-[10px] text-success">✓ Recording captured — play it back:</p>
                <audio controls src={audio.sampleUrl} className="w-full" />
              </div>
            )}

            {audio.state === "error" && (
              <p className="text-[12px] text-alert">{audio.error}</p>
            )}
          </section>
        )}

        {/* Screen sharing is now natively requested along with camera and microphone. */}
        {/* ── Device detection results ── */}
        {scanDone && (
          <section className="border border-line p-4 space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Device security scan</p>
            {risks.map((r) => (
              <div key={r.label} className={`flex items-center justify-between border px-3 py-2 text-[12px] ${r.detected ? (r.severity === "block" ? "border-alert/40 bg-alert/5" : r.severity === "warn" ? "border-amber/40 bg-amber/5" : "border-line") : "border-line"}`}>
                <span className="text-ink">{r.label}</span>
                <span className={`font-mono text-[10px] uppercase tracking-wider ${r.detected ? (r.severity === "block" ? "text-alert" : r.severity === "warn" ? "text-amber" : "text-soft") : "text-success"}`}>
                  {r.detected ? (r.severity === "block" ? <><FiAlertOctagon className="inline" aria-hidden /> Blocked</> : <><FiAlertTriangle className="inline" aria-hidden /> Warning</>) : <><FiCheck className="inline" aria-hidden /> Clear</>}
                </span>
              </div>
            ))}
            {blockers.length > 0 && (
              <p className="text-[12px] text-alert font-medium">
                {blockers.map((b) => b.label).join(", ")} detected. You must disable these before entering the exam.
              </p>
            )}
            {warnings.length > 0 && blockers.length === 0 && (
              <p className="text-[12px] text-amber">
                {warnings.map((w) => w.label).join(", ")} detected. This will be flagged to your invigilator.
              </p>
            )}
          </section>
        )}

        {/* ── Desk Monitor ── */}
        <MonitorQRPanel attemptId={attemptId} />

        {/* ── Continue button ── */}
        <button
          disabled={!canContinue}
          onClick={onContinue}
          title={!devicesReady ? "Grant all permissions first" : blockers.length > 0 ? "Resolve security issues first" : undefined}
          className="w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:cursor-not-allowed disabled:opacity-50"
        >
          {!devicesReady ? "Grant permissions to continue" : blockers.length > 0 ? "Resolve issues to continue" : <><span>Continue</span><FiArrowRight aria-hidden /></>}
        </button>
      </div>
    </div>
  );
}

// ── Shared helper ─────────────────────────────────────────────────────────────
function AccessRow({
  label,
  state,
  screenShareState,
}: {
  label: string;
  state: AccessState;
  screenShareState?: ScreenShareState;
}) {
  let displayText = state === "granted" ? "GRANTED" : state === "denied" ? "BLOCKED" : "WAITING";
  let tone = state === "granted" ? "text-success" : state === "denied" ? "text-alert" : "text-soft";
  let dot  = state === "granted" ? "bg-success" : state === "denied" ? "bg-alert" : "bg-line";

  if (screenShareState !== undefined) {
    switch (screenShareState) {
      case "active":       displayText = "GRANTED";     tone = "text-success"; dot = "bg-success"; break;
      case "requesting":   displayText = "REQUESTING";  tone = "text-amber";   dot = "bg-amber animate-pulse"; break;
      case "cancelled":    displayText = "CANCELLED";   tone = "text-amber";   dot = "bg-amber"; break;
      case "denied":       displayText = "DENIED";      tone = "text-alert";   dot = "bg-alert"; break;
      case "error":        displayText = "ERROR";       tone = "text-alert";   dot = "bg-alert"; break;
      case "unsupported":  displayText = "UNSUPPORTED"; tone = "text-alert";   dot = "bg-alert"; break;
      default:             displayText = "WAITING";     tone = "text-soft";    dot = "bg-line"; break;
    }
  }

  return (
    <div className="flex items-center justify-between border border-line px-3 py-2.5 text-[13px]">
      <span className="flex items-center gap-2"><span className={`h-2 w-2 ${dot}`} />{label}</span>
      <span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>{displayText}</span>
    </div>
  );
}
