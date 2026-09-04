import { useState } from "react";
import type { ExamRecord } from "../../lib/examApi";
import { publishExam } from "../../lib/examApi";
import { Button, PageHeading } from "../../pages/TeacherDashboard";

export default function ExamWizard({ notify, navigate, onCreate }: { notify: (s: string) => void; navigate: (s: string) => void; onCreate: (exam: ExamRecord) => void }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [enrollmentMode, setEnrollmentMode] = useState<"all" | "manual">("all");
  const [course, setCourse] = useState("");
  const [department, setDepartment] = useState("CSE");
  const [section, setSection] = useState("A");
  const batch = department + " \u2014 Sec " + section;
  const [date, setDate] = useState("");
  const [durationHours, setDurationHours] = useState(0);
  const [durationMinutes, setDurationMinutes] = useState(45);
  const totalDurationMinutes = (durationHours * 60) + durationMinutes;

  const handleCreate = async () => {
    setSaving(true);
    const id = "EXAM-2026-" + String(15 + Math.floor(Math.random() * 80)).padStart(3, "0");
    const examRecord: ExamRecord = {
      id,
      name: title || "Untitled exam",
      batch,
      mode: "lockdown",
      status: "draft",
      duration_minutes: totalDurationMinutes || 45,
      per_student: 0,
      pool_count: 0,
      total_marks: 0,
      scheduled_at: date ? new Date(date).toISOString() : null,
      join_link: "vignan-exam://open?exam=" + id,
      settings: { enrollmentMode },
    };
    const res = await publishExam(examRecord);
    if (res.ok) {
      onCreate(examRecord);
      notify("Exam saved as draft. Add questions and security settings from the Question Bank.");
      navigate("/teacher/questions?q=" + id);
    } else {
      notify("Failed to create exam: " + res.error);
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeading
        eyebrow="Exams / New exam"
        title="Create a new exam"
        detail="Set up exam details. Questions and security are configured from the Question Bank after saving."
        action={<Button onClick={() => navigate("/teacher/exams")}>&larr; Back to exams</Button>}
      />
      <div className="mt-8 grid gap-8 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          <button onClick={() => setStep(1)} className={"flex w-full items-center gap-3 px-3 py-3 text-left text-[13px] " + (step === 1 ? "border-l-2 border-forest bg-paper-raised font-medium text-forest" : "border-l-2 border-transparent text-ink-soft hover:text-ink")}>
            <span className="font-mono text-[10px]">01</span>Details
          </button>
          <button onClick={() => setStep(2)} className={"flex w-full items-center gap-3 px-3 py-3 text-left text-[13px] " + (step === 2 ? "border-l-2 border-forest bg-paper-raised font-medium text-forest" : "border-l-2 border-transparent text-ink-soft hover:text-ink")}>
            <span className="font-mono text-[10px]">02</span>Review
          </button>
          <div className="mt-6 border-t border-line pt-5 text-[12px] text-ink-soft">Questions and security are added after saving.</div>
        </div>
        <div className="border border-line bg-paper p-6 sm:p-8">
          {step === 1 && (
            <div>
              <h2 className="font-serif text-2xl font-semibold">Exam details</h2>
              <p className="mt-2 text-[13px] text-ink-soft">Give your exam a name and assign it to a batch.</p>
              <div className="mt-7">
                <label className="block text-[12px] text-ink-soft">Exam title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Data Structures Midterm" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                </label>
                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <label className="block text-[12px] text-ink-soft sm:col-span-2">Course Name
                    <input type="text" value={course} onChange={(e) => setCourse(e.target.value)} placeholder="e.g. Data Structures & Algorithms" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  </label>
                  <div>
                    <label className="block text-[12px] text-ink-soft">Department / Branch</label>
                    <div className="mt-1 flex gap-2">
                      <input type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="CSE" className="block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest"/>
                      <select value={["CSE","ECE","IT","EEE","MECH","CIVIL","AI & DS","MBA","MCA"].includes(department) ? department : "other"} onChange={(e) => { if (e.target.value !== "other") setDepartment(e.target.value); }} className="border border-line-strong bg-paper px-2 py-2 text-[12px] text-ink outline-none">
                        <option value="CSE">CSE</option><option value="ECE">ECE</option><option value="IT">IT</option><option value="EEE">EEE</option><option value="MECH">MECH</option><option value="CIVIL">CIVIL</option><option value="AI & DS">AI & DS</option><option value="MBA">MBA</option><option value="MCA">MCA</option><option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                  <label className="block text-[12px] text-ink-soft">Section
                    <input type="text" value={section} onChange={(e) => setSection(e.target.value)} placeholder="A" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest"/>
                  </label>
                  <label className="block text-[12px] text-ink-soft sm:col-span-2">Schedule date &amp; time
                    <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  </label>
                  <div className="sm:col-span-2">
                    <label className="block text-[12px] text-ink-soft">Exam duration</label>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1"><div className="relative flex items-center">
                        <input type="number" min="0" max="12" value={durationHours} onChange={(e) => setDurationHours(Math.max(0, Math.min(12, parseInt(e.target.value) || 0)))} className="block w-full border border-line-strong bg-paper px-3 py-2.5 pr-10 text-[13px] text-ink outline-none focus:border-forest" placeholder="0"/>
                        <span className="pointer-events-none absolute right-3 text-[11px] text-ink-soft">hrs</span></div></div>
                      <span className="font-mono text-ink-soft">:</span>
                      <div className="flex-1"><div className="relative flex items-center">
                        <input type="number" min="0" max="59" step="5" value={durationMinutes} onChange={(e) => setDurationMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))} className="block w-full border border-line-strong bg-paper px-3 py-2.5 pr-10 text-[13px] text-ink outline-none focus:border-forest" placeholder="45"/>
                        <span className="pointer-events-none absolute right-3 text-[11px] text-ink-soft">mins</span></div></div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-mono text-ink-soft">Quick:</span>
                      {[{l:"30m",h:0,m:30},{l:"45m",h:0,m:45},{l:"1h",h:1,m:0},{l:"1.5h",h:1,m:30},{l:"2h",h:2,m:0},{l:"3h",h:3,m:0}].map(p => <button key={p.l} type="button" onClick={() => { setDurationHours(p.h); setDurationMinutes(p.m); }} className={"px-2 py-0.5 text-[10px] font-mono border " + (durationHours === p.h && durationMinutes === p.m ? "border-forest bg-forest text-paper" : "border-line text-ink-soft hover:border-ink bg-paper")}>{p.l}</button>)}
                    </div>
                    <span className="mt-1.5 block text-[11px] font-medium text-forest">Total: {durationHours > 0 ? durationHours + " hr " : ""}{durationMinutes} min ({totalDurationMinutes}m)</span>
                  </div>
                </div>
              </div>
            </div>
          )}
          {step === 2 && (
            <div>
              <h2 className="font-serif text-2xl font-semibold">Review &amp; save</h2>
              <p className="mt-2 text-[13px] text-ink-soft">Confirm details. Questions and security are added from the Question Bank after saving.</p>
              <div className="mt-7 divide-y divide-line border border-line">
                {[
                  ["Exam title", title || "Untitled exam"],
                  ["Course & batch", (course || "\u2014") + " \u00b7 " + batch],
                  ["Schedule & Duration", (date ? new Date(date).toLocaleString() : "Not scheduled") + " \u00b7 " + (durationHours > 0 ? durationHours + " hr " : "") + durationMinutes + " mins (" + totalDurationMinutes + "m total)"],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{label}</span>
                    <span className="text-[13px] sm:text-right">{value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 border border-line bg-paper-raised p-4 text-[13px] text-ink-soft">
                <p><strong>Next steps after saving:</strong></p>
                <ul className="mt-2 list-disc pl-5 space-y-1">
                  <li>Add questions to this exam from the Question Bank</li>
                  <li>Configure security &amp; proctoring settings</li>
                  <li>Set the question pool and marking scheme</li>
                </ul>
              </div>
              <div className="mt-6 border border-line p-5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student Enrollment</p>
                <div className="mt-3 flex flex-col gap-2 text-[13px]">
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "all"} onChange={() => setEnrollmentMode("all")} className="accent-forest"/>
                    Enroll all students in the <strong>{batch}</strong> batch
                  </label>
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "manual"} onChange={() => setEnrollmentMode("manual")} className="accent-forest"/>
                    I will enroll specific students later
                  </label>
                </div>
              </div>
            </div>
          )}
          <div className="mt-8 flex flex-wrap justify-between gap-3 border-t border-line pt-5">
            <button onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1} className={"border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider " + (step === 1 ? "border-line text-ink-soft opacity-40 cursor-not-allowed" : "border-line-strong text-ink-soft hover:border-forest hover:text-ink")}>&larr; Previous</button>
            <div className="flex gap-2">
              {step < 2
                ? <button onClick={() => setStep(step + 1)} disabled={!title.trim()} className={"border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider " + (!title.trim() ? "border-forest bg-forest/60 text-paper cursor-not-allowed" : "border-forest bg-forest text-paper hover:bg-forest-light")}>Continue &rarr;</button>
                : <button onClick={handleCreate} disabled={saving} className={"border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider " + (saving ? "border-forest bg-forest/60 text-paper cursor-not-allowed" : "border-forest bg-forest text-paper hover:bg-forest-light")}>{saving ? "Saving..." : "Save exam"}</button>
              }
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
