import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import { getTeacherNav } from "@/features/teacher/navigation";
import QuestionEditor from "@/features/teacher/pages/QuestionEditor";
import ExaminerDashboard from "@/features/teacher/pages/ExaminerDashboard";
import ExamStudio from "@/features/teacher/pages/ExamStudio";
import TeacherExams from "@/features/teacher/pages/TeacherExams";
import TeacherQuestionBank from "@/features/teacher/pages/TeacherQuestionBank";
import TeacherStudents from "@/features/teacher/pages/TeacherStudents";
import TeacherSubmissions from "@/features/teacher/pages/TeacherSubmissions";
import TeacherEvaluation from "@/features/teacher/pages/TeacherEvaluation";
import { listExamsForTeacher, listLiveAttempts, type ExamRecord } from "@/shared/data/examApi";
import EvidenceBrowser from "@/features/teacher/pages/EvidenceBrowser";
import AuditLog from "@/features/teacher/pages/AuditLog";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { useAuth } from "@/features/auth/auth";
import { Overview } from "@/features/teacher/pages/TeacherOverview";
import { ExamWorkspace, ExamSettings } from "@/features/teacher/pages/ExamWorkspace";
import { Reports } from "@/features/teacher/pages/TeacherReports";
import { SettingsPanel } from "@/features/teacher/pages/TeacherSettings";

function toExamCard(exam: ExamRecord) {
  return {
    id: exam.id,
    name: exam.name,
    batch: exam.batch,
    state: exam.status === "draft" ? "Draft" : exam.status === "scheduled" ? "Scheduled" : "Live",
    status: exam.status,
    scheduled_at: exam.scheduled_at,
    created_at: exam.created_at ?? new Date().toISOString(),
    count: `${exam.pool_count || 0} questions`,
    tone: exam.status === "draft" ? "text-amber" : "text-success",
    progress: exam.status === "draft" ? 18 : 100,
    schedule: exam.scheduled_at,
    duration: exam.duration_minutes,
    duration_minutes: exam.duration_minutes,
    mode: exam.mode,
    settings: exam.settings ?? {},
  };
}

export default function TeacherDashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<{id: number, msg: string}[]>([]);
  const notify = (msg: string) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  const { profile } = useCurrentProfile();
  const { isAdmin } = useAuth();
  
  const [createdExams, setCreatedExams] = useState<any[]>([]);
  const [loadingExams, setLoadingExams] = useState(true);

  useEffect(() => {
    let active = true;
    const fetchExams = async () => {
      setLoadingExams(true);
      const dbExams = await listExamsForTeacher();
      if (active && dbExams) {
        setCreatedExams(
          dbExams.map(toExamCard)
        );
        void refreshTotals(dbExams.map((e) => ({ id: e.id, state: e.status })));
      }
      if (active) setLoadingExams(false);
    };
    fetchExams();
    return () => { active = false; };
  }, []);

  const pathParts = location.pathname.split("/").filter(Boolean);
  const section = pathParts[1] || "overview";
  const subSection = pathParts[2] || "";
  const examAction = pathParts[3] || "";

  // Aggregate roster totals across ALL of the teacher's exams (not one hardcoded
  // demo exam), refreshed every 45s so nav badges and the overview stay live.
  const [totals, setTotals] = useState({ live: 0, submitted: 0, flagged: 0, scored: 0, scoreSum: 0 });

  const refreshTotals = async (examList: { id: string; state?: string }[]) => {
    const t = { live: 0, submitted: 0, flagged: 0, scored: 0, scoreSum: 0 };
    for (const ex of examList) {
      if (ex.state === "draft" || ex.state === "Draft") continue;
      const rows = await listLiveAttempts(ex.id);
      for (const r of rows) {
        // Live = actually writing. Enrolled-but-idle (not_started) is roster,
        // not a live candidate — counting those made the console look mocked.
        if (r.state === "submitted") t.submitted += 1;
        else if (r.state === "in_progress" || r.state === "paused") t.live += 1;
        if ((r.violations ?? []).length > 0) t.flagged += 1;
        if (typeof r.score === "number") { t.scored += 1; t.scoreSum += r.score; }
      }
    }
    setTotals(t);
  };

  useEffect(() => {
    if (!createdExams.length) return;
    const t = window.setInterval(() => void refreshTotals(createdExams), 45000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdExams]);

  const nav = [
    ...getTeacherNav(totals.live, totals.submitted, totals.flagged, createdExams.length),
    ...(isAdmin ? [{ label: "Admin console", to: "/admin" }] : []),
  ];

  const avgScore =
    totals.scored > 0 ? (totals.scoreSum / totals.scored).toFixed(1) : null;

  return (
    <>
      <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={nav}>
        {section === "overview" && <Overview notify={notify} navigate={navigate} examsList={createdExams} loading={loadingExams} avgScore={avgScore} scoredCount={totals.scored} stats={{ live: totals.live, submitted: totals.submitted, flagged: totals.flagged }} />}
    {section === "exams" && subSection === "new" && <TeacherExams notify={notify} navigate={navigate} exams={createdExams} autoCreate onCreate={(exam) => setCreatedExams((current) => [toExamCard(exam), ...current])} onDeleted={(examId) => setCreatedExams((current) => current.filter((e) => e.id !== examId))} />}
    {section === "exams" && subSection && subSection !== "new" && examAction === "settings" && <ExamSettings notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && subSection && subSection !== "new" && examAction === "build" && <ExamStudio notify={notify} navigate={navigate} examId={subSection} onSaved={(exam) => setCreatedExams((current) => { const rest = current.filter((e) => e.id !== exam.id); return [toExamCard(exam), ...rest]; })} />}
    {section === "exams" && subSection && subSection !== "new" && !examAction && <ExamWorkspace notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && !subSection && <TeacherExams notify={notify} navigate={navigate} exams={createdExams} onCreate={(exam) => setCreatedExams((current) => [toExamCard(exam), ...current])} onDeleted={(examId) => setCreatedExams((current) => current.filter((e) => e.id !== examId))} />}
    {section === "dashboard" && <ExaminerDashboard notify={notify} navigate={navigate} />}
    {section === "questions" && subSection === "new" && <QuestionEditor notify={notify} navigate={navigate} />}
    {section === "bank" && <TeacherQuestionBank notify={notify} navigate={navigate} />}
    {section === "students" && <TeacherStudents notify={notify} navigate={navigate} exams={createdExams} />}
    {section === "submissions" && <TeacherSubmissions notify={notify} />}
    {section === "evidence" && <EvidenceBrowser />}
    {section === "evaluate" && <TeacherEvaluation notify={notify} />}
    {section === "reports" && <Reports notify={notify} />}
    {section === "audit" && <AuditLog />}
        {section === "settings" && <SettingsPanel notify={notify} />}
      </RoleLayout>
      
      <div className="fixed right-6 top-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="animate-fade-in border-l-2 border-alert bg-paper px-4 py-3 shadow-xl pointer-events-auto">
            <p className="font-serif text-[14px] text-ink">{t.msg}</p>
          </div>
        ))}
      </div>
    </>
  );
}
