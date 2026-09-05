import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listLiveAttempts, subscribeToAttempts, type LiveAttempt } from "../lib/examApi";
import type { Attempt, AttemptState, Network, Flag } from "../lib/rosterModel";

function fmtClock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function timeAgo(dateString: string | null) {
  if (!dateString) return "";
  const diff = Date.now() - new Date(dateString).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min === 1) return "1 min ago";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs} hr ago`;
}

/** Short human device label parsed from a real User-Agent, or "—" when unknown. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "—";
  const s = ua.toLowerCase();
  const os = s.includes("windows")
    ? "Windows"
    : s.includes("mac os") || s.includes("macintosh")
      ? "macOS"
      : s.includes("android")
        ? "Android"
        : s.includes("iphone") || s.includes("ipad")
          ? "iOS"
          : s.includes("linux")
            ? "Linux"
            : "Other OS";
  const browser = s.includes("edg/")
    ? "Edge"
    : s.includes("chrome") && !s.includes("edg/")
      ? "Chrome"
      : s.includes("firefox")
        ? "Firefox"
        : s.includes("safari") && !s.includes("chrome")
          ? "Safari"
          : "Browser";
  return `${browser} · ${os}`;
}

function toUIAttempt(row: LiveAttempt, examName: string): Attempt {
  const name = row.student?.full_name || "Unknown Student";
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const roll = row.student?.roll || "Unknown Roll";

  // Transform DB state -> UI AttemptState
  const stateMap: Record<string, AttemptState> = {
    not_started: "Not started",
    in_progress: "In progress",
    submitted: "Submitted",
    paused: "Paused",
  };
  const state: AttemptState = stateMap[row.state] || "Not started";

  // Real presence: an in-progress attempt whose last autosave is old is
  // disconnected; a recent one is actively writing. No fabricated values.
  let network: Network = "Stable";
  if (state === "In progress" || state === "Paused") {
    const lastSeen = row.auto_saved_at ? new Date(row.auto_saved_at).getTime() : 0;
    const started = row.started_at ? new Date(row.started_at).getTime() : Date.now();
    const freshMs = Date.now() - Math.max(lastSeen, started);
    if (!row.auto_saved_at && Date.now() - started > 5 * 60 * 1000) network = "Offline";
    else if (freshMs > 5 * 60 * 1000) network = "Offline";
    else if (freshMs > 90 * 1000) network = "Idle";
    else network = "Stable";
  } else if (state === "Not started") {
    network = "Idle";
  }

  // Real violation events from violation_events (student AI flags + proctor
  // actions), mapped to the flags the UI renders across Submissions/Evaluate.
  const flags: Flag[] = (row.violations ?? []).map((v) => ({
    severity: v.severity === "critical" || v.severity === "high" ? "critical" : "notice",
    label: v.description || v.violation_type,
    at: v.offset_seconds != null ? `at ${fmtClock(v.offset_seconds)}` : `at ${new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  }));

  return {
    id: row.id,
    name,
    roll,
    initials,
    email: row.student?.email ?? null,
    studentId: row.student?.id ?? null,
    examId: row.exam_id,
    exam: examName,
    state,
    answered: row.answered,
    total: row.total,
    startedAt: row.started_at ? new Date(row.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—",
    submittedAgo: state === "Submitted" ? timeAgo(row.submitted_at) : "",
    minutesUsed: row.minutes_used,
    lastActivity:
      state === "Submitted"
        ? `Submitted ${new Date(row.submitted_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : row.auto_saved_at
          ? `Active ${timeAgo(row.auto_saved_at).toLowerCase()}`
          : "Never signed in",
    device: deviceLabel((row as unknown as { user_agent?: string | null }).user_agent),
    network,
    autoSaveAt: timeAgo(row.auto_saved_at),
    flags,
    paper: row.paper ?? [],
    score: row.score,
  };
}

/**
 * Live attempt roster for one exam (real DB rows + realtime refresh).
 * @param examId real exam id — an empty string yields an empty roster.
 * @param examName display name used in the UI rows.
 */
export default function useLiveAttempts(examId: string, examName: string = "") {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["liveAttempts", examId],
    queryFn: async () => {
      if (!examId) return [];
      const rows = await listLiveAttempts(examId);
      return rows.map((r) => toUIAttempt(r, examName));
    },
    enabled: !!examId,
    refetchInterval: 20000,
  });

  useEffect(() => {
    if (!examId) return;
    const unsub = subscribeToAttempts(examId, () => {
      void queryClient.invalidateQueries({ queryKey: ["liveAttempts", examId] });
    });
    return () => unsub();
  }, [examId, queryClient]);

  return query;
}
