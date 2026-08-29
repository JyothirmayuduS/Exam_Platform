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
  return (
    <div className="min-h-screen bg-paper">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-line bg-paper-raised lg:flex">
        <Link to="/" className="flex items-center gap-3 border-b border-line px-6 py-5">
          <div className="flex h-9 w-9 items-center justify-center border border-ink font-serif text-base font-semibold">V</div>
          <div className="leading-none">
            <p className="font-serif text-[16px] font-semibold">Vignan OS</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft">Exam platform</p>
          </div>
        </Link>
        <div className="px-5 py-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{role} workspace</p>
          <p className="mt-2 font-serif text-[17px] font-semibold">{name}</p>
          <p className="mt-1 text-[12px] text-ink-soft">{subtitle}</p>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `flex items-center justify-between border-l-2 px-3 py-2.5 text-[13px] transition-colors ${isActive ? "border-current bg-paper text-ink" : "border-transparent text-ink-soft hover:bg-paper hover:text-ink"}`}
              style={({ isActive }) => (isActive ? { color: tone } : undefined)}
            >
              <span>{item.label}</span>
              {item.badge && <span className="rounded-full bg-alert/10 px-1.5 py-0.5 font-mono text-[9px] text-alert">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-5 py-4">
          <div className="flex items-center gap-2 font-mono text-[10px] text-ink-soft"><span className="h-1.5 w-1.5 bg-success" />{status}</div>
          <Link to="/" className="mt-3 block text-[12px] text-ink-soft hover:text-ink">Switch role →</Link>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper/95 px-5 py-4 backdrop-blur lg:px-8">
          <div><p className="font-mono text-[10px] uppercase tracking-widest" style={{ color: tone }}>{role} console</p><p className="mt-1 font-serif text-lg font-semibold">{name}</p></div>
          <div className="flex items-center gap-3"><span className="hidden text-[12px] text-ink-soft sm:block">{status}</span><div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-paper">{name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</div></div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-7 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
