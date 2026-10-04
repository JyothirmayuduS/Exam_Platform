import { useState } from "react";
import RoleLayout from "@/shared/components/RoleLayout";
import { STUDENT_NAV, STUDENT_TONE } from "@/features/student/pages/StudentExams";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";

const FAQS: { q: string; a: string }[] = [
  {
    q: "What do I need before starting an exam?",
    a: "A working webcam and microphone, a stable internet connection, your ID card, and a quiet, well-lit room. The system check at the start of every exam confirms these automatically.",
  },
  {
    q: "The exam window locked my screen — is that normal?",
    a: "Yes. Lockdown exams run full-screen and block tab switching, copy/paste, and right-click. Leaving full-screen or switching apps is logged for your invigilator.",
  },
  {
    q: "My camera says 'Camera lost'. What should I do?",
    a: "Make sure no other app is using the camera, then allow camera access when prompted. If it persists, refresh — your answers are saved automatically and will restore.",
  },
  {
    q: "Can I use a calculator or rough work?",
    a: "Yes. During the exam, the Tools panel provides an on-screen calculator and a rough sheet. Neither is submitted with your answers.",
  },
  {
    q: "What happens if my internet drops mid-exam?",
    a: "Answers save as you work. Reconnect and re-enter from My exams — you resume with remaining time intact.",
  },
];

export default function StudentHelp() {
  const { profile } = useCurrentProfile();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone={STUDENT_TONE} items={STUDENT_NAV}>
      <section className="border border-line bg-paper px-5 py-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Support</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Help &amp; support</h1>
        <p className="mt-2 text-[13px] text-ink-soft">Common questions and how to reach the exam cell.</p>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="border border-line bg-paper divide-y divide-line">
          {FAQS.map((f, i) => (
            <div key={f.q}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-paper-raised"
              >
                <span className="text-[14px] font-medium">{f.q}</span>
                <span className="font-mono text-[14px] text-ink-soft">{open === i ? "−" : "+"}</span>
              </button>
              {open === i && (
                <p className="border-t border-line bg-paper-raised px-5 py-4 text-[13px] leading-relaxed text-ink-soft">
                  {f.a}
                </p>
              )}
            </div>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam cell</p>
            <p className="mt-3 text-[13px]">Reach the invigilation desk during exam hours.</p>
            <div className="mt-4 space-y-2 font-mono text-[12px] text-ink-soft">
              <p>examcell@vignan.edu</p>
              <p>+91 863 234 4700</p>
              <p>Mon–Sat · 9:00–17:00</p>
            </div>
          </div>
          <div className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">During a live exam</p>
            <p className="mt-3 text-[13px] text-ink-soft">
              Use the in-exam Raise hand control to alert your proctor without leaving the locked window.
            </p>
          </div>
        </aside>
      </div>
    </RoleLayout>
  );
}
