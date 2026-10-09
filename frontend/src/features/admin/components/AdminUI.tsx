import type { ReactNode } from "react";
import type { ExamRef, StudentRef } from "@/shared/data/api/admin";

export function Panel({ title, count, tone, note, action, children }: { title: string; count?: number | string; tone?: "alert" | "amber" | "ok"; note?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const toneCls = tone === "alert" ? "border-alert text-alert" : tone === "amber" ? "border-amber text-amber" : tone === "ok" ? "border-success text-success" : "border-line text-soft";
  return (
    <section className="border border-line bg-paper">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-lg font-semibold">{title}</h2>
          {count !== undefined && <span className={`border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${toneCls}`}>{count}</span>}
        </div>
        {action}
      </header>
      {note && <p className="border-b border-line bg-raised/60 px-5 py-2 text-[12px] text-soft">{note}</p>}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12.5px] text-soft">{children}</p>;
}

/** Shown where the platform doesn't record the data yet, instead of a made-up number. */
export function NotTracked({ children }: { children: ReactNode }) {
  return (
    <div className="border border-dashed border-line px-4 py-3 text-[12.5px] text-soft">
      <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-amber">Not tracked yet</span>
      {children}
    </div>
  );
}

export function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-success" : warn ? "bg-amber" : "bg-alert"}`} />;
}

export function Stat({ label, value, tone, detail }: { label: string; value: ReactNode; tone?: string; detail?: string }) {
  return (
    <div className="border border-line bg-raised px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-soft">{label}</p>
      <p className={`mt-1 font-serif text-2xl tabular-nums ${tone ?? ""}`}>{value}</p>
      {detail && <p className="mt-0.5 text-[11px] text-soft">{detail}</p>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-soft">
            {head.map((h) => <th key={h} className="px-5 py-2 font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className = "" }: { children: ReactNode; className?: string }) => <td className={`px-5 py-2 align-top ${className}`}>{children}</td>;

export const examLabel = (e: ExamRef | null | undefined) => (e ? e.name : "Deleted exam");
export const studentLabel = (s: StudentRef | null | undefined) => (s ? [s.roll, s.full_name].filter(Boolean).join(" · ") || "Unknown student" : "—");

export function bytes(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${units[i]}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  const future = s < 0;
  const a = Math.abs(s);
  const txt = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return future ? `in ${txt}` : `${txt} ago`;
}

export function seconds(s: number | null): string {
  if (s === null) return "no signal yet";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} days`;
}
