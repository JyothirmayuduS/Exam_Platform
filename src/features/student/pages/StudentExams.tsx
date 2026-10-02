import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import { supabaseConfigured } from "@/shared/data/env";
import { listEnrolledExamsForAuthUser, subscribeToStudentExams, type ExamRecord } from "@/shared/data/examApi";
import { detectOS, downloadUrl, isTauri, osLabel } from "@/shared/platform/platform";
import { launchExamInLockdown } from "@/shared/platform/lockdownBridge";
import { GatekeeperHelp } from "@/features/student/components/exam/ExamFlowScreens";
import { useAuth } from "@/features/auth/auth";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";

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
  const { session: authSession } = useAuth();
  const [enterModal, setEnterModal] = useState<string | null>(null);
  const launchCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => launchCleanupRef.current?.(), []);

  /**
   * Hand the exam AND the signed-in session to the Vignan Exam Browser via
   * vignan-exam://. The kiosk restores this session before its first render,
   * so it opens directly on the system-check screen — no login, no role
   * switch, no console detour inside the app.
   */
  function launchExam(examId: string) {
    launchCleanupRef.current?.();
    const roll = profile && "roll" in profile ? profile.roll : "";
    const handoff = authSession?.access_token && authSession?.refresh_token
      ? { access_token: authSession.access_token, refresh_token: authSession.refresh_token }
      : null;
    launchCleanupRef.current = launchExamInLockdown(examId, roll, () => setEnterModal(examId), handoff);
  }

  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { getSupabase } = await import("@/shared/data/supabase");
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
      // null = query failed / keep last-known rows; only a real result replaces.
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
                    // Already inside the lockdown browser — the exam page
                    // starts at the system check step and flows through
                    // device access → registration → start → exam.
                    void navigate(`/student/exam?examId=${encodeURIComponent(r.id)}`);
                  } else {
                    // Normal browser: launch the kiosk app synchronously in the
                    // click gesture. launchExamInLockdown watches visibility and
                    // only shows the fallback when the app truly did not open.
                    launchExam(r.id);
                  }
                }}
                className="border border-maroon bg-maroon px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-maroon/90"
              >
                Enter exam /
              </button>
            ) : r.status === "completed" ? (
              <Link to="/student/results" className="border border-line-strong px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">View result /</Link>
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

      {/* Fallback: shown ONLY when the vignan-exam:// launch was not picked up
          by the OS (app not installed, or macOS Gatekeeper blocked it). Never
          routes to /student/exam — a normal browser must never reach the exam
          (it would bounce through ProtectedRoute into the login page). */}
      {enterModal && (() => {
        const os = detectOS();
        const href = downloadUrl(os) || "";
        const row = rows.find(x => x.id === enterModal);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 px-4 backdrop-blur-sm">
            <div className="w-full max-w-md border border-line bg-paper p-6 shadow-2xl">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Lockdown required</p>
              <h2 className="mt-2 font-serif text-xl font-semibold">Vignan Exam Browser didn&apos;t open</h2>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-maroon">{row?.name ?? ""}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
                The exam opens only inside the <strong className="text-ink">Vignan Exam Browser</strong> desktop app.
                If it is installed but macOS blocked it with &ldquo;Apple could not verify&rdquo;, unblock it once below —
                then <strong className="text-ink">Try again</strong> opens your exam directly at the system check.
              </p>
              <GatekeeperHelp />
              <div className="mt-5 flex flex-col gap-2">
                <button
                  onClick={() => {
                    setEnterModal(null);
                    launchExam(enterModal);
                  }}
                  className="w-full border border-maroon bg-maroon py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon/90"
                >
                  Try again /
                </button>
                {href && (
                  <a
                    href={href}
                    download
                    className="w-full border border-line py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-raised"
                  >
                    Download installer ({osLabel(os)}) /
                  </a>
                )}
                <button
                  onClick={() => setEnterModal(null)}
                  className="border border-line px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
  })()}
    </RoleLayout>
  );
}
