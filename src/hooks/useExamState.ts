import { useCallback, useMemo, useState } from "react";

export type QuestionStatus = "unvisited" | "visited" | "answered" | "marked";

export type ExamQuestionLike = {
  id: string;
};

function hasAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export default function useExamState(questions: ExamQuestionLike[]) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [markedForReview, setMarkedForReview] = useState<Set<string>>(new Set());
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [lastVisited, setLastVisited] = useState<string | null>(null);

  const total = questions.length;

  const markVisited = useCallback((questionId: string) => {
    setVisited((prev) => {
      if (prev.has(questionId)) return prev;
      const next = new Set(prev);
      next.add(questionId);
      return next;
    });
    setLastVisited(questionId);
  }, []);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= total) return;
      const q = questions[index];
      if (!q) return;
      setCurrentIndex(index);
      markVisited(q.id);
    },
    [markVisited, questions, total],
  );

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(total - 1, prev + 1));
  }, [total]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const goFirst = useCallback(() => {
    if (total > 0) goTo(0);
  }, [goTo, total]);

  const goLast = useCallback(() => {
    if (total > 0) goTo(total - 1);
  }, [goTo, total]);

  const goLastVisited = useCallback(() => {
    if (!lastVisited) return;
    const idx = questions.findIndex((q) => q.id === lastVisited);
    if (idx >= 0) goTo(idx);
  }, [goTo, lastVisited, questions]);

  const setAnswer = useCallback((questionId: string, answer: unknown) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
    markVisited(questionId);
  }, [markVisited]);

  const clearAnswer = useCallback((questionId: string) => {
    setAnswers((prev) => {
      if (!(questionId in prev)) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }, []);

  const toggleReview = useCallback((questionId: string) => {
    setMarkedForReview((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
    markVisited(questionId);
  }, [markVisited]);

  const isReviewed = useCallback((questionId: string) => markedForReview.has(questionId), [markedForReview]);

  const getQuestionStatus = useCallback((questionId: string): QuestionStatus => {
    if (markedForReview.has(questionId)) return "marked";
    if (hasAnswer(answers[questionId])) return "answered";
    if (visited.has(questionId)) return "visited";
    return "unvisited";
  }, [answers, markedForReview, visited]);

  const counts = useMemo(() => {
    let answered = 0;
    let marked = 0;
    let visitedCount = 0;

    for (const q of questions) {
      const status = getQuestionStatus(q.id);
      if (status === "answered") answered += 1;
      if (status === "marked") marked += 1;
      if (status === "visited" || status === "answered" || status === "marked") visitedCount += 1;
    }

    return {
      answered,
      marked,
      visited: visitedCount,
      remaining: Math.max(0, total - answered),
      drafted: Object.keys(answers).length,
    };
  }, [answers, getQuestionStatus, questions, total]);

  return {
    currentIndex,
    setCurrentIndex,
    answers,
    markedForReview,
    visited,
    lastVisited,
    total,
    markVisited,
    goTo,
    goNext,
    goPrev,
    goFirst,
    goLast,
    goLastVisited,
    setAnswer,
    clearAnswer,
    toggleReview,
    isReviewed,
    getQuestionStatus,
    counts,
  };
}
