import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { supabaseConfigured } from "../lib/env";
import { listExamsForStudent, subscribeToStudentExams, type ExamRecord } from "../lib/examApi";
import { useAuthProfile } from "../lib/auth";

const nav = [
  { label: "Overview", to: "/student", end: true },
  { label: "My exams", to: "/student/exams" },
  { label: "Results", to: "/student/results" },
  { label: "Help & support", to: "/student/help" },
];

type Card = { id: string; name: string; meta: string; date: string; ready: boolean };

const FALLBACK: Card[] = [
  { id: "EXAM-2026-014", name: "Data Structures & Algorithms", meta: "CSE · Semester III · 45 minutes", date: "Today · 10:00 AM", ready: true },
  { id: "EXAM-2026-021", name: "Digital Electronics", meta: "ECE · Semester III · 60 minutes", date: "18 Mar 2026 · 2:00 PM", ready: false },
];

function toCard(e: ExamRecord): Card {
  const when = e.scheduled_at ? new Date(e.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Available now";
  return {
    id: e.id,
    name: e.name,
    meta: `${e.batch} · ${e.duration_minutes} minutes`,
    date: e.status === "scheduled" ? when : "Available now",
    ready: e.status === "published",
  };
}

export default function StudentHome() {
  const { profile } = useAuthProfile();
  const [cards, setCards] = useState<Card[]>(supabaseConfigured ? [] : FALLBACK);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) return;
    let active = true;
    const load = async () => {
      const rows = await listExamsForStudent();
      if (!active) return;
      setLive(true);
      setLoading(false);
      if (rows) setCards(rows.map(toCard));
    };
    void load();
    const unsub = subscribeToStudentExams(() => void load());
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const firstName = profile?.fullName.split(" ")[0] ?? "Student";
  const subtitle = `${profile?.batch ?? "Batch unassigned"}`;

  return (
    <RoleLayout role="Student" name={profile?.fullName ?? "Student"} subtitle={subtitle} tone="#7A1F2B" items={nav}>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student dashboard</p><h1 className="mt-2 font-serif text-3xl font-semibold">Good morning, {firstName}.</h1><p className="mt-2 text-[13px] text-ink-soft">Your next assessment is ready when you are.</p></div><span className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${live ? "border-success/40 bg-success/5 text-success" : "border-line text-ink-soft"}`}>{live ? "● Live · synced" : "Profile verified"}</span></div>
      <div className="mt-8 grid gap-4 sm:grid-cols-3"><div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Upcoming</p><p className="mt-2 font-serif text-3xl">{cards.length}</p><p className="mt-1 text-[12px] text-ink-soft">scheduled exams</p></div><div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Completed</p><p className="mt-2 font-serif text-3xl">8</p><p className="mt-1 text-[12px] text-ink-soft">assessments this term</p></div><div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Average score</p><p className="mt-2 font-serif text-3xl">78%</p><p className="mt-1 text-[12px] text-ink-soft">across published results</p></div></div>
      <section className="mt-9"><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Your exam schedule</h2><Link to="/student/exams" className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">View all →</Link></div><div className="mt-3 space-y-2">{cards.map((exam) => <div key={exam.id} className="flex flex-col gap-4 border border-line bg-paper p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-serif text-[16px] font-medium">{exam.name}</p><p className="mt-1 text-[12px] text-ink-soft">{exam.meta}</p><p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{exam.date}</p></div>{exam.ready ? <Link to={`/student/exam/${exam.id}`} className="border border-maroon bg-maroon px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-maroon/90">Enter exam →</Link> : <span className="border border-line px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft">Scheduled</span>}</div>)}{loading && cards.length === 0 && <div className="animate-pulse space-y-2">{[0, 1].map((i) => <div key={i} className="h-[92px] border border-line bg-paper-raised" />)}</div>}{!loading && cards.length === 0 && <div className="border border-dashed border-line-strong p-8 text-center text-[13px] text-ink-soft">No exams assigned yet. Published exams appear here the moment your teacher releases them.</div>}</div></section>
      <section className="mt-9 grid gap-4 md:grid-cols-2"><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Before you begin</p><ul className="mt-4 space-y-3 text-[13px] text-ink-soft"><li>✓ Keep your ID card nearby</li><li>✓ Use a stable internet connection</li><li>✓ Allow camera and microphone access</li></ul></div><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Latest result</p><p className="mt-3 font-serif text-[16px]">Operating Systems</p><div className="mt-3 flex items-end justify-between"><span className="font-mono text-[11px] text-ink-soft">Published 12 Mar 2026</span><span className="font-serif text-2xl text-success">84%</span></div></div></section>
    </RoleLayout>
  );
}
