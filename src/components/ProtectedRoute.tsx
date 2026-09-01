import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { AuthRole } from "../lib/auth";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRole?: AuthRole;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  return <>{children}</>;
}
