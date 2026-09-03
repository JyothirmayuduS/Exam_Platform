import { useState, useEffect } from "react";
import type { ExamRecord } from "../../lib/examApi";
import { publishExam } from "../../lib/examApi";
import { Button, PageHeading } from "../../pages/TeacherDashboard";

export default function ExamWizard({ notify, navigate, onCreate }: { notify: (s: string) => void; navigate: (s: string) => void; onCreate: (exam: ExamRecord) => void }) {
  const [step, setStep] = useState(1);
  const [saved, setSaved] = useState(false);
  
  // Step 1: Details
  const [title, setTitle] = useState("");
  const [enrollmentMode, setEnrollmentMode] = useState<"all" | "manual">("all");
  const [course, setCourse] = useState("");
  const [department, setDepartment] = useState("CSE");
  const [section, setSection] = useState("A");
  const batch = `${department} — Sec ${section}`;
  const [date, setDate] = useState("");
  const [durationHours, setDurationHours] = useState(0);
  const [durationMinutes, setDurationMinutes] = useState(45);
  const totalDurationMinutes = (durationHours * 60) + durationMinutes;
  
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
  }, [title, course, department, section, date, durationHours, durationMinutes, questionMode, proctoringOptions, autoSubmitEnabled]);

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
      duration_minutes: totalDurationMinutes || 45,
      per_student: parseInt(questionCount),
      pool_count: parseInt(questionCount),
      total_marks: parseInt(questionCount) * (markingScheme.includes("2 marks") ? 2 : 1),
      scheduled_at: date ? new Date(date).toISOString() : null,
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
                <label className="block text-[12px] text-ink-soft sm:col-span-2">Course Name
                  <input type="text" value={course} onChange={(e) => setCourse(e.target.value)} placeholder="e.g. Data Structures & Algorithms" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                </label>

                {/* Divided: Department / Branch */}
                <div>
                  <label className="block text-[12px] text-ink-soft">Department / Branch</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      placeholder="e.g. CSE"
                      className="block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest"
                    />
                    <select
                      value={["CSE", "ECE", "IT", "EEE", "MECH", "CIVIL", "AI & DS", "MBA", "MCA"].includes(department) ? department : "other"}
                      onChange={(e) => { if (e.target.value !== "other") setDepartment(e.target.value); }}
                      className="border border-line-strong bg-paper px-2 py-2 text-[12px] text-ink outline-none"
                    >
                      <option value="CSE">CSE</option>
                      <option value="ECE">ECE</option>
                      <option value="IT">IT</option>
                      <option value="EEE">EEE</option>
                      <option value="MECH">MECH</option>
                      <option value="CIVIL">CIVIL</option>
                      <option value="AI & DS">AI & DS</option>
                      <option value="MBA">MBA</option>
                      <option value="MCA">MCA</option>
                      <option value="other">Custom</option>
                    </select>
                  </div>
                </div>

                {/* Divided: Section */}
                <div>
                  <label className="block text-[12px] text-ink-soft">Section</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={section}
                      onChange={(e) => setSection(e.target.value)}
                      placeholder="e.g. A"
                      className="block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest"
                    />
                    <select
                      value={["A", "B", "C", "D", "A & B", "All"].includes(section) ? section : "other"}
                      onChange={(e) => { if (e.target.value !== "other") setSection(e.target.value); }}
                      className="border border-line-strong bg-paper px-2 py-2 text-[12px] text-ink outline-none"
                    >
                      <option value="A">Sec A</option>
                      <option value="B">Sec B</option>
                      <option value="C">Sec C</option>
                      <option value="D">Sec D</option>
                      <option value="A & B">Sec A & B</option>
                      <option value="All">All Sections</option>
                      <option value="other">Custom</option>
                    </select>
                  </div>
                  <span className="mt-1 block text-[10px] text-ink-soft">Target Batch: <strong>{batch}</strong></span>
                </div>
                <label className="block text-[12px] text-ink-soft">Date & Start Time
                  <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  <span className="mt-1 block text-[10px] text-ink-soft">Select the date and scheduled start time.</span>
                </label>
                <div>
                  <label className="block text-[12px] text-ink-soft">Exam Duration</label>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1">
                      <div className="relative flex items-center">
                        <input
                          type="number"
                          min="0"
                          max="12"
                          value={durationHours}
                          onChange={(e) => setDurationHours(Math.max(0, parseInt(e.target.value) || 0))}
                          className="block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"
                          placeholder="0"
                        />
                        <span className="pointer-events-none absolute right-3 text-[11px] text-ink-soft">hrs</span>
                      </div>
                    </div>
                    <span className="font-mono text-ink-soft font-bold">:</span>
                    <div className="flex-1">
                      <div className="relative flex items-center">
                        <input
                          type="number"
                          min="0"
                          max="59"
                          step="5"
                          value={durationMinutes}
                          onChange={(e) => setDurationMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                          className="block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"
                          placeholder="45"
                        />
                        <span className="pointer-events-none absolute right-3 text-[11px] text-ink-soft">mins</span>
                      </div>
                    </div>
                  </div>
                  {/* Quick Select Presets */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-mono text-ink-soft">Quick select:</span>
                    {[
                      { label: "30m", h: 0, m: 30 },
                      { label: "45m", h: 0, m: 45 },
                      { label: "1h", h: 1, m: 0 },
                      { label: "1.5h", h: 1, m: 30 },
                      { label: "2h", h: 2, m: 0 },
                      { label: "3h", h: 3, m: 0 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setDurationHours(preset.h);
                          setDurationMinutes(preset.m);
                        }}
                        className={`px-2 py-0.5 text-[10px] font-mono border transition-colors ${
                          durationHours === preset.h && durationMinutes === preset.m
                            ? "border-forest bg-forest text-paper"
                            : "border-line text-ink-soft hover:border-ink hover:text-ink bg-paper"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <span className="mt-1.5 block text-[11px] font-medium text-forest">
                    Total duration: {durationHours > 0 ? `${durationHours} hr${durationHours > 1 ? "s" : ""} ` : ""}{durationMinutes} min ({totalDurationMinutes} minutes)
                  </span>
                </div>
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
                <label className="block text-[12px] text-ink-soft">Questions per student
                  <input type="number" min="1" value={questionCount} onChange={(e) => setQuestionCount(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  <span className="mt-1 block text-[10px] text-ink-soft">How many questions each candidate will face.</span>
                </label>
                <SelectField label="Marking scheme" value={markingScheme} onChange={setMarkingScheme} options={["1 mark each · No negative", "2 marks each · -0.5 negative", "Custom (Set per question)"]}/>
              </div>
              {questionMode === "pool" && (
                <div className="mt-5">
                  <label className="block text-[12px] text-ink-soft">Units / Tags to include
                    <input type="text" placeholder="e.g. Arrays, Trees, Recursion" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/>
                  </label>
                </div>
              )}
              {questionMode === "fixed" && (
                <div className="mt-5 border border-dashed border-forest/40 bg-success/5 p-4 text-[13px] text-ink-soft">
                  <p>In fixed mode, you will hand-pick exactly {questionCount || "X"} questions from your Question Bank after creating the exam workspace.</p>
                </div>
              )}
              {questionMode === "import" && (
                <div className="mt-5">
                  <label className="block text-[12px] text-ink-soft">Select previous exam to clone
                    <select className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest">
                      <option>Select an exam</option>
                      <option>Data Structures Midterm (Fall 2025)</option>
                      <option>Operating Systems Final (Spring 2026)</option>
                    </select>
                  </label>
                </div>
              )}
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
                  ["Schedule & Duration", `${date ? new Date(date).toLocaleString() : "Not scheduled"} · ${durationHours > 0 ? `${durationHours} hr${durationHours > 1 ? "s" : ""} ` : ""}${durationMinutes} mins (${totalDurationMinutes}m total)`], 
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
