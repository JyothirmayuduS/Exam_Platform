import { Navigate, useLocation } from "react-router-dom";
import { supabaseConfigured } from "../lib/supabase";
import { roleHomePath, useAuthProfile, type AppRole } from "../lib/auth";

type ProtectedRouteProps = {
  allowedRoles: AppRole[];
  children: React.ReactNode;
};

export default function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { profile, loading } = useAuthProfile();
  const location = useLocation();

  if (!supabaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md border border-line bg-paper-raised p-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Authentication unavailable</p>
          <p className="mt-2 text-[13px] text-ink-soft">Configure Supabase auth to access this route.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Checking session…</p>
      </div>
    );
  }

  if (!profile) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/auth/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (!allowedRoles.includes(profile.role)) {
    return <Navigate to={roleHomePath(profile.role)} replace />;
  }

  return <>{children}</>;
}
