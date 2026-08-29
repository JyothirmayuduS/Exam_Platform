import { useState } from "react";
import Header from "../components/Header";

type Severity = "none" | "low" | "high";

type Candidate = {
  id: string;
  name: string;
  roll: string;
  severity: Severity;
  reason?: string;
  time?: string;
  initials: string;
};

const CANDIDATES: Candidate[] = [
  { id: "c1", name: "B. Priya Nikitha", roll: "21VGN0142", severity: "none", initials: "PN" },
  { id: "c2", name: "K. Rohan Teja", roll: "21VGN0158", severity: "high", reason: "Second face detected in frame", time: "2m ago", initials: "RT" },
  { id: "c3", name: "M. Sai Charan", roll: "21VGN0163", severity: "none", initials: "SC" },
  { id: "c4", name: "A. Deepika Reddy", roll: "21VGN0171", severity: "low", reason: "Gaze away from screen (8s)", time: "40s ago", initials: "DR" },
  { id: "c5", name: "S. Vamsi Krishna", roll: "21VGN0184", severity: "none", initials: "VK" },
  { id: "c6", name: "N. Harika Sree", roll: "21VGN0191", severity: "low", reason: "Tab-switch attempt blocked", time: "1m ago", initials: "HS" },
  { id: "c7", name: "T. Yashwanth", roll: "21VGN0203", severity: "none", initials: "TY" },
  { id: "c8", name: "P. Meghana", roll: "21VGN0217", severity: "high", reason: "Prohibited software: AnyDesk", time: "just now", initials: "PM" },
  { id: "c9", name: "R. Charan Kumar", roll: "21VGN0229", severity: "none", initials: "CK" },
  { id: "c10", name: "G. Sindhu Priya", roll: "21VGN0234", severity: "none", initials: "SP" },
];

const severityTone: Record<Severity, string> = { none: "#284B34", low: "#B7791F", high: "#9B2C2C" };
const severityRank: Record<Severity, number> = { high: 0, low: 1, none: 2 };

export default function ProctorGrid() {
  const [selected, setSelected] = useState<Candidate>(
    CANDIDATES.find((c) => c.severity === "high") ?? CANDIDATES[0]
  );

  const flagged = [...CANDIDATES].filter((c) => c.severity !== "none").sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return (
    <div className="min-h-screen bg-paper">
      <Header
        role="Proctor"
        roleTone="#B7791F"
        right={
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
            <span className="h-1.5 w-1.5 bg-alert" /> {CANDIDATES.length} candidates · Hall B, Slot 2
          </div>
        }
      />

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 px-6 py-8">
        {/* Flag feed */}
        <div className="col-span-3">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Flag feed</p>
          <div className="mt-3 space-y-px border border-line bg-line">
            {flagged.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className={`block w-full bg-paper px-4 py-3 text-left transition-colors hover:bg-paper-raised ${
                  selected.id === c.id ? "bg-paper-raised" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="font-mono text-[10px] uppercase tracking-wider"
                    style={{ color: severityTone[c.severity] }}
                  >
                    {c.severity === "high" ? "Critical" : "Notice"}
                  </span>
                  <span className="font-mono text-[10px] text-ink-soft">{c.time}</span>
                </div>
                <p className="mt-1 text-[13px] font-medium">{c.name}</p>
                <p className="text-[12px] text-ink-soft">{c.reason}</p>
              </button>
            ))}
            {flagged.length === 0 && (
              <div className="bg-paper px-4 py-6 text-center font-mono text-[11px] text-ink-soft">
                No active flags
              </div>
            )}
          </div>
        </div>

        {/* Grid */}
        <div className="col-span-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Live grid</p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {CANDIDATES.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className={`group relative aspect-[4/3] border bg-[#EFEBE2] transition-colors ${
                  selected.id === c.id ? "border-maroon" : "border-line"
                }`}
              >
                <div className="flex h-full items-center justify-center">
                  <span className="font-serif text-2xl text-ink-soft/50">{c.initials}</span>
                </div>
                <div
                  className="absolute right-1.5 top-1.5 h-2 w-2"
                  style={{ backgroundColor: severityTone[c.severity] }}
                />
                <div className="absolute inset-x-0 bottom-0 truncate bg-paper/90 px-1.5 py-1 font-mono text-[9px] text-ink">
                  {c.roll}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail / actions */}
        <div className="col-span-3">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Candidate</p>
          <div className="mt-3 border border-line">
            <div className="flex aspect-[4/3] items-center justify-center border-b border-line bg-[#EFEBE2]">
              <span className="font-serif text-3xl text-ink-soft/50">{selected.initials}</span>
            </div>
            <div className="p-4">
              <p className="font-serif text-[15px] font-medium">{selected.name}</p>
              <p className="font-mono text-[11px] text-ink-soft">{selected.roll}</p>

              <div className="mt-3 flex items-center gap-2">
                <span className="h-2 w-2" style={{ backgroundColor: severityTone[selected.severity] }} />
                <span className="text-[12px] text-ink-soft">
                  {selected.reason ?? "No active flags"}
                </span>
              </div>

              <div className="mt-5 space-y-2">
                <button className="w-full border border-line-strong py-2 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink">
                  Send warning
                </button>
                <button className="w-full border border-amber py-2 font-mono text-[11px] uppercase tracking-wider text-amber hover:bg-amber/[0.06]">
                  Pause session
                </button>
                <button className="w-full border border-alert py-2 font-mono text-[11px] uppercase tracking-wider text-alert hover:bg-alert/[0.06]">
                  Escalate to teacher
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
