import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubmittedScreen } from "@/features/student/components/exam/ExamFlowScreens";
import { waitingPiecesWarning } from "@/shared/services/submitEvidence";

const base = {
  answeredCount: 3, totalQuestions: 3, studentName: "Candidate", studentRoll: "R1",
  violationsCount: 0, examId: "E1", attemptId: "attempt-1234", feedbackStudentId: null,
};

describe("submitted screen", () => {
  it("holds the student while recording pieces or snapshots are uploading", () => {
    render(<SubmittedScreen {...base} uploadState="uploading" evidenceLeft={4} />);
    expect(screen.getByRole("button", { name: /close exam window/i })).toBeDisabled();
    expect(screen.queryByText(/go to results hub/i)).toBeNull();
    expect(screen.getAllByText(/recording and camera snapshots \(4 items left\)/).length).toBeGreaterThan(0);
  });

  it("becomes closable with a clear warning once the wait limit passes", () => {
    render(<SubmittedScreen {...base} uploadState="uploading" evidenceLeft={2} closeWarning={waitingPiecesWarning(2)} />);
    expect(screen.getByRole("button", { name: /close exam window/i })).toBeEnabled();
    expect(screen.getAllByText(/2 items of exam evidence \(recording pieces and camera snapshots\) are still waiting to upload from this PC/).length).toBeGreaterThan(0);
  });

  it("is closable and reports refused pieces once nothing is left to retry", () => {
    const detail = "Some exam evidence is missing: 1 recording piece was refused by storage and not uploaded (kept on this PC). Please inform your invigilator before closing the app.";
    render(<SubmittedScreen {...base} uploadState="partial" uploadDetail={detail} evidenceLeft={0} />);
    expect(screen.getByRole("button", { name: /close exam window/i })).toBeEnabled();
    expect(screen.getByText(/refused by storage and not uploaded/)).toBeInTheDocument();
  });
});
