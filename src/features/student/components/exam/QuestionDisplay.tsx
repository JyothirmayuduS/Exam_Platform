import SubjectiveQRBlock from "@/features/student/components/exam/SubjectiveQRBlock";
import { useEffect, useState } from "react";
import { getSupabase } from "@/shared/data/supabase";

/** Resolve a stored upload reference to a displayable URL.
 *
 *  The answer store keeps the STORAGE PATH ("…/subjective/q3_….pdf") — never
 *  a signed URL, which expires after an hour and made uploaded answers
 *  vanish on revisit. blob: URLs (dev uploads) pass straight through.
 */
function useUploadUrl(ref: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ref) { setUrl(null); return; }
    if (ref.startsWith("blob:") || ref.startsWith("data:")) { setUrl(ref); return; }
    if (ref.startsWith("http")) { setUrl(ref); return; }
    const db = getSupabase();
    if (!db) { setUrl(null); return; }
    let alive = true;
    void db.storage.from("exam-records").createSignedUrl(ref, 3600).then(({ data }: { data: { signedUrl?: string } | null }) => {
      if (alive && data?.signedUrl) setUrl(data.signedUrl);
    });
    return () => { alive = false; };
  }, [ref]);
  return url;
}

type Question = {
  id: string;
  text: string;
  options: string[];
  category: string;
  type?: "mcq" | "subjective";
  subjective_mode?: "both" | "qr" | "textbox" | null;
  marks?: number;
};

type QuestionDisplayProps = {
  question: Question | undefined;
  showMarks?: boolean;
  examId: string;
  attemptId?: string;
  studentId: string | null;
  answer: unknown;
  isReviewed: boolean;
  examName: string;
  studentName: string;
  questionIndex: number;
  onSelectOption: (optionIndex: number) => void;
  onToggleReview: () => void;
  onClear?: () => void;
  /** Fired when a subjective answer upload completes (QR from phone or direct).
   *  Carries the STORAGE PATH of the upload (dev: a blob: URL). The exam page
   *  uses it to cross-check the AI's phone-visibility record. */
  onAnswerUploaded?: (pathOrUrl: string) => void;
};

/** A stored subjective upload: renders PDFs in an <iframe> (browsers cannot
 *  render PDF bytes inside an <img>) and images in an <img>. */
function UploadedAnswerView({ refPath, heightClass }: { refPath: string; heightClass: string }) {
  const url = useUploadUrl(refPath);
  // Legacy signed URLs embed ".pdf?token=…", so test the whole reference —
  // anything that mentions .pdf renders as a PDF, everything else as an image.
  const isImage = !refPath.toLowerCase().includes(".pdf");
  if (!url) {
    return (
      <div className={`${heightClass} flex items-center justify-center border border-line bg-ink`}>
        <span className="animate-pulse font-mono text-[10px] uppercase tracking-widest text-paper/60">Loading answer…</span>
      </div>
    );
  }
  return isImage ? (
    <img src={url} alt="Uploaded answer" className={`w-full border border-line bg-ink object-contain ${heightClass}`} />
  ) : (
    <iframe src={`${url}#toolbar=0`} className={`w-full border border-line bg-ink ${heightClass}`} title="Uploaded Answer" />
  );
}

export default function QuestionDisplay({
  question,
  showMarks,
  examId,
  attemptId,
  studentId,
  answer,
  isReviewed,
  examName,
  studentName,
  questionIndex,
  onSelectOption,
  onToggleReview,
  onClear,
  onAnswerUploaded,
}: QuestionDisplayProps) {
  if (!question) return null;

  const isSubjective = question.type === "subjective" || question.options.length === 0;

  return (
    <section className="rounded-2xl border border-line/40 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex items-start justify-between gap-4">
        {/* Question text */}
        <h2 className="mt-2 font-serif text-2xl leading-relaxed text-slate-800 sm:text-3xl">{question.text}</h2>
        {showMarks && typeof question.marks === "number" && (
          <span className="mt-3 shrink-0 whitespace-nowrap rounded-full border border-line/50 bg-slate-50 px-3 py-1 font-sans text-xs font-semibold uppercase tracking-wider text-slate-500">
            {question.marks} {question.marks === 1 ? "mark" : "marks"}
          </span>
        )}
      </div>

      {/* MCQ options */}
      {question.options.length > 0 && (
        <div className="mt-8 space-y-3">
          {question.options.map((opt, i) => {
            const selected = answer === i;
            return (
              <button
                key={i}
                onClick={() => onSelectOption(i)}
                className={`flex w-full items-center gap-4 rounded-xl border p-4 text-left text-sm transition-all duration-200 ${
                  selected
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900 shadow-sm ring-1 ring-emerald-500"
                    : "border-line/60 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                }`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-sans text-xs font-bold transition-colors ${
                    selected
                      ? "bg-emerald-500 text-white"
                      : "bg-slate-100 text-slate-500"
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
            <p className="mt-2 text-center font-sans text-xs text-slate-400">
              Tip: Press <kbd className="rounded border border-line/40 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] shadow-sm">Space</kbd> to toggle T/F
            </p>
          )}
        </div>
      )}

      {/* Subjective — QR upload block / Answer box / Both */}
      {isSubjective && (
        <div className="mt-6 space-y-4">
          {typeof answer === "string" && answer.startsWith("[Uploaded answer:") ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/50 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <p className="font-sans text-xs font-bold uppercase tracking-wider text-emerald-700">✓ Handwritten Answer Uploaded</p>
                <button 
                  onClick={() => onSelectOption("" as unknown as number)}
                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 font-sans text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
                >
                  Remove & Retake
                </button>
              </div>
              <UploadedAnswerView
                refPath={answer.replace("[Uploaded answer: ", "").replace("]", "").trim()}
                heightClass="h-[500px]"
              />
            </div>
          ) : (
            <>
              {(!question.subjective_mode || question.subjective_mode === "both" || question.subjective_mode === "textbox") && (
                <div>
                  <label className="mb-2 block font-sans text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {question.subjective_mode === "both" ? "Option 1: Type your answer" : "Type your answer"}
                  </label>
                  <textarea
                    className="h-40 w-full rounded-xl border border-line/60 bg-white p-4 text-sm text-slate-700 outline-none transition-all focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                    placeholder="Type your response here..."
                    value={typeof answer === "string" ? answer : ""}
                    onChange={(e) => onSelectOption(e.target.value as unknown as number)}
                  />
                </div>
              )}

              {(!question.subjective_mode || question.subjective_mode === "both" || question.subjective_mode === "qr") && (
                <div>
                  {question.subjective_mode === "both" && (
                    <div className="relative py-6">
                      <div className="absolute inset-0 flex items-center" aria-hidden="true">
                        <div className="w-full border-t border-line/40"></div>
                      </div>
                      <div className="relative flex justify-center">
                        <span className="bg-white px-4 font-sans text-xs font-semibold uppercase tracking-wider text-slate-400">
                          Option 2: Scan QR &amp; upload handwritten answer from phone
                        </span>
                      </div>
                    </div>
                  )}
                  <SubjectiveQRBlock
                    key={`qr_${question.id}_${attemptId ?? "init"}`}
                    examId={examId}
                    attemptId={attemptId}
                    questionId={question.id}
                    questionIndex={questionIndex}
                    studentId={studentId}
                    studentName={studentName}
                    examName={examName}
                    questionText={question.text}
                    onAnswerUploaded={(url) => {
                      onSelectOption(`[Uploaded answer: ${url}]` as unknown as number);
                      onAnswerUploaded?.(url);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Revisit later / clear response */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-line/30 pt-6">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600 select-none hover:text-slate-900">
          <input
            type="checkbox"
            checked={isReviewed}
            onChange={onToggleReview}
            className="h-4 w-4 rounded border-slate-300 text-amber-500 focus:ring-amber-500"
          />
          Mark to revisit later
        </label>
        {onClear && (
          <button
            onClick={onClear}
            disabled={answer === undefined}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider transition-colors ${
              answer === undefined
                ? "cursor-not-allowed bg-slate-50 text-slate-300"
                : "bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700"
            }`}
          >
            ⌫ Clear response
          </button>
        )}
      </div>
    </section>
  );
}
