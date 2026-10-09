import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const auth = vi.hoisted(() => ({ value: { user: { id: "u1" }, role: "teacher" as string | null, loading: false, isAdmin: false } }));
vi.mock("@/features/auth/auth", () => ({ useAuth: () => auth.value }));

import ProtectedRoute, { roleAllowed } from "./ProtectedRoute";

describe("admin route", () => {
  it("lets only teachers listed as admins in", () => {
    expect(roleAllowed("admin", "teacher", true)).toBe(true);
    expect(roleAllowed("admin", "teacher", false)).toBe(false);
    expect(roleAllowed("admin", "proctor", true)).toBe(false);
    expect(roleAllowed("admin", "student", true)).toBe(false);
    expect(roleAllowed("teacher", "teacher", true)).toBe(true);
  });

  const renderAt = () => render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<ProtectedRoute allowedRole="admin"><p>ADMIN CONSOLE</p></ProtectedRoute>} />
        <Route path="/teacher" element={<p>TEACHER CONSOLE</p>} />
      </Routes>
    </MemoryRouter>,
  );

  it("sends a plain teacher to the teacher console", () => {
    auth.value = { user: { id: "u1" }, role: "teacher", loading: false, isAdmin: false };
    renderAt();
    expect(screen.getByText("TEACHER CONSOLE")).toBeTruthy();
  });

  it("opens the console for an admin", () => {
    auth.value = { user: { id: "u1" }, role: "teacher", loading: false, isAdmin: true };
    renderAt();
    expect(screen.getByText("ADMIN CONSOLE")).toBeTruthy();
  });
});
