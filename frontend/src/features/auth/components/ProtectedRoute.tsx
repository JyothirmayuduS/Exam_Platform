import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/features/auth/auth";
import type { AuthRole } from "@/features/auth/auth";
import { isTauri } from "@/shared/platform/platform";

export type RouteRole = Exclude<AuthRole, null> | "staff" | "admin";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRole?: RouteRole;
}

export default function ProtectedRoute({ children, allowedRole }: ProtectedRouteProps) {
  const { user, role, loading, isAdmin } = useAuth();
  const location = useLocation();

  // A deep-linked native exam restores the student's existing Supabase
  // session before mount. If the webview has no session yet (for example while
  // a warm macOS URL is still being hydrated), let StudentExam render its
  // explicit account/link error instead of sending the candidate into a
  // second login screen inside the lockdown app.
  //
  // This check comes BEFORE the loading spinner on purpose: while the kiosk
  // restores its session, the candidate should already be looking at the
  // exam's first system check. Gating on `loading` first swapped that instant
  // pre-flight screen for a blank spinner on every deep-link launch.
  //
  // Extended to ALL student routes inside the kiosk: clicking "Enter exam"
  // from the student dashboard navigates to /student/exam?examId=…, but the
  // auth provider is still hydrating (INITIAL_SESSION event hasn't fired yet).
  // Without this bypass every in-kiosk navigation bounces to /login for a
  // split second before the session resolves. The kiosk is already a trusted
  // environment — if the session truly expired, StudentExam and the API layer
  // handle it gracefully (error screens, not a login redirect loop).
  const nativeStudentRoute = isTauri() && allowedRole === "student" && location.pathname.startsWith("/student");
  if (!user && nativeStudentRoute) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <span className="relative block h-10 w-10" aria-hidden>
            <span className="absolute inset-0 rounded-full border-2 border-line" />
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-forest" />
          </span>
          <p className="font-mono text-[11px] uppercase tracking-widest text-soft">Signing you in</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRole && !roleAllowed(allowedRole, role, isAdmin)) {
    return <Navigate to={homeFor(role, allowedRole)} replace />;
  }

  return <>{children}</>;
}

/** "staff" = teacher or proctor (live supervision, evidence). Authoring,
 *  grading and results stay teacher-only; the database enforces the same split.
 *  "admin" = a teacher listed in staff_admins. */
export function roleAllowed(allowed: RouteRole, role: AuthRole, isAdmin = false): boolean {
  if (allowed === "staff") return role === "teacher" || role === "proctor";
  if (allowed === "admin") return role === "teacher" && isAdmin;
  return role === allowed;
}

function homeFor(role: AuthRole, allowed: RouteRole): string {
  if (role === "proctor") return "/proctor";
  if (role === "teacher") return "/teacher";
  if (role === "student") return "/student";
  return allowed === "student" ? "/teacher" : "/student";
}
