import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import IdentityVerificationScreen from "./IdentityVerificationScreen";

describe("IdentityVerificationScreen", () => {
  it("requires and returns a real camera frame before continuing", () => {
    const onVerified = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const drawImage = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation(((name: string) => {
      if (name === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }),
          toDataURL: () => "data:image/jpeg;base64,captured",
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(name);
    }) as typeof document.createElement);

    try {
      render(
        <IdentityVerificationScreen
          examName="Secure Exam"
          studentName="Candidate"
          studentRoll="ROLL-1"
          stream={{} as MediaStream}
          previewRef={{ current: null }}
          onBack={vi.fn()}
          onVerified={onVerified}
        />,
      );

      const video = document.querySelector("video");
      expect(video).not.toBeNull();
      Object.defineProperty(video, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
      Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
      fireEvent.click(screen.getByRole("button", { name: /capture face \+ id/i }));

      expect(drawImage).toHaveBeenCalledOnce();
      expect(screen.getByAltText("Captured face and photo ID")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      expect(onVerified).toHaveBeenCalledWith("data:image/jpeg;base64,captured");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
