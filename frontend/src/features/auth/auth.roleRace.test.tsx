import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;

const db = vi.hoisted(() => {
  let release: (v: { data: { id: string; role: string } }) => void = () => {};
  const teacherRow = new Promise<{ data: { id: string; role: string } }>((r) => { release = r; });
  const state: { onChange: AuthCallback | null } = { onChange: null };
  const client = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: (cb: AuthCallback) => { state.onChange = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => teacherRow }) }) }),
    rpc: () => Promise.resolve({ data: true, error: null }),
  };
  return { client, state, release: (v: { data: { id: string; role: string } }) => release(v) };
});
vi.mock("@/shared/data/supabase", () => ({ getSupabase: () => db.client }));

import { AuthProvider } from "./auth";
import ProtectedRoute from "./components/ProtectedRoute";

describe("just signed in, role not known yet", () => {
  it("waits for the role instead of bouncing between consoles", async () => {
    const visited: string[] = [];
    const Page = ({ name }: { name: string }) => { visited.push(name); return <p>{name}</p>; };
    const Login = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/admin")}>GO</button>;
    };
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/admin" element={<ProtectedRoute allowedRole="admin"><Page name="ADMIN" /></ProtectedRoute>} />
            <Route path="/teacher" element={<ProtectedRoute allowedRole="teacher"><Page name="TEACHER" /></ProtectedRoute>} />
            <Route path="/student" element={<ProtectedRoute allowedRole="student"><Page name="STUDENT" /></ProtectedRoute>} />
            <Route path="/login" element={<Login />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    await act(async () => { db.state.onChange?.("SIGNED_IN", { user: { id: "u-admin" } }); });
    fireEvent.click(screen.getByText("GO"));
    expect(screen.getByText(/signing you in/i)).toBeTruthy();

    await act(async () => { db.release({ data: { id: "t1", role: "teacher" } }); });
    expect(await screen.findByText("ADMIN")).toBeTruthy();
    expect(visited).not.toContain("STUDENT");
    expect(visited).not.toContain("TEACHER");
  });
});
