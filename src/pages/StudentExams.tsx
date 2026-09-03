import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import { supabaseConfigured } from "../lib/env";
import { listEnrolledExamsForAuthUser, subscribeToStudentExams, type ExamRecord } from "../lib/examApi";
import { isTauri } from "../lib/platform";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";

export const STUDENT_NAV = [
  { label: "Overview", to: "/student", end: true },
  { label: "My exams", to: "/student/exams" },
  { label: "Results", to: "/student/results" },
  { label: "Help & support", to: "/student/help" },
];

export const STUDENT_BATCH = "CSE — Sem III · Sec A/B"; // Keep for fallback purposes

type Row = { id: string; name: string; meta: string; when: string; status: "published" | "scheduled" | "completed" };

function toRow(e: ExamRecord): Row {
  const when = e.scheduled_at ? new Date(e.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Available now";
  return {
    id: e.id,
    name: e.name,
    meta: `${e.batch} · ${e.duration_minutes} min · ${e.total_marks} marks`,
    when: e.status === "scheduled" ? when : "Available now",
    status: e.status === "published" ? "published" : "scheduled",
  };
}

export default function StudentExams() {
  const navigate = useNavigate();
  const { profile } = useCurrentProfile();
  const [enterModal, setEnterModal] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { getSupabase } = await import("../lib/supabase");
      const db = getSupabase();
      if (!db) {
        if (active) setLoading(false);
        return;
      }
      
      const { data: { user } } = await db.auth.getUser();
      if (!user) {
        if (active) setLoading(false);
        return;
      }

      const data = await listEnrolledExamsForAuthUser(user.id);
      if (!active) return;
      
      let attemptsMap: Record<string, string> = {};
      
      if (data) {
         const { data: st } = await db.from("students").select("id").eq("auth_id", user.id).maybeSingle();
         if (st?.id) {
           const { data: att } = await db.from("attempts").select("exam_id, state").eq("student_id", st.id);
            if (att) {
              att.forEach((a: any) => { attemptsMap[a.exam_id] = a.state; });
            }
         }
      }

      if (!active) return;
      setLive(true);
      setLoading(false);
      // null = query failed → keep last-known rows; only a real result replaces.
      if (data) {
        setRows(data.map(e => {
          const row = toRow(e);
          if (attemptsMap[e.id] === "submitted") {
            row.status = "completed";
          }
          return row;
        }));
      }
    };
    void load();
    const unsub = subscribeToStudentExams(STUDENT_BATCH, () => void load());
    return () => { active = false; unsub(); };
  }, []);

  const badge: Record<Row["status"], string> = {
    published: "border-success/50 bg-success/10 text-success",
    scheduled: "border-amber/50 bg-amber/10 text-amber",
    completed: "border-line text-ink-soft",
  };

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#7A1F2B" items={STUDENT_NAV} status={live ? "● Live · synced" : "Profile verified"}>
      <div className="flex items-end justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Assessments</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">My exams</h1>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{rows.length} total</span>
      </div>

      <div className="mt-8 space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-4 border border-line bg-paper p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <p className="font-serif text-[16px] font-medium">{r.name}</p>
                <span className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${badge[r.status]}`}>{r.status}</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-soft">{r.meta}</p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{r.when}</p>
            </div>
            {r.status === "published" ? (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  if (isTauri()) {
                    // Already inside the lockdown browser — go straight into the exam.
                    void navigate(`/student/exam?examId=${encodeURIComponent(r.id)}`);
                  } else {
                    // Normal browser: instantly trigger the deep link to open the app
                    window.location.href = `vignan-exam://open?exam=${encodeURIComponent(r.id)}&roll=${encodeURIComponent(profile && "roll" in profile ? profile.roll : "21BQ1A0501")}`;
                    // If it doesn't open (not installed), show the gate/modal fallback after a delay
                    setTimeout(() => {
                      setEnterModal(r.name);
                    }, 2500);
                  }
                }}
                className="border border-maroon bg-maroon px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-maroon/90"
              >
                Enter exam →
              </button>
            ) : r.status === "completed" ? (
              <Link to="/student/results" className="border border-line-strong px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">View result →</Link>
            ) : (
              <span className="border border-line px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft">Scheduled</span>
            )}
          </div>
        ))}
        {loading && rows.length === 0 && (
          <div className="animate-pulse space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-[104px] border border-line bg-paper-raised" />)}</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="border border-dashed border-line-strong p-10 text-center text-[13px] text-ink-soft">No exams assigned yet. Published exams appear here the moment your teacher releases them.</div>
        )}
      </div>

      {/* Modal: shown when student clicks Enter exam in a normal browser */}
      {enterModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md border border-line bg-paper p-6 shadow-2xl">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Lockdown required</p>
            <h2 className="mt-2 font-serif text-xl font-semibold">Open the Vignan Lockdown Browser</h2>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-maroon">{enterModal}</p>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
              This exam must be opened inside the <strong className="text-ink">Vignan Lockdown Browser</strong>{" "}
              desktop app — not in a regular web browser.
            </p>
            <div className="mt-4 border border-line bg-paper-raised p-4 text-[12.5px] text-ink-soft">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink">Steps</p>
              <p className="mt-2">1. Close or minimise this browser window.</p>
              <p className="mt-1">2. Open <strong className="text-ink">Vignan Lockdown Browser</strong> from your desktop.</p>
              <p className="mt-1">3. Click <strong className="text-ink">Enter exam</strong> inside the app.</p>
            </div>
            <div className="mt-5 flex gap-3">
              <a
                href={`/student/exam?examId=${encodeURIComponent(rows.find(x => x.name === enterModal)?.id || "")}`}
                className="flex-1 border border-maroon bg-maroon py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon/90"
              >
                Install Lockdown Browser →
              </a>
              <button
                onClick={() => setEnterModal(null)}
                className="border border-line px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </RoleLayout>
  );
}
