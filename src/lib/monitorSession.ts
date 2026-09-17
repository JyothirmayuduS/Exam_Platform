import { getSupabase } from "./supabase";

/**
 * Client API for the phone-based secondary proctoring module.
 *
 * All calls go through the `mobile-monitor-session` edge function, which is
 * server-authoritative: the phone only ever presents its one-time capability
 * token — never trusted IDs. The laptop uses the same function with its
 * Supabase session for `create`/`status`.
 */

export type MonitorPhase =
  | "idle"
  | "connected" // token valid, session CONNECTED
  | "publishing" // camera live, connecting/publishing to LiveKit
  | "live" // camera published + LiveKit connected — full monitoring
  | "degraded" // LiveKit unavailable → snapshot fallback evidence mode
  | "ended";

export type MonitorEventInput = {
  type: string;
  metadata?: Record<string, unknown>;
};

export type MonitorStatus = {
  status: string;
  cameraStatus: string | null;
  livekitRoom: string | null;
  questionId: string | null;
  expiresAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
};

async function invokeMonitor(payload: Record<string, unknown>): Promise<Record<string, any>> {
  const db = getSupabase();
  if (!db) throw new Error("Supabase is not configured on this device");
  const { data, error } = await db.functions.invoke("mobile-monitor-session", { body: payload });
  if (error) throw new Error(error.message || "mobile-monitor-session failed");
  return (data ?? {}) as Record<string, any>;
}

// ------------------------------------------------------------------ laptop

/** Laptop: mint a one-time monitor session for the active attempt. */
export async function createMonitorSession(attemptId: string, questionId: string | number): Promise<{
  token: string;
  sessionId: string;
  expiresAt: string;
  livekitRoom: string;
  livekitIdentity: string;
}> {
  const data = await invokeMonitor({ action: "create", attemptId, questionId: String(questionId) });
  if (!data.token) throw new Error(data.error ?? "Monitor session creation failed");
  return data as any;
}

/** Laptop: poll the session status for the QR panel. */
export async function fetchMonitorStatus(token: string): Promise<MonitorStatus | null> {
  try {
    const data = await invokeMonitor({ action: "status", token });
    return data as MonitorStatus;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- phone

/** Phone: validate the scanned token and mark the session connected. */
export async function validateMonitorToken(token: string): Promise<{
  ok: boolean;
  sessionId: string;
  status: string;
  livekitRoom: string;
  livekitIdentity: string;
  questionId: string;
  expiresAt: string;
}> {
  const data = await invokeMonitor({ action: "validate", token });
  if (!data.ok) throw new Error(data.error ?? "Invalid monitor token");
  return data as any;
}

/** Phone: keep-alive ping (server flags staleness, not the client). */
export async function sendMonitorHeartbeat(token: string): Promise<void> {
  await invokeMonitor({ action: "heartbeat", token });
}

/** Phone: report an interruption/monitoring signal. */
export async function sendMonitorEvent(token: string, input: MonitorEventInput): Promise<void> {
  try {
    await invokeMonitor({ action: "event", token, type: input.type, metadata: input.metadata ?? {} });
  } catch (err) {
    // Never let telemetry failures break the exam flow — log and continue.
    console.warn("[monitor] event send failed:", input.type, err);
  }
}

/** Phone: record a snapshot-fallback evidence object. */
export async function sendMonitorSnapshot(token: string, path: string, ts: number): Promise<void> {
  await invokeMonitor({ action: "snapshot", token, path, ts }).catch(() => undefined);
}

/** Phone (fallback mode): upload a base64 JPEG snapshot via the edge function
 *  — the phone never holds storage credentials; the server writes it into the
 *  session's own private namespace. */
export async function sendMonitorSnapshotData(token: string, dataUrl: string): Promise<string | null> {
  try {
    const data = await invokeMonitor({ action: "snapshot-data", token, dataUrl });
    return (data.path as string) ?? null;
  } catch {
    return null;
  }
}

/** Phone/laptop: terminate the session (stop monitoring). */
export async function endMonitorSession(token: string, reason: string): Promise<void> {
  await invokeMonitor({ action: "end", token, reason }).catch(() => undefined);
}
