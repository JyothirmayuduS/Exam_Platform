import { useEffect, useState, type RefObject } from "react";
import { FiArrowRight, FiCamera, FiRefreshCw } from "react-icons/fi";

/**
 * The optional photo-ID step is deliberately a real camera capture, not a
 * checkbox that merely claims verification. The candidate must show their
 * face and ID card together in the live preview before continuing.
 */
type Props = {
  examName: string;
  studentName: string;
  studentRoll: string;
  stream: MediaStream | null;
  previewRef: RefObject<HTMLVideoElement | null>;
  onBack: () => void;
  onVerified: (capture: string) => void;
};

export default function IdentityVerificationScreen({
  examName,
  studentName,
  studentRoll,
  stream,
  previewRef,
  onBack,
  onVerified,
}: Props) {
  const [capture, setCapture] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const video = previewRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void Promise.resolve(video.play()).catch(() => undefined);
  }, [previewRef, stream, capture]);

  const takeCapture = () => {
    const video = previewRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      setError("Camera preview is not ready yet. Keep your face and ID card in view, then try again.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("This device cannot capture a camera frame. Use a supported desktop camera and try again.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.86);
    setCapture(image);
    setError("");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-10 text-ink">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-soft">Pre-exam · Identity verification</p>
          <h1 className="mt-1 font-serif text-2xl font-semibold">Verify your photo ID</h1>
          <p className="mt-1 text-[13px] text-soft">
            This exam requires one camera capture of your face and photo ID together. Make sure both are clear and readable.
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-maroon">{examName}</p>
        </div>

        <div className="grid gap-5 md:grid-cols-[1fr_220px]">
          <div className="overflow-hidden border border-line bg-ink">
            {capture ? (
              <img src={capture} alt="Captured face and photo ID" className="aspect-video w-full bg-black object-contain" />
            ) : (
              <video ref={previewRef} autoPlay playsInline muted className="aspect-video w-full bg-black object-cover" />
            )}
            <div className="border-t border-white/10 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-paper/70">
              {capture ? "Capture ready for confirmation" : "Live camera preview"}
            </div>
          </div>

          <div className="space-y-3 border border-line bg-raised p-4 text-[12px]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Candidate</p>
            <p className="font-medium">{studentName || "Candidate"}</p>
            <p className="font-mono text-[11px] text-soft">{studentRoll}</p>
            <div className="border-t border-line pt-3 text-soft">
              <p>Hold the ID beside your face.</p>
              <p className="mt-1">Remove glare and keep all text inside the frame.</p>
            </div>
          </div>
        </div>

        {error && <p className="border border-alert/40 bg-alert/5 px-3 py-2 text-[12px] text-alert">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button onClick={onBack} className="border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-soft hover:border-ink hover:text-ink">
            Back
          </button>
          <div className="flex flex-wrap gap-3">
            {capture && (
              <button onClick={() => { setCapture(null); setError(""); }} className="flex items-center gap-2 border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-raised">
                <FiRefreshCw aria-hidden /> Retake
              </button>
            )}
            {!capture ? (
              <button onClick={takeCapture} className="flex items-center gap-2 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-soft">
                <FiCamera aria-hidden /> Capture face + ID
              </button>
            ) : (
              <button onClick={() => onVerified(capture)} className="flex items-center gap-2 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-soft">
                Continue <FiArrowRight aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
