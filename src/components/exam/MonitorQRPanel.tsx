import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FiSmartphone, FiCheck } from "react-icons/fi";
import { createMonitorSession, fetchMonitorStatus, endMonitorSession } from "../../lib/monitorSession";

/**
 * MonitorQRPanel — desktop side of the phone-based secondary proctoring feed.
 *
 * The student taps "Start desk monitoring" during the exam; a one-time QR
 * (server-minted, 15-min sliding TTL) appears; the phone opens
 * /mobile-monitor/<token> and publishes its rear camera into the exam's
 * LiveKit room as `mobile:<roll>`. The panel polls session status so the
 * student sees when the phone connects. The session is torn down on submit.
 */

type Session = { token: string; sessionId: string; expiresAt: string };

function getPublicBase(): string {
  const envUrl = import.meta.env.VITE_APP_BASE_URL as string | undefined;
  if (envUrl && envUrl.trim() !== "" && !envUrl.includes("shy-rattlesnake-39") && !envUrl.includes("loca.lt")) {
    return envUrl.trim().replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      // @ts-ignore: __LOCAL_IP__ is injected by Vite at build time
      const localIp = typeof __LOCAL_IP__ !== "undefined" ? __LOCAL_IP__ : "localhost";
      return `http://${localIp}:${window.location.port}`;
    }
    return window.location.origin;
  }
  return "";
}

export default function MonitorQRPanel({ attemptId, onSubmitConsumed }: {
  attemptId?: string;
  /** Called when the exam ends — the panel terminates the monitor session. */
  onSubmitConsumed?: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [phoneStatus, setPhoneStatus] = useState<string | null>(null); // null = not connected yet
  const [cameraStatus, setCameraStatus] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const base = getPublicBase();

  const start = useCallback(async () => {
    if (!attemptId || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const s = await createMonitorSession(attemptId, "monitor");
      setSession(s);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not start the monitoring session");
    } finally {
      setCreating(false);
    }
  }, [attemptId, creating]);

  // Poll session status while a QR is active.
  useEffect(() => {
    if (!session) return;
    let active = true;
    pollRef.current = window.setInterval(async () => {
      const st = await fetchMonitorStatus(session.token);
      if (!active) return;
      if (!st) return;
      setPhoneStatus(st.status);
      setCameraStatus(st.cameraStatus);
      if (st.status === "TERMINATED" || st.status === "EXPIRED") {
        if (pollRef.current) window.clearInterval(pollRef.current);
      }
    }, 4000);
    return () => {
      active = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session]);

  // Exam submit → terminate the monitor session.
  const consumedRef = useRef(false);
  useEffect(() => {
    if (onSubmitConsumed && !consumedRef.current) {
      consumedRef.current = true;
      if (session) void endMonitorSession(session.token, "exam_submitted");
    }
  }, [onSubmitConsumed, session]);

  // Unmount cleanup.
  useEffect(() => () => {
    if (session && !consumedRef.current) void endMonitorSession(session.token, "panel_unmounted");
  }, [session]);

  if (!attemptId) return null;

  const connected = phoneStatus === "CONNECTED";
  const live = connected && cameraStatus === "CONNECTED";

  return (
    <div className="border border-line bg-paper-raised p-3">
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
        <FiSmartphone aria-hidden /> Desk monitor
      </p>

      {!session ? (
        <>
          <p className="text-[11.5px] leading-snug text-soft">
            Optional: use your phone as a second camera showing your desk and hands. This strengthens your integrity record.
          </p>
          <button
            onClick={start}
            disabled={creating}
            className="mt-2 w-full border border-ink py-2 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-raised disabled:opacity-60"
          >
            {creating ? "Generating…" : "Start desk monitoring"}
          </button>
          {createError && <p className="mt-1.5 text-[11px] text-alert">{createError}</p>}
        </>
      ) : live ? (
        <div className="flex items-center gap-2 border border-success/40 bg-success/10 px-2.5 py-2">
          <span className="h-1.5 w-1.5 animate-pulse bg-success" aria-hidden />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-success">Phone desk feed live</span>
          <FiCheck className="ml-auto text-success" aria-hidden />
        </div>
      ) : connected ? (
        <div className="flex items-center gap-2 border border-amber/40 bg-amber/10 px-2.5 py-2">
          <span className="h-1.5 w-1.5 animate-pulse bg-amber" aria-hidden />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber">Phone connecting…</span>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="mx-auto w-fit bg-white p-2">
            <QRCodeSVG value={`${base}/mobile-monitor/${session.token}`} size={132} level="M" />
          </div>
          <p className="text-center font-mono text-[9px] uppercase leading-relaxed tracking-wider text-soft">
            Scan with your phone camera → allow the rear camera → keep desk + hands in frame
          </p>
          <p className="text-center font-mono text-[9px] uppercase tracking-widest text-soft">
            {phoneStatus === "EXPIRED" || phoneStatus === "TERMINATED"
              ? "Session ended — tap to restart"
              : "Waiting for phone…"}
          </p>
          {(phoneStatus === "EXPIRED" || phoneStatus === "TERMINATED") && (
            <button onClick={start} className="w-full border border-ink py-1.5 font-mono text-[9px] uppercase tracking-widest text-ink hover:bg-raised">
              Regenerate QR
            </button>
          )}
        </div>
      )}
    </div>
  );
}
