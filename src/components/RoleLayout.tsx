import { useState } from "react";
import { NavLink, Link } from "react-router-dom";

type NavItem = { label: string; to: string; end?: boolean; badge?: string };

type RoleLayoutProps = {
  role: "Student" | "Teacher" | "Proctor";
  name: string;
  subtitle: string;
  tone: string;
  items: NavItem[];
  children: React.ReactNode;
  status?: string;
};

export default function RoleLayout({ role, name, subtitle, tone, items, children, status = "Systems operational" }: RoleLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="min-h-screen bg-paper">
      {/* Mobile header bar */}
      <header className="flex items-center justify-between border-b border-line bg-paper px-4 py-3 lg:hidden">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center border border-ink font-serif text-sm font-semibold">V</div>
          <span className="font-serif text-sm font-semibold">Vignan Lockdown OS</span>
        </Link>
        <button onClick={() => setMobileOpen(true)} className="border border-line bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-soft" aria-label="Open menu">Menu</button>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-72 border-r border-line bg-paper p-5 flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <Link to="/" onClick={() => setMobileOpen(false)} className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center border border-ink font-serif text-sm font-semibold">V</div>
                <span className="font-serif text-sm font-semibold">Vignan Lockdown OS</span>
              </Link>
            </div>
            <nav className="flex-1 space-y-1">
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMobileOpen(false)} className={({ isActive }) => `block border-l-2 px-3 py-2.5 text-[13px] ${isActive ? "border-current bg-raised text-ink" : "border-transparent text-soft hover:bg-raised"}`} style={({ isActive }) => isActive ? { color: tone } : undefined}>
                  <span>{item.label}</span>
                  {item.badge && <span className="ml-2 rounded-none bg-alert/10 px-1.5 py-0.5 font-mono text-[9px] text-alert">{item.badge}</span>}
                </NavLink>
              ))}
            </nav>
            <div className="border-t border-line pt-4 mt-4">
              <p className="font-mono text-[10px] text-soft">{status}</p>
              <button onClick={async () => { const { getSupabase } = await import("../lib/supabase"); const supabase = getSupabase(); if (supabase) await supabase.auth.signOut(); window.location.href = "/login"; }} className="mt-3 block text-[12px] text-soft hover:text-ink">Sign out</button>
            </div>
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-line bg-paper lg:flex">
        <Link to="/" className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center border border-ink font-serif text-base font-semibold">V</div>
          <div className="leading-none">
            <p className="font-serif text-[15px] font-semibold">Vignan Lockdown OS</p>
            <p className="mt-0.5 font-mono text-[8px] uppercase tracking-widest text-soft">Exam platform</p>
          </div>
        </Link>
        <div className="px-4 py-5">
          <p className="font-mono text-[9px] uppercase tracking-widest text-soft">{role} workspace</p>
          <p className="mt-1.5 font-serif text-[15px] font-semibold">{name}</p>
          <p className="mt-0.5 text-[11px] text-soft">{subtitle}</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `flex items-center justify-between border-l-2 px-3 py-2 text-[12px] transition-colors ${isActive ? "border-current bg-raised text-ink" : "border-transparent text-soft hover:bg-raised hover:text-ink"}`} style={({ isActive }) => isActive ? { color: tone } : undefined}>
              <span>{item.label}</span>
              {item.badge && <span className="rounded-none bg-alert/10 px-1.5 py-0.5 font-mono text-[9px] text-alert">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-5 py-4">
          <div className="flex items-center gap-2 font-mono text-[10px] text-soft"><span className="h-1.5 w-1.5 bg-success" />{status}</div>
          <button onClick={async () => { const { getSupabase } = await import("../lib/supabase"); const supabase = getSupabase(); if (supabase) await supabase.auth.signOut(); window.location.href = "/login"; }} className="mt-3 block text-[11px] text-soft hover:text-ink">Sign out</button>
        </div>
      </aside>

      <div className="lg:pl-56">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper/95 px-5 py-3 backdrop-blur lg:px-8">
          <div><p className="font-mono text-[9px] uppercase tracking-widest" style={{ color: tone }}>{role} console</p><p className="mt-0.5 font-serif text-base font-semibold">{name}</p></div>
          <div className="flex items-center gap-3"><span className="hidden text-[11px] text-soft sm:block">{status}</span><div className="flex h-7 w-7 items-center justify-center rounded-none bg-ink text-[10px] font-semibold text-paper">{name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</div></div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
