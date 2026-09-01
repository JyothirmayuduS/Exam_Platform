import { useEffect } from "react";

type UseKeyboardShortcutsOpts = {
  enabled: boolean;
  onPrev: () => void;
  onNext: () => void;
  onFirst: () => void;
  onLast: () => void;
  onToggleReview: () => void;
  onSave: () => void;
  onSubmit: () => void;
  onShowHelp: () => void;
  onToggleAnswer?: () => void; // Spacebar: toggle T/F or clear MCQ selection
};

function shouldIgnoreTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

export default function useKeyboardShortcuts({
  enabled,
  onPrev,
  onNext,
  onFirst,
  onLast,
  onToggleReview,
  onSave,
  onSubmit,
  onShowHelp,
  onToggleAnswer,
}: UseKeyboardShortcutsOpts) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreTarget(event.target)) return;

      if (event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSubmit();
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        onToggleReview();
        return;
      }

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          onPrev();
          break;
        case "ArrowDown":
          event.preventDefault();
          onNext();
          break;
        case "ArrowLeft":
          event.preventDefault();
          onFirst();
          break;
        case "ArrowRight":
          event.preventDefault();
          onLast();
          break;
        case " ":
          if (onToggleAnswer) {
            event.preventDefault();
            onToggleAnswer();
          }
          break;
        case "r":
        case "R":
          event.preventDefault();
          onToggleReview();
          break;
        case "?":
        case "/":
          event.preventDefault();
          onShowHelp();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onFirst, onLast, onNext, onPrev, onSave, onShowHelp, onSubmit, onToggleReview, onToggleAnswer]);
}
