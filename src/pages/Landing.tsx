import { Link } from "react-router-dom";

const roles = [
  {
    key: "student",
    to: "/student",
    title: "Student",
    tone: "#7A1F2B",
    desc: "Verify your identity, complete the system check, and take your exam in a locked, distraction-free window.",
    points: ["Kiosk-mode exam screen", "Auto-save every answer", "Live countdown & question palette"],
  },
  {
    key: "teacher",
    to: "/teacher",
    title: "Teacher",
    tone: "#284B34",
    desc: "Build the question bank, configure the lockdown tier, and evaluate submissions once the window closes.",
    points: ["Question bank & randomized pools", "Live submission dashboard", "On-screen subjective evaluation"],
  },
  {
    key: "proctor",
    to: "/proctor",
    title: "Proctor",
    tone: "#B7791F",
    desc: "Monitor the live candidate grid, review AI-raised flags, and act on incidents as they happen.",
    points: ["Live webcam grid", "Severity-sorted flag feed", "Warn, pause, or escalate a candidate"],
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-line">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-ink font-serif text-lg font-semibold">
              V
            </div>
            <div className="leading-none">
              <p className="font-serif text-[19px] font-semibold tracking-tight">Vignan Lockdown OS</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
                Secure Examination Platform
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-16">
        <div className="max-w-2xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-maroon">
            Semester Examinations · 2026
          </p>
          <h1 className="mt-3 font-serif text-4xl font-semibold leading-tight text-ink sm:text-5xl">
            One examination hall,
            <br />
            three vantage points.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            The same exam, seen from where you sit. Choose a role below to open its console — each is
            built for exactly what that seat in the hall needs to see, and nothing else.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-3">
          {roles.map((r, i) => (
            <Link
              key={r.key}
              to={r.to}
              className="group flex flex-col justify-between bg-paper p-7 transition-colors hover:bg-paper-raised"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-ink-soft">0{i + 1}</span>
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: r.tone }}
                  />
                </div>
                <h2 className="mt-4 font-serif text-2xl font-semibold" style={{ color: r.tone }}>
                  {r.title}
                </h2>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">{r.desc}</p>
                <ul className="mt-5 space-y-1.5">
                  {r.points.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-[12.5px] text-ink">
                      <span className="mt-1.5 h-1 w-1 shrink-0 bg-ink-soft" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-8 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft group-hover:text-ink">
                Enter console
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-16 flex items-center gap-2 border-t border-line pt-6 font-mono text-[11px] text-ink-soft">
          <span className="h-1.5 w-1.5 bg-success" />
          All systems operational · Tier: AI Proctoring
        </div>
      </main>
    </div>
  );
}
