import { useState, useEffect, useCallback, useRef } from "react";
import { FiCamera, FiAlertTriangle } from "react-icons/fi";
import { QRCodeSVG } from "qrcode.react";
import { getSupabase } from "@/shared/data/supabase";
import { uploadSubjectiveAnswer } from "@/shared/services/subjectiveUpload";
import { markUploadHandled, shouldApplyUpload } from "@/features/student/services/uploadedAnswers";

function getPublicBase(): string {
  const envUrl = import.meta.env.VITE_APP_BASE_URL as string | undefined;
  if (envUrl && envUrl.trim() !== "" && !envUrl.includes("shy-rattlesnake-39") && !envUrl.includes("loca.lt")) {
    return envUrl.trim().replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    // If the teacher accesses the dashboard via localhost, the QR code must STILL use their real network IP!
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      // @ts-ignore: __LOCAL_IP__ is injected by Vite at build time
      const localIp = typeof __LOCAL_IP__ !== "undefined" ? __LOCAL_IP__ : "localhost";
      return `http://${localIp}:${window.location.port}`;
    }
    return window.location.origin;
  }
  return "";
}

type Props = {
  examId: string;
  attemptId?: string;
  questionId: number | string;
  questionIndex?: number;
  studentId: string | null;
  studentName?: string;
  examName?: string;
  questionText?: string;
  /** Receives the STORAGE PATH of the upload (or a blob: URL in dev mode) —
   *  never a 1-hour signed URL, which expires while the exam is still open
   *  and made the answer look "uploaded but missing" on revisit. */
  onAnswerUploaded?: (pathOrUrl: string) => void;
  /** The question's answer as the exam currently holds it. */
  currentAnswer?: unknown;
};

export default function SubjectiveQRBlock({
  examId,
  attemptId,
  questionId,
  questionIndex,
  studentId,
  studentName,
  examName,
  onAnswerUploaded,
  currentAnswer,
}: Props) {
  const currentAnswerRef = useRef(currentAnswer);
  currentAnswerRef.current = currentAnswer;
  const base = getPublicBase();
  const [token] = useState<string>(() => {
    const generateToken = () => typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : `token_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
    if (!attemptId) return generateToken();
    const key = `mobile_upload_${attemptId}_${questionId}`;
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const newToken = generateToken();
    sessionStorage.setItem(key, newToken);
    return newToken;
  });
  const [status, setStatus] = useState<string>("WAITING");
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Bumping this re-runs the session-creation effect (retry button).
  const [retryNonce, setRetryNonce] = useState(0);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  // Mobile uploads are PDFs — unless PDF generation failed on the server and
  // only the original JPEG landed. Rendered differently (iframe vs img).
  const [uploadIsImage, setUploadIsImage] = useState(false);

  // Direct desktop browser upload (no QR needed)
  const [showUploader, setShowUploader] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isLocalhost = base.includes("localhost") || base.includes("127.0.0.1");

  // The parent passes a fresh callback on every render (the exam timer ticks
  // every second); keep it in a ref so the session effect below doesn't
  // tear down its realtime channel and poller on each tick.
  const onUploadedRef = useRef(onAnswerUploaded);
  onUploadedRef.current = onAnswerUploaded;

  // Looks up the latest stored upload for this question. The submissions
  // table is the source of truth: it is read directly (not only after the
  // session flips to COMPLETED), so an upload from an older QR for the same
  // question is still picked up. Returns true once the answer is shown.
  const fetchSubmission = useCallback(async (db: NonNullable<ReturnType<typeof getSupabase>>): Promise<boolean> => {
    let query = db.from("question_submissions")
      .select("pdf_storage_path, mime_type")
      .eq("question_id", String(questionId))
      .eq("student_id", studentId ?? "")
      .order("created_at", { ascending: false })
      .limit(1);
    if (attemptId) query = query.eq("attempt_id", attemptId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn("[SubjectiveQRBlock] submission lookup failed:", error.message);
      return false;
    }
    const path = data?.pdf_storage_path as string | undefined;
    if (!path || !shouldApplyUpload(attemptId, path, currentAnswerRef.current)) return false;
    markUploadHandled(attemptId, path);
    // The answer keeps the storage PATH; signed URLs are minted at render.
    onUploadedRef.current?.(path);
    setUploadIsImage((data?.mime_type ?? "").startsWith("image/") || !path.endsWith(".pdf"));
    setStatus("COMPLETED");
    const { getArtifactObjectUrl } = await import("@/shared/services/examStorage");
    const signedUrl = await getArtifactObjectUrl(path, 3600);
    if (signedUrl) setPdfUrl(signedUrl);
    return true;
  }, [attemptId, questionId, studentId]);

  useEffect(() => {
    // Create the session as soon as studentId is available — don't block on
    // attemptId; the mobile-upload function resolves a placeholder attempt.
    if (!studentId) return;
    const db = getSupabase();
    if (!db) return;

    let active = true;
    let done = false;
    let channel: ReturnType<typeof db.channel> | null = null;
    let pollId: number | undefined;

    const check = async () => {
      if (!active || done) return;
      if (await fetchSubmission(db)) {
        done = true;
        if (pollId !== undefined) window.clearInterval(pollId);
      }
    };

    const initSession = async () => {
      // Restore an already-completed upload (question revisited / remount).
      await check();
      if (!active || done) return;

      // `question_index` is deliberately not written: the column does not
      // exist and referencing it makes every scan fail with "Invalid token".
      const { error } = await db.from("mobile_upload_sessions").upsert({
        attempt_id: attemptId || `pending_${studentId}`,
        question_id: String(questionId),
        student_id: studentId,
        token_hash: token,
        expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      }, { onConflict: "token_hash" });
      if (!active) return;
      if (error) {
        console.error("[SubjectiveQRBlock] Session upsert failed:", error);
        setSessionError(`Session error: ${error.message}`);
        return;
      }
      setSessionError(null);

      channel = db.channel(`session_${token}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "mobile_upload_sessions", filter: `token_hash=eq.${token}` },
          (payload: { new: { status?: string } }) => {
            if (!active || done) return;
            const next = payload.new.status ?? "WAITING";
            setStatus(next);
            // The submission row is written just before COMPLETED; check now
            // and once more shortly after in case it lands a beat later.
            if (next === "COMPLETED") {
              void check();
              window.setTimeout(() => void check(), 1500);
            }
          },
        )
        .subscribe();

      // Polling fallback: realtime can be dropped by flaky networks or
      // throttled sockets, so the upload still appears within a few seconds.
      pollId = window.setInterval(() => void check(), 3000);
    };

    void initSession();

    return () => {
      active = false;
      if (channel) void db.removeChannel(channel);
      if (pollId !== undefined) window.clearInterval(pollId);
    };
  }, [studentId, attemptId, questionId, token, fetchSubmission, retryNonce]);


  // Direct desktop image upload (no QR/phone required)
  const handleDirectUpload = useCallback(async (file: File) => {
    if (!studentId || !examId) { setUploadError("Session not ready"); return; }
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      setUploadProgress(30);
      const result = await uploadSubjectiveAnswer({
        examId,
        studentId,
        questionId: String(questionId),
        blob: file,
        onProgress: setUploadProgress,
      });
      if (!result.ok) { setUploadError(result.error); return; }
      setUploadProgress(100);
      // blob: URLs (dev mode) display directly; real uploads pass the storage
      // path so signed URLs are minted fresh at render time, never stored.
      if (!result.publicUrl.startsWith("blob:")) markUploadHandled(attemptId, result.path);
      onUploadedRef.current?.(result.publicUrl.startsWith("blob:") ? result.publicUrl : result.path);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [studentId, examId, questionId, attemptId]);

  // The QR URL carries only the single-use capability token + non-PII ids.
  // The student's NAME is never placed in the URL (it would leak into phone
  // browser history / any URL logging) — the mobile-upload function resolves
  // the authoritative name/roll from the DB via the session's student_id.
  const queryParams = new URLSearchParams({
    examId: examId,
    qId: String(questionIndex || questionId),
    student: studentId || "",
    examName: examName || "",
    // Display-only name so the phone page can show WHO is uploading without a
    // DB round trip. It is not an auth credential — the edge function resolves
    // the authoritative identity from the session's student_id.
    studentName: studentName || "",
  });
  const uploadUrl = token ? `${base}/mobile-upload/${token}?${queryParams.toString()}` : "";

  return (
    <div className="mt-4 border border-dashed border-line bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-soft">
          Subjective answer — {showUploader ? "upload from desktop" : "scan to upload from phone"}
        </p>
        <button
          onClick={() => setShowUploader(v => !v)}
          className="border border-forest text-forest px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-forest/10"
        >
          {showUploader ? "Use QR Code" : "Upload from Desktop"}
        </button>
      </div>

      {isLocalhost && !pdfUrl && (
        <div className="mb-4 border border-amber/50 bg-amber/10 px-4 py-2.5 text-[12px]">
          <p className="font-mono text-[10px] uppercase tracking-wider text-amber font-bold mb-1">
            ℹ Local dev mode
          </p>
          <p className="text-soft">
            The QR code points to <code className="bg-raised px-1 font-mono text-[11px]">{base}</code>. Both devices <strong>MUST be on the same Wi-Fi network</strong>.
          </p>
        </div>
      )}



      {sessionError ? (
        <div className="border border-alert/40 bg-alert/5 px-4 py-3 text-[12px] text-alert">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider font-bold">
            <FiAlertTriangle className="text-amber" aria-hidden /> Upload session could not be created
          </p>
          <p className="mt-1 text-ink">{sessionError}</p>
          <p className="mt-1 text-[11px] text-soft">
            The QR code is disabled until this is fixed — scanning it would just fail with
            “Invalid or expired token”. You can still use “Upload from Desktop” below, or retry
            creating the session.
          </p>
          <button
            onClick={() => setRetryNonce((n) => n + 1)}
            className="mt-3 border border-alert px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/10"
          >
            ↻ Retry creating session
          </button>
        </div>
      ) : status === "COMPLETED" ? (
        <div className="space-y-4">
          <div className="flex h-12 items-center gap-3 bg-success/10 px-4 text-success border border-success/20">
            <span className="text-xl">✓</span>
            <span className="font-mono text-[12px] uppercase tracking-widest font-bold">Answer Uploaded Successfully</span>
          </div>
          {!pdfUrl ? (
            <div className="flex h-40 items-center justify-center border border-line bg-raised font-mono text-[10px] uppercase tracking-widest text-soft">Loading preview…</div>
          ) : uploadIsImage ? (
            <img src={pdfUrl} alt="Uploaded answer" className="max-h-[600px] w-full border border-line bg-ink object-contain" />
          ) : (
            <iframe src={`${pdfUrl}#toolbar=0`} className="w-full h-[600px] border border-line bg-ink" title="Answer Preview" />
          )}
        </div>
      ) : showUploader ? (
        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-soft">
            Upload a photo of your handwritten answer directly from this device
          </p>
          <label className="flex cursor-pointer items-center gap-3 border border-forest/40 bg-forest/5 px-4 py-3 hover:bg-forest/10">
            <span className="text-xl text-forest"><FiCamera aria-hidden /></span>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-forest font-bold">Choose image file</p>
              <p className="font-mono text-[10px] text-soft">JPG, PNG, HEIC — max 10 MB</p>
            </div>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleDirectUpload(f); }}
            />
          </label>
          {uploading && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded bg-line">
                <div className="h-full bg-forest transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="font-mono text-[10px] text-soft">Uploading… {uploadProgress}%</p>
            </div>
          )}
          {uploadError && <p className="flex items-center gap-1.5 text-[12px] text-alert"><FiAlertTriangle aria-hidden /> {uploadError}</p>}
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0 bg-white p-2 border border-line flex items-center justify-center">
            {uploadUrl ? (
              <QRCodeSVG
                value={uploadUrl}
                size={180}
                bgColor={"#ffffff"}
                fgColor={"#1a1a1a"}
                level={"M"}
                includeMargin={false}
              />
            ) : (
              <div className="w-[180px] h-[180px] bg-raised animate-pulse flex items-center justify-center">
                <span className="font-mono text-[10px] text-soft uppercase tracking-widest text-center px-4">Generating Secure QR...</span>
              </div>
            )}
          </div>

          <div className="flex-1 space-y-4">
            <ol className="space-y-3 font-serif text-[15px] text-ink">
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-forest font-bold mt-0.5">01</span>
                <span>Open your phone's camera and scan this QR code.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-forest font-bold mt-0.5">02</span>
                <span>The link is securely tied to your exam session.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-forest font-bold mt-0.5">03</span>
                <span>Take a clear photo of your handwritten paper and tap Submit.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-forest font-bold mt-0.5">04</span>
                <span>The scanned PDF will appear here automatically.</span>
              </li>
            </ol>
            
            {status === "PROCESSING" && (
              <div className="flex items-center gap-2 mt-4 px-3 py-2 bg-forest/10 border border-forest/20 text-forest">
                <span className="animate-spin text-lg">⏳</span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest">Processing PDF & Watermarking...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
