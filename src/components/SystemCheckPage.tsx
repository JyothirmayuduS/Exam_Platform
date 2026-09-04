import { useState } from "react";
import { FiCheck, FiAlertTriangle } from "react-icons/fi";
import { useParams, useNavigate } from "react-router-dom";

type CheckResult = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
};

async function testCamera(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

async function testMicrophone(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

function testBrowserSupport(): boolean {
  const ua = navigator.userAgent;
  return /Chrome|Firefox|Edg\//i.test(ua);
}

function testInternetSpeed(): { ok: boolean; detail: string } {
  const connection = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  if (!connection?.downlink) {
    return { ok: false, detail: "Unable to measure network speed on this browser" };
  }
  return {
    ok: connection.downlink >= 5,
    detail: `Detected ${connection.downlink.toFixed(1)} Mbps`,
  };
}

export default function SystemCheckPage() {
  const { examId } = useParams();
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);

  const runChecks = async () => {
    setRunning(true);
    const speed = testInternetSpeed();
    const checks: CheckResult[] = [
      {
        key: "camera",
        label: "Camera access",
        ok: await testCamera(),
        detail: "Required for invigilation",
        fix: "Allow camera permission in browser site settings.",
      },
      {
        key: "microphone",
        label: "Microphone access",
        ok: await testMicrophone(),
        detail: "Required for invigilation",
        fix: "Allow microphone permission in browser site settings.",
      },
      {
        key: "screen",
        label: "Screen share capability",
        ok: !!navigator.mediaDevices?.getDisplayMedia,
        detail: "Screen API availability",
        fix: "Use latest Chrome, Firefox, or Edge and allow screen-share permission.",
      },
      {
        key: "browser",
        label: "Browser support",
        ok: testBrowserSupport(),
        detail: navigator.userAgent,
        fix: "Use the latest Chrome, Firefox, or Edge browser.",
      },
      {
        key: "speed",
        label: "Internet speed (min 5 Mbps)",
        ok: speed.ok,
        detail: speed.detail,
        fix: "Switch to a stable network with at least 5 Mbps speed.",
      },
      {
        key: "admin",
        label: "Administrator rights check",
        ok: "__TAURI__" in window || "__TAURI_INTERNALS__" in window,
        detail: "Desktop lockdown browser provides elevated runtime checks",
        fix: "Open exam in the official lockdown desktop app.",
      },
    ];
    setResults(checks);
    setRunning(false);
  };

  const passed = results.length > 0 && results.every((check) => check.ok);

  return (
    <section className="border border-line bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">System requirements</p>
          <h3 className="mt-1 font-serif text-xl font-semibold">Device compatibility check</h3>
        </div>
        <button
          onClick={() => void runChecks()}
          disabled={running}
          className="border border-maroon bg-maroon px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper disabled:opacity-60"
        >
          {running ? "Running checks..." : "Run checks"}
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {results.map((check) => (
          <div key={check.key} className="border border-line p-3">
            <p className={`font-mono text-[11px] uppercase tracking-wider ${check.ok ? "text-success" : "text-alert"}`}>
              {check.ok ? <FiCheck className="inline text-success" aria-hidden /> : <FiAlertTriangle className="inline text-alert" aria-hidden />} {check.label}
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">{check.detail}</p>
            {!check.ok && <p className="mt-1 text-[12px] text-alert">Fix: {check.fix}</p>}
          </div>
        ))}
      </div>

      {passed && (
        <button
          onClick={() => {
            if (examId) navigate(`/student/exams/${examId}`);
          }}
          className="mt-4 border border-success bg-success/10 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-success hover:bg-success hover:text-paper transition-colors"
        >
          All Good → Return to Exam
        </button>
      )}
    </section>
  );
}
