import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { FiCamera, FiMic, FiMonitor, FiLock, FiArrowRight } from "react-icons/fi";
import { useAudioTest, AudioBars, runDeviceDetection, type DeviceRisk } from "@/features/proctoring/services/proctorUtils";
import MonitorQRPanel from "@/features/student/components/exam/MonitorQRPanel";
import "./ExamStyle.css";

// Pre-exam proctoring setup: permission prompt, camera preview, device status,
// microphone test, device security scan and the optional desk monitor.

type AccessState = "idle" | "granted" | "denied";

type DeviceAccessFullProps = {
  attemptId?: string;
  cam: AccessState;
  mic: AccessState;
  screen: AccessState;
  /** Kiosk only: system-wide shortcut lock (macOS hot keys / Windows keyboard hook). */
  keyboard?: AccessState;
  requesting: boolean;
  devicesReady: boolean;
  /** True inside the Vignan Exam Browser: permission recovery is native, not browser settings. */
  inKiosk?: boolean;
  /** Ask the shell to re-trigger the native camera/mic permission prompt. */
  onReRequest?: () => void;
  /** Open the OS privacy pane for the blocked device. */
  onOpenMediaSettings?: (kind: "camera" | "microphone" | "screen" | "keyboard") => void;
  /** macOS Screen Recording is off; it only applies after a restart of the exam browser. */
  screenNeedsRestart?: boolean;
  onRestart?: () => void;
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
  keyboard = "granted",
  requesting,
  devicesReady,
  inKiosk = false,
  onReRequest,
  onOpenMediaSettings,
  screenNeedsRestart = false,
  onRestart,
  previewRef,
  onRequest,
  onContinue,
  onExit,
}: DeviceAccessFullProps) {
  const audio = useAudioTest();
  const [risks, setRisks] = useState<DeviceRisk[]>([]);
  const [scanDone, setScanDone] = useState(false);
  const untouched = cam === "idle" && mic === "idle" && screen === "idle";
  const [prompt, setPrompt] = useState<"ask" | "declined" | null>(untouched ? "ask" : null);

  const allowAll = () => {
    setPrompt(null);
    onRequest();
  };

  useEffect(() => {
    if (cam !== "granted" || scanDone) return;
    runDeviceDetection().then((r) => { setRisks(r); setScanDone(true); });
  }, [cam, scanDone]);

  const blockers = risks.filter((r) => r.detected && r.severity === "block");
  const warnings = risks.filter((r) => r.detected && r.severity === "warn");
  const canContinue = devicesReady && blockers.length === 0;
  const camMicBlocked = cam === "denied" || mic === "denied";

  return (
    <div className="exam-body">
      <header className="exam-header">
        <div className="exam-brand" style={{ borderRight: 0 }}>
          <svg className="exam-logo" viewBox="0 0 64 64" role="img" aria-label="Vignan">
            <rect width="64" height="64" rx="10" fill="#F7F5F0" />
            <path d="M32 46 14 18h8.4l9.6 17.6L41.6 18H50L32 46Z" fill="#284B34" />
            <circle cx="48.5" cy="18.5" r="4.5" fill="#B7791F" />
          </svg>
          <div>
            <div className="exam-b1">Vignan Exam Browser</div>
            <div className="exam-b2">Vignan University</div>
          </div>
        </div>
        <div className="exam-sp" />
        {onExit && (
          <button type="button" onClick={onExit} className="exam-btn">Exit</button>
        )}
      </header>

      <div className="exam-setup">
        <div className="exam-steps">
          <span className="done"><b>✓</b>Exam details</span><i />
          <span className="now"><b>2</b>Camera, mic &amp; screen</span><i />
          <span><b>3</b>Identity &amp; start</span>
        </div>
        <h1>Set up proctoring</h1>
        <div className="exam-mute">
          Your camera, microphone and entire screen are monitored for the whole exam by AI and your invigilator.
        </div>

        <div className="exam-sg">
          <section className="exam-panel">
            <div className="exam-cam">
              <video ref={previewRef} autoPlay playsInline muted />
              <span className="exam-rec" style={cam === "granted" ? undefined : { gap: 0 }}>
                {cam === "granted" ? "Live" : "Camera off"}
              </span>
            </div>
            <div className="exam-sm exam-mute" style={{ marginTop: 8 }}>Sit facing the camera in good light.</div>
          </section>

          <section className="exam-panel">
            <DeviceRow icon={<FiCamera />} title="Camera" detail="Your face, checked by AI" state={cam} />
            <DeviceRow icon={<FiMic />} title="Microphone" detail="Sound in the room" state={mic} />
            <DeviceRow icon={<FiMonitor />} title="Entire screen" detail="Your whole display, never a single window" state={screen} />
            {inKiosk && (
              <DeviceRow icon={<FiLock />} title="Keyboard lock" detail="Shortcuts and app switching are switched off" state={keyboard} />
            )}

            {camMicBlocked && (
              <div className="exam-fix">
                {inKiosk ? (
                  <>
                    <b>{cam === "denied" && mic === "denied" ? "Camera and microphone are" : cam === "denied" ? "Camera is" : "Microphone is"} blocked.</b>
                    <ol>
                      <li>Click <strong>Open settings</strong> and turn on <strong>Vignan Exam Browser</strong>.</li>
                      <li>Come back and click <strong>Try again</strong>.</li>
                    </ol>
                    <div className="exam-nv">
                      {cam === "denied" && <button className="exam-btn" onClick={() => onOpenMediaSettings?.("camera")}>Open camera settings</button>}
                      {mic === "denied" && <button className="exam-btn" onClick={() => onOpenMediaSettings?.("microphone")}>Open microphone settings</button>}
                      <button className="exam-btn pri" onClick={onReRequest ?? onRequest} disabled={requesting}>
                        {requesting ? "Checking…" : "Try again"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <b>Camera or microphone is blocked in this browser.</b>
                    <ol>
                      <li>Click the <FiLock className="inline" aria-hidden /> lock icon in the address bar.</li>
                      <li>Set Camera and Microphone to Allow.</li>
                      <li>Reload the page and click Allow again.</li>
                    </ol>
                  </>
                )}
              </div>
            )}

            {screen === "denied" && inKiosk && screenNeedsRestart && (
              <div className="exam-fix">
                <b>Screen recording is off for Vignan Exam Browser.</b>
                <ol>
                  <li>Click <strong>Open screen settings</strong>.</li>
                  <li>Turn on <strong>Vignan Exam Browser</strong>.</li>
                  <li>If macOS offers <strong>Quit &amp; Reopen</strong>, choose <strong>Later</strong>. This page connects your screen by itself.</li>
                </ol>
                <p className="exam-sm exam-mute" style={{ margin: "6px 0 0" }}>
                  <span className="exam-pill w"><i />Waiting for screen recording</span>
                </p>
                <div className="exam-nv">
                  <button className="exam-btn pri" onClick={() => onOpenMediaSettings?.("screen")}>Open screen settings</button>
                  {onRestart && <button className="exam-btn q" onClick={onRestart}>Still blocked? Restart exam browser</button>}
                </div>
              </div>
            )}

            <div className="exam-cta">
              {canContinue ? (
                <button className="exam-btn ok lg" onClick={onContinue}>
                  Continue <FiArrowRight className="inline" aria-hidden />
                </button>
              ) : devicesReady ? (
                <button className="exam-btn lg" disabled title="Resolve security issues first">Resolve the issues below to continue</button>
              ) : (
                <button className="exam-btn pri lg" onClick={allowAll} disabled={requesting}>
                  {requesting ? "Asking for access…" : untouched ? "Allow camera, microphone & screen" : "Try again"}
                </button>
              )}
            </div>
          </section>
        </div>

        {mic === "granted" && <MicTest audio={audio} />}

        {scanDone && (
          <section className="exam-panel" style={{ marginTop: 16 }}>
            <h2>Device security check</h2>
            <ul className="exam-scan">
              {risks.map((r) => (
                <li key={r.label}>
                  <span>{r.label}</span>
                  {r.detected
                    ? <span className={`exam-pill ${r.severity === "block" ? "b" : "w"}`}>{r.severity === "block" ? "Blocked" : "Warning"}</span>
                    : <span className="exam-pill g">Clear</span>}
                </li>
              ))}
            </ul>
            {blockers.length > 0 && (
              <div className="exam-fix"><b>{blockers.map((b) => b.label).join(", ")} detected.</b> Turn these off before entering the exam.</div>
            )}
            {warnings.length > 0 && blockers.length === 0 && (
              <p className="exam-sm" style={{ color: "var(--warn)", margin: "10px 0 0" }}>
                {warnings.map((w) => w.label).join(", ")} detected. This will be shown to your invigilator.
              </p>
            )}
          </section>
        )}

        <section className="exam-panel" style={{ marginTop: 16 }}>
          <MonitorQRPanel attemptId={attemptId} />
        </section>
      </div>

      {prompt && (
        <PermissionPrompt
          declined={prompt === "declined"}
          onAllow={allowAll}
          onDeny={() => setPrompt("declined")}
          onReview={() => setPrompt("ask")}
          onExit={onExit}
        />
      )}
    </div>
  );
}

function DeviceRow({ icon, title, detail, state }: { icon: ReactNode; title: string; detail: string; state: AccessState }) {
  return (
    <div className="exam-dev">
      <span className="exam-ic" aria-hidden>{icon}</span>
      <div>
        <b>{title}</b>
        <span className="exam-sm exam-mute">{detail}</span>
      </div>
      <span className={`exam-pill ${state === "granted" ? "g" : state === "denied" ? "b" : "n"}`}>
        {state === "granted" ? "Allowed" : state === "denied" ? "Blocked" : "Not allowed yet"}
      </span>
    </div>
  );
}

function MicTest({ audio }: { audio: ReturnType<typeof useAudioTest> }) {
  return (
    <section className="exam-panel" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Microphone test</h2>
        {audio.state === "idle" && <button className="exam-btn" onClick={() => void audio.startTest()}>Test microphone</button>}
        {audio.state === "testing" && <button className="exam-btn" onClick={audio.startRecording}>Record a sample</button>}
        {audio.state === "recording" && <button className="exam-btn bad" onClick={audio.stopRecording}>Stop recording</button>}
      </div>
      {(audio.state === "testing" || audio.state === "recording") && (
        <div style={{ marginTop: 10 }}>
          <AudioBars level={audio.level} />
          <p className="exam-sm exam-mute" style={{ margin: "4px 0 0" }}>
            {audio.level < 0.05 ? "No sound yet — say something." : "Sound detected."}
          </p>
        </div>
      )}
      {audio.state === "done" && audio.sampleUrl && (
        <div style={{ marginTop: 10 }}>
          <p className="exam-sm" style={{ color: "var(--ok)", margin: "0 0 6px" }}>Recording captured — play it back:</p>
          <audio controls src={audio.sampleUrl} className="w-full" />
        </div>
      )}
      {audio.state === "error" && <p className="exam-sm" style={{ color: "var(--bad)", margin: "10px 0 0" }}>{audio.error}</p>}
    </section>
  );
}

function PermissionPrompt({
  declined,
  onAllow,
  onDeny,
  onReview,
  onExit,
}: {
  declined: boolean;
  onAllow: () => void;
  onDeny: () => void;
  onReview: () => void;
  onExit?: () => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { primaryRef.current?.focus(); }, [declined]);

  return (
    <div className="exam-scrim" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="exam-dialog">
        {declined ? (
          <>
            <h3 id="perm-title">The exam can't start without these</h3>
            <div className="exam-mute">
              Proctoring needs your camera, microphone and entire screen for the whole exam. Nothing is recorded until you allow it.
            </div>
            <div className="exam-dact">
              {onExit && <button onClick={onExit} className="exam-btn q">Exit</button>}
              <button ref={primaryRef} onClick={onReview} className="exam-btn pri">Review again</button>
            </div>
          </>
        ) : (
          <>
            <h3 id="perm-title">Allow access for this exam</h3>
            <div className="exam-mute">
              The exam is proctored. Your computer will ask you to confirm each one — choose <b>Allow</b>.
            </div>
            <ul className="exam-perm">
              <li><span className="exam-ic" aria-hidden><FiCamera /></span><div><b>Camera</b><div className="exam-sm exam-mute">Your face, checked by AI and your invigilator</div></div></li>
              <li><span className="exam-ic" aria-hidden><FiMic /></span><div><b>Microphone</b><div className="exam-sm exam-mute">Sound in the room</div></div></li>
              <li><span className="exam-ic" aria-hidden><FiMonitor /></span><div><b>Entire screen</b><div className="exam-sm exam-mute">Your whole display, never a single window</div></div></li>
            </ul>
            <div className="exam-dact">
              <button onClick={onDeny} className="exam-btn q">Deny</button>
              <button ref={primaryRef} onClick={onAllow} className="exam-btn pri">Allow all</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
