import { useState, useEffect } from "react";
import { PageHeading, Button, SelectField } from "@/features/teacher/components/PageChrome";
import { listExamsForTeacher, saveTeacherSettings, getTeacherSettings, updateTeacherProfile } from "@/shared/data/examApi";
import { getSupabase } from "@/shared/data/supabase";
import useCurrentProfile from "@/features/auth/hooks/useCurrentProfile";

export function SettingsPanel({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState("Profile");
  const { profile } = useCurrentProfile();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(profile?.full_name ?? "");
  const [department, setDepartment] = useState(profile?.kind === "teacher" ? (profile.department ?? "") : "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [batchOptions, setBatchOptions] = useState<string[]>([]);
  const [template, setTemplate] = useState({ subject: "You are invited to {exam_name}", body: "Dear {candidate_name},\n\nYou have been enrolled in {exam_name}.\n\nPlease ensure your system meets the requirements." });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getTeacherSettings().then((s) => {
      if (!active) return;
      setSettings(s);
      if (s.email_template_subject) setTemplate((t) => ({ ...t, subject: String(s.email_template_subject) }));
      if (s.email_template_body) setTemplate((t) => ({ ...t, body: String(s.email_template_body) }));
    });
    void listExamsForTeacher().then((exams) => {
      if (!active) return;
      const batches = Array.from(new Set((exams ?? []).map((e) => e.batch).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      setBatchOptions(batches);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (profile?.full_name) setName(profile.full_name);
    if (profile?.kind === "teacher" && profile.department) setDepartment(profile.department);
    if (profile?.email) setEmail(profile.email);
  }, [profile]);

  const setFlag = (key: string, value: boolean) => setSettings((cur) => ({ ...cur, [key]: value }));
  const saveProfile = async () => {
    setSaving(true);
    const ok = await updateTeacherProfile({ full_name: name, department, email });
    setSaving(false);
    notify(ok ? "Profile saved" : "Could not save profile — database unavailable");
  };
  const saveAll = async () => {
    setSaving(true);
    const ok = await saveTeacherSettings({ ...settings, email_template_subject: template.subject, email_template_body: template.body });
    setSaving(false);
    notify(ok ? "Settings saved" : "Could not save settings — database unavailable");
  };
  const sendTestEmail = async () => {
    const db = getSupabase();
    if (!db) { notify("Email service unavailable (offline)"); return; }
    // Send the reminder against a real exam of this teacher — never a demo id.
    const exams = await listExamsForTeacher();
    const examId = exams?.find((e) => e.status !== "draft")?.id;
    if (!examId) { notify("Create and publish an exam first, then send a test reminder"); return; }
    const { error } = await db.functions.invoke("send-reminder-email", { body: { examId, studentEmail: email || profile?.email || null } });
    notify(error ? `Test email failed: ${error.message}` : "Test email sent");
  };
  const b = (key: string) => settings[key] !== false;
  return <><PageHeading eyebrow="Settings" title="Teacher workspace settings" detail="Control your profile, exam defaults, security rules, and notifications."/><div className="mt-8 grid gap-8 lg:grid-cols-[210px_1fr]"><nav className="space-y-1">{["Profile", "Department defaults", "Security & proctoring", "Notifications", "Email templates"].map((item) => <button key={item} onClick={() => setTab(item)} className={`w-full border-l-2 px-3 py-2.5 text-left text-[13px] ${tab === item ? "border-forest bg-raised text-forest" : "border-transparent text-soft hover:bg-raised hover:text-ink"}`}>{item}</button>)}</nav><div className="max-w-3xl border border-line bg-paper p-6 sm:p-8">{tab === "Profile" && <SettingsSection title="Faculty profile" detail="This information appears on exam instructions and reports."><div className="grid gap-5 sm:grid-cols-2"><EditableField label="Full name" value={name} onChange={setName}/><EditableField label="Department" value={department} onChange={setDepartment}/><EditableField label="Email address" value={email} onChange={setEmail}/></div><div className="mt-5 flex justify-end"><Button primary onClick={() => void saveProfile()}>{saving ? "Saving…" : "Save profile"}</Button></div></SettingsSection>}{tab === "Department defaults" && <SettingsSection title="Department defaults" detail="These values prefill whenever you create a new exam."><div className="grid gap-5 sm:grid-cols-2"><SelectField label="Default duration" options={["00:45", "01:00", "01:30"]} value={String(settings.default_duration ?? "00:45")} onChange={(v) => setSettings((c) => ({ ...c, default_duration: v }))}/><SelectField label="Default question type" options={["Mixed question set", "MCQ only", "Subjective only"]} value={String(settings.default_question_type ?? "Mixed question set")} onChange={(v) => setSettings((c) => ({ ...c, default_question_type: v }))}/><SelectField label="Default batch" options={batchOptions.length ? batchOptions : [String(settings.default_batch ?? "No batches yet")]} value={String(settings.default_batch ?? batchOptions[0] ?? "")} onChange={(v) => setSettings((c) => ({ ...c, default_batch: v }))}/><SelectField label="Default proctoring" options={["AI Proctoring", "Basic Lockdown", "Live Proctoring"]} value={String(settings.default_proctoring ?? "AI Proctoring")} onChange={(v) => setSettings((c) => ({ ...c, default_proctoring: v }))}/></div><Toggle label="Auto-save exam drafts" detail="Save changes as you move through the exam builder." checked={b("auto_save_drafts")} onChange={(v) => setFlag("auto_save_drafts", v)}/><Toggle label="Shuffle questions by default" detail="Randomize question order for each candidate." checked={b("shuffle_questions")} onChange={(v) => setFlag("shuffle_questions", v)}/></SettingsSection>}{tab === "Security & proctoring" && <SettingsSection title="Security & proctoring" detail="Set the minimum security standard for new assessments."><Toggle label="Require camera and microphone" detail="Candidates must pass device checks before starting." checked={b("require_camera")} onChange={(v) => setFlag("require_camera", v)}/><Toggle label="Block tab switching and copy/paste" detail="Lock the exam window during active sessions." checked={b("block_tab_switch")} onChange={(v) => setFlag("block_tab_switch", v)}/><Toggle label="Enable second-face detection" detail="Create a flag when another face enters the frame." checked={b("second_face_detection")} onChange={(v) => setFlag("second_face_detection", v)}/><Toggle label="Allow late entry" detail="Let candidates join after the scheduled start time." checked={settings.allow_late_entry === true} onChange={(v) => setFlag("allow_late_entry", v)}/></SettingsSection>}{tab === "Notifications" && <SettingsSection title="Notifications" detail="Choose which events should reach your faculty inbox."><Toggle label="Critical proctoring flags" detail="Notify immediately when a severe incident is detected." checked={b("notify_critical_flags")} onChange={(v) => setFlag("notify_critical_flags", v)}/><Toggle label="Submission milestones" detail="Notify when 25%, 50%, 75%, and 100% submit." checked={b("notify_submission_milestones")} onChange={(v) => setFlag("notify_submission_milestones", v)}/><Toggle label="Evaluation reminders" detail="Send a daily reminder for ungraded subjective answers." checked={settings.evaluation_reminders === true} onChange={(v) => setFlag("evaluation_reminders", v)}/><SelectField label="Daily summary time" options={["08:00 AM", "12:00 PM", "06:00 PM"]} value={String(settings.daily_summary_time ?? "08:00 AM")} onChange={(v) => setSettings((c) => ({ ...c, daily_summary_time: v }))}/></SettingsSection>}{tab === "Email templates" && <SettingsSection title="Email templates" detail="Customize automated emails sent to candidates."><div className="grid gap-5"><label className="block text-[12px] text-soft">Subject<input value={template.subject} onChange={(e) => setTemplate((t) => ({ ...t, subject: e.target.value }))} className="mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><label className="block text-[12px] text-soft">Body<textarea rows={6} value={template.body} onChange={(e) => setTemplate((t) => ({ ...t, body: e.target.value }))} className="mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><div className="flex gap-2"><Button primary onClick={() => void saveAll()}>{saving ? "Saving…" : "Save Template"}</Button><Button onClick={() => void sendTestEmail()}>Send Test Email</Button></div></div></SettingsSection>}<div className="mt-8 flex justify-end border-t border-line pt-5"><Button primary onClick={() => void saveAll()}>{saving ? "Saving…" : "Save changes"}</Button></div></div></div></>; }
function SettingsSection({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { return <section><h2 className="font-serif text-2xl font-semibold">{title}</h2><p className="mt-2 text-[13px] text-soft">{detail}</p><div className="mt-7 space-y-5">{children}</div></section>; }
function EditableField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) { return <label className="block text-[12px] text-soft">{label}<input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label>; }
function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) { return <label className="flex items-start justify-between gap-5 border-b border-line pb-4"><span><span className="block text-[13px] font-medium">{label}</span><span className="mt-1 block text-[12px] text-soft">{detail}</span></span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-forest"/></label>; }
