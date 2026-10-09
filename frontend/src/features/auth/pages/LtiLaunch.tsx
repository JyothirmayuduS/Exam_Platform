import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/auth";
import { getSupabase } from "@/shared/data/supabase";
import { claimMoodleInstructor, completeLtiLaunch, type LtiSessionResult } from "@/shared/data/api/lti";

// React StrictMode runs effects twice in development; tickets and claims work once.
const exchanges = new Map<string, Promise<LtiSessionResult>>();
const claims = new Map<string, Promise<{ error?: string }>>();

/** The instructor claim survives the teacher sign-in round trip in this tab. */
const CLAIM_KEY = "vignan.lti_claim";
const CLAIM_TTL_MS = 15 * 60_000;

function rememberClaim(claim: string | null): string | null {
  try {
    if (claim) {
      sessionStorage.setItem(CLAIM_KEY, JSON.stringify({ claim, at: Date.now() }));
      return claim;
    }
    const saved = JSON.parse(sessionStorage.getItem(CLAIM_KEY) ?? "null") as { claim?: string; at?: number } | null;
    return saved?.claim && Date.now() - Number(saved.at) < CLAIM_TTL_MS ? saved.claim : null;
  } catch {
    return claim;
  }
}

const MESSAGES: Record<string, { title: string; body: string }> = {
  not_mapped: { title: "This activity is not linked to an exam yet", body: "Your teacher has not connected this Moodle activity to an exam. Please ask them to link it, then open it again from Moodle." },
  wrong_exam: { title: "This link cannot open that exam", body: "A Moodle activity only opens the exam it is linked to. Go back to Moodle and open the activity for the exam you want." },
  exam_unavailable: { title: "This exam is not open", body: "The linked exam is not published yet. Try again from Moodle when your teacher opens it." },
  account_pending: { title: "Your account is waiting for your teacher", body: "Your Moodle account is not linked to an exam account yet. Your teacher has been asked to confirm it; open the activity again from Moodle once they have." },
  no_roles: { title: "Moodle did not say who you are in this course", body: "The launch from Moodle had no course role, so the exam cannot open. Ask your teacher to check that you are enrolled in the course." },
  unsupported_role: { title: "This Moodle role cannot open the exam", body: "Only students (Learner) and teachers (Instructor) of the course can use this activity. Ask your teacher to check your role in the Moodle course." },
  expired_login: { title: "The Moodle sign-in expired", body: "Go back to Moodle and open the activity again." },
  expired_ticket: { title: "The Moodle sign-in expired", body: "Go back to Moodle and open the activity again." },
  invalid_token: { title: "Moodle could not be verified", body: "The launch from Moodle could not be verified. Open the activity again; if this keeps happening, tell your teacher." },
  platform_unreachable: { title: "Moodle did not answer in time", body: "The exam platform could not check the launch with Moodle. Wait a moment and open the activity again." },
  unknown_platform: { title: "This Moodle site is not registered", body: "The exam platform does not recognise this Moodle site. Your Moodle administrator needs to finish the setup." },
  no_account: { title: "Your account could not be linked", body: "Your Moodle account could not be matched to an exam account. Please contact your teacher." },
};
const FALLBACK = { title: "Could not open the exam", body: "Something went wrong while opening the exam from Moodle. Go back to Moodle and try again." };

/** Landing page for a Moodle launch: signs the student in as their Moodle
 *  user and opens the exam the activity is mapped to, or lets a teacher tie
 *  their Moodle course to their platform account. */
export default function LtiLaunch() {
  const navigate = useNavigate();
  const [launch] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const instructor = query.get("status") === "instructor";
    return {
      ticket: hash.get("ticket"),
      exam: query.get("exam"),
      error: query.get("error"),
      instructor: instructor ? { activity: query.get("activity") ?? "", exam: query.get("exam"), claim: rememberClaim(hash.get("claim")) } : null,
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

  if (instructor) return <InstructorView {...instructor} />;
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

/** A Moodle instructor is never signed in by the launch. A platform teacher
 *  signed in here redeems the one-time claim, which lets them manage this
 *  Moodle course's activities. */
function InstructorView({ activity, exam, claim }: { activity: string; exam: string | null; claim: string | null }) {
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const [result, setResult] = useState<{ error?: string } | null>(null);
  const teacher = !loading && !!user && role === "teacher";

  useEffect(() => {
    if (!teacher || !claim) return;
    let run = claims.get(claim);
    if (!run) {
      run = claimMoodleInstructor(claim);
      claims.set(claim, run);
    }
    let active = true;
    void run.then((res) => {
      try { sessionStorage.removeItem(CLAIM_KEY); } catch { /* storage blocked */ }
      if (active) setResult(res);
    });
    return () => { active = false; };
  }, [teacher, claim]);

  const name = activity || "this activity";
  const status = exam
    ? <>Students who open <b>{name}</b> go straight to exam <b>{exam}</b>, signed in as themselves. Scores go to this activity's grade column.</>
    : <><b>{name}</b> is not linked to an exam yet.</>;

  if (result && !result.error) {
    return (
      <Panel kicker="Moodle · Teacher view" title="Your Moodle course is linked">
        {status} Open your exam on the platform and go to <b>Candidates → Moodle links</b> to link this activity or confirm waiting students.
        <span className="mt-6 block"><button onClick={() => navigate("/teacher/exams")} className="border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light">Go to my exams</button></span>
      </Panel>
    );
  }
  return (
    <Panel kicker="Moodle · Teacher view" title={exam ? `Linked to ${exam}` : "Not linked to an exam yet"} tone={result?.error ? "alert" : undefined}>
      {result?.error ?? status}
      {!result && !claim && <span className="mt-4 block">To manage this course's activities, open the activity in Moodle again.</span>}
      {!result && claim && !teacher && !loading && (
        <span className="mt-6 block">
          <span className="block">Sign in as a platform teacher to manage this Moodle course's activities.</span>
          <button
            onClick={() => navigate("/login?role=teacher", { state: { from: { pathname: "/lti/launch", search: window.location.search } } })}
            className="mt-4 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light"
          >
            Link my Moodle course
          </button>
        </span>
      )}
      {!result && claim && teacher && <span className="mt-4 block" role="status">Linking your Moodle course…</span>}
    </Panel>
  );
}

function Panel({ kicker, title, tone, children }: { kicker: string; title: string; tone?: "alert"; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 py-12 text-center">
      <div className="w-full max-w-md border border-line-strong bg-paper p-8 shadow-xl" role={tone === "alert" ? "alert" : undefined}>
        <p className={`font-mono text-[12px] uppercase tracking-widest ${tone === "alert" ? "text-alert" : "text-soft"}`}>{kicker}</p>
        <h1 className="mt-2 font-serif text-2xl font-semibold text-ink">{title}</h1>
        <div className="mt-4 text-[13px] text-ink-soft">{children}</div>
      </div>
    </div>
  );
}
