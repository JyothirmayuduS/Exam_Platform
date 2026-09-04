// Create new test — Mettl-style creation dialog in the Vignan theme.
// Test name / language / purpose / timed-vs-deadline are collected up front,
// then a draft exam row is persisted and the caller opens the paper builder.

import { useEffect, useState } from "react";
import { getSupabase } from "../../lib/supabase";
import { publishExam, type ExamRecord } from "../../lib/examApi";

const PURPOSES = ["Academic exam", "Campus placement", "Skill / certification", "Mock test", "Other"];

export default function CreateTestModal({
  onClose,
  onCreate,
  notify,
}: {
  onClose: () => void;
  onCreate: (exam: ExamRecord) => void;
  notify: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("English");
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [assessmentType, setAssessmentType] = useState<"timed" | "deadline">("timed");
  const [duration, setDuration] = useState(45);
  const [deadline, setDeadline] = useState("");
  const [batch, setBatch] = useState("");
  const [batches, setBatches] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const db = getSupabase();
    if (!db) return;
    void db
      .from("students")
      .select("batch")
      .then((res: { data?: { batch?: string | null }[] | null }) => {
        if (!active || !res.data) return;
        const seen = new Set<string>();
        for (const r of res.data) if (r.batch) seen.add(r.batch);
        setBatches(Array.from(seen).sort());
      });
    return () => { active = false; };
  }, []);

  const canProceed = name.trim().length > 0 && batch.trim().length > 0 && (assessmentType === "timed" || deadline !== "");

  const proceed = async () => {
    if (!canProceed || saving) return;
    setSaving(true);
    setError("");
    const db = getSupabase();
    if (!db) { setError("Database not connected — configure Supabase first."); setSaving(false); return; }
    const id = "EXAM-2026-" + String(15 + Math.floor(Math.random() * 80)).padStart(3, "0");
    const record: ExamRecord = {
      id,
      name: name.trim(),
      batch: batch.trim(),
      mode: "lockdown",
      status: "draft",
      duration_minutes: assessmentType === "timed" ? duration : 0,
      per_student: 5,
      pool_count: 0,
      total_marks: 0,
      scheduled_at: assessmentType === "deadline" && deadline ? new Date(deadline).toISOString() : null,
      join_link: `https://vignan.exam/join/${id.toLowerCase()}`,
      settings: {
        language,
        purpose,
        assessmentType,
        perStudent: 5,
        randomSelect: true,
        shuffleOrder: true,
        shuffleOptions: true,
        autoSubmit: true,
        mode: "lockdown",
        attempts: 1,
        negative: false,
        calculator: false,
        instantFeedback: false,
        photoId: false,
        violationLimit: 3,
        violationAction: "submit",
        releaseDate: "",
        ipWhitelist: "",
        sections: false,
        sectionTiming: false,
        autoClose: assessmentType === "deadline",
        durationLock: true,
        deadline: assessmentType === "deadline" && deadline ? deadline : "",
        showReportToTaker: false,
        commentsMandatory: false,
        skipFeedback: false,
        redirectAfter: "",
        watermarkText: "",
        fixedSectionOrder: false,
        scratchpad: false,
        allowQrUpload: false,
        showMarksInTest: true,
        regEmail: true,
        regName: true,
        regUsn: true,
        regTerms: true,
      },
    };
    const res = await publishExam(record);
    setSaving(false);
    if (!res.ok) { setError("Could not save the test: " + res.error); return; }
    notify(`Test "${record.name}" created — add questions to the paper.`);
    onCreate(record);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/50 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Create new test">
      <div className="w-full max-w-lg border border-line-strong bg-paper shadow-2xl">
        {/* Modal header */}
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <h2 className="font-serif text-2xl font-semibold">Create new test</h2>
            <p className="mt-1 text-[12px] text-ink-soft">Set up the paper. Questions, settings and candidates come next.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-ink-soft transition hover:text-ink">×</button>
        </div>

        {/* Body */}
        <div className="space-y-6 px-6 py-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Test Name</span><span className="text-alert"> *</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Structures Midterm" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-soft/60 focus:border-forest" />
            </label>
            <label className="block text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Test Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest">
                <option>English</option><option>Hindi</option><option>Telugu</option><option>Bilingual</option>
              </select>
            </label>
          </div>

          <label className="block text-[12px] text-ink-soft">
            <span className="font-medium text-ink">Purpose of the test is</span>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest">
              {PURPOSES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>

          <fieldset>
            <legend className="text-[12px] text-ink-soft"><span className="font-medium text-ink">Assessment type</span></legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setAssessmentType("timed")} className={`flex items-start gap-3 border p-4 text-left transition ${assessmentType === "timed" ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}>
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${assessmentType === "timed" ? "border-forest" : "border-line-strong"}`}>{assessmentType === "timed" && <span className="h-2 w-2 rounded-full bg-forest" />}</span>
                <span>
                  <span className="block text-[13px] font-medium">Timed Assessment</span>
                  <span className="mt-1 block text-[11px] text-ink-soft">Candidates get a fixed window; auto-submit at 00:00.</span>
                </span>
              </button>
              <button type="button" onClick={() => setAssessmentType("deadline")} className={`flex items-start gap-3 border p-4 text-left transition ${assessmentType === "deadline" ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}>
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${assessmentType === "deadline" ? "border-forest" : "border-line-strong"}`}>{assessmentType === "deadline" && <span className="h-2 w-2 rounded-full bg-forest" />}</span>
                <span>
                  <span className="block text-[13px] font-medium">Deadline Based Assessment</span>
                  <span className="mt-1 block text-[11px] text-ink-soft">Opens immediately, closes at a fixed date &amp; time.</span>
                </span>
              </button>
            </div>
          </fieldset>

          {assessmentType === "timed" ? (
            <label className="block text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Duration (minutes)</span>
              <input type="number" min={5} max={300} step={5} value={duration} onChange={(e) => setDuration(Math.max(5, Math.min(300, Number(e.target.value) || 45)))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest" />
            </label>
          ) : (
            <label className="block text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Deadline date &amp; time</span>
              <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest" />
            </label>
          )}

          <label className="block text-[12px] text-ink-soft">
            <span className="font-medium text-ink">Assigned batch / program</span><span className="text-alert"> *</span>
            <span className="mt-0.5 block text-[11px]">Which students can see this test? Pick an existing program or type a new one.</span>
            <input list="create-test-batches" value={batch} onChange={(e) => setBatch(e.target.value)} placeholder={batches[0] ?? "e.g. CSE · Sem III"} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-soft/60 focus:border-forest" />
            <datalist id="create-test-batches">
              {batches.map((b) => <option key={b} value={b} />)}
            </datalist>
          </label>

          {error && <p className="border border-alert/40 bg-alert/5 px-4 py-3 text-[12px] text-alert">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-5">
          <p className="text-[11px] text-ink-soft">You can pick questions, difficulty and candidates next.</p>
          <button
            onClick={() => void proceed()}
            disabled={!canProceed || saving}
            className={`border px-7 py-3 font-mono text-[11px] uppercase tracking-wider ${canProceed && !saving ? "border-forest bg-forest text-paper hover:bg-forest-light" : "cursor-not-allowed border-line-strong bg-line/30 text-ink-soft"}`}
          >
            {saving ? "Creating…" : "Proceed"}
          </button>
        </div>
      </div>
    </div>
  );
}
