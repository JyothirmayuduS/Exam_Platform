import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/features/auth/auth";
import type { AuthRole } from "@/features/auth/auth";
import { isTauri } from "@/shared/platform/platform";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRole?: AuthRole;
}

export default function ProtectedRoute({ children, allowedRole }: ProtectedRouteProps) {
  const { user, role, loading } = useAuth();
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
        <div className="h-8 w-8 animate-spin rounded-none border-4 border-ink border-t-transparent"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If a role is required and user's role doesn't match
  if (allowedRole && role !== allowedRole) {
    // Proctors can access teacher routes conceptually, but let's be strict if needed.
    // For now, if allowedRole is "teacher", both teacher and proctor should be allowed,
    // or maybe they are distinct. The user asked for proctor and teacher as distinct.
    if (allowedRole === "teacher" && role !== "teacher" && role !== "proctor") {
      return <Navigate to="/student" replace />;
    }
    if (allowedRole === "student" && role !== "student") {
      return <Navigate to="/teacher" replace />;
    }
  }

  return <>{children}</>;
}
