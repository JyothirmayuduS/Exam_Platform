import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowRight, FiCamera, FiRefreshCw } from "react-icons/fi";
import { loadPhotoStatus, uploadRegistrationPhoto } from "@/shared/data/api/registrationPhoto";
import { useAuth } from "@/features/auth/auth";

const MAX_WIDTH = 640;
/** A status check slower than this counts as unreachable, so the student goes on. */
export const PHOTO_STATUS_TIMEOUT_MS = 4000;

/** Signed-in users already known to have a photo (or to need none) in this tab. */
const cleared = new Set<string>();

/** Shrinks a camera frame to a small JPEG for storage. */
function frameToJpeg(video: HTMLVideoElement): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Before a student reaches their exams they take one registration photo.
 * If the server can't be reached, or doesn't answer within a few seconds, the
 * student is let through, so a network problem never blocks an exam; the
 * admin console lists who is missing one.
 */
export default function RegistrationPhotoGate({ children }: { children: ReactNode }) {
  const userId = useAuth().user?.id ?? null;
  const [state, setState] = useState<"checking" | "needed" | "done">(() => (userId && cleared.has(userId) ? "done" : "checking"));

  useEffect(() => {
    if (!userId || cleared.has(userId)) { setState("done"); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unreachable = { ok: false as const, error: "timeout" };
    const timeout = new Promise<typeof unreachable>((resolve) => { timer = setTimeout(() => resolve(unreachable), PHOTO_STATUS_TIMEOUT_MS); });
    void Promise.race([loadPhotoStatus().catch(() => unreachable), timeout]).then((res) => {
      clearTimeout(timer);
      if (!alive) return;
      const needed = res.ok && res.data.required && !res.data.hasPhoto;
      if (res.ok && !needed) cleared.add(userId);
      setState(needed ? "needed" : "done");
    });
    return () => { alive = false; clearTimeout(timer); };
  }, [userId]);

  const finish = () => { if (userId) cleared.add(userId); setState("done"); };

  if (state === "checking") return <p className="flex min-h-screen items-center justify-center bg-paper font-mono text-[11px] uppercase tracking-widest text-soft">Loading…</p>;
  if (state === "needed") return <PhotoCapture onDone={finish} />;
  return <>{children}</>;
}

function PhotoCapture({ onDone }: { onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<{ msg: string; noDevice: boolean } | null>(null);
  const [capture, setCapture] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live: MediaStream | null = null;
    let alive = true;
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError({ msg: "This browser can't use a camera.", noDevice: true });
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 } }, audio: false })
      .then((s) => { if (!alive) { s.getTracks().forEach((t) => t.stop()); return; } live = s; setStream(s); })
      .catch((e: { name?: string }) => {
        if (!alive) return;
        const noDevice = e?.name === "NotFoundError" || e?.name === "OverconstrainedError";
        setCameraError({
          msg: noDevice ? "No camera was found on this device." : "Camera access was blocked. Allow the camera for this site, then try again.",
          noDevice,
        });
      });
    return () => { alive = false; live?.getTracks().forEach((t) => t.stop()); };
  }, [attempt]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    void Promise.resolve(v.play()).catch(() => undefined);
  }, [stream, capture]);

  const take = () => {
    const img = videoRef.current ? frameToJpeg(videoRef.current) : null;
    if (!img) { setError("The camera isn't ready yet. Wait a moment and try again."); return; }
    setCapture(img);
    setError("");
  };

  const save = async () => {
    if (!capture) return;
    setSaving(true);
    const res = await uploadRegistrationPhoto(capture);
    setSaving(false);
    if (res.ok || res.code === "already_taken") { stream?.getTracks().forEach((t) => t.stop()); onDone(); return; }
    setError(res.error);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-10 text-ink">
      <div className="w-full max-w-xl space-y-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-soft">One-time step</p>
          <h1 className="mt-1 font-serif text-2xl font-semibold">Take your registration photo</h1>
          <p className="mt-1 text-[13px] text-soft">
            This photo is kept on your record so staff can confirm who is writing the exam. You only do this once. Face the camera in good light, without a cap or mask.
          </p>
        </div>

        <div className="overflow-hidden border border-line bg-ink">
          {capture ? (
            <img src={capture} alt="Your registration photo" className="aspect-video w-full bg-black object-contain" />
          ) : cameraError ? (
            <div className="flex aspect-video items-center justify-center px-6 text-center text-[13px] text-paper/80">{cameraError.msg}</div>
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full -scale-x-100 bg-black object-cover" />
          )}
        </div>

        {error && <p role="alert" className="border border-alert/40 bg-alert/5 px-3 py-2 text-[12px] text-alert">{error}</p>}

        <div className="flex flex-wrap justify-end gap-3">
          {cameraError ? (
            <>
              {cameraError.noDevice && (
                <button onClick={onDone} className="border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-soft hover:border-ink hover:text-ink">Continue without a photo</button>
              )}
              <button onClick={() => setAttempt((n) => n + 1)} className="flex items-center gap-2 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-soft">
                <FiRefreshCw aria-hidden /> Try again
              </button>
            </>
          ) : capture ? (
            <>
              <button onClick={() => { setCapture(null); setError(""); }} disabled={saving} className="flex items-center gap-2 border border-line px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-raised">
                <FiRefreshCw aria-hidden /> Retake
              </button>
              <button onClick={() => void save()} disabled={saving} className="flex items-center gap-2 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-soft disabled:opacity-60">
                {saving ? "Saving…" : <>Save and continue <FiArrowRight aria-hidden /></>}
              </button>
            </>
          ) : (
            <button onClick={take} disabled={!stream} className="flex items-center gap-2 border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-soft disabled:opacity-60">
              <FiCamera aria-hidden /> Take photo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
