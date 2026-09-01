import { QRCodeSVG } from "qrcode.react";

// ── SubjectiveQRBlock ─────────────────────────────────────────────────────────
// IMPORTANT: The QR code URL must be reachable from the student's phone.
// Set VITE_APP_BASE_URL in .env.local to your tunnel or deployed URL.
// e.g. VITE_APP_BASE_URL=https://vignan-exam.loca.lt

// Resolve the public base URL for QR codes.
// Priority: env var > window.location.origin (works only on same network)
function getPublicBase(): string {
  const envUrl = import.meta.env.VITE_APP_BASE_URL as string | undefined;
  if (envUrl && envUrl.trim() !== "") return envUrl.trim().replace(/\/$/, "");
  return typeof window !== "undefined" ? window.location.origin : "";
}

type Props = {
  examId: string;
  questionId: number | string;
  studentId: string | null;
  questionText?: string;
};

export default function SubjectiveQRBlock({ examId, questionId, studentId }: Props) {
  const base = getPublicBase();
  const isLocalhost = base.includes("localhost") || base.includes("127.0.0.1");
  const uploadUrl = `${base}/mobile-upload?examId=${encodeURIComponent(examId)}&qId=${encodeURIComponent(String(questionId))}&student=${encodeURIComponent(studentId ?? "")}`;

  return (
    <div className="mt-5 border border-dashed border-line-strong bg-paper p-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft mb-4">
        Subjective answer — scan to upload from phone
      </p>

      {/* Warning: URL is localhost — QR won't work across networks */}
      {isLocalhost && (
        <div className="mb-4 border border-amber/50 bg-amber/10 px-4 py-3 text-[12.5px]">
          <p className="font-mono text-[10px] uppercase tracking-wider text-amber font-bold mb-1">⚠ Dev mode — QR may not work from phone</p>
          <p className="text-ink-soft">
            The QR code points to <code className="bg-paper-raised px-1 font-mono text-[11px]">{base}</code> which is only reachable on this computer.
          </p>
          <p className="mt-1 text-ink-soft">
            Run <code className="bg-paper-raised px-1 font-mono text-[11px]">npm run tunnel</code> in a new terminal, then paste the tunnel URL into <code className="bg-paper-raised px-1 font-mono text-[11px]">VITE_APP_BASE_URL</code> in your <code className="bg-paper-raised px-1 font-mono text-[11px]">.env.local</code> file and restart the dev server.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-center gap-6">
        {/* QR code */}
        <div className="flex flex-col items-center gap-2 shrink-0">
          <div className="bg-white p-3 border border-line">
            <QRCodeSVG
              value={uploadUrl}
              size={160}
              bgColor="#ffffff"
              fgColor="#1a1a1a"
              level="M"
              imageSettings={{
                src: "/vite.svg",
                x: undefined,
                y: undefined,
                height: 22,
                width: 22,
                excavate: true,
              }}
            />
          </div>
          <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Q{questionId}</span>
        </div>

        {/* Instructions */}
        <div className="flex-1 space-y-3 text-[13px]">
          <ol className="space-y-2 text-ink-soft">
            <li className="flex gap-2">
              <span className="font-mono text-[10px] text-maroon mt-0.5">01</span>
              <span>Open your phone camera and point it at the QR code above</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-[10px] text-maroon mt-0.5">02</span>
              <span>Tap the notification that appears to open the upload page</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-[10px] text-maroon mt-0.5">03</span>
              <span>Take a clear photo of your written answer and submit</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-[10px] text-maroon mt-0.5">04</span>
              <span>A confirmation will appear on this screen once uploaded</span>
            </li>
          </ol>

          {/* Text URL fallback */}
          <div className="border border-line bg-paper-raised px-3 py-2">
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-1">Can't scan? Type this URL:</p>
            <p className="font-mono text-[10px] break-all text-ink select-all">
              {base}/mobile-upload?examId={examId}&qId={questionId}
            </p>
          </div>
        </div>
      </div>

      {/* Upload status placeholder — poll via Supabase Realtime in production */}
      <div className="mt-4 flex items-center gap-2 border border-line px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-amber animate-pulse" />
        <span className="font-mono text-[10px] text-ink-soft">Waiting for mobile upload…</span>
      </div>
    </div>
  );
}
