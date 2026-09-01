import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LIVE_EXAM, SESSION_MINUTES, evaluationPath, needsAttention, type Attempt, type AttemptState, type Network } from "../data/examSession";
import useLiveAttempts from "../hooks/useLiveAttempts";

type StatusTab = "All" | AttemptState | "Needs attention";
const TABS: StatusTab[] = ["All", "Submitted", "In progress", "Not started", "Needs attention"];
const SORTS = ["Progress", "Time used", "Roll number", "Name"] as const;

const donePct = (a: Attempt) => (a.total ? Math.round((a.answered / a.total) * 100) : 0);
const stateTone = (s: AttemptState) => (s === "Submitted" ? "text-success" : s === "In progress" ? "text-forest" : "text-amber");
const netTone = (n: Network) => (n === "Stable" ? "text-success" : n === "Offline" ? "text-alert" : "text-amber");
function hms(total: number) {
  const s = Math.max(0, total);
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  return `${h}:${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function TeacherSubmissions({ notify }: { notify: (message: string) => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<StatusTab>("All");
  const [exam, setExam] = useState<string>(LIVE_EXAM);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]>("Progress");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(18 * 60 + 24);
  const [extended, setExtended] = useState(0);

  const { data: attempts = [], isLoading } = useLiveAttempts("EXAM-2026-014", LIVE_EXAM);

  useEffect(() => {
    const id = window.setInterval(() => setRemaining((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const exams = useMemo(() => ["All exams", ...Array.from(new Set(attempts.map((a) => a.exam)))], [attempts]);
  const scoped = useMemo(() => attempts.filter((a) => exam === "All exams" || a.exam === exam), [exam, attempts]);

  const counts = useMemo(() => ({
    All: scoped.length,
    Submitted: scoped.filter((a) => a.state === "Submitted").length,
    "In progress": scoped.filter((a) => a.state === "In progress").length,
    "Not started": scoped.filter((a) => a.state === "Not started").length,
    "Needs attention": scoped.filter(needsAttention).length,
  }), [scoped]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = scoped.filter((a) => {
      const matchesTab = tab === "All" || (tab === "Needs attention" ? needsAttention(a) : a.state === tab);
      return matchesTab && (!q || `${a.name} ${a.roll}`.toLowerCase().includes(q));
    });
    if (sort === "Name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "Roll number") list.sort((a, b) => a.roll.localeCompare(b.roll));
    else if (sort === "Time used") list.sort((a, b) => b.minutesUsed - a.minutesUsed);
    else list.sort((a, b) => donePct(b) - donePct(a));
    return list;
  }, [scoped, tab, search, sort]);

  const selected = scoped.find((a) => a.id === selectedId) ?? visible[0] ?? scoped[0];
  const liveScope = exam === LIVE_EXAM || exam === "All exams";
  const stillWriting = scoped.filter((a) => a.state === "In progress").length;
  const notStarted = scoped.filter((a) => a.state === "Not started");
  const submittedFeed = scoped.filter((a) => a.state === "Submitted").slice(0, 5);

  const openEvaluation = (a: Attempt) => {
    if (a.state !== "Submitted") { notify(`${a.name} has not submitted yet — the paper opens for evaluation after submit`); return; }
    navigate(evaluationPath(a.id));
  };
  const watchLive = (a: Attempt) => { notify(`Opening the live feed for ${a.name}`); navigate("/teacher/proctoring"); };

  return <>
    <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Submissions</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Track attempts as they come in</h1>
        <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">This page follows the attempt itself — progress, time used, connection, and integrity. Answer papers are graded from <button onClick={() => navigate("/teacher/evaluate")} className="text-forest underline">Evaluate</button>.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => notify("Broadcast composer opened")} className="border border-line-strong bg-paper px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Send announcement</button>
        <button onClick={() => notify(`Roster CSV exported · ${visible.length} rows`)} className="border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Export roster</button>
      </div>
    </div>
    {liveScope && <section className="mt-8 border border-alert/30 bg-alert/5 p-5">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Live window · {LIVE_EXAM}</p>
          <p className="mt-1 text-[13px]">{stillWriting} candidates are still writing. Unsubmitted papers are auto-submitted when the window closes.</p>
          <p className="mt-1 font-mono text-[10px] text-ink-soft">Started 10:00 AM · {SESSION_MINUTES + extended} minute window{extended ? ` (extended by ${extended} min)` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="border border-alert/40 bg-paper px-4 py-2 text-center">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Time left</p>
            <p className="tabular font-mono text-[15px] text-alert">● {hms(remaining)}</p>
          </div>
          <button onClick={() => { setExtended((m) => m + 5); setRemaining((s) => s + 300); notify("Exam window extended by 5 minutes for all candidates"); }} className="border border-line-strong bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">+5 min for all</button>
          <button onClick={() => notify(`Force submit requested for ${stillWriting} unsubmitted attempts`)} className="border border-alert px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/10">Force submit remaining</button>
        </div>
      </div>
    </section>}

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
        <select id="sub-exam" value={exam} onChange={(e) => setExam(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest">{exams.map((e) => <option key={e}>{e}</option>)}</select>
        <label className="sr-only" htmlFor="sub-sort">Sort by</label>
        <select id="sub-sort" value={sort} onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest">{SORTS.map((s) => <option key={s}>{s}</option>)}</select>
      </div>
    </section>
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 border border-line bg-paper">
        <div className="flex items-center justify-between border-b border-line bg-paper-raised px-5 py-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Attempt roster</p>
          <span className="font-mono text-[10px] text-ink-soft">Showing {visible.length} of {scoped.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft"><th className="px-5 py-3">Candidate</th><th className="px-5 py-3">Attempt progress</th><th className="px-5 py-3">Time used</th><th className="px-5 py-3">Connection</th><th className="px-5 py-3">Integrity</th><th className="px-5 py-3">State</th><th className="px-5 py-3" /></tr></thead>
            <tbody>
              {visible.map((a) => <tr key={a.id} onClick={() => setSelectedId(a.id)} className={`cursor-pointer border-b border-line last:border-0 ${selected?.id === a.id ? "bg-success/5" : needsAttention(a) ? "bg-alert/[0.03] hover:bg-alert/5" : "hover:bg-paper-raised"}`}>
                <td className="px-5 py-4"><button onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); }} className="text-left font-medium hover:text-forest hover:underline">{a.name}</button><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{a.roll} · {a.exam === LIVE_EXAM ? "DSA" : "DBMS"}</p></td>
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2"><div className="h-1.5 w-24 bg-line"><div className={`h-full ${a.state === "Submitted" ? "bg-success" : "bg-forest"}`} style={{ width: `${donePct(a)}%` }} /></div><span className="tabular font-mono text-[10px] text-ink-soft">{a.answered}/{a.total}</span></div>
                  <p className="mt-1 font-mono text-[10px] text-ink-soft">Autosaved {a.autoSaveAt}</p>
                </td>
                <td className="px-5 py-4"><p className="tabular text-[12px]">{a.minutesUsed ? `${a.minutesUsed} min` : "—"}</p><p className="mt-0.5 font-mono text-[10px] text-ink-soft">Started {a.startedAt}</p></td>
                <td className="px-5 py-4"><p className={`font-mono text-[10px] uppercase tracking-wider ${netTone(a.network)}`}>{a.network}</p><p className="mt-0.5 text-[11px] text-ink-soft">{a.device}</p></td>
                <td className="px-5 py-4">{a.flags.length ? <span className="border border-alert/30 bg-alert/5 px-2 py-1 font-mono text-[10px] text-alert">{a.flags.length} flag{a.flags.length > 1 ? "s" : ""}</span> : <span className="font-mono text-[10px] text-success">Clean</span>}</td>
                <td className="px-5 py-4"><p className={`font-mono text-[10px] uppercase tracking-wider ${stateTone(a.state)}`}>{a.state === "In progress" && "● "}{a.state}</p><p className="mt-0.5 text-[11px] text-ink-soft">{a.state === "Submitted" ? a.submittedAgo : a.lastActivity}</p></td>
                <td className="px-5 py-4 text-right">
                  {a.state === "Submitted"
                    ? <button onClick={(e) => { e.stopPropagation(); openEvaluation(a); }} className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Evaluate →</button>
                    : a.state === "In progress"
                      ? <button onClick={(e) => { e.stopPropagation(); watchLive(a); }} className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink hover:underline">Watch live →</button>
                      : <button onClick={(e) => { e.stopPropagation(); notify(`Start reminder sent to ${a.name}`); }} className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-amber hover:underline">Remind</button>}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <div className="p-10 text-center"><p className="font-serif text-lg">No attempts match this view</p><p className="mt-1 text-[12px] text-ink-soft">Clear the search or switch the status tab.</p></div>}
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
            <Row label="Connection" value={`${selected.network} · ${selected.device}`} />
            <Row label="Last autosave" value={selected.autoSaveAt} />
            <Row label="Integrity" value={selected.flags.length ? `${selected.flags.length} flag(s)` : "Clean"} />
          </div>
          {selected.flags.length > 0 && <ul className="mt-3 space-y-1.5 border-t border-line/60 pt-3">
            {selected.flags.map((f, i) => <li key={i} className="flex items-start gap-2 text-[11px]"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${f.severity === "critical" ? "bg-alert" : "bg-amber"}`} /><span><span className="font-medium">{f.label}</span> <span className="font-mono text-[10px] text-ink-soft">{f.at}</span></span></li>)}
          </ul>}
          <div className="mt-5 grid gap-2">
            {selected.state === "Submitted"
              ? <button onClick={() => openEvaluation(selected)} className="border border-forest bg-forest px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Open in evaluation →</button>
              : <button disabled className="cursor-not-allowed border border-line-strong bg-line/30 px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">Evaluation opens after submit</button>}
            {selected.state !== "Not started" && <button onClick={() => watchLive(selected)} className="border border-line-strong px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Watch proctoring feed</button>}
            {selected.state === "In progress" && <button onClick={() => notify(`5 extra minutes granted to ${selected.name}`)} className="border border-line-strong px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Grant +5 minutes</button>}
            <button onClick={() => notify(`Message composer opened for ${selected.name}`)} className="border border-line-strong px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Message candidate</button>
          </div>
        </section>}

        <section className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Latest submissions</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">Ready to evaluate</h2>
          <div className="mt-4 space-y-2">
            {submittedFeed.map((a) => <button key={a.id} onClick={() => openEvaluation(a)} className="flex w-full items-center justify-between gap-3 border-l-2 border-success px-3 py-2 text-left hover:bg-paper-raised">
              <span><span className="block text-[12px] font-medium">{a.name}</span><span className="mt-0.5 block font-mono text-[10px] text-ink-soft">{a.submittedAgo} · {a.answered}/{a.total} answered</span></span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-forest">Evaluate →</span>
            </button>)}
            {submittedFeed.length === 0 && <p className="text-[12px] text-ink-soft">No submissions in this view yet.</p>}
          </div>
        </section>

        {notStarted.length > 0 && <section className="border border-amber/40 bg-amber/5 p-5">
          <div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-widest text-amber">Not started</p><span className="rounded-full bg-amber px-2 py-1 font-mono text-[9px] text-paper">{notStarted.length}</span></div>
          <div className="mt-3 space-y-2">
            {notStarted.map((a) => <div key={a.id} className="flex items-center justify-between gap-3 text-[12px]"><span>{a.name}<span className="mt-0.5 block font-mono text-[10px] text-ink-soft">{a.lastActivity}</span></span><button onClick={() => notify(`Start reminder sent to ${a.name}`)} className="font-mono text-[10px] uppercase tracking-wider text-amber hover:underline">Remind</button></div>)}
          </div>
          <button onClick={() => notify(`Reminder sent to ${notStarted.length} candidate(s) who have not started`)} className="mt-4 w-full border border-amber px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-amber hover:bg-amber/10">Remind everyone</button>
        </section>}
      </aside>
    </div>
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
