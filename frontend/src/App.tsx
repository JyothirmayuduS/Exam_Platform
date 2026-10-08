import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "@/shared/pages/Landing";
import { isTauri } from "@/shared/platform/platform";
import ErrorPage from "@/shared/pages/ErrorPage";
import StudentExam from "@/features/student/pages/StudentExam";
import TeacherDashboard from "@/features/teacher/pages/TeacherDashboard";
import ProctorGrid from "@/features/proctoring/pages/ProctorGrid";
import StudentHome from "@/features/student/pages/StudentHome";
import StudentExams from "@/features/student/pages/StudentExams";
import StudentResults from "@/features/student/pages/StudentResults";
import StudentResultDetail from "@/features/student/pages/StudentResultDetail";
import StudentHelp from "@/features/student/pages/StudentHelp";
import StudentExamDetail from "@/features/student/pages/StudentExamDetail";
import PracticeModeExam from "@/features/student/pages/PracticeModeExam";
import TeacherProctoring from "@/features/proctoring/pages/TeacherProctoring";
import MobileUpload from "@/features/mobile/pages/MobileUpload";
import MobileMonitor from "@/features/mobile/pages/MobileMonitor";
import Login from "@/features/auth/pages/Login";
import ForgotPassword from "@/features/auth/pages/ForgotPassword";
import PasswordRecover from "@/features/auth/pages/PasswordRecover";
import ProtectedRoute from "@/features/auth/components/ProtectedRoute";
import SystemCheckPage from "@/shared/components/SystemCheckPage";
import OfflineIndicator from "@/shared/components/OfflineIndicator";
import LockdownNotice from "@/shared/components/LockdownNotice";

export default function App() {
  // Inside the Vignan Exam Browser the candidate sees exactly ONE surface: the
  // exam flow (system checks → devices → exam) reached from My exams. Every
  // other route — the marketing root, the teacher/proctor consoles, the
  // password-recovery pages, the mobile pages, even the 404 — is unreachable
  // marketing or staff surface that must never appear on a candidate's
  // screen. main.tsx still rewrites the path before mount; this is the
  // structural backstop for anything that arrives afterwards (deep link, late
  // OS event, manual navigation).
  const inKiosk = isTauri();
  // Signed-in kiosks go to My exams (one click from "Enter exam"); a
  // signed-out one falls through to Login, whose kiosk face is the
  // waiting-for-exam screen rather than a credential form.
  const studentOnly = <Navigate to="/student/exams" replace />;

  return (
    <>
      <OfflineIndicator />
      <LockdownNotice />
      <Routes>
        {/* The lockdown kiosk has no marketing surface: a candidate must never
            land on the role-picker ("One examination hall, three vantage
            points"). main.tsx normally rewrites the path before mount; this
            route is the backstop for any residual "/" (e.g. a deep link that
            arrived while the webview was still booting). A signed-in kiosk
            goes to My exams — one click from "Enter exam"; a signed-out one
            falls through to the in-app waiting screen. */}
        <Route path="/" element={inKiosk ? studentOnly : <Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/forgot" element={inKiosk ? studentOnly : <ForgotPassword />} />
        <Route path="/recover" element={inKiosk ? studentOnly : <PasswordRecover />} />
      
      {/* Student Routes */}
      <Route path="/student" element={<ProtectedRoute allowedRole="student"><StudentHome /></ProtectedRoute>} />
      <Route path="/student/exams" element={<ProtectedRoute allowedRole="student"><StudentExams /></ProtectedRoute>} />
      <Route path="/student/exams/:examId" element={<ProtectedRoute allowedRole="student"><StudentExamDetail /></ProtectedRoute>} />
      <Route path="/student/exams/:examId/practice" element={<ProtectedRoute allowedRole="student"><PracticeModeExam /></ProtectedRoute>} />
      <Route path="/student/exams/:examId/system-check" element={<SystemCheckPage />} />
      <Route path="/student/results" element={<ProtectedRoute allowedRole="student"><StudentResults /></ProtectedRoute>} />
      <Route path="/student/results/:resultId" element={<ProtectedRoute allowedRole="student"><StudentResultDetail /></ProtectedRoute>} />
      <Route path="/student/help" element={<ProtectedRoute allowedRole="student"><StudentHelp /></ProtectedRoute>} />
      <Route path="/student/exam" element={<ProtectedRoute allowedRole="student"><StudentExam /></ProtectedRoute>} />
      <Route path="/system-check" element={<SystemCheckPage />} />
      <Route path="/student/practice" element={<ProtectedRoute allowedRole="student"><PracticeModeExam /></ProtectedRoute>} />
      <Route path="/mobile-upload/:token" element={<MobileUpload />} />
      <Route path="/mobile-upload" element={<MobileUpload />} />
      <Route path="/mobile-monitor/:token" element={<MobileMonitor />} />
      
      {/* Teacher Routes — staff consoles, never reachable from the kiosk */}
      <Route path="/teacher/proctoring" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="teacher"><TeacherProctoring /></ProtectedRoute>} />
      <Route path="/teacher/evidence" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="staff"><TeacherDashboard /></ProtectedRoute>} />
      <Route path="/teacher/*" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="teacher"><TeacherDashboard /></ProtectedRoute>} />
      <Route path="/proctor" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="staff"><ProctorGrid /></ProtectedRoute>} />
      <Route path="/proctor/flags" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="staff"><ProctorGrid /></ProtectedRoute>} />
      <Route path="/proctor/recordings" element={inKiosk ? studentOnly : <ProtectedRoute allowedRole="staff"><ProctorGrid /></ProtectedRoute>} />
      
      {/* 404 Catch All */}
      <Route path="*" element={inKiosk ? studentOnly : <ErrorPage />} />
    </Routes>
    </>
  );
}
