import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listLiveAttempts, subscribeToAttempts, type LiveAttempt } from "../lib/examApi";
import type { Attempt, AttemptState, Network, Flag } from "../data/examSession";

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

function toUIAttempt(row: LiveAttempt, examName: string = "Data Structures & Algorithms"): Attempt {
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
    exam: examName, // We assume a single context or it's passed
    state: stateMap[row.state] || "Not started",
    answered: row.answered,
    total: row.total,
    startedAt: row.started_at ? new Date(row.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—",
    submittedAgo: row.state === "submitted" ? timeAgo(row.submitted_at) : "",
    minutesUsed: row.minutes_used,
    lastActivity: row.state === "submitted" 
      ? `Submitted ${new Date(row.submitted_at!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : row.auto_saved_at 
        ? `Active now` 
        : "Never signed in",
    device: "Chrome · Windows", // Hardcoded for now unless we capture UA
    network: "Stable", // Hardcoded for now 
    autoSaveAt: timeAgo(row.auto_saved_at),
    flags,
    paper: row.paper ?? [],
    score: row.score,
  };
}

export default function useLiveAttempts(examId: string, examName: string = "Data Structures & Algorithms") {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["liveAttempts", examId],
    queryFn: async () => {
      if (!examId) return [];
      const rows = await listLiveAttempts(examId);
      return rows.map((r) => toUIAttempt(r, examName));
    },
    enabled: !!examId,
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
