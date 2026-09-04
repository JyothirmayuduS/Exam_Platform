import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getSupabase } from "../../lib/supabase";
import { uploadSubjectiveAnswer } from "../../lib/subjectiveUpload";

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
  onAnswerUploaded?: (url: string) => void;
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
}: Props) {
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
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  // Direct desktop browser upload (no QR needed)
  const [showUploader, setShowUploader] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isLocalhost = base.includes("localhost") || base.includes("127.0.0.1");

  useEffect(() => {
    // Create the session as soon as studentId is available — don't block on attemptId.
    // If attemptId isn't ready yet, use a placeholder so the mobile-upload edge function
    // can still find and validate the token.
    if (!studentId) return;
    const db = getSupabase();
    if (!db) return;

    let active = true;
    let channel: any = null;

    const initSession = async () => {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hr
      const effectiveAttemptId = attemptId || `pending_${studentId}`;

      const { error } = await db.from("mobile_upload_sessions").upsert({
        attempt_id: effectiveAttemptId,
        question_id: String(questionId),
        student_id: studentId,
        token_hash: token,
        expires_at: expiresAt,
        question_index: questionIndex,
      }, { onConflict: "token_hash" });

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
          async (payload: any) => {
            if (!active) return;
            const newStatus = payload.new.status;
            setStatus(newStatus);

            if (newStatus === "COMPLETED") {
              const { data: subData } = await db.from("question_submissions")
                .select("pdf_storage_path")
                .eq("attempt_id", effectiveAttemptId)
                .eq("question_id", String(questionId))
                .order("created_at", { ascending: false })
                .limit(1)
                .single();

              if (subData?.pdf_storage_path) {
                const { data: urlData } = db.storage.from("exam-records").getPublicUrl(subData.pdf_storage_path);
                setPdfUrl(urlData.publicUrl);
                onAnswerUploaded?.(urlData.publicUrl);
              }
            }
          }
        )
        .subscribe();
    };

    void initSession();

    return () => {
      active = false;
      if (channel) db.removeChannel(channel);
    };
  }, [examId, studentId, attemptId, questionId, questionIndex, token, onAnswerUploaded]);


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
      onAnswerUploaded?.(result.publicUrl);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [studentId, examId, questionId, onAnswerUploaded]);

  const queryParams = new URLSearchParams({
    examId: examId,
    qId: String(questionIndex || questionId),
    student: studentId || "",
    examName: examName || "",
    studentName: studentName || ""
  });
  const uploadUrl = token ? `${base}/mobile-upload/${token}?${queryParams.toString()}` : "";

  return (
    <div className="mt-4 border border-dashed border-line-strong bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Subjective answer — {showUploader ? "upload from desktop" : "scan to upload from phone"}
        </p>
        <button
          onClick={() => setShowUploader(v => !v)}
          className="border border-forest text-forest px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-forest/10"
        >
          {showUploader ? "Use QR Code" : "Upload from Desktop"}
        </button>
      </div>

      {sessionError && (
        <div className="mb-3 border border-alert/40 bg-alert/5 px-4 py-2.5 text-[12px] text-alert">
          <span className="font-mono text-[10px] uppercase tracking-wider">⚠ Session: </span>
          {sessionError}
        </div>
      )}

      {isLocalhost && !pdfUrl && (
        <div className="mb-4 border border-amber/50 bg-amber/10 px-4 py-2.5 text-[12px]">
          <p className="font-mono text-[10px] uppercase tracking-wider text-amber font-bold mb-1">
            ℹ Local dev mode
          </p>
          <p className="text-ink-soft">
            The QR code points to <code className="bg-paper-raised px-1 font-mono text-[11px]">{base}</code>. Both devices <strong>MUST be on the same Wi-Fi network</strong>.
          </p>
        </div>
      )}



      {status === "COMPLETED" && pdfUrl ? (
        <div className="space-y-4">
          <div className="flex h-12 items-center gap-3 bg-success/10 px-4 text-success border border-success/20">
            <span className="text-xl">✓</span>
            <span className="font-mono text-[12px] uppercase tracking-widest font-bold">Answer Uploaded Successfully</span>
          </div>
          <iframe src={`${pdfUrl}#toolbar=0`} className="w-full h-[600px] border border-line bg-ink" title="Answer Preview" />
        </div>
      ) : showUploader ? (
        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Upload a photo of your handwritten answer directly from this device
          </p>
          <label className="flex cursor-pointer items-center gap-3 border border-forest/40 bg-forest/5 px-4 py-3 hover:bg-forest/10">
            <span className="text-xl">📷</span>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-forest font-bold">Choose image file</p>
              <p className="font-mono text-[10px] text-ink-soft">JPG, PNG, HEIC — max 10 MB</p>
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
              <p className="font-mono text-[10px] text-ink-soft">Uploading… {uploadProgress}%</p>
            </div>
          )}
          {uploadError && <p className="text-[12px] text-alert">⚠ {uploadError}</p>}
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
              <div className="w-[180px] h-[180px] bg-paper-raised animate-pulse flex items-center justify-center">
                <span className="font-mono text-[10px] text-ink-soft uppercase tracking-widest text-center px-4">Generating Secure QR...</span>
              </div>
            )}
          </div>

          <div className="flex-1 space-y-4">
            <ol className="space-y-3 font-serif text-[15px] text-ink">
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-maroon font-bold mt-0.5">01</span>
                <span>Open your phone's camera and scan this QR code.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-maroon font-bold mt-0.5">02</span>
                <span>The link is securely tied to your exam session.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-maroon font-bold mt-0.5">03</span>
                <span>Take a clear photo of your handwritten paper and tap Submit.</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-maroon font-bold mt-0.5">04</span>
                <span>The scanned PDF will appear here automatically.</span>
              </li>
            </ol>
            
            {status === "PROCESSING" && (
              <div className="flex items-center gap-2 mt-4 px-3 py-2 bg-maroon/10 border border-maroon/20 text-maroon">
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
