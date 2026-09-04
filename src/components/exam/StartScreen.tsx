// Ready to start? — the Mettl-style pre-exam screen where the candidate picks
// the section they want to attempt first, then clicks Start Test. The section
// list comes from the student's real paper (grouped by type), so counts are
// always accurate.

import { useState } from "react";
import { Steps } from "./RegistrationScreen";

export type StartSection = { name: string; count: number };

type Props = {
  examName: string;
  questionCount: number;
  sectionCount: number;
  durationMin: number;
  studentName: string;
  sections: StartSection[];
  onStart: (sectionIndex: number) => void;
  onBack: () => void;
};

export default function StartScreen({
  examName,
  questionCount,
  sectionCount,
  durationMin,
  studentName,
  sections,
  onStart,
  onBack,
}: Props) {
  const [selected, setSelected] = useState(0);
  const safe = sections.length > 0 ? sections : [{ name: "All Questions", count: questionCount }];
  const sel = Math.min(selected, safe.length - 1);

  return (
    <div className="flex min-h-screen bg-[#0b1b3d] text-ink">
      <div className="mx-auto my-8 flex w-full max-w-5xl flex-col overflow-hidden rounded-md bg-paper shadow-2xl md:my-16">
        <header className="flex items-center justify-between bg-[#0b1b3d] px-6 py-4 text-paper">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white/60 font-serif text-[16px] font-bold">V</span>
            <div>
              <p className="text-[15px] font-bold leading-tight tracking-wide">VIGNAN&apos;S ONLINE</p>
              <p className="text-[9px] uppercase tracking-[0.3em] text-white/60">CDOE · Exam Platform</p>
            </div>
          </div>
          <span className="grid h-4 w-4 grid-cols-3 gap-0.5">
            {Array.from({ length: 9 }).map((_, i) => <span key={i} className="bg-white/70" />)}
          </span>
        </header>

        <div className="flex flex-col md:flex-row">
          <div className="flex flex-col justify-between border-b border-line p-8 md:w-[46%] md:border-b-0 md:border-r md:px-10 md:py-9">
            <div>
              <p className="text-[13px] text-ink-soft">Hi {studentName || "Candidate"},</p>
              <p className="mt-4 text-[15px]">Welcome to</p>
              <h1 className="mt-1 font-serif text-3xl font-bold leading-tight">{examName || "Your exam"}</h1>
              <div className="mt-5 border-t border-line" />
              <div className="mt-5 grid grid-cols-3 gap-4">
                <div><p className="text-[10px] text-ink-soft">Question count</p><p className="mt-1 text-[13px] font-bold">{questionCount} Questions</p></div>
                <div><p className="text-[10px] text-ink-soft">Section count</p><p className="mt-1 text-[13px] font-bold">{sectionCount} Sections</p></div>
                <div><p className="text-[10px] text-ink-soft">Test Duration</p><p className="mt-1 text-[13px] font-bold">{durationMin} Minutes</p></div>
              </div>
            </div>
            <Steps current={2} />
          </div>

          <div className="flex-1 px-8 py-9 md:px-10">
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-full border-[3px] border-[#1d4ed8]" />
              <h2 className="text-[18px] font-bold text-[#0b1b3d]">All done. Ready to start?</h2>
            </div>
            <p className="mt-2 text-[13px] text-ink-soft">
              Select the section you would like to attempt first, and then click on <span className="font-semibold text-ink">Start Test</span>.
            </p>

            <div className="mt-6 overflow-hidden rounded border border-gray-300">
              <div className="grid grid-cols-[1fr_1fr_1fr] bg-sky-50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-[#1d4ed8]">
                <span>Section name</span><span>No. of questions</span><span>Duration</span>
              </div>
              {safe.map((s, i) => (
                <button
                  key={s.name}
                  onClick={() => setSelected(i)}
                  className={`grid w-full grid-cols-[1fr_1fr_1fr] items-center border-t border-gray-200 px-4 py-3 text-left text-[13px] transition ${i === sel ? "bg-blue-50" : "bg-white hover:bg-gray-50"}`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <span className={`h-3.5 w-3.5 rounded-full border-2 ${i === sel ? "border-[#1d4ed8] bg-[#1d4ed8]" : "border-gray-400 bg-white"}`} />
                    {s.name}
                  </span>
                  <span>{s.count} Question{s.count === 1 ? "" : "s"}</span>
                  <span className="text-[12px] text-gray-500">Untimed*</span>
                </button>
              ))}
            </div>

            <p className="mt-3 text-[11.5px] leading-relaxed text-gray-500">
              * Untimed: these sections are without any specific time limit. You can answer them within the total assessment time limit.
            </p>
            <p className="mt-1 text-[11.5px] font-semibold text-gray-600">
              Total time of untimed sections = total time of test − time of timed sections.
            </p>

            <div className="mt-8 flex items-center justify-between gap-3">
              <button onClick={onBack} className="border border-gray-300 px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-[#0b1b3d] hover:text-ink">
                ← Back
              </button>
              <button
                onClick={() => onStart(sel)}
                className="rounded-md bg-[#1d4ed8] px-10 py-3 text-[15px] font-semibold text-white transition hover:bg-[#1e40af]"
              >
                Start Test
              </button>
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-gray-50 px-6 py-2.5 text-[10px] text-ink-soft">
          <span>Vignan Online Assessment © 2021–2031</span>
          <span>Need Help? Contact us (please add country code while dialing) · +91 80471-89190</span>
          <span>Terms of Services · Powered by Vignan Exam Platform</span>
        </footer>
      </div>
    </div>
  );
}