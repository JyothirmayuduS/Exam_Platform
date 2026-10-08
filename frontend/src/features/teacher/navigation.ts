/** Sidebar entries for the faculty console; badges carry live counts. */
export const getTeacherNav = (liveAttemptsCount: number, submittedAttemptsCount: number, needsAttentionCount: number, examCount = 0) => [
  { label: "Overview", to: "/teacher", end: true },
  { label: "Examiner dashboard", to: "/teacher/dashboard" },
  { label: "Exams", to: "/teacher/exams", badge: examCount ? String(examCount) : undefined },
  { label: "My questions", to: "/teacher/bank" },
  { label: "Students", to: "/teacher/students" },
  { label: "Submissions", to: "/teacher/submissions", badge: String(liveAttemptsCount) },
  { label: "Evaluate", to: "/teacher/evaluate", badge: String(submittedAttemptsCount) },
  { label: "Proctoring", to: "/teacher/proctoring", badge: String(needsAttentionCount) },
  { label: "Reports", to: "/teacher/reports" },
  { label: "Evidence", to: "/teacher/evidence" },
  { label: "Audit log", to: "/teacher/audit" },
  { label: "Settings", to: "/teacher/settings" },
];
