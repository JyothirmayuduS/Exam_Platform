import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getSupabase } from "../../lib/supabase";

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
  const [upsertError, setUpsertError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const isLocalhost = base.includes("localhost") || base.includes("127.0.0.1");

  useEffect(() => {
    if (!studentId || !attemptId) return;
    const db = getSupabase();
    if (!db) return;

    let active = true;
    let channel: any = null;

    const initSession = async () => {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hr

      // Insert or ignore if it already exists (same token)
      const { error } = await db.from("mobile_upload_sessions").upsert({
        attempt_id: attemptId,
        question_id: String(questionId),
        student_id: studentId,
        token_hash: token,
        expires_at: expiresAt,
        question_index: questionIndex // Pass index for watermark
      }, { onConflict: "token_hash" });

      if (error) {
        console.error("Failed to create upload session:", error);
        setUpsertError(error.message);
        return;
      }
      setUpsertError("SUCCESS (no error returned from upsert)");

      channel = db.channel(`session_${token}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "mobile_upload_sessions", filter: `token_hash=eq.${token}` },
          async (payload: any) => {
            const newStatus = payload.new.status;
            setStatus(newStatus);
            
            if (newStatus === "COMPLETED") {
               const { data: subData } = await db.from("question_submissions")
                 .select("pdf_storage_path")
                 .eq("attempt_id", attemptId)
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
  }, [examId, attemptId, questionId, studentId, onAnswerUploaded]);

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
          Subjective answer — scan to upload from phone
        </p>
      </div>

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
