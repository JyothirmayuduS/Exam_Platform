import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { states, rpc } = vi.hoisted(() => ({
  states: { held: true },
  rpc: vi.fn(),
}));

vi.mock("@/features/auth/auth", () => ({ useAuth: () => ({ user: { id: "auth-1" } }) }));
vi.mock("@/features/auth/hooks/useCurrentProfile", () => ({
  default: () => ({ profile: { roll: "21BQ1A0501", full_name: "Asha" }, loading: false }),
  profileSubtitle: () => "",
}));
vi.mock("@/shared/components/RoleLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/shared/data/supabase", () => {
  const attempt = {
    state: "submitted", submitted_at: "2026-10-09T08:40:00Z",
    exam: { id: "EX-1", name: "Data Structures", total_marks: 10, settings: { results_published: true }, status: "completed", scheduled_at: null, duration_minutes: 60 },
  };
  const students = { select: () => students, eq: () => students, maybeSingle: async () => ({ data: { id: "s1" } }) };
  const attempts = { select: () => attempts, eq: () => attempts, order: async () => ({ data: [attempt], error: null }) };
  return {
    getSupabase: () => ({
      from: (t: string) => (t === "students" ? students : attempts),
      rpc: async (name: string) => {
        rpc(name);
        return { data: [{ exam_id: "EX-1", graded: true, held: states.held, score: states.held ? null : "8" }], error: null };
      },
    }),
  };
});

import StudentResults from "./StudentResults";

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><StudentResults /></MemoryRouter>
  </QueryClientProvider>,
);

describe("student results on malpractice hold", () => {
  afterEach(cleanup);

  it("shows no score while the result is held", async () => {
    states.held = true;
    show();
    expect(await screen.findByText("Your result is under review.")).toBeTruthy();
    expect(screen.queryByText("/10")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("student_result_states");
  });

  it("shows the score once the hold is released", async () => {
    states.held = false;
    show();
    expect(await screen.findByText("/10")).toBeTruthy();
    expect(screen.queryByText("Your result is under review.")).toBeNull();
  });
});
