import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import Landing from "./pages/Landing";
import StudentExam from "./pages/StudentExam";
import TeacherDashboard from "./pages/TeacherDashboard";
import ProctorGrid from "./pages/ProctorGrid";
import StudentHome from "./pages/StudentHome";
import StudentExams from "./pages/StudentExams";
import StudentResults from "./pages/StudentResults";
import StudentHelp from "./pages/StudentHelp";
import TeacherProctoring from "./pages/TeacherProctoring";
import MobileUpload from "./pages/MobileUpload";
import AuthLogin from "./pages/AuthLogin";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth/login" element={<AuthLogin />} />

      <Route
        path="/student"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <StudentHome />
          </ProtectedRoute>
        }
      />
      <Route
        path="/student/exams"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <StudentExams />
          </ProtectedRoute>
        }
      />
      <Route
        path="/student/results"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <StudentResults />
          </ProtectedRoute>
        }
      />
      <Route
        path="/student/help"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <StudentHelp />
          </ProtectedRoute>
        }
      />
      <Route path="/student/exam" element={<Navigate to="/student/exams" replace />} />
      <Route
        path="/student/exam/:examId"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <StudentExam />
          </ProtectedRoute>
        }
      />

      <Route
        path="/mobile-upload"
        element={
          <ProtectedRoute allowedRoles={["student", "admin"]}>
            <MobileUpload />
          </ProtectedRoute>
        }
      />
      <Route
        path="/teacher/proctoring"
        element={
          <ProtectedRoute allowedRoles={["teacher", "proctor", "admin"]}>
            <TeacherProctoring />
          </ProtectedRoute>
        }
      />
      <Route
        path="/teacher/*"
        element={
          <ProtectedRoute allowedRoles={["teacher", "admin"]}>
            <TeacherDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/proctor"
        element={
          <ProtectedRoute allowedRoles={["proctor", "teacher", "admin"]}>
            <ProctorGrid />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
