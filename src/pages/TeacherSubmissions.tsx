import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { evaluationPath, needsAttention, type Attempt, type AttemptState } from "../data/examSession";
import useLiveAttempts from "../hooks/useLiveAttempts";
import useTeacherExams from "../hooks/useTeacherExams";
import { listLiveAttempts, forceSubmitAttempt, extendAttemptTime, sendProctorMessage } from "../lib/examApi";
import { downloadCsv } from "../lib/sessionReport";
import { FiUpload, FiSend, FiEye, FiClock, FiMessageSquare, FiAlertTriangle, FiChevronRight } from "react-icons/fi";
import { Button } from "../components/ui";
import { getSupabase } from "../lib/supabase";

type StatusTab = "All" | AttemptState | "Needs attention";
const TABS: StatusTab[] = ["All", "Submitted", "In progress", "Not started", "Needs attention"];
const SORTS = ["Progress", "Time used", "Roll number", "Name"] as const;

const donePct = (a: Attempt) => (a.total ? Math.round((a.answered / a.total) * 100) : 0);
const stateTone = (s: AttemptState) => (s === "Submitted" ? "text-success" : s === "In progress" ? "text-forest" : "text-amber");
const netTone = (n: string) => (n === "Stable" ? "text-success" : n === "Offline" ? "text-alert" : "text-amber");
function hms(total: number) {
  const s = Math.max(0, total);
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  return `${h}:${m}:${(s % 60).toString().padStart(2, "0")}`;
}
function clock(dateIso: string | null) {
  if (!dateIso) return "—";
  return new Date(dateIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TeacherSubmissions({ notify }: { notify: (message: string) => void }) {
  const navigate = useNavigate();
  const { exams, examId, exam, selectExam, loading: examsLoading } = useTeacherExams();
  const [tab, setTab] = useState<StatusTab>("All");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]>("Progress");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { data: attempts = [], isLoading } = useLiveAttempts(examId ?? "", exam?.name ?? "");

  // One tick per second only while a scheduled window is open, so the strip
  // countdown is real (derived from the exam schedule), never fabricated.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const counts = useMemo(
    () => ({
      All: attempts.length,
      Submitted: attempts.filter((a) => a.state === "Submitted").length,
      "In progress": attempts.filter((a) => a.state === "In progress").length,
      Paused: attempts.filter((a) => a.state === "Paused").length,
      "Not started": attempts.filter((a) => a.state === "Not started").length,
      "Needs attention": attempts.filter(needsAttention).length,
    }),
    [attempts],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = attempts.filter((a) => {
      const matchesTab = tab === "All" || (tab === "Needs attention" ? needsAttention(a) : a.state === tab);
      return matchesTab && (!q || `${a.name} ${a.roll}`.toLowerCase().includes(q));
    });
    if (sort === "Name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "Roll number") list.sort((a, b) => a.roll.localeCompare(b.roll));
    else if (sort === "Time used") list.sort((a, b) => b.minutesUsed - a.minutesUsed);
    else list.sort((a, b) => donePct(b) - donePct(a));
    return list;
  }, [attempts, tab, search, sort]);

  const selected = attempts.find((a) => a.id === selectedId) ?? visible[0] ?? attempts[0];
  const stillWriting = attempts.filter((a) => a.state === "In progress").length;
  const notStarted = attempts.filter((a) => a.state === "Not started");
  const submittedFeed = attempts.filter((a) => a.state === "Submitted").slice(0, 5);

  // Real window state from the exam schedule (not a fake countdown).
  const scheduledEndMs = exam?.scheduled_at
    ? new Date(exam.scheduled_at).getTime() + (exam.duration_minutes || 0) * 60 * 1000
    : null;
  const windowOpen = exam && exam.status !== "completed" && exam.status !== "draft";
  const remainingSec = scheduledEndMs ? Math.max(0, Math.round((scheduledEndMs - now) / 1000)) : null;
  const windowEnded = scheduledEndMs !== null && now >= scheduledEndMs;

  const openEvaluation = (a: Attempt) => {
    if (a.state !== "Submitted") {
      notify(`${a.name} has not submitted yet — the paper opens for evaluation after submit`);
      return;
    }
    navigate(evaluationPath(a.id));
  };

  // Real DB actions scoped to the selected exam.
  const openAttempts = async () => {
    if (!examId) return [];
    const rows = await listLiveAttempts(examId);
    return rows.filter((r) => r.state === "in_progress" || r.state === "paused");
  };
  const forceSubmitAll = async () => {
    const open = await openAttempts();
    let ok = 0;
    for (const r of open) if (await forceSubmitAttempt(r.id)) ok += 1;
    notify(ok ? `Force submitted ${ok} open attempt(s) in ${exam?.name ?? "this exam"}` : open.length ? "Force submit failed — database unavailable" : "No open attempts to force submit");
  };
  const extendAll = async () => {
    const open = await openAttempts();
    if (!open.length) { notify("No in-progress candidates to extend"); return; }
    for (const r of open) await extendAttemptTime(r.id, 5);
    notify(`Extended ${open.length} candidate(s) by 5 minutes`);
  };
  const remind = async (studentEmail?: string | null) => {
    if (!examId) { notify("Select an exam first"); return; }
    const db = getSupabase();
    if (!db) { notify("Reminder service unavailable (offline)."); return; }
    const { error } = await db.functions.invoke("send-reminder-email", {
      body: { examId, studentEmail: studentEmail ?? null },
    });
    notify(error ? `Reminder failed: ${error.message}` : studentEmail ? "Reminder sent to candidate" : `Reminder queued for ${notStarted.length} candidate(s)`);
  };
  const broadcast = () => {
    if (!examId) { notify("Select an exam first"); return; }
    const body = window.prompt("Announcement for all candidates:");
    if (body?.trim()) {
      void sendProctorMessage({ examId, sender: "Teacher", senderRole: "teacher", body, kind: "broadcast" }).then((ok) =>
        notify(ok ? "Announcement broadcast to all candidates" : "Announcement failed — database unavailable"),
      );
    }
  };
  const watchLive = (a: Attempt) => {
    if (!examId) return;
    navigate(`/teacher/proctoring?examId=${encodeURIComponent(examId)}&focus=${encodeURIComponent(a.roll)}`);
  };

  // Real exports/actions for the header + selected-attempt panel.
  const exportRosterCsv = () => {
    downloadCsv(
      `roster_${examId ?? "all"}_${new Date().toISOString().slice(0, 10)}`,
      ["Candidate", "Roll", "Exam", "State", "Answered", "Total", "Minutes used", "Flags", "Email"],
      visible.map((a) => [a.name, a.roll, a.exam, a.state, a.answered, a.total, a.minutesUsed, a.flags.length, a.email ?? ""]),
    );
    notify(`Roster CSV exported · ${visible.length} rows`);
  };
  const grantExtraTime = async (a: Attempt) => {
    const ok = await extendAttemptTime(a.id, 5);
    notify(ok ? `Granted +5 minutes to ${a.name}` : `Could not extend ${a.name} — attempt unavailable`);
  };
  const messageCandidate = async (a: Attempt) => {
    if (!examId) { notify("Select an exam first"); return; }
    const body = window.prompt(`Message for ${a.name}:`);
    if (!body?.trim()) return;
    const ok = await sendProctorMessage({
      examId,
      sender: "Teacher",
      senderRole: "teacher",
      body,
      kind: "message",
    });
    notify(ok ? `Message sent to ${a.name}` : "Message failed — database unavailable");
  };

  return <>
    <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Submissions</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Track attempts as they come in</h1>
        <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">This page follows the attempt itself — progress, time used, connection, and integrity. Answer papers are graded from <button onClick={() => navigate(examId ? `/teacher/evaluate?examId=${encodeURIComponent(examId)}` : "/teacher/evaluate")} className="text-forest underline">Evaluate</button>.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<FiSend />} onClick={broadcast} disabled={!examId}>Send announcement</Button>
        <Button icon={<FiUpload />} onClick={exportRosterCsv} disabled={!attempts.length}>Export roster</Button>
      </div>
    </div>

    {windowOpen && <section className="mt-8 border border-alert/30 bg-alert/5 p-5">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Live window · {exam?.name}</p>
          <p className="mt-1 text-[13px]">
            {stillWriting} candidate(s) still writing
            {windowEnded ? " — the window has ended; unsubmitted papers were auto-submitted." : " — unsubmitted papers are auto-submitted when the window closes."}
          </p>
          <p className="mt-1 font-mono text-[10px] text-ink-soft">
            {exam?.scheduled_at
              ? `Opened ${clock(exam.scheduled_at)} · ${exam?.duration_minutes ?? 0} minute window${windowEnded ? " · ended" : remainingSec != null && remainingSec <= 60 ? " · closing now" : ""}`
              : "Published immediately · duration is per candidate"}
          </p>
        </div>
        {!windowEnded && scheduledEndMs != null && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="border border-alert/40 bg-paper px-4 py-2 text-center">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Time left in window</p>
              <p className="tabular font-mono text-[15px] text-alert">{hms(remainingSec ?? 0)}</p>
            </div>
            <Button variant="secondary" size="sm" icon={<FiClock />} onClick={() => void extendAll()}>+5 min for all</Button>
            <Button variant="danger" size="sm" icon={<FiAlertTriangle />} onClick={() => void forceSubmitAll()}>Force submit remaining</Button>
          </div>
        )}
      </div>
    </section>}

    {!examsLoading && !exam && (
      <section className="mt-8 border border-dashed border-line-strong bg-paper p-10 text-center">
        <h2 className="font-serif text-xl font-semibold">No exams to monitor yet</h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] text-ink-soft">Create and publish a test from <button onClick={() => navigate("/teacher/exams")} className="text-forest underline">My tests</button>, then live attempts from enrolled candidates appear here.</p>
      </section>
    )}

    {exam && <>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Insight label="Submitted" value={`${counts.Submitted}`} detail={`${counts.All ? Math.round((counts.Submitted / counts.All) * 100) : 0}% of this roster`} tone="text-success" />
        <Insight label="Writing now" value={`${counts["In progress"]}`} detail="Attempt still open" tone="text-forest" />
        <Insight label="Not started" value={`${counts["Not started"]}`} detail="No sign-in yet" tone="text-amber" />
        <Insight label="Needs attention" value={`${counts["Needs attention"]}`} detail="Flags or lost connection" tone="text-alert" />
      </div>

      <section className="mt-6 border border-line bg-paper p-4">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${tab === t ? (t === "Needs attention" ? "border-alert bg-alert text-paper" : "border-forest bg-forest text-paper") : "border-line-strong text-ink-soft hover:border-forest hover:text-ink"}`}>{t} · {counts[t]}</button>)}
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_180px]">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search candidate name or roll number" className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest" />
          <label className="sr-only" htmlFor="sub-exam">Exam</label>
          <select
            id="sub-exam"
            value={examId ?? ""}
            onChange={(e) => selectExam(e.target.value)}
            className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest"
          >
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}{e.status === "draft" ? " (draft)" : ""}</option>)}
          </select>
          <label className="sr-only" htmlFor="sub-sort">Sort by</label>
          <select id="sub-sort" value={sort} onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest">{SORTS.map((s) => <option key={s}>{s}</option>)}</select>
        </div>
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line bg-paper-raised px-5 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Attempt roster · {exam.name}</p>
            <span className="font-mono text-[10px] text-ink-soft">Showing {visible.length} of {attempts.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-[13px]">
              <thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft"><th className="px-5 py-3">Candidate</th><th className="px-5 py-3">Attempt progress</th><th className="px-5 py-3">Time used</th><th className="px-5 py-3">Connection</th><th className="px-5 py-3">Integrity</th><th className="px-5 py-3">State</th><th className="px-5 py-3" /></tr></thead>
              <tbody>
                {visible.map((a) => <tr key={a.id} onClick={() => setSelectedId(a.id)} className={`cursor-pointer border-b border-line last:border-0 ${selected?.id === a.id ? "bg-success/5" : needsAttention(a) ? "bg-alert/[0.03] hover:bg-alert/5" : "hover:bg-paper-raised"}`}>
                  <td className="px-5 py-4"><button onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); }} className="text-left font-medium hover:text-forest hover:underline">{a.name}</button><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{a.roll}</p></td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2"><div className="h-1.5 w-24 bg-line"><div className={`h-full ${a.state === "Submitted" ? "bg-success" : "bg-forest"}`} style={{ width: `${donePct(a)}%` }} /></div><span className="tabular font-mono text-[10px] text-ink-soft">{a.answered}/{a.total}</span></div>
                    <p className="mt-1 font-mono text-[10px] text-ink-soft">Autosaved {a.autoSaveAt || "never"}</p>
                  </td>
                  <td className="px-5 py-4"><p className="tabular text-[12px]">{a.minutesUsed ? `${a.minutesUsed} min` : "—"}</p><p className="mt-0.5 font-mono text-[10px] text-ink-soft">Started {a.startedAt}</p></td>
                  <td className="px-5 py-4"><p className={`font-mono text-[10px] uppercase tracking-wider ${netTone(a.network)}`}>{a.network}</p><p className="mt-0.5 text-[11px] text-ink-soft">{a.device}</p></td>
                  <td className="px-5 py-4">{a.flags.length ? <span className="border border-alert/30 bg-alert/5 px-2 py-1 font-mono text-[10px] text-alert">{a.flags.length} flag{a.flags.length > 1 ? "s" : ""}</span> : <span className="font-mono text-[10px] text-success">Clean</span>}</td>
                  <td className="px-5 py-4"><p className={`font-mono text-[10px] uppercase tracking-wider ${stateTone(a.state)}`}>{a.state === "In progress" && "● "}{a.state}</p><p className="mt-0.5 text-[11px] text-ink-soft">{a.state === "Submitted" ? a.submittedAgo : a.lastActivity}</p></td>
                  <td className="px-5 py-4 text-right">
                    {a.state === "Submitted"
                      ? <Button size="sm" onClick={(e) => { e.stopPropagation(); openEvaluation(a); }} iconRight={<FiChevronRight />}>Evaluate</Button>
                      : a.state === "In progress"
                        ? <Button size="sm" variant="secondary" icon={<FiEye />} onClick={(e) => { e.stopPropagation(); watchLive(a); }}>Watch live</Button>
                        : <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void remind(a.email); }}>Remind</Button>}
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {isLoading && <div className="p-10 text-center text-[12px] text-ink-soft">Loading attempt roster…</div>}
          {!isLoading && visible.length === 0 && <div className="p-10 text-center"><p className="font-serif text-lg">No attempts match this view</p><p className="mt-1 text-[12px] text-ink-soft">Clear the search or switch the status tab. Enrolled candidates who have not signed in appear as "Not started".</p></div>}
        </section>
        <aside className="space-y-5">
          {selected && <section className={`border p-5 ${needsAttention(selected) ? "border-alert/40 bg-alert/5" : "border-forest bg-success/5"}`}>
            <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Selected attempt</p>
            <div className="mt-3 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-line-strong bg-paper font-serif text-ink-soft">{selected.initials}</span>
              <div className="min-w-0"><h2 className="font-serif text-xl font-semibold">{selected.name}</h2><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{selected.roll} · {selected.exam}</p></div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-y border-line/60 py-4">
              <SmallStat label="Answered" value={`${selected.answered} / ${selected.total}`} />
              <SmallStat label="Time used" value={selected.minutesUsed ? `${selected.minutesUsed} min` : "—"} />
            </div>
            <div className="mt-4 space-y-2 text-[12px]">
              <Row label="State" value={selected.state} />
              <Row label="Last activity" value={selected.lastActivity} />
              <Row label="Connection" value={`${selected.network}${selected.device !== "—" ? ` · ${selected.device}` : ""}`} />
              <Row label="Last autosave" value={selected.autoSaveAt || "—"} />
              <Row label="Integrity" value={selected.flags.length ? `${selected.flags.length} flag(s)` : "Clean"} />
            </div>
            {selected.flags.length > 0 && <ul className="mt-3 space-y-1.5 border-t border-line/60 pt-3">
              {selected.flags.map((f, i) => <li key={i} className="flex items-start gap-2 text-[11px]"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${f.severity === "critical" ? "bg-alert" : "bg-amber"}`} /><span><span className="font-medium">{f.label}</span> <span className="font-mono text-[10px] text-ink-soft">{f.at}</span></span></li>)}
            </ul>}
            <div className="mt-5 grid gap-2">
              {selected.state === "Submitted"
                ? <Button size="lg" iconRight={<FiChevronRight />} onClick={() => openEvaluation(selected)}>Open in evaluation</Button>
                : <Button size="lg" disabled>Evaluation opens after submit</Button>}
              {selected.state !== "Not started" && <Button size="lg" variant="secondary" icon={<FiEye />} onClick={() => watchLive(selected)}>Watch proctoring feed</Button>}
              {selected.state === "In progress" && <Button size="lg" variant="secondary" icon={<FiClock />} onClick={() => void grantExtraTime(selected)}>Grant +5 minutes</Button>}
              <Button size="lg" variant="secondary" icon={<FiMessageSquare />} onClick={() => void messageCandidate(selected)}>Message candidate</Button>
            </div>
          </section>}

          <section className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Latest submissions</p>
            <h2 className="mt-1 font-serif text-xl font-semibold">Ready to evaluate</h2>
            <div className="mt-4 space-y-2">
              {submittedFeed.map((a) => <button key={a.id} onClick={() => openEvaluation(a)} className="flex w-full items-center justify-between gap-3 border-l-2 border-success px-3 py-2 text-left transition hover:bg-paper-raised">
                <span><span className="block text-[12px] font-medium">{a.name}</span><span className="mt-0.5 block font-mono text-[10px] text-ink-soft">{a.submittedAgo} · {a.answered}/{a.total} answered</span></span>
                <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-forest">Evaluate <FiChevronRight /></span>
              </button>)}
              {submittedFeed.length === 0 && <p className="text-[12px] text-ink-soft">No submissions in this view yet.</p>}
            </div>
          </section>

          {notStarted.length > 0 && <section className="border border-amber/40 bg-amber/5 p-5">
            <div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-widest text-amber">Not started</p><span className="rounded-full bg-amber px-2 py-1 font-mono text-[9px] text-paper">{notStarted.length}</span></div>
            <div className="mt-3 space-y-2">
              {notStarted.map((a) => <div key={a.id} className="flex items-center justify-between gap-3 text-[12px]"><span>{a.name}<span className="mt-0.5 block font-mono text-[10px] text-ink-soft">{a.lastActivity}</span></span><button onClick={() => void remind(a.email)} className="font-mono text-[10px] uppercase tracking-wider text-amber hover:underline">Remind</button></div>)}
            </div>
            <button onClick={() => void remind()} className="mt-4 w-full border border-amber px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-amber hover:bg-amber/10">Remind everyone</button>
          </section>}
        </aside>
      </div>
    </>}
  </>;
}

function Insight({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <div className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p><p className={`mt-2 font-serif text-3xl ${tone}`}>{value}</p><p className="mt-1 text-[12px] text-ink-soft">{detail}</p></div>;
}
function SmallStat({ label, value }: { label: string; value: string }) {
  return <div><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p><p className="mt-1 font-serif text-xl">{value}</p></div>;
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-ink-soft">{label}</span><span className="text-right font-medium">{value}</span></div>;
}
