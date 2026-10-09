import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const verifyOtp = vi.fn();
vi.mock("@/shared/data/supabase", () => ({
  getSupabase: () => ({ functions: { invoke }, auth: { verifyOtp } }),
}));
const auth = { user: null as { id: string } | null, role: null as string | null, loading: false };
vi.mock("@/features/auth/auth", () => ({ useAuth: () => auth }));

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
    Object.assign(auth, { user: null, role: null, loading: false });
    sessionStorage.clear();
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

  it("tells a student their account is waiting for the teacher", async () => {
    open("/lti/launch?error=account_pending&activity=Mid-term");
    expect(await screen.findByText("Your account is waiting for your teacher")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a launch without the Learner role with a clear message", async () => {
    open("/lti/launch?error=unsupported_role");
    expect(await screen.findByText("This Moodle role cannot open the exam")).toBeTruthy();
  });

  it("asks a Moodle teacher to sign in, and never signs them in from the launch", async () => {
    open("/lti/launch?status=instructor&activity=Mid-term#claim=c-1");
    expect(await screen.findByText("Link my Moodle course")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("links the Moodle course to the signed-in platform teacher once", async () => {
    Object.assign(auth, { user: { id: "auth-A" }, role: "teacher" });
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    open("/lti/launch?status=instructor&activity=Mid-term#claim=c-2");
    expect(await screen.findByText("Your Moodle course is linked")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("lti/claim", { body: { claim: "c-2" } });
  });
});
