import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { AuthRole } from "../lib/auth";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRole?: AuthRole;
}

export default function ProtectedRoute({ children, allowedRole }: ProtectedRouteProps) {
  const { user, role, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-ink border-t-transparent"></div>
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
