import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const verifyOtp = vi.fn();
vi.mock("@/shared/data/supabase", () => ({
  getSupabase: () => ({ functions: { invoke }, auth: { verifyOtp } }),
}));

import LtiLaunch from "./LtiLaunch";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function open(url: string) {
  window.history.replaceState(null, "", url);
  return render(
    <MemoryRouter initialEntries={["/lti/launch"]}>
      <Routes>
        <Route path="/lti/launch" element={<LtiLaunch />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Moodle launch landing page", () => {
  beforeEach(() => {
    invoke.mockReset();
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ error: null });
  });

  it("signs in as the Moodle user and opens the exam the server mapped", async () => {
    invoke.mockResolvedValue({ data: { tokenHash: "hash-1", examId: "EXAM-A" }, error: null });
    open("/lti/launch?exam=EXAM-A#ticket=t-123");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/student/exams/EXAM-A"));
    expect(invoke).toHaveBeenCalledWith("lti/session", { body: { ticket: "t-123", examId: "EXAM-A" } });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "hash-1", type: "magiclink" });
    expect(window.location.hash).toBe("");
  });

  it("shows a refusal and signs nobody in when the server refuses the exam", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { status: 403 } } });
    open("/lti/launch?exam=EXAM-B#ticket=t-9");
    expect(await screen.findByText("This link cannot open that exam")).toBeTruthy();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("explains an unmapped activity without calling the server", async () => {
    open("/lti/launch?error=not_mapped&activity=Quiz%202");
    expect(await screen.findByText("This activity is not linked to an exam yet")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
