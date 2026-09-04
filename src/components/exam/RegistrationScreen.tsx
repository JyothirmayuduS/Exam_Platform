// Registration Details — the Mettl-style step between device checks and the
// "Ready to start?" screen. Fields are pre-filled from the student's real
// record when the session is resolvable (email link carries ?name=&roll=&email=
// if available); every value is validated before the user can continue.

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
          {/* Left: welcome + stats + step indicator */}
          <div className="flex flex-col justify-between border-b border-line p-8 md:w-[46%] md:border-b-0 md:border-r md:px-10 md:py-9">
            <div>
              <p className="text-[13px] text-ink-soft">Hi {studentName || "Candidate"},</p>
              <p className="mt-4 text-[15px]">Welcome to</p>
              <h1 className="mt-1 font-serif text-3xl font-bold leading-tight">{examName || "Your exam"}</h1>
              <div className="mt-5 border-t border-line" />
              <div className="mt-5 grid grid-cols-3 gap-4">
                <Stat label="Question count" value={`${questionCount} Question${questionCount === 1 ? "" : "s"}`} />
                <Stat label="Section count" value={`${sectionCount} Section${sectionCount === 1 ? "" : "s"}`} />
                <Stat label="Test Duration" value={`${durationMin} Minutes`} />
              </div>
            </div>
            <Steps current={3} />
          </div>

          {/* Right: registration form */}
          <div className="flex-1 px-8 py-9 md:px-10">
            <div className="flex items-start gap-2 border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
              <span className="mt-0.5">ⓘ</span>
              <span>Fields marked with <span className="font-bold">*</span> are mandatory</span>
            </div>
            <h2 className="mt-5 border-b-2 border-[#0b1b3d] pb-2 text-[17px] font-bold">Registration Details</h2>

            <div className="mt-5 space-y-4">
              <Field label="Email Address" required value={form.email} onChange={(v) => set("email", v)} placeholder="Enter Email Address" type="email" error={form.email.length > 0 && !emailOk ? "Enter a valid email address" : undefined} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First Name" required value={form.firstName} onChange={(v) => set("firstName", v)} placeholder="Enter First Name" />
                <Field label="Last Name" value={form.lastName} onChange={(v) => set("lastName", v)} placeholder="Enter Last Name" />
              </div>
              <Field label="University Seat Number (USN)" required value={form.usn} onChange={(v) => set("usn", v)} placeholder="Enter University Seat Number (USN)" mono />
            </div>

            <label className="mt-6 flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-relaxed text-ink">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0b1b3d]" />
              <span>
                By using our offerings and services, you are agreeing to the Terms of Services and License Agreement, the
                <span className="font-semibold text-[#0b1b3d] underline"> security policy</span> and the
                <span className="font-semibold text-[#0b1b3d] underline"> privacy notice</span> of the examination.
              </span>
            </label>

            <div className="mt-7 flex items-center justify-between gap-3">
              <button onClick={onBack} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-[#0b1b3d] hover:text-ink">
                ← Back
              </button>
              <button
                onClick={() => onDone(form)}
                disabled={!valid}
                className={`rounded-md px-8 py-3 text-[14px] font-semibold text-white transition ${valid ? "bg-[#1d4ed8] hover:bg-[#1e40af]" : "cursor-not-allowed bg-slate-300"}`}
              >
                Submit
              </button>
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-gray-50 px-6 py-2.5 text-[10px] text-ink-soft">
          <span>Vignan Online Assessment © 2021–2031</span>
          <span className="flex items-center gap-1">Need Help? Contact us (please add country code while dialing) · +91 80471-89190</span>
          <span>Terms of Services · Powered by Vignan Exam Platform</span>
        </footer>
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
    <div className="mt-8 flex flex-col gap-2">
      {items.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${s.done ? "border-[#1d4ed8] bg-[#1d4ed8] text-white" : i === current ? "border-[#1d4ed8] bg-white text-[#1d4ed8]" : "border-gray-300 bg-white text-gray-400"}`}>
            {s.done ? "✓" : i + 1}
          </span>
          <span className={`text-[11px] ${s.done || i === current ? "font-medium text-ink" : "text-gray-400"}`}>{s.label}</span>
          {i < items.length - 1 && <span className="ml-1 h-3 w-px bg-gray-300" />}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-ink-soft">{label}</p>
      <p className="mt-1 text-[13px] font-bold leading-tight text-ink">{value}</p>
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
        {label} {required && <span className="text-red-600">*</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 block w-full rounded border border-gray-300 bg-white px-3 py-2.5 text-[13px] outline-none focus:border-[#1d4ed8] ${mono ? "font-mono uppercase" : ""}`}
      />
      {error && <span className="mt-0.5 block text-[11px] text-red-600">{error}</span>}
    </label>
  );
}