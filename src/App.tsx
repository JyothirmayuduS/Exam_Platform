import { Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing";
import StudentExam from "./pages/StudentExam";
import TeacherDashboard from "./pages/TeacherDashboard";
import ProctorGrid from "./pages/ProctorGrid";
import StudentHome from "./pages/StudentHome";
import StudentExams from "./pages/StudentExams";
import StudentResults from "./pages/StudentResults";
import StudentResultDetail from "./pages/StudentResultDetail";
import StudentHelp from "./pages/StudentHelp";
import StudentExamDetail from "./pages/StudentExamDetail";
import PracticeModeExam from "./pages/PracticeModeExam";
import TeacherProctoring from "./pages/TeacherProctoring";
import MobileUpload from "./pages/MobileUpload";
import AuthLogin from "./pages/AuthLogin";
import ProtectedRoute from "./components/ProtectedRoute";
import SystemCheckPage from "./components/SystemCheckPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<AuthLogin />} />
      
      {/* Student Routes */}
      <Route path="/student" element={<ProtectedRoute allowedRole="student"><StudentHome /></ProtectedRoute>} />
      <Route path="/student/exams" element={<ProtectedRoute allowedRole="student"><StudentExams /></ProtectedRoute>} />
      <Route path="/student/exams/:examId" element={<ProtectedRoute allowedRole="student"><StudentExamDetail /></ProtectedRoute>} />
      <Route path="/student/exams/:examId/practice" element={<ProtectedRoute allowedRole="student"><PracticeModeExam /></ProtectedRoute>} />
      <Route path="/student/exams/:examId/system-check" element={<ProtectedRoute allowedRole="student"><SystemCheckPage /></ProtectedRoute>} />
      <Route path="/student/results" element={<ProtectedRoute allowedRole="student"><StudentResults /></ProtectedRoute>} />
      <Route path="/student/results/:resultId" element={<ProtectedRoute allowedRole="student"><StudentResultDetail /></ProtectedRoute>} />
      <Route path="/student/help" element={<ProtectedRoute allowedRole="student"><StudentHelp /></ProtectedRoute>} />
      <Route path="/student/exam" element={<ProtectedRoute allowedRole="student"><StudentExam /></ProtectedRoute>} />
      <Route path="/mobile-upload" element={<MobileUpload />} />
      
      {/* Teacher Routes */}
      <Route path="/teacher/proctoring" element={<ProtectedRoute allowedRole="teacher"><TeacherProctoring /></ProtectedRoute>} />
      <Route path="/teacher/*" element={<ProtectedRoute allowedRole="teacher"><TeacherDashboard /></ProtectedRoute>} />
      <Route path="/proctor" element={<ProtectedRoute allowedRole="teacher"><ProctorGrid /></ProtectedRoute>} />
    </Routes>
  );
}
