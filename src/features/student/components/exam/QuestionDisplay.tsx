import SubjectiveQRBlock from "@/features/student/components/exam/SubjectiveQRBlock";
import { useEffect, useState } from "react";
import { getArtifactObjectUrl } from "@/shared/services/examStorage";

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
    if (ref.startsWith("blob:") || ref.startsWith("data:") || ref.startsWith("http")) {
      setUrl(ref);
      return;
    }
    let alive = true;
    void getArtifactObjectUrl(ref, 3600).then((signed) => {
      if (alive && signed) setUrl(signed);
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
  /** "msq" renders checkboxes, "numerical" a single number field. */
  kind?: string;
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
  /** Total questions in the paper — shown in the "Question X of Y" header. */
  totalQuestions?: number;
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
  totalQuestions,
  onSelectOption,
  onToggleReview,
  onClear,
  onAnswerUploaded,
}: QuestionDisplayProps) {
  if (!question) return null;

  const isMulti = question.kind === "msq";
  const isNumeric = question.kind === "numerical";
  const isSubjective = !isNumeric && (question.type === "subjective" || question.options.length === 0);
  const chosenSet = Array.isArray(answer) ? (answer as number[]) : [];
  const toggleMulti = (i: number) => {
    const next = chosenSet.includes(i) ? chosenSet.filter((x) => x !== i) : [...chosenSet, i].sort((a, b) => a - b);
    onSelectOption((next.length ? next : "") as unknown as number);
  };
  return (
    <>
      <div className="exam-qh">
        <h2>Question {questionIndex}{totalQuestions ? ` of ${totalQuestions}` : ""}</h2>
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
          <p className="exam-hint exam-mute exam-sm">{isMulti ? "Select all correct answers." : "Select one answer."}</p>
          <div>
            {question.options.map((opt, i) => {
              const selected = isMulti ? chosenSet.includes(i) : answer === i;
              return (
                <label
                  key={i}
                  className={`exam-opt ${selected ? "selected" : ""}`}
                >
                  <input
                    type={isMulti ? "checkbox" : "radio"}
                    name={`q-${question.id}`}
                    value={i}
                    checked={selected}
                    onChange={() => (isMulti ? toggleMulti(i) : onSelectOption(i))}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
          {/* Keyboard hint for T/F */}
          {!isMulti && question.options.length === 2 && (
            <p className="exam-hint exam-mute exam-sm" style={{ textAlign: "center" }}>
              Tip: Press <kbd style={{ padding: "0 4px", border: "1px solid var(--line)", borderRadius: "4px" }}>Space</kbd> to toggle T/F
            </p>
          )}
        </>
      )}

      {isNumeric && (
        <div style={{ marginTop: 16 }}>
          <p className="exam-hint exam-mute exam-sm">Enter a number.</p>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="exam-search"
            style={{ maxWidth: 240, fontFamily: "var(--mono, monospace)" }}
            placeholder="e.g. 42 or 3.14"
            value={typeof answer === "string" || typeof answer === "number" ? String(answer) : ""}
            onChange={(e) => onSelectOption(e.target.value as unknown as number)}
            aria-label="Numerical answer"
          />
        </div>
      )}

      {/* Subjective — QR upload block / Answer box / Both */}
      {isSubjective && (
        <div style={{ marginTop: 16 }}>
          {typeof answer === "string" && answer.startsWith("[Uploaded answer:") ? (
            <div className="exam-up" style={{ background: "var(--oks)", borderColor: "var(--ok)" }}>
              <div className="exam-uh">
                <span className="exam-sm" style={{ color: "var(--ok)", fontWeight: 600 }}>Handwritten answer uploaded</span>
                <button
                  onClick={() => {
                    // A used QR session can't take a second upload; the next
                    // QR panel mints a fresh token.
                    try { sessionStorage.removeItem(`mobile_upload_${attemptId}_${question.id}`); } catch { /* ignore */ }
                    onSelectOption("" as unknown as number);
                  }}
                  className="exam-btn"
                  style={{ color: "var(--bad)" }}
                >
                  Remove and retake
                </button>
              </div>
              <div style={{ padding: 12 }}>
              <UploadedAnswerView
                refPath={answer.replace("[Uploaded answer: ", "").replace("]", "").trim()}
                heightClass="h-[500px]"
              />
              </div>
            </div>
          ) : (
            <>
              {(!question.subjective_mode || question.subjective_mode === "both" || question.subjective_mode === "textbox") && (
                <div>
                  <p className="exam-hint exam-mute exam-sm">
                    {question.subjective_mode === "both" ? "Option 1: Type your answer" : "Type your answer"}
                  </p>
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
                    <p className="exam-hint exam-mute exam-sm" style={{ marginTop: 12 }}>
                      Option 2: Scan QR and upload a handwritten answer from your phone
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
                    currentAnswer={answer}
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
