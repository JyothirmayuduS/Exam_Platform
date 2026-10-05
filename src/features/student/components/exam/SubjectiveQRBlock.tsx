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
    <div className="exam-up">
      <div className="exam-uh">
        <span className="exam-sm exam-mute">
          {showUploader ? "Upload from this computer" : "Upload from your phone"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {status === "COMPLETED" ? (
            <span className="exam-pill g"><i />Answer received</span>
          ) : status === "PROCESSING" ? (
            <span className="exam-pill w"><i />Processing upload</span>
          ) : !showUploader && !sessionError ? (
            <span className="exam-pill w"><i />Waiting for upload</span>
          ) : null}
          {status !== "COMPLETED" && (
            <button onClick={() => setShowUploader((v) => !v)} className="exam-btn">
              {showUploader ? "Use phone instead" : "Upload from desktop"}
            </button>
          )}
        </div>
      </div>

      {isLocalhost && !pdfUrl && (
        <div className="exam-note w" style={{ marginTop: 14 }}>
          Local dev mode: the QR code points to <code>{base}</code>. The phone must be on the same Wi-Fi network.
        </div>
      )}

      {sessionError ? (
        <div className="exam-note b" style={{ marginTop: 14 }}>
          <p style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, margin: 0 }}>
            <FiAlertTriangle aria-hidden /> Upload link could not be created
          </p>
          <p style={{ margin: "4px 0 0", color: "var(--ink)" }}>{sessionError}</p>
          <p style={{ margin: "4px 0 10px", color: "var(--mute)" }}>
            The QR code is off until this is fixed. You can still upload from this computer.
          </p>
          <button onClick={() => setRetryNonce((n) => n + 1)} className="exam-btn">Try again</button>
        </div>
      ) : status === "COMPLETED" ? (
        <div style={{ padding: 14 }}>
          {!pdfUrl ? (
            <div className="flex h-40 items-center justify-center rounded-md border border-line bg-raised text-[13px] text-soft">Loading preview…</div>
          ) : uploadIsImage ? (
            <img src={pdfUrl} alt="Uploaded answer" className="max-h-[600px] w-full rounded-md border border-line bg-white object-contain" />
          ) : (
            <iframe src={`${pdfUrl}#toolbar=0`} className="h-[600px] w-full rounded-md border border-line bg-white" title="Answer preview" />
          )}
        </div>
      ) : showUploader ? (
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-line bg-[var(--card)] px-4 py-3 hover:border-forest">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-[var(--ps)] text-forest"><FiCamera aria-hidden /></span>
            <span>
              <b style={{ display: "block", fontWeight: 600 }}>Choose a photo of your answer</b>
              <span className="exam-sm exam-mute">JPG, PNG or HEIC, up to 10 MB</span>
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleDirectUpload(f); }}
            />
          </label>
          {uploading && (
            <div>
              <div className="exam-bar" style={{ margin: "0 0 4px" }}>
                <div style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="exam-sm exam-mute">Uploading… {uploadProgress}%</span>
            </div>
          )}
          {uploadError && <p style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--bad)", margin: 0 }}><FiAlertTriangle aria-hidden /> {uploadError}</p>}
        </div>
      ) : (
        <div className="exam-ub">
          <div className="exam-qr">
            {uploadUrl ? (
              <QRCodeSVG value={uploadUrl} size={140} bgColor="#ffffff" fgColor="#1A1814" level="M" includeMargin={false} />
            ) : (
              <div className="flex h-[140px] w-[140px] animate-pulse items-center justify-center bg-raised px-3 text-center text-[12px] text-soft">
                Creating secure code…
              </div>
            )}
          </div>
          <ol>
            <li>Scan this code with your phone camera.</li>
            <li>The link is tied to your exam session.</li>
            <li>Photograph your paper in good light and tap Submit.</li>
            <li>Your answer appears here automatically.</li>
          </ol>
        </div>
      )}
    </div>
  );
}
