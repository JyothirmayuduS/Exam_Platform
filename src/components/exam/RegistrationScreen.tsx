// Registration Details — the step between device checks and "Ready to start?".
// Fields are pre-filled from the student's real record; every value is
// validated before the user can continue. Styled to match the platform's
// editorial theme (StartScreen / exam shells).
import { useState } from "react";

export type RegistrationInfo = {
  email: string;
  firstName: string;
  lastName: string;
  usn: string;
};

type Props = {
  examName: string;
  questionCount: number;
  sectionCount: number;
  durationMin: number;
  studentName: string;
  initial?: Partial<RegistrationInfo>;
  onBack: () => void;
  onDone: (info: RegistrationInfo) => void;
};

export default function RegistrationScreen({
  examName,
  questionCount,
  sectionCount,
  durationMin,
  studentName,
  initial,
  onBack,
  onDone,
}: Props) {
  const [form, setForm] = useState<RegistrationInfo>({
    email: initial?.email ?? "",
    firstName: initial?.firstName ?? "",
    lastName: initial?.lastName ?? "",
    usn: initial?.usn ?? "",
  });
  const [terms, setTerms] = useState(false);
  const set = <K extends keyof RegistrationInfo>(k: K, v: string) => setForm((c) => ({ ...c, [k]: v }));

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const valid = emailOk && form.firstName.trim().length > 0 && form.usn.trim().length > 0 && terms;

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
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Step 2 · Registration</span>
          </header>

          <div className="flex flex-col md:flex-row">
            {/* Left rail */}
            <div className="flex flex-col justify-between border-b border-line p-6 md:w-[42%] md:border-b-0 md:border-r md:p-8">
              <div>
                <p className="text-[13px] text-ink-soft">Hi {studentName || "Candidate"},</p>
                <p className="mt-4 text-[15px]">Welcome to</p>
                <h1 className="mt-1 font-serif text-2xl font-semibold leading-tight md:text-3xl">{examName || "Your exam"}</h1>
                <div className="mt-5 border-t border-line" />
                <div className="mt-5 grid grid-cols-3 gap-4">
                  <Stat label="Questions" value={`${questionCount}`} />
                  <Stat label="Sections" value={`${sectionCount}`} />
                  <Stat label="Duration" value={`${durationMin} min`} />
                </div>
              </div>
              <div className="mt-8"><Steps current={3} /></div>
            </div>

            {/* Registration form */}
            <div className="flex-1 px-6 py-7 md:px-8 md:py-8">
              <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Pre-exam · Step 2 of 3</p>
              <h2 className="mt-1 font-serif text-2xl font-semibold">Confirm your details</h2>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                These details identify your answer paper. Fields marked with <span className="font-semibold text-ink">*</span> are required.
              </p>

              <div className="mt-6 space-y-4">
                <Field label="Email Address" required value={form.email} onChange={(v) => set("email", v)} placeholder="Enter Email Address" type="email" error={form.email.length > 0 && !emailOk ? "Enter a valid email address" : undefined} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First Name" required value={form.firstName} onChange={(v) => set("firstName", v)} placeholder="Enter First Name" />
                  <Field label="Last Name" value={form.lastName} onChange={(v) => set("lastName", v)} placeholder="Enter Last Name" />
                </div>
                <Field label="University Seat Number (USN)" required value={form.usn} onChange={(v) => set("usn", v)} placeholder="Enter USN" mono />
              </div>

              <label className="mt-6 flex cursor-pointer items-start gap-3 border border-line bg-paper-raised p-4 text-[12.5px] leading-relaxed">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 h-4 w-4 accent-forest" />
                <span>
                  By continuing you agree to the Terms of Service, the{" "}
                  <span className="font-medium text-forest underline decoration-forest/40 underline-offset-2">security policy</span> and the{" "}
                  <span className="font-medium text-forest underline decoration-forest/40 underline-offset-2">privacy notice</span> of the examination.
                </span>
              </label>

              <div className="mt-7 flex items-center justify-between gap-3">
                <button onClick={onBack} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-ink hover:text-ink">
                  Back
                </button>
                <button
                  onClick={() => onDone(form)}
                  disabled={!valid}
                  className="border border-forest bg-forest px-8 py-3 text-[14px] font-medium text-paper transition hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-line/40 disabled:text-ink-soft"
                >
                  Submit
                </button>
              </div>
              {!valid && (
                <p className="mt-3 text-[11.5px] text-ink-soft">Complete the required fields and accept the terms to continue.</p>
              )}
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-paper-raised px-6 py-2.5 font-mono text-[10px] text-ink-soft">
            <span>Vignan OS · Secure Examination Platform</span>
            <span>Identity verified · Monitored assessment</span>
          </footer>
        </div>
      </div>
    </div>
  );
}

export function Steps({ current }: { current: number }) {
  const items = [
    { label: "Device check", done: current > 0 },
    { label: "Registration", done: current > 1 },
    { label: "Start", done: current > 2 },
  ];
  return (
    <div className="flex flex-col gap-2">
      {items.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2.5">
          <span
            className={`flex h-5 w-5 items-center justify-center border text-[10px] ${
              s.done
                ? "border-forest bg-forest text-paper"
                : i === current
                  ? "border-forest text-forest"
                  : "border-line-strong text-ink-soft"
            }`}
          >
            {s.done ? (
              <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-none stroke-current stroke-[1.8]"><path d="M1 4l2.5 2.5L9 1" /></svg>
            ) : (
              i + 1
            )}
          </span>
          <span className={`text-[11px] ${s.done || i === current ? "font-medium text-ink" : "text-ink-soft"}`}>{s.label}</span>
          {i < items.length - 1 && <span className="ml-1 h-3 w-px bg-line" />}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
      <p className="mt-1 font-serif text-[15px] font-semibold leading-tight">{value}</p>
    </div>
  );
}

function Field({
  label,
  required,
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
  error,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-ink">
        {label} {required && <span className="text-alert">*</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-forest ${mono ? "font-mono uppercase" : ""}`}
      />
      {error && <span className="mt-0.5 block text-[11px] text-alert">{error}</span>}
    </label>
  );
}
