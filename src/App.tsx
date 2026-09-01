import { Routes, Route } from "react-router-dom";
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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/student" element={<StudentHome />} />
      <Route path="/student/exams" element={<StudentExams />} />
      <Route path="/student/results" element={<StudentResults />} />
      <Route path="/student/help" element={<StudentHelp />} />
      <Route path="/student/exam" element={<StudentExam />} />
      <Route path="/mobile-upload" element={<MobileUpload />} />
      <Route path="/teacher/proctoring" element={<TeacherProctoring />} />
      <Route path="/teacher/*" element={<TeacherDashboard />} />
      <Route path="/proctor" element={<ProctorGrid />} />
    </Routes>
  );
}
