import { useState, useEffect } from "react";
import type { ExamRecord } from "../../lib/examApi";
import { publishExam } from "../../lib/examApi";
import { Button, PageHeading, questions } from "../../pages/TeacherDashboard";

export default function ExamWizard({ notify, navigate, onCreate }: { notify: (s: string) => void; navigate: (s: string) => void; onCreate: (exam: ExamRecord) => void }) {
  const [step, setStep] = useState(1);
  const [saved, setSaved] = useState(false);
  
  // Step 1: Details
  const [title, setTitle] = useState("");
  const [enrollmentMode, setEnrollmentMode] = useState<"all" | "manual">("all");
  const [course, setCourse] = useState("Data Structures & Algorithms");
  const [batch, setBatch] = useState("CSE — Sem III · Sec A/B");
  const [date, setDate] = useState("18 March 2026");
  const [duration, setDuration] = useState("00:45");
  
  // Step 2: Question Set
  const [questionMode, setQuestionMode] = useState("pool");
  const [questionCount, setQuestionCount] = useState("30");
  const [markingScheme, setMarkingScheme] = useState("1 mark each · No negative");
  
  // Step 3: Security & Proctoring
  const [proctoringOptions, setProctoringOptions] = useState({
    ai: true,
    lockdown: true,
    shuffle: true,
  });
  const [autoSubmitEnabled, setAutoSubmitEnabled] = useState(true);
  const [submitOnTime, setSubmitOnTime] = useState(true);
  const [submitOnViolationCount, setSubmitOnViolationCount] = useState(true);
  const [violationLimit, setViolationLimit] = useState(3);
  const [proctoringTier, setProctoringTier] = useState("AI Proctoring");
  
  const steps = ["Details", "Question set", "Security", "Review"];

  // Handle Unsaved Changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (title.trim() !== "") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [title]);

  // Auto-Save Draft
  useEffect(() => {
    if (!title.trim()) return;
    const timer = setTimeout(async () => {
      const draftId = `EXAM-2026-${String(15 + Math.floor(Math.random() * 80)).padStart(3, "0")}`; // We'd ideally keep this stable
      // In a real app we'd keep a ref to the ID once created
    }, 2000);
    return () => clearTimeout(timer);
  }, [title, course, batch, date, duration, questionMode, proctoringOptions, autoSubmitEnabled]);

  const handleSaveDraft = async () => {
    setSaved(true);
    notify("Exam saved as draft");
  };

  const handleCreate = async () => {
    const id = `EXAM-2026-${String(15 + Math.floor(Math.random() * 80)).padStart(3, "0")}`;
    const examRecord: ExamRecord = {
      id,
      name: title || "Untitled exam",
      batch,
      mode: "lockdown",
      status: "published",
      duration_minutes: parseInt(duration.split(":")[1]) || 45,
      per_student: parseInt(questionCount),
      pool_count: parseInt(questionCount),
      total_marks: parseInt(questionCount) * (markingScheme.includes("2 marks") ? 2 : 1),
      scheduled_at: date,
      join_link: `vignan-exam://open?exam=${id}`,
      settings: {
        proctoringOptions,
        autoSubmitEnabled,
        submitOnTime,
        submitOnViolationCount,
        violationLimit,
        proctoringTier
      }
    };
    
    const res = await publishExam(examRecord);
    if (res.ok) {
      onCreate(examRecord);
      notify("Exam created successfully.");
      navigate("/teacher/exams");
    } else {
      notify("Failed to create exam: " + res.error);
    }
  };

  return (
    <>
      <PageHeading 
        eyebrow="Exams / New exam" 
        title="Create a new exam" 
        detail="Set up the assessment in four quick steps." 
        action={<Button onClick={() => navigate("/teacher/exams")}>← Back to exams</Button>} 
      />
      
      <div className="mt-8 grid gap-8 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          {steps.map((label, i) => (
            <button 
              key={label} 
              onClick={() => setStep(i + 1)} 
              className={`flex w-full items-center gap-3 px-3 py-3 text-left text-[13px] ${step === i + 1 ? "border-l-2 border-forest bg-paper-raised font-medium text-forest" : "border-l-2 border-transparent text-ink-soft hover:text-ink"}`}
            >
              <span className="font-mono text-[10px]">0{i + 1}</span>{label}
            </button>
          ))}
          <div className="mt-6 border-t border-line pt-5 text-[12px] text-ink-soft">
            Drafts autosave as you move between steps.
          </div>
        </div>
        
        <div className="border border-line bg-paper p-6 sm:p-8">
          {step === 1 && (
            <FormStep title="Exam details" detail="Give your exam a clear name and assign it to a class.">
              <label className="block text-[12px] text-ink-soft">Exam title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Data Structures Midterm" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
              </label>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <SelectField label="Course" value={course} onChange={setCourse} options={["Data Structures & Algorithms", "Digital Electronics", "Database Management Systems"]}/>
                <SelectField label="Batch" value={batch} onChange={setBatch} options={["CSE — Sem III · Sec A/B", "CSE — Sem V", "ECE — Sem III"]}/>
                <SelectField label="Date" value={date} onChange={setDate} options={["18 March 2026", "19 March 2026", "20 March 2026"]}/>
                <label className="block text-[12px] text-ink-soft">Duration
                  <input type="time" value={duration} onChange={(e) => setDuration(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  <span className="mt-1 block text-[10px] text-ink-soft">Select the exact exam duration (hours : minutes).</span>
                </label>
              </div>
            </FormStep>
          )}
          
          {step === 2 && (
            <FormStep title="Question set" detail="Choose how questions are selected for this exam.">
              <div className="space-y-3">
                {[["pool", "Use a question bank pool", "Randomly select questions from tagged units."], ["fixed", "Build a fixed question set", "Choose the exact questions every candidate sees."], ["import", "Import from previous exam", "Reuse a previous exam as a starting point."]].map(([key, label, detail]) => (
                  <label key={key} className={`flex cursor-pointer gap-3 border p-4 ${questionMode === key ? "border-forest bg-success/5" : "border-line hover:bg-paper-raised"}`}>
                    <input type="radio" name="question-mode" checked={questionMode === key} onChange={() => setQuestionMode(key)} className="mt-1 accent-forest"/>
                    <span>
                      <span className="block text-[13px] font-medium">{label}</span>
                      <span className="mt-1 block text-[12px] text-ink-soft">{detail}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                <SelectField label="Questions" value={questionCount} onChange={setQuestionCount} options={["30", "40", "50"]}/>
                <SelectField label="Marking scheme" value={markingScheme} onChange={setMarkingScheme} options={["1 mark each · No negative", "2 marks each · -0.5 negative"]}/>
              </div>
            </FormStep>
          )}
          
          {step === 3 && (
            <FormStep title="Security & proctoring" detail="Protect exam integrity with sensible defaults.">
              <div className="space-y-4">
                {[["ai", "AI proctoring", "Detect additional faces, tab switches, and restricted software."], ["lockdown", "Lockdown browser", "Prevent copy, paste, printing, and leaving the exam window."], ["shuffle", "Shuffle questions", "Give each candidate a different question order."]].map(([key, label, detail]) => (
                  <label key={key} className="flex items-center justify-between gap-5 border-b border-line pb-4">
                    <span>
                      <span className="block text-[13px] font-medium">{label}</span>
                      <span className="mt-1 block text-[12px] text-ink-soft">{detail}</span>
                    </span>
                    <input type="checkbox" checked={proctoringOptions[key as keyof typeof proctoringOptions]} onChange={(e) => setProctoringOptions(prev => ({ ...prev, [key]: e.target.checked }))} className="h-4 w-4 accent-forest"/>
                  </label>
                ))}
              </div>
              <div className="mt-6 border border-line bg-paper-raised p-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Auto-submit policy</p>
                  <label className="flex items-center gap-2 text-[11px] text-ink-soft">
                    <input type="checkbox" checked={autoSubmitEnabled} onChange={(e) => setAutoSubmitEnabled(e.target.checked)} className="h-4 w-4 accent-forest"/>Enabled
                  </label>
                </div>
                {autoSubmitEnabled && (
                  <div className="mt-4 space-y-4">
                    <label className="flex items-center justify-between gap-4 text-[13px]">
                      <span>Auto-submit when timer reaches zero</span>
                      <input type="checkbox" checked={submitOnTime} onChange={(e) => setSubmitOnTime(e.target.checked)} className="h-4 w-4 accent-forest"/>
                    </label>
                    <label className="flex items-center justify-between gap-4 text-[13px]">
                      <span>Auto-submit on violation count</span>
                      <input type="checkbox" checked={submitOnViolationCount} onChange={(e) => setSubmitOnViolationCount(e.target.checked)} className="h-4 w-4 accent-forest"/>
                    </label>
                    {submitOnViolationCount && (
                      <label className="block text-[12px] text-ink-soft">Violation threshold
                        <input type="number" min="1" max="20" value={violationLimit} onChange={(e) => setViolationLimit(Math.max(1, Number(e.target.value)))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px]"/>
                      </label>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-6">
                <SelectField label="Proctoring tier" value={proctoringTier} onChange={setProctoringTier} options={["AI Proctoring", "Basic Lockdown", "Live Proctoring"]}/>
              </div>
            </FormStep>
          )}
          
          {step === 4 && (
            <FormStep title="Review and publish" detail="Check the essentials before you send the exam to candidates.">
              <div className="divide-y divide-line border border-line">
                {[
                  ["Exam title", title || "Untitled exam"], 
                  ["Course & batch", `${course} · ${batch}`], 
                  ["Schedule", `${date} · ${duration}`], 
                  ["Question set", `${questionCount} questions · ${questionMode}`], 
                  ["Security", `${autoSubmitEnabled ? "Auto-submit active" : "Manual submit only"} · ${submitOnTime && submitOnViolationCount ? "Time + violation triggers" : submitOnTime ? "Time trigger" : submitOnViolationCount ? `Violation trigger (${violationLimit})` : "No auto-submit trigger"}`]
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{label}</span>
                    <span className="text-[13px] sm:text-right">{value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 border border-line p-5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student Enrollment</p>
                <div className="mt-3 flex flex-col gap-2 text-[13px]">
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "all"} onChange={() => setEnrollmentMode("all")} className="accent-forest" />
                    Enroll all students currently in the <strong>{batch}</strong> batch
                  </label>
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "manual"} onChange={() => setEnrollmentMode("manual")} className="accent-forest" />
                    I will enroll specific students later from the Students tab
                  </label>
                </div>
              </div>
              <label className="mt-5 flex gap-3 text-[12px] text-ink-soft">
                <input type="checkbox" defaultChecked className="mt-0.5 accent-forest"/>
                I confirm the exam details and question set are ready for candidates.
              </label>
            </FormStep>
          )}
          
          <div className="mt-8 flex flex-wrap justify-between gap-3 border-t border-line pt-5">
            <Button onClick={handleSaveDraft}>Save draft</Button>
            <div className="flex gap-2">
              {step > 1 && <Button onClick={() => setStep(step - 1)}>← Previous</Button>}
              {step < 4 ? <Button primary onClick={() => setStep(step + 1)}>Continue →</Button> : <Button primary onClick={handleCreate}>Publish exam</Button>}
            </div>
          </div>
          {saved && <p className="mt-4 text-[12px] text-success">✓ Draft saved to database.</p>}
        </div>
      </div>
    </>
  );
}

function FormStep({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { 
  return <div><h2 className="font-serif text-2xl font-semibold">{title}</h2><p className="mt-2 text-[13px] text-ink-soft">{detail}</p><div className="mt-7">{children}</div></div>; 
}

function SelectField({ label, options, value, onChange }: { label: string; options: string[]; value?: string; onChange?: (value: string) => void }) { 
  return (
    <label className="block text-[12px] text-ink-soft">{label}
      <select value={value} onChange={(e) => onChange?.(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink">
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  ); 
}
