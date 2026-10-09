import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getSupabase } from "@/shared/data/supabase";
import { completeLtiLaunch, type LtiSessionResult } from "@/shared/data/api/lti";

// React StrictMode runs effects twice in development; a ticket works once.
const exchanges = new Map<string, Promise<LtiSessionResult>>();

const MESSAGES: Record<string, { title: string; body: string }> = {
  not_mapped: { title: "This activity is not linked to an exam yet", body: "Your teacher has not connected this Moodle activity to an exam. Please ask them to link it, then open it again from Moodle." },
  wrong_exam: { title: "This link cannot open that exam", body: "A Moodle activity only opens the exam it is linked to. Go back to Moodle and open the activity for the exam you want." },
  exam_unavailable: { title: "This exam is not open", body: "The linked exam is not published yet. Try again from Moodle when your teacher opens it." },
  expired_login: { title: "The Moodle sign-in expired", body: "Go back to Moodle and open the activity again." },
  expired_ticket: { title: "The Moodle sign-in expired", body: "Go back to Moodle and open the activity again." },
  invalid_token: { title: "Moodle could not be verified", body: "The launch from Moodle could not be verified. Open the activity again; if this keeps happening, tell your teacher." },
  unknown_platform: { title: "This Moodle site is not registered", body: "The exam platform does not recognise this Moodle site. Your Moodle administrator needs to finish the setup." },
  no_account: { title: "Your account could not be linked", body: "Your Moodle account could not be matched to an exam account. Please contact your teacher." },
};
const FALLBACK = { title: "Could not open the exam", body: "Something went wrong while opening the exam from Moodle. Go back to Moodle and try again." };

/** Landing page for a Moodle launch: signs the student in as their Moodle
 *  user and opens the exam the activity is mapped to. */
export default function LtiLaunch() {
  const navigate = useNavigate();
  const [launch] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      ticket: new URLSearchParams(window.location.hash.slice(1)).get("ticket"),
      exam: query.get("exam"),
      error: query.get("error"),
      instructor: query.get("status") === "instructor" ? { activity: query.get("activity") ?? "", exam: query.get("exam") } : null,
    };
  });
  const instructor = launch.instructor;
  const [error, setError] = useState<string | null>(
    () => launch.error ?? (!instructor && (!launch.ticket || !getSupabase()) ? "expired_ticket" : null),
  );

  useEffect(() => {
    const { ticket } = launch;
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const db = getSupabase();
    if (launch.instructor || launch.error || !ticket || !db) return;
    let run = exchanges.get(ticket);
    if (!run) {
      run = completeLtiLaunch(db, ticket, launch.exam);
      exchanges.set(ticket, run);
    }
    let active = true;
    void run.then((res) => {
      if (!active) return;
      if (res.ok) navigate(`/student/exams/${encodeURIComponent(res.examId)}`, { replace: true });
      else setError(res.error);
    });
    return () => { active = false; };
  }, [launch, navigate]);

  if (instructor) {
    return (
      <Panel kicker="Moodle · Teacher view" title={instructor.exam ? `Linked to ${instructor.exam}` : "Not linked to an exam yet"}>
        {instructor.exam
          ? <>Students who open <b>{instructor.activity || "this activity"}</b> go straight to exam <b>{instructor.exam}</b>, signed in as themselves. Scores are sent back to this activity's grade column.</>
          : <>To link <b>{instructor.activity || "this activity"}</b>, sign in to the exam platform as a teacher, open the exam, go to <b>Candidates → Moodle links</b> and choose “Link to this exam”.</>}
      </Panel>
    );
  }
  if (error) {
    const m = MESSAGES[error] ?? FALLBACK;
    return <Panel kicker="Moodle" title={m.title} tone="alert">{m.body}</Panel>;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper">
      <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
        <span className="relative block h-10 w-10" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-line" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-forest" />
        </span>
        <p className="font-mono text-[11px] uppercase tracking-widest text-soft">Opening your exam from Moodle</p>
      </div>
    </div>
  );
}

function Panel({ kicker, title, tone, children }: { kicker: string; title: string; tone?: "alert"; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 py-12 text-center">
      <div className="w-full max-w-md border border-line-strong bg-paper p-8 shadow-xl" role={tone === "alert" ? "alert" : undefined}>
        <p className={`font-mono text-[12px] uppercase tracking-widest ${tone === "alert" ? "text-alert" : "text-soft"}`}>{kicker}</p>
        <h1 className="mt-2 font-serif text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-4 text-[13px] text-ink-soft">{children}</p>
      </div>
    </div>
  );
}
