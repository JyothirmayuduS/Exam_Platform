import { Link } from "react-router-dom";

type HeaderProps = {
  role?: string;
  roleTone?: string;
  right?: React.ReactNode;
};

export default function Header({ role, roleTone = "#7A1F2B", right }: HeaderProps) {
  return (
    <header className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center border font-serif text-base font-semibold"
            style={{ borderColor: "#1C1C1A" }}
          >
            V
          </div>
          <div className="leading-none">
            <p className="font-serif text-[17px] font-semibold tracking-tight">Vignan Lockdown OS</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
              Secure Examination Platform
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-4">
          {role && (
            <span
              className="border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest"
              style={{ borderColor: roleTone, color: roleTone }}
            >
              {role}
            </span>
          )}
          {right}
        </div>
      </div>
    </header>
  );
}
