import { Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing";
import StudentExam from "./pages/StudentExam";
import TeacherDashboard from "./pages/TeacherDashboard";
import ProctorGrid from "./pages/ProctorGrid";
import StudentHome from "./pages/StudentHome";
import TeacherProctoring from "./pages/TeacherProctoring";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/student" element={<StudentHome />} />
      <Route path="/student/exam" element={<StudentExam />} />
      <Route path="/teacher/proctoring" element={<TeacherProctoring />} />
      <Route path="/teacher/*" element={<TeacherDashboard />} />
      <Route path="/proctor" element={<ProctorGrid />} />
    </Routes>
  );
}
