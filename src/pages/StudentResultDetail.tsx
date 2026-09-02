import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { STUDENT_NAV } from "./StudentExams";
import { useAuth } from "../lib/auth";
import { getSupabase } from "../lib/supabase";
import { useQuery } from "@tanstack/react-query";
import AppealForm from "../components/exam/AppealForm";

// ── Mock Data for Detailed Results ────────────────────────────────────────────
const EXAM_DETAIL = {
  name: "Computer Networks",
  code: "EXAM-2025-061",
  date: "14 Feb 2026",
  score: 91,
  outOf: 100,
  percentile: 88,
  classAvg: 72,
  passMark: 40,
  timeSpent: "1h 42m",
  categoryBreakdown: [
    { category: "OSI Model", score: 100 },
    { category: "TCP/IP", score: 85 },
    { category: "Routing", score: 90 },
    { category: "Network Security", score: 75 },
  ],
  questions: [
    {
      id: 1,
      type: "mcq",
      text: "Which layer of the OSI model is responsible for routing?",
      options: ["Data Link", "Network", "Transport", "Session"],
      studentAnswer: 1,
      correctAnswer: 1,
      marksAwarded: 2,
      maxMarks: 2,
      explanation: "The Network layer (Layer 3) handles packet routing across multiple networks.",
      markedForReview: false,
      timeSpentSec: 45,
    },
    {
      id: 2,
      type: "mcq",
      text: "TCP is a connectionless protocol.",
      options: ["True", "False"],
      studentAnswer: 0,
      correctAnswer: 1,
      marksAwarded: 0,
      maxMarks: 2,
      explanation: "TCP is connection-oriented. UDP is connectionless.",
      teacherComment: "Review the differences between TCP and UDP.",
      markedForReview: true,
      timeSpentSec: 12,
    },
    {
      id: 3,
      type: "subjective",
      text: "Explain the three-way handshake in TCP.",
      studentAnswerText: "[Image Uploaded via Mobile]",
      marksAwarded: 8,
      maxMarks: 10,
      teacherComment: "Good explanation of SYN and ACK, but missed mentioning the sequence numbers in detail.",
      markedForReview: false,
      timeSpentSec: 320,
      appealStatus: "none", // none, pending, reviewed
    }
  ],
};

function MiniBarChart({ data }: { data: { category: string; score: number }[] }) {
  return (
    <div className="space-y-3 mt-4">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3 text-[12px]">
          <div className="w-32 truncate text-ink-soft" title={d.category}>{d.category}</div>
          <div className="flex-1 h-2 bg-line">
            <div 
              className={`h-full ${d.score >= 80 ? 'bg-success' : d.score >= 50 ? 'bg-amber' : 'bg-alert'}`}
              style={{ width: `${d.score}%` }}
            />
          </div>
          <div className="w-8 text-right font-mono text-[10px]">{d.score}%</div>
        </div>
      ))}
    </div>
  );
}

export default function StudentResultDetail() {
  const { resultId } = useParams();
  const { user } = useAuth();
  const [appealingQ, setAppealingQ] = useState<number | null>(null);
  const [submittedAppeals, setSubmittedAppeals] = useState<Record<number, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ['resultDetail', resultId, user?.id],
    queryFn: async () => {
      const db = getSupabase();
      if (!db || !user?.id || !resultId) return null;

      const { data: student } = await db
        .from("students")
        .select("id")
        .eq("auth_id", user.id)
        .maybeSingle();
      if (!student) return null;

      const { data: attempt } = await db
        .from("attempts")
        .select("score, submitted_at, answers, minutes_used")
        .eq("exam_id", resultId)
        .eq("student_id", student.id)
        .maybeSingle();

      if (!attempt) return null;

      const { data: exam } = await db
        .from("exams")
        .select("name, total_marks, settings")
        .eq("id", resultId)
        .maybeSingle();

      const { data: questions } = await db
        .from("questions")
        .select("*")
        .eq("exam_id", resultId)
        .order("id", { ascending: true });

      const answersObj = attempt.answers || {};

      const processedQuestions = (questions || []).map((q: any, i: number) => {
        const studentAns = answersObj[i];
        let type = q.type === "Subjective" || q.type === "Coding" ? "subjective" : "mcq";
        let isCorrect = q.answer === studentAns;
        let awarded = isCorrect ? q.marks : 0;
        
        return {
          id: i,
          type,
          text: q.title,
          options: q.options || [],
          studentAnswer: type === "mcq" ? (studentAns !== undefined ? parseInt(studentAns) : -1) : -1,
          studentAnswerText: type === "subjective" ? (studentAns || "") : "",
          correctAnswer: type === "mcq" ? (q.answer !== null ? parseInt(q.answer) : -1) : -1,
          marksAwarded: type === "mcq" ? awarded : (attempt.score === null ? "..." : awarded),
          maxMarks: q.marks,
          explanation: null,
          teacherComment: null,
          markedForReview: false,
          timeSpentSec: 0,
        };
      });

      return {
        name: exam?.name || "Unknown Exam",
        code: resultId,
        date: attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleDateString() : "N/A",
        score: attempt.score ?? 0,
        outOf: exam?.total_marks ?? 100,
        percentile: 88, // Mock
        classAvg: 72, // Mock
        passMark: (exam?.total_marks ?? 100) * 0.4,
        timeSpent: `${Math.floor(attempt.minutes_used / 60)}h ${attempt.minutes_used % 60}m`,
        categoryBreakdown: [], // Mock or empty
        questions: processedQuestions
      };
    },
    enabled: !!user?.id && !!resultId,
  });

  if (isLoading) {
    return (
      <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={STUDENT_NAV}>
        <div className="p-10 text-center text-ink-soft">Loading results...</div>
      </RoleLayout>
    );
  }

  if (!data) {
    return (
      <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={STUDENT_NAV}>
        <div className="p-10 text-center text-alert">Failed to load exam result.</div>
      </RoleLayout>
    );
  }

  const EXAM_DETAIL = data;

  const handleAppealSubmit = (qId: number, reason: string) => {
    setSubmittedAppeals(prev => ({ ...prev, [qId]: reason }));
    setAppealingQ(null);
  };

  const isPassed = EXAM_DETAIL.score >= EXAM_DETAIL.passMark;

  return (
    <RoleLayout role="Student" name="Priya Nikitha" subtitle="21VGN0142 · CSE — Sem III" tone="#7A1F2B" items={STUDENT_NAV}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link to="/student/results" className="text-[12px] text-ink-soft hover:text-ink font-mono uppercase tracking-wider mb-2 inline-block">← Back to Results</Link>
          <h1 className="font-serif text-3xl font-semibold">{EXAM_DETAIL.name}</h1>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft mt-1">{EXAM_DETAIL.code} • {EXAM_DETAIL.date}</p>
        </div>
        <div className={`px-4 py-2 border ${isPassed ? 'border-success/50 bg-success/10 text-success' : 'border-alert/50 bg-alert/10 text-alert'}`}>
          <p className="font-mono text-[10px] uppercase tracking-widest text-center">{isPassed ? 'Passed' : 'Failed'}</p>
        </div>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="border border-line bg-paper-raised p-4">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Your Score</p>
          <p className="mt-1 font-serif text-2xl">{EXAM_DETAIL.score} <span className="text-[14px] text-ink-soft font-sans">/ {EXAM_DETAIL.outOf}</span></p>
        </div>
        <div className="border border-line bg-paper-raised p-4">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Class Avg</p>
          <p className="mt-1 font-serif text-2xl">{EXAM_DETAIL.classAvg}</p>
        </div>
        <div className="border border-line bg-paper-raised p-4">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Percentile</p>
          <p className="mt-1 font-serif text-2xl">{EXAM_DETAIL.percentile}th</p>
        </div>
        <div className="border border-line bg-paper-raised p-4">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Time Spent</p>
          <p className="mt-1 font-serif text-2xl">{EXAM_DETAIL.timeSpent}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Review Section */}
        <div className="lg:col-span-2 space-y-6">
          <h2 className="font-serif text-xl border-b border-line pb-2">Question Review</h2>
          
          {EXAM_DETAIL.questions.map((q, i) => {
            const isCorrect = q.marksAwarded === q.maxMarks;
            const isPartial = q.marksAwarded > 0 && q.marksAwarded < q.maxMarks;
            const borderCol = isCorrect ? 'border-success' : isPartial ? 'border-amber' : 'border-alert';
            
            return (
              <div key={q.id} className={`border-l-4 ${borderCol} bg-paper-raised border-t border-r border-b border-y-line border-r-line p-5 relative`}>
                {q.markedForReview && (
                  <span className="absolute top-0 right-0 bg-amber text-white font-mono text-[9px] uppercase tracking-wider px-2 py-1">Flagged</span>
                )}
                
                <div className="flex justify-between items-start mb-3">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question {i + 1}</span>
                  <span className="font-mono text-[11px] font-bold">
                    {q.marksAwarded} / {q.maxMarks} marks
                  </span>
                </div>
                
                <p className="text-[14px] text-ink mb-4">{q.text}</p>
                
                {q.type === 'mcq' && q.options && (
                  <div className="space-y-2 mb-4">
                    {q.options.map((opt, optIdx) => {
                      const isStudentAns = q.studentAnswer === optIdx;
                      const isCorrectAns = q.correctAnswer === optIdx;
                      
                      let rowClass = "border border-line px-3 py-2 text-[13px] ";
                      if (isCorrectAns && isStudentAns) rowClass += "bg-success/10 border-success text-success";
                      else if (isCorrectAns) rowClass += "bg-success/5 border-success/30 text-success";
                      else if (isStudentAns) rowClass += "bg-alert/10 border-alert text-alert";
                      else rowClass += "text-ink-soft";
                      
                      return (
                        <div key={optIdx} className={rowClass}>
                          {String.fromCharCode(65 + optIdx)}. {opt}
                          {isStudentAns && <span className="float-right text-[10px] uppercase font-mono tracking-wider">Your Answer</span>}
                          {isCorrectAns && !isStudentAns && <span className="float-right text-[10px] uppercase font-mono tracking-wider">Correct Answer</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {q.type === 'subjective' && (
                  <div className="border border-line p-3 bg-white mb-4 text-[13px] italic text-ink-soft flex items-center gap-2">
                    <span className="text-xl">📄</span> {q.studentAnswerText}
                  </div>
                )}

                {(q.explanation || q.teacherComment) && (
                  <div className="bg-paper p-4 border border-line text-[12px] space-y-2 mb-4">
                    {q.explanation && (
                      <p><strong className="font-mono text-[9px] uppercase tracking-wider text-ink-soft block mb-1">Explanation</strong> {q.explanation}</p>
                    )}
                    {q.teacherComment && (
                      <p className="text-maroon"><strong className="font-mono text-[9px] uppercase tracking-wider text-maroon/70 block mb-1">Teacher Note</strong> {q.teacherComment}</p>
                    )}
                  </div>
                )}
                
                <div className="flex justify-between items-center mt-2 border-t border-line pt-3">
                  <span className="font-mono text-[9px] text-ink-soft">Time spent: {q.timeSpentSec}s</span>
                  
                  {submittedAppeals[q.id] ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-amber border border-amber/30 bg-amber/5 px-2 py-1">Appeal Pending</span>
                  ) : (
                    <button 
                      onClick={() => setAppealingQ(appealingQ === q.id ? null : q.id)}
                      className="text-[10px] font-mono uppercase tracking-wider text-ink-soft hover:text-ink underline underline-offset-4"
                    >
                      Report Grading Error
                    </button>
                  )}
                </div>

                {appealingQ === q.id && !submittedAppeals[q.id] && (
                  <AppealForm 
                    examId={resultId || ""} 
                    questionId={q.id} 
                    currentMarks={q.marksAwarded} 
                    maxMarks={q.maxMarks} 
                    onSubmit={(r) => handleAppealSubmit(q.id, r)}
                    onCancel={() => setAppealingQ(null)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar Analytics */}
        <div className="space-y-6">
          <div className="border border-line bg-paper-raised p-5">
            <h3 className="font-serif text-lg mb-1">Category Breakdown</h3>
            <p className="text-[11px] text-ink-soft mb-4">Your performance across topics</p>
            <MiniBarChart data={EXAM_DETAIL.categoryBreakdown} />
          </div>

          <div className="border border-line bg-paper-raised p-5">
            <h3 className="font-serif text-lg mb-1">Analytics Insights</h3>
            <ul className="text-[12.5px] space-y-3 mt-4 text-ink-soft list-disc pl-4 marker:text-line-strong">
              <li>You spent <strong className="text-ink">45% less time</strong> than average on OSI Model questions, yet scored 100%.</li>
              <li>Your accuracy drops on questions flagged for review (0% correct).</li>
              <li><strong className="text-amber">Weak Area Identified:</strong> Transport Layer Protocols. Focus on TCP vs UDP.</li>
            </ul>
          </div>
        </div>
      </div>
    </RoleLayout>
  );
}
