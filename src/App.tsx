import { Routes, Route } from "react-router-dom";
import Landing from "@/shared/pages/Landing";
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
  return (
    <>
      <OfflineIndicator />
      <LockdownNotice />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/forgot" element={<ForgotPassword />} />
        <Route path="/recover" element={<PasswordRecover />} />
      
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
      
      {/* Teacher Routes */}
      <Route path="/teacher/proctoring" element={<ProtectedRoute allowedRole="teacher"><TeacherProctoring /></ProtectedRoute>} />
      <Route path="/teacher/*" element={<ProtectedRoute allowedRole="teacher"><TeacherDashboard /></ProtectedRoute>} />
      <Route path="/proctor" element={<ProtectedRoute allowedRole="teacher"><ProctorGrid /></ProtectedRoute>} />
      <Route path="/proctor/flags" element={<ProtectedRoute allowedRole="teacher"><ProctorGrid /></ProtectedRoute>} />
      <Route path="/proctor/recordings" element={<ProtectedRoute allowedRole="teacher"><ProctorGrid /></ProtectedRoute>} />
      
      {/* 404 Catch All */}
      <Route path="*" element={<ErrorPage />} />
    </Routes>
    </>
  );
}
