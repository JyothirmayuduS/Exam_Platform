import { useEffect, useMemo, useState } from "react";
import Seal from "../components/Seal";

type QStatus = "unvisited" | "visited" | "answered" | "marked";

type Question = {
  id: number;
  text: string;
  options: string[];
};

const QUESTIONS: Question[] = [
  {
    id: 1,
    text: "Which data structure underlies the call stack used for recursive function execution?",
    options: ["Queue", "Stack", "Linked List", "Hash Map"],
  },
  {
    id: 2,
    text: "In relational databases, which normal form eliminates transitive dependency on the primary key?",
    options: ["1NF", "2NF", "3NF", "BCNF"],
  },
  {
    id: 3,
    text: "What is the time complexity of binary search on a sorted array of n elements?",
    options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"],
  },
  {
    id: 4,
    text: "Which TCP flag is used to gracefully terminate a connection?",
    options: ["SYN", "ACK", "FIN", "RST"],
  },
  {
    id: 5,
    text: "In operating systems, which scheduling algorithm can cause starvation of low-priority processes?",
    options: ["Round Robin", "FCFS", "Priority Scheduling", "SJF (non-preemptive, fair queue)"],
  },
  {
    id: 6,
    text: "Which of these is NOT a property required for a valid B-tree of order m?",
    options: [
      "Every node has at most m children",
      "Every non-leaf node has at least ⌈m/2⌉ children",
      "All leaves appear at the same level",
      "Every node must be colored red or black",
    ],
  },
];

const CHECKS = [
  "Verifying browser environment",
  "Testing camera access",
  "Testing microphone access",
  "Measuring connection speed",
  "Scanning for restricted software",
];

export default function StudentExam() {
  const [step, setStep] = useState<"check" | "verify" | "rules" | "exam" | "submitted">("check");
  const [checkIndex, setCheckIndex] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [status, setStatus] = useState<Record<number, QStatus>>(
    Object.fromEntries(QUESTIONS.map((q) => [q.id, "unvisited"]))
  );
  const [secondsLeft, setSecondsLeft] = useState(45 * 60);

  // Simulated pre-flight checks
  useEffect(() => {
    if (step !== "check") return;
    if (checkIndex >= CHECKS.length) {
      const t = setTimeout(() => setStep("verify"), 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCheckIndex((i) => i + 1), 550);
    return () => clearTimeout(t);
  }, [step, checkIndex]);

  // Exam timer
  useEffect(() => {
    if (step !== "exam") return;
    if (secondsLeft <= 0) {
      setStep("submitted");
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, secondsLeft]);

  useEffect(() => {
    if (step === "exam") {
      setStatus((s) => (s[QUESTIONS[current].id] === "unvisited" ? { ...s, [QUESTIONS[current].id]: "visited" } : s));
    }
  }, [current, step]);

  const timeString = useMemo(() => {
    const m = Math.floor(secondsLeft / 60)
      .toString()
      .padStart(2, "0");
    const s = (secondsLeft % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }, [secondsLeft]);

  const q = QUESTIONS[current];
  const answeredCount = Object.values(status).filter((s) => s === "answered").length;
  const markedCount = Object.values(status).filter((s) => s === "marked").length;

  function selectOption(optIndex: number) {
    setAnswers((a) => ({ ...a, [q.id]: optIndex }));
    setStatus((s) => ({ ...s, [q.id]: "answered" }));
  }

  function markForReview() {
    setStatus((s) => ({ ...s, [q.id]: s[q.id] === "answered" ? "answered" : "marked" }));
    goNext();
  }

  function goNext() {
    if (current < QUESTIONS.length - 1) setCurrent((c) => c + 1);
  }

  function goTo(i: number) {
    setCurrent(i);
  }

  // ---------- Step: system check ----------
  if (step === "check") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 1 of 3</p>
          <h1 className="mb-8 font-serif text-2xl font-semibold">System readiness check</h1>
          <div className="space-y-3 border border-line bg-paper-raised p-5">
            {CHECKS.map((c, i) => (
              <div key={c} className="flex items-center justify-between text-[13.5px]">
                <span className={i <= checkIndex ? "text-ink" : "text-ink-soft"}>{c}</span>
                {i < checkIndex ? (
                  <span className="font-mono text-[11px] text-success">PASS</span>
                ) : i === checkIndex ? (
                  <span className="font-mono text-[11px] text-amber">CHECKING…</span>
                ) : (
                  <span className="font-mono text-[11px] text-ink-soft">—</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---------- Step: identity verification ----------
  if (step === "verify") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 2 of 3</p>
          <h1 className="mb-8 font-serif text-2xl font-semibold">Identity verified</h1>
          <div className="flex flex-col items-center gap-6 border border-line bg-paper-raised p-8">
            <Seal label="Verified" sublabel="Face match 98.4%" tone="forest" size={92} />
            <div className="w-full space-y-2 text-left font-mono text-[12px] text-ink-soft">
              <div className="flex justify-between border-b border-line pb-2">
                <span>Candidate</span>
                <span className="text-ink">B. Priya Nikitha</span>
              </div>
              <div className="flex justify-between border-b border-line pb-2">
                <span>Roll No.</span>
                <span className="text-ink">21VGN0142</span>
              </div>
              <div className="flex justify-between">
                <span>Room scan</span>
                <span className="text-success">Clear</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setStep("rules")}
            className="mt-8 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // ---------- Step: rules ----------
  if (step === "rules") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-lg">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Pre-exam · Step 3 of 3</p>
          <h1 className="mb-6 font-serif text-2xl font-semibold">Examination rules</h1>
          <div className="max-h-64 space-y-3 overflow-y-auto border border-line bg-paper-raised p-5 text-[13.5px] leading-relaxed text-ink-soft">
            <p>1. This window will lock into full-screen mode. Exiting full-screen more than twice will auto-submit your paper.</p>
            <p>2. Your webcam and microphone will record for the duration of the exam.</p>
            <p>3. Switching applications, using a second device, or unauthorized software will be flagged to the proctor.</p>
            <p>4. All answers are saved automatically as you attempt them.</p>
            <p>5. The exam auto-submits when the timer reaches zero.</p>
          </div>
          <label className="mt-5 flex items-start gap-3 text-[13px]">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-maroon"
            />
            <span>I have read and understood the rules above, and consent to audio/video monitoring for this exam.</span>
          </label>
          <button
            disabled={!agreed}
            onClick={() => setStep("exam")}
            className="mt-6 w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
          >
            Begin exam
          </button>
        </div>
      </div>
    );
  }

  // ---------- Step: submitted ----------
  if (step === "submitted") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <Seal label="Submitted" sublabel="Receipt recorded" tone="maroon" size={100} />
          <h1 className="mt-6 font-serif text-2xl font-semibold">Your exam has been submitted</h1>
          <p className="mt-2 text-[13.5px] text-ink-soft">
            {answeredCount} of {QUESTIONS.length} questions answered.
          </p>
          <div className="mt-6 border border-line bg-paper-raised p-4 text-left font-mono text-[11px] text-ink-soft">
            <div className="flex justify-between">
              <span>Submission hash</span>
              <span className="text-ink">7F3A-92CD-11EE</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Submitted at</span>
              <span className="text-ink">{new Date().toLocaleTimeString()}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Step: exam (kiosk mode) ----------
  return (
    <div className="flex h-screen flex-col bg-paper">
      <div className="flex items-center justify-between border-b border-line bg-paper px-6 py-3">
        <div>
          <p className="font-serif text-[15px] font-semibold">Data Structures &amp; Algorithms — Sem III</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Locked session · No exit</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse bg-alert" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Recording</span>
          </div>
          <div
            className={`tabular border px-3 py-1.5 font-mono text-[15px] font-medium ${
              secondsLeft < 300 ? "border-alert text-alert" : "border-ink text-ink"
            }`}
          >
            {timeString}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Question panel */}
        <div className="flex flex-1 flex-col overflow-y-auto px-10 py-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-maroon">
            Question {current + 1} of {QUESTIONS.length}
          </p>
          <h2 className="mt-3 max-w-2xl font-serif text-[19px] leading-snug text-ink">{q.text}</h2>

          <div className="mt-8 max-w-xl space-y-3">
            {q.options.map((opt, i) => {
              const selected = answers[q.id] === i;
              return (
                <button
                  key={i}
                  onClick={() => selectOption(i)}
                  className={`flex w-full items-center gap-3 border px-4 py-3 text-left text-[13.5px] transition-colors ${
                    selected
                      ? "border-maroon bg-maroon/[0.06] text-ink"
                      : "border-line text-ink hover:border-line-strong"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${
                      selected ? "border-maroon bg-maroon text-paper" : "border-line-strong text-ink-soft"
                    }`}
                  >
                    {String.fromCharCode(65 + i)}
                  </span>
                  {opt}
                </button>
              );
            })}
          </div>

          <div className="mt-10 flex max-w-xl items-center gap-3">
            <button
              onClick={markForReview}
              className="border border-line-strong px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink"
            >
              Mark for review &amp; next
            </button>
            <button
              onClick={goNext}
              disabled={current === QUESTIONS.length - 1}
              className="border border-ink bg-ink px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
            >
              Save &amp; next
            </button>
          </div>
        </div>

        {/* Palette sidebar */}
        <div className="flex w-72 shrink-0 flex-col border-l border-line bg-paper-raised px-5 py-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Question palette</p>
          <div className="mt-4 grid grid-cols-5 gap-2">
            {QUESTIONS.map((qq, i) => {
              const st = status[qq.id];
              const base = "flex h-9 w-9 items-center justify-center border font-mono text-[12px]";
              const styleMap: Record<QStatus, string> = {
                unvisited: "border-line text-ink-soft",
                visited: "border-line-strong text-ink",
                answered: "border-success bg-success text-paper",
                marked: "border-amber bg-amber text-paper",
              };
              return (
                <button
                  key={qq.id}
                  onClick={() => goTo(i)}
                  className={`${base} ${styleMap[st]} ${current === i ? "ring-1 ring-maroon" : ""}`}
                >
                  {qq.id}
                </button>
              );
            })}
          </div>

          <div className="mt-6 space-y-2 border-t border-line pt-4 font-mono text-[11px] text-ink-soft">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 border border-success bg-success" /> Answered ({answeredCount})
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 border border-amber bg-amber" /> Marked for review ({markedCount})
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 border border-line-strong" /> Visited, not answered
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 border border-line" /> Not visited
            </div>
          </div>

          <button
            onClick={() => setStep("submitted")}
            className="mt-auto border border-maroon bg-maroon py-3 font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-maroon-dark"
          >
            Submit exam
          </button>
        </div>
      </div>
    </div>
  );
}
