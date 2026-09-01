import { useState } from "react";
import RoleLayout from "../components/RoleLayout";
import { STUDENT_NAV } from "./StudentExams";

const FAQS: { q: string; a: string }[] = [
  { q: "What do I need before starting an exam?", a: "A working webcam and microphone, a stable internet connection, your ID card, and a quiet, well-lit room. The system check at the start of every exam confirms these automatically." },
  { q: "The exam window locked my screen — is that normal?", a: "Yes. Lockdown exams run in full-screen and disable tab switching, copy/paste and right-click. Leaving full-screen or switching apps is logged as a proctoring flag and shown to your invigilator." },
  { q: "My camera says 'Camera lost'. What should I do?", a: "Check that no other app is using the camera, then allow camera access when prompted. If it persists, refresh the exam page — your answers are saved automatically and will be restored." },
  { q: "Can I use a calculator or rough work?", a: "Yes. During the exam, the Tools panel on the right provides an on-screen calculator and a rough sheet for scratch work. Neither is submitted with your answers." },
  { q: "What happens if my internet drops mid-exam?", a: "Your answers are saved as you attempt them. Reconnect and re-enter the exam from My exams — you'll resume where you left off with the remaining time intact." },
];

export default function StudentHelp() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={STUDENT_NAV}>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Support</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Help &amp; support</h1>
        <p className="mt-2 text-[13px] text-ink-soft">Answers to common questions, plus how to reach the exam cell.</p>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_300px]">
        <div className="divide-y divide-line border border-line">
          {FAQS.map((f, i) => (
            <div key={f.q}>
              <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center justify-between gap-4 bg-paper-raised px-5 py-4 text-left hover:bg-paper">
                <span className="text-[14px] font-medium">{f.q}</span>
                <span className="font-mono text-[14px] text-ink-soft">{open === i ? "−" : "+"}</span>
              </button>
              {open === i && <p className="border-t border-line bg-paper px-5 py-4 text-[13px] leading-relaxed text-ink-soft">{f.a}</p>}
            </div>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="border border-line bg-paper-raised p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam cell</p>
            <p className="mt-3 text-[13px]">Reach the invigilation desk during exam hours.</p>
            <div className="mt-4 space-y-2 font-mono text-[12px] text-ink-soft">
              <p>examcell@vignan.edu</p>
              <p>+91 863 234 4700</p>
              <p>Mon–Sat · 9:00–17:00</p>
            </div>
          </div>
          <div className="border border-line p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">During a live exam</p>
            <p className="mt-3 text-[13px] text-ink-soft">Use the in-exam "Raise hand" control to alert your proctor without leaving the locked window.</p>
          </div>
        </aside>
      </div>
    </RoleLayout>
  );
}
