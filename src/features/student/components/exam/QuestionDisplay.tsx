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
    <>
      <div className="exam-qh">
        <h2>Question {questionIndex} of {examId ? "N/A" : "N/A"}</h2>
        {showMarks && typeof question.marks === "number" && (
          <span className="exam-badge">
            {question.marks} {question.marks === 1 ? "mark" : "marks"}
          </span>
        )}
      </div>

      <p className="exam-qt">{question.text}</p>
      
      {/* MCQ options */}
      {question.options.length > 0 && (
        <>
          <p className="exam-hint exam-mute exam-sm">Select one answer.</p>
          <div>
            {question.options.map((opt, i) => {
              const selected = answer === i;
              return (
                <label
                  key={i}
                  className={`exam-opt ${selected ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name={`q-${question.id}`}
                    value={i}
                    checked={selected}
                    onChange={() => onSelectOption(i)}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
          {/* Keyboard hint for T/F */}
          {question.options.length === 2 && (
            <p className="exam-hint exam-mute exam-sm" style={{ textAlign: "center" }}>
              Tip: Press <kbd style={{ padding: "0 4px", border: "1px solid var(--line)", borderRadius: "4px" }}>Space</kbd> to toggle T/F
            </p>
          )}
        </>
      )}

      {/* Subjective — QR upload block / Answer box / Both */}
      {isSubjective && (
        <div className="mt-6 space-y-4">
          {typeof answer === "string" && answer.startsWith("[Uploaded answer:") ? (
            <div className="rounded-lg border border-success bg-[#E4F1E9] p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <p className="font-sans text-[12px] font-bold tracking-wider text-success">✓ Handwritten Answer Uploaded</p>
                <button 
                  onClick={() => onSelectOption("" as unknown as number)}
                  className="rounded-md border border-alert bg-white px-3 py-1.5 font-sans text-[11px] font-medium text-alert hover:bg-alert/10"
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
                  <label className="mb-2 block font-sans text-[12px] font-semibold text-soft">
                    {question.subjective_mode === "both" ? "Option 1: Type your answer" : "Type your answer"}
                  </label>
                  <textarea
                    className="exam-textarea"
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
                        <div className="w-full border-t border-line"></div>
                      </div>
                      <div className="relative flex justify-center">
                        <span className="bg-paper px-4 font-sans text-[11px] text-soft">
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
      <div className="exam-ft">
        <label>
          <input
            type="checkbox"
            checked={isReviewed}
            onChange={onToggleReview}
          />
          Mark for review
        </label>
        {onClear && (
          <button
            onClick={onClear}
            disabled={answer === undefined}
            className="exam-btn"
          >
            Clear response
          </button>
        )}
      </div>
    </>
  );
}
