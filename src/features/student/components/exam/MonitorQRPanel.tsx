import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FiSmartphone, FiCheck } from "react-icons/fi";
import { createMonitorSession, fetchMonitorStatus, endMonitorSession } from "@/features/mobile/services/monitorSession";

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
    <div>
      <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <FiSmartphone aria-hidden /> Desk monitor
      </h2>

      {!session ? (
        <>
          <p className="exam-sm exam-mute" style={{ margin: 0 }}>
            Optional: use your phone as a second camera showing your desk and hands. This strengthens your integrity record.
          </p>
          <button onClick={start} disabled={creating} className="exam-btn" style={{ marginTop: 10, width: "100%" }}>
            {creating ? "Creating code…" : "Start desk monitoring"}
          </button>
          {createError && <p className="exam-sm" style={{ color: "var(--bad)", margin: "6px 0 0" }}>{createError}</p>}
        </>
      ) : live ? (
        <span className="exam-pill g"><i />Phone desk feed live <FiCheck aria-hidden /></span>
      ) : connected ? (
        <span className="exam-pill w"><i />Phone connecting…</span>
      ) : (
        <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
          <div className="exam-qr">
            <QRCodeSVG value={`${base}/mobile-monitor/${session.token}`} size={132} level="M" fgColor="#1A1814" />
          </div>
          <p className="exam-sm exam-mute" style={{ margin: 0, textAlign: "center" }}>
            Scan with your phone camera, allow the rear camera, and keep your desk and hands in frame.
          </p>
          {phoneStatus === "EXPIRED" || phoneStatus === "TERMINATED" ? (
            <button onClick={start} className="exam-btn" style={{ width: "100%" }}>Session ended — create a new code</button>
          ) : (
            <span className="exam-pill w"><i />Waiting for phone</span>
          )}
        </div>
      )}
    </div>
  );
}
