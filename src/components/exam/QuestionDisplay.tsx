import { QRCodeSVG } from "qrcode.react";

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

  return (
    <section className="border border-line bg-paper-raised p-5 sm:p-7">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{question.category}</p>
      <h2 className="mt-2 font-serif text-[22px] leading-snug text-ink sm:text-[26px]">{question.text}</h2>

      <div className="mt-7 space-y-3">
        {question.options.map((opt, i) => {
          const selected = answer === i;
          return (
            <button
              key={i}
              onClick={() => onSelectOption(i)}
              className={`flex w-full items-center gap-3 border px-4 py-3 text-left text-[13.5px] transition-colors ${selected ? "border-maroon bg-maroon/[0.06] text-ink" : "border-line text-ink hover:border-line-strong"}`}
              aria-label={`Option ${String.fromCharCode(65 + i)}`}
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${selected ? "border-maroon bg-maroon text-paper" : "border-line-strong text-ink-soft"}`}>
                {String.fromCharCode(65 + i)}
              </span>
              {opt}
            </button>
          );
        })}

        {question.type === "subjective" && (
          <div className="flex flex-col items-center justify-center border border-dashed border-line-strong bg-paper p-8">
            <p className="mb-4 font-mono text-[12px] uppercase tracking-wider text-ink">Subjective Upload Required</p>
            <p className="mb-6 text-center text-[13px] text-ink-soft">Scan with mobile and upload answer sheet.</p>
            <div className="bg-white p-2">
              <QRCodeSVG value={`${window.location.origin}/mobile-upload?examId=${examId}&qId=${question.id}&student=${studentId ?? ""}`} size={180} />
            </div>
          </div>
        )}
      </div>

      <label className="mt-5 inline-flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={isReviewed} onChange={onToggleReview} className="h-4 w-4 accent-amber" />
        Mark for review
      </label>
    </section>
  );
}
