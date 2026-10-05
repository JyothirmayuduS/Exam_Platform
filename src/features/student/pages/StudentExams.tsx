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
import { STUDENT_NAV, STUDENT_TONE } from "@/features/student/navigation";


type Row = { id: string; name: string; meta: string; when: string; status: "published" | "scheduled" | "completed" };

function toRow(e: ExamRecord): Row {
  const when = e.scheduled_at ? new Date(e.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Available now";
  return {
    id: e.id,
    name: e.name,
    meta: `${e.batch} · ${e.duration_minutes} min · ${e.total_marks} marks`,
    when: e.status === "scheduled" ? when : "Available now",
    status: e.my_attempt_state === "submitted" ? "completed" : e.status === "published" ? "published" : "scheduled",
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
      setLive(true);
      setLoading(false);
      // null = query failed / keep last-known rows; only a real result replaces.
      if (data) {
        setRows(data.map(toRow));
      }
    };
    void load();
    let unsub: () => void = () => {};
    void (async () => {
      const { getSupabase } = await import("@/shared/data/supabase");
      const db = getSupabase();
      if (!db || !active) return;
      const { data: { user } } = await db.auth.getUser();
      if (!user || !active) return;
      const { data: st } = await db.from("students").select("id").eq("auth_id", user.id).maybeSingle();
      if (!active) return;
      unsub = subscribeToStudentExams(st?.id ?? null, () => void load());
    })();
    return () => { active = false; unsub(); };
  }, []);

  const badge: Record<Row["status"], string> = {
    published: "border-forest/40 bg-forest/5 text-forest",
    scheduled: "border-amber/40 bg-amber/5 text-amber",
    completed: "border-line bg-paper-raised text-ink-soft",
  };

  return (
    <RoleLayout role="Student" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone={STUDENT_TONE} items={STUDENT_NAV} status={live ? "Synced" : "Profile verified"}>
      <section className="border border-line bg-paper">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Assessments</p>
            <h1 className="mt-2 font-serif text-3xl font-semibold">My exams</h1>
            <p className="mt-2 text-[13px] text-ink-soft">Enter open papers in the Vignan Exam Browser. Scheduled papers appear here when released.</p>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{rows.length} total</span>
        </div>

        <div className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-serif text-lg font-semibold">{r.name}</p>
                  <span className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${badge[r.status]}`}>{r.status}</span>
                </div>
                <p className="mt-1 text-[13px] text-ink-soft">{r.meta}</p>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">{r.when}</p>
              </div>
              {r.status === "published" ? (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    if (isTauri()) {
                      void navigate(`/student/exam?examId=${encodeURIComponent(r.id)}`);
                    } else {
                      launchExam(r.id);
                    }
                  }}
                  className="border border-forest bg-forest px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90"
                >
                  Enter exam
                </button>
              ) : r.status === "completed" ? (
                <Link to="/student/results" className="border border-line bg-paper-raised px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">
                  View result
                </Link>
              ) : (
                <span className="border border-line px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft">Scheduled</span>
              )}
            </div>
          ))}
          {loading && rows.length === 0 && (
            <div className="space-y-0">{[0, 1, 2].map((i) => <div key={i} className="h-24 border-b border-line bg-paper-raised/50" />)}</div>
          )}
          {!loading && rows.length === 0 && (
            <div className="px-5 py-12 text-center text-[13px] text-ink-soft">
              No exams assigned yet. Published exams appear here when your teacher releases them.
            </div>
          )}
        </div>
      </section>

      {enterModal && (() => {
        const os = detectOS();
        const href = downloadUrl(os) || "";
        const row = rows.find((x) => x.id === enterModal);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
            <div className="w-full max-w-md border border-line bg-paper p-6">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Lockdown required</p>
              <h2 className="mt-2 font-serif text-xl font-semibold">Vignan Exam Browser didn&apos;t open</h2>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-forest">{row?.name ?? ""}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
                This exam opens only inside the <strong className="text-ink">Vignan Exam Browser</strong> desktop app.
                If macOS blocked it, unblock once below, then try again.
              </p>
              <GatekeeperHelp />
              <div className="mt-5 flex flex-col gap-2">
                <button
                  onClick={() => {
                    setEnterModal(null);
                    launchExam(enterModal);
                  }}
                  className="w-full border border-forest bg-forest py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest/90"
                >
                  Try again
                </button>
                {href && (
                  <a
                    href={href}
                    download
                    className="w-full border border-line py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-paper-raised"
                  >
                    Download installer ({osLabel(os)})
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
