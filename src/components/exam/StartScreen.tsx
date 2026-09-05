// Ready to start? — the pre-exam screen where the candidate confirms identity,
// accepts the monitoring notice, and starts the test. Sections listed are real
// groupings of the student's own paper. The consent checkbox is required: it is
// persisted on the attempt row (consent_at) for audit.
import { useState } from "react";
import { Steps } from "./RegistrationScreen";

export type StartSection = { name: string; count: number };

type Props = {
  examName: string;
  questionCount: number;
  sectionCount: number;
  durationMin: number;
  studentName: string;
  studentRoll?: string;
  sections: StartSection[];
  consentGiven: boolean;
  onConsentChange: (value: boolean) => void;
  onStart: (sectionIndex: number) => void;
  onBack: () => void;
};

export default function StartScreen({
  examName,
  questionCount,
  sectionCount,
  durationMin,
  studentName,
  studentRoll,
  sections,
  consentGiven,
  onConsentChange,
  onStart,
  onBack,
}: Props) {
  const [selected, setSelected] = useState(0);
  const safe = sections.length > 0 ? sections : [{ name: "All Questions", count: questionCount }];
  const sel = Math.min(selected, safe.length - 1);

  return (
    <div className="min-h-screen bg-paper px-6 py-10 text-ink md:py-14">
      <div className="mx-auto w-full max-w-4xl">
        <div className="border border-line bg-paper shadow-sm">
          {/* Header */}
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper-raised px-6 py-4 md:px-8">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center border-2 border-ink font-serif text-[15px] font-bold">V</span>
              <div>
                <p className="text-[15px] font-semibold leading-tight tracking-wide">Vignan OS</p>
                <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-soft">CDOE · Exam Platform</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-forest" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-forest">Session verified</span>
            </div>
          </header>

          <div className="flex flex-col md:flex-row">
            {/* Left rail */}
            <div className="flex flex-col justify-between border-b border-line p-6 md:w-[42%] md:border-b-0 md:border-r md:p-8">
              <div>
                <p className="text-[13px] text-ink-soft">Hi {studentName || "Candidate"},</p>
                <p className="mt-4 text-[15px]">Welcome to</p>
                <h1 className="mt-1 font-serif text-2xl font-semibold leading-tight md:text-3xl">{examName || "Your exam"}</h1>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                  {studentRoll ? `${studentRoll} · ` : ""}{sectionCount} section{sectionCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="mt-8 grid grid-cols-3 gap-4 border-t border-line pt-6">
                <div><p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Questions</p><p className="mt-1 font-serif text-lg font-semibold">{questionCount}</p></div>
                <div><p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Sections</p><p className="mt-1 font-serif text-lg font-semibold">{sectionCount}</p></div>
                <div><p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Duration</p><p className="mt-1 font-serif text-lg font-semibold">{durationMin} min</p></div>
              </div>
              <div className="mt-8"><Steps current={2} /></div>
            </div>

            {/* Right panel */}
            <div className="flex-1 px-6 py-7 md:px-8 md:py-8">
              <p className="font-mono text-[10px] uppercase tracking-widest text-forest">All checks passed</p>
              <h2 className="mt-1 font-serif text-2xl font-semibold">Ready to start?</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                Select the section you would like to attempt first, then start the test. The full {durationMin}-minute timer
                runs once you begin and counts for the whole paper.
              </p>

              <div className="mt-5 overflow-hidden border border-line-strong">
                <div className="grid grid-cols-[1fr_90px] bg-paper-raised px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft md:grid-cols-[1fr_1fr_90px]">
                  <span>Section name</span><span className="hidden md:block">No. of questions</span><span className="text-right md:text-left">Duration</span>
                </div>
                {safe.map((s, i) => (
                  <button
                    key={s.name}
                    onClick={() => setSelected(i)}
                    className={`grid w-full grid-cols-[1fr_90px] items-center border-t border-line px-4 py-3 text-left text-[13px] transition md:grid-cols-[1fr_1fr_90px] ${i === sel ? "bg-forest/5" : "bg-paper hover:bg-paper-raised"}`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <span className={`h-3 w-3 rounded-full border ${i === sel ? "border-forest bg-forest" : "border-ink-soft"}`} />
                      {s.name}
                    </span>
                    <span className="hidden md:block">{s.count} question{s.count === 1 ? "" : "s"}</span>
                    <span className="text-right font-mono text-[11px] text-ink-soft md:text-left">In total</span>
                  </button>
                ))}
              </div>

              {/* Monitoring / recording consent */}
              <label className="mt-6 flex cursor-pointer items-start gap-3 border border-line bg-paper-raised p-4">
                <input
                  type="checkbox"
                  checked={consentGiven}
                  onChange={(e) => onConsentChange(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-forest"
                />
                <span className="text-[12.5px] leading-relaxed text-ink">
                  I confirm I am the registered candidate for this assessment and consent to{" "}
                  <span className="font-medium">continuous video, audio and screen monitoring</span> by the exam platform,
                  automated integrity analysis, and secure retention of recordings and snapshots by the examination
                  authority for audit and result-review purposes only.
                </span>
              </label>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <button onClick={onBack} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-ink hover:text-ink">
                  Back
                </button>
                <button
                  disabled={!consentGiven}
                  onClick={() => onStart(sel)}
                  className="border border-forest bg-forest px-10 py-3 text-[14px] font-medium text-paper transition hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-line/40 disabled:text-ink-soft"
                >
                  Start test
                </button>
              </div>
              {!consentGiven && (
                <p className="mt-3 text-[11.5px] text-ink-soft">You must accept the monitoring notice above before the test can begin.</p>
              )}
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-paper-raised px-6 py-2.5 font-mono text-[10px] text-ink-soft">
            <span>Vignan OS · Secure Examination Platform</span>
            <span>Monitored assessment · Camera · Mic · Screen</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
