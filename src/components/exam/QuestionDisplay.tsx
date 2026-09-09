import SubjectiveQRBlock from "./SubjectiveQRBlock";
import { useEffect, useState } from "react";
import { getSupabase } from "../../lib/supabase";

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
};

type QuestionDisplayProps = {
  question: Question | undefined;
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
    <section className="border border-line bg-raised p-5 sm:p-7">
      {/* Question text (category/unit removed — it duplicated the top label) */}
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
                    : "border-line text-ink hover:border-line hover:bg-paper"
                }`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] transition-colors ${
                    selected
                      ? "border-maroon bg-maroon text-paper"
                      : "border-line text-soft"
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
            <p className="font-mono text-[9px] text-soft mt-1">
              Tip: Press <kbd className="border border-line px-1 py-0.5 font-mono text-[9px]">Space</kbd> to toggle T/F
            </p>
          )}
        </div>
      )}

      {/* Subjective — QR upload block / Answer box / Both */}
      {isSubjective && (
        <div className="mt-6 space-y-4">
          {typeof answer === "string" && answer.startsWith("[Uploaded answer:") ? (
            <div className="border border-line bg-raised p-4">
              <div className="flex justify-between items-center mb-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-bold">✓ Handwritten Answer Uploaded</p>
                <button 
                  onClick={() => onSelectOption("" as unknown as number)}
                  className="border border-alert text-alert px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-alert/10"
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
                  <label className="block font-mono text-[10px] uppercase tracking-wider text-soft mb-1.5">
                    {question.subjective_mode === "both" ? "Option 1: Type your answer" : "Type your answer"}
                  </label>
                  <textarea
                    className="h-32 w-full border border-line bg-paper p-3 text-[14px] outline-none focus:border-forest"
                    placeholder="Type your response here..."
                    value={typeof answer === "string" ? answer : ""}
                    onChange={(e) => onSelectOption(e.target.value as unknown as number)}
                  />
                </div>
              )}

              {(!question.subjective_mode || question.subjective_mode === "both" || question.subjective_mode === "qr") && (
                <div>
                  {question.subjective_mode === "both" && (
                    <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-medium mt-3 mb-1">
                      Option 2: Scan QR &amp; upload handwritten answer from phone
                    </p>
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
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] select-none">
          <input
            type="checkbox"
            checked={isReviewed}
            onChange={onToggleReview}
            className="h-4 w-4 accent-amber"
          />
          Revisit later
        </label>
        {onClear && (
          <button
            onClick={onClear}
            disabled={answer === undefined}
            className={`flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition ${
              answer === undefined
                ? "cursor-not-allowed border-line text-soft/40"
                : "border-line text-soft hover:border-alert hover:text-alert"
            }`}
          >
            ⌫ Clear response
          </button>
        )}
      </div>
    </section>
  );
}
