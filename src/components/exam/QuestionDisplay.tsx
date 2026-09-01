import SubjectiveQRBlock from "./SubjectiveQRBlock";

type Question = {
  id: number;
  text: string;
  options: string[];
  category: string;
  type?: "mcq" | "subjective";
};

type QuestionDisplayProps = {
  question: Question | undefined;
  examId: string;
  studentId: string | null;
  answer: unknown;
  isReviewed: boolean;
  onSelectOption: (optionIndex: number) => void;
  onToggleReview: () => void;
};

export default function QuestionDisplay({
  question,
  examId,
  studentId,
  answer,
  isReviewed,
  onSelectOption,
  onToggleReview,
}: QuestionDisplayProps) {
  if (!question) return null;

  const isSubjective = question.type === "subjective" || question.options.length === 0;

  return (
    <section className="border border-line bg-paper-raised p-5 sm:p-7">
      {/* Category tag */}
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{question.category}</p>

      {/* Question text */}
      <h2 className="mt-2 font-serif text-[22px] leading-snug text-ink sm:text-[26px]">{question.text}</h2>

      {/* MCQ options */}
      {question.options.length > 0 && (
        <div className="mt-7 space-y-3">
          {question.options.map((opt, i) => {
            const selected = answer === i;
            return (
              <button
                key={i}
                onClick={() => onSelectOption(i)}
                className={`flex w-full items-center gap-3 border px-4 py-3 text-left text-[13.5px] transition-colors ${
                  selected
                    ? "border-maroon bg-maroon/[0.06] text-ink"
                    : "border-line text-ink hover:border-line-strong hover:bg-paper"
                }`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] transition-colors ${
                    selected
                      ? "border-maroon bg-maroon text-paper"
                      : "border-line-strong text-ink-soft"
                  }`}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                {opt}
              </button>
            );
          })}

          {/* Keyboard hint for T/F */}
          {question.options.length === 2 && (
            <p className="font-mono text-[9px] text-ink-soft mt-1">
              Tip: Press <kbd className="border border-line px-1 py-0.5 font-mono text-[9px]">Space</kbd> to toggle T/F
            </p>
          )}
        </div>
      )}

      {/* Subjective — QR upload block */}
      {isSubjective && (
        <SubjectiveQRBlock
          examId={examId}
          questionId={question.id}
          studentId={studentId}
          questionText={question.text}
        />
      )}

      {/* Mark for review */}
      <label className="mt-5 inline-flex cursor-pointer items-center gap-2 text-[13px] select-none">
        <input
          type="checkbox"
          checked={isReviewed}
          onChange={onToggleReview}
          className="h-4 w-4 accent-amber"
        />
        Mark for review
      </label>
    </section>
  );
}
