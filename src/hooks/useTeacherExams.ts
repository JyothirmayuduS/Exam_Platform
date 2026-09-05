/**
 * useTeacherExams — the single source of "which exam am I working on" for the
 * teacher console (Submissions, Evaluate, Reports …).
 *
 * Every page used to default to a hardcoded demo id (EXAM-2026-014), which is
 * why real exams never appeared. Now pages share this scope and resolve the
 * active exam in a deterministic order:
 *
 *   1. `?examId=` / `?exam=` in the URL (deep links, proctor hand-off)
 *   2. the last exam the teacher selected on this browser (localStorage)
 *   3. the newest non-draft exam that already has live candidates/attempts
 *   4. the newest non-draft exam, else the newest exam at all
 *
 * Selection is persisted so switching exams on one page carries to the next.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  listExamsForTeacher,
  listProctoringStats,
  type ExamRecord,
} from "../lib/examApi";

export type ExamLiveStats = {
  candidates: number;
  active: number;
  submitted: number;
  paused: number;
  flagged: number;
};

export type ProctoringStatsMap = Record<string, ExamLiveStats>;

export const ACTIVE_EXAM_STORAGE_KEY = "vignan-teacher-active-exam";

export function activeExamIdFromStorage(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_EXAM_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistActiveExamId(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_EXAM_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — selection just won't persist */
  }
}

/** Pure resolver, exported for tests. */
export function resolveActiveExamId(
  exams: ExamRecord[],
  stats: ProctoringStatsMap,
  urlParam: string | null,
  stored: string | null,
): string | null {
  if (!exams.length) return null;
  const known = (id: string | null) => (id ? exams.some((e) => e.id === id) : false);

  if (known(urlParam)) return urlParam;
  if (known(stored)) return stored;

  // Prefer a real exam that already has candidates writing — that is what the
  // teacher opens the console to watch.
  const withActivity = exams
    .filter((e) => e.status !== "draft" && (stats[e.id]?.candidates ?? 0) > 0)
    .sort((a, b) => (stats[b.id]?.candidates ?? 0) - (stats[a.id]?.candidates ?? 0));
  if (withActivity.length) return withActivity[0].id;

  const nonDraft = exams.find((e) => e.status !== "draft");
  return nonDraft?.id ?? exams[0]?.id ?? null;
}

export type TeacherExamScope = {
  /** All exams visible to this teacher, newest first. */
  exams: ExamRecord[];
  /** True while the first load is in flight. */
  loading: boolean;
  /** Resolved active exam id (null only when there are no exams at all). */
  examId: string | null;
  /** The active ExamRecord, or null. */
  exam: ExamRecord | null;
  /** Switch the active exam (persists for the next page). */
  selectExam: (id: string) => void;
  /** Live roster stats per exam, for "which exam has activity" decisions. */
  stats: ProctoringStatsMap;
};

export default function useTeacherExams(): TeacherExamScope {
  const [searchParams] = useSearchParams();
  const urlParam = searchParams.get("examId") ?? searchParams.get("exam");

  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [stats, setStats] = useState<ProctoringStatsMap>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [examRows, statRows] = await Promise.all([
        listExamsForTeacher(),
        listProctoringStats(),
      ]);
      if (!active) return;
      setExams(examRows ?? []);
      setStats(statRows ?? {});
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Resolve the active exam once the roster is in. The resolver is stable in
  // its inputs, so this only needs to re-run when those inputs change.
  useEffect(() => {
    if (loading) return;
    if (selectedId && exams.some((e) => e.id === selectedId)) return;
    const resolved = resolveActiveExamId(
      exams,
      stats,
      urlParam,
      activeExamIdFromStorage(),
    );
    if (resolved) {
      setSelectedId(resolved);
      persistActiveExamId(resolved);
    }
  }, [loading, exams, stats, urlParam, selectedId]);

  const selectExam = useCallback((id: string) => {
    setSelectedId(id);
    persistActiveExamId(id);
  }, []);

  const exam = useMemo(
    () => exams.find((e) => e.id === selectedId) ?? null,
    [exams, selectedId],
  );

  return { exams, loading, examId: selectedId, exam, selectExam, stats };
}
