import { useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ImageCropper from "../components/ImageCropper";
import { getSupabase } from "../lib/supabase";
import {
  compressImage,
  autoCropWhiteEdges,
  rotateImage,
} from "../lib/subjectiveUpload";

type UploadStep = "capture" | "preview" | "crop" | "review" | "uploading" | "done" | "error";

export default function MobileUpload() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const examId = searchParams.get("examId") || "EXAM";
  const examName = searchParams.get("examName") || "";
  const qId = searchParams.get("qId") || "1";
  const studentId = searchParams.get("student") || "";
  const studentName = searchParams.get("studentName") || "";

  const [pages, setPages] = useState<{ blob: Blob; url: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<UploadStep>("capture");
  const [rawBlob, setRawBlob] = useState<Blob | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const loadFile = async (file: File) => {
    setProcessing(true);
    try {
      // Compress first
      const compressed = await compressImage(file, { maxWidth: 1920, maxHeight: 2560, quality: 0.85 });
      setRawBlob(compressed);
      setPreviewBlob(compressed);
      setPreviewUrl(URL.createObjectURL(compressed));
      setStep("preview");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to read image");
      setStep("error");
    } finally {
      setProcessing(false);
    }
  };

  const applyRotate = async (deg: 90 | 180 | 270) => {
    if (!previewBlob) return;
    setProcessing(true);
    const newDeg = ((rotation + deg) % 360) as 0 | 90 | 180 | 270;
    const rotated = await rotateImage(previewBlob, deg);
    setPreviewBlob(rotated);
    setPreviewUrl(URL.createObjectURL(rotated));
    setRotation(newDeg);
    setProcessing(false);
  };

  const applyAutoCrop = async () => {
    if (!previewBlob) return;
    setProcessing(true);
    const cropped = await autoCropWhiteEdges(previewBlob);
    setPreviewBlob(cropped);
    setPreviewUrl(URL.createObjectURL(cropped));
    setProcessing(false);
  };

  const handleCropConfirm = (cropped: Blob) => {
    setPreviewBlob(cropped);
    setPreviewUrl(URL.createObjectURL(cropped));
    setStep("preview");
  };

  const doUpload = async () => {
    if (pages.length === 0 || !token) {
      setErrorMsg("Missing token or image. Please scan the QR code again.");
      setStep("error");
      return;
    }
    setStep("uploading");
    setProgress(0);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append("token", token);
      pages.forEach((p, i) => formData.append(`image_${i}`, p.blob, `page_${i}.jpg`));

      const db = getSupabase();
      if (!db) throw new Error("Database not connected");

      setProgress(50);
      const { data, error } = await db.functions.invoke("mobile-upload", {
        body: formData,
      });
      setProgress(100);

      if (error) {
        let errMessage = error.message;
        if (error.context && typeof error.context.json === 'function') {
          try {
            const errBody = await error.context.json();
            if (errBody && errBody.error) errMessage = errBody.error;
          } catch (e) {}
        } else if (typeof error.message === 'string' && error.message.includes('{')) {
           try { errMessage = JSON.parse(error.message).error || error.message; } catch(e) {}
        }
        throw new Error(errMessage || "Upload failed");
      }

      setUploadedUrl(pages[0].url); // just preview the first page
      setStep("done");
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "An error occurred");
      setStep("error");
    }
  };

  return (
    <>
      {/* Crop overlay */}
      {step === "crop" && previewBlob && (
        <ImageCropper
          blob={previewBlob}
          onCrop={handleCropConfirm}
          onCancel={() => setStep("preview")}
        />
      )}

      <div className="min-h-screen bg-paper text-ink flex flex-col">
        {/* Header */}
        <header className="border-b border-line px-4 py-3">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Vignan University · Exam Upload</p>
          <h1 className="mt-0.5 font-serif text-lg font-semibold">Subjective Answer Upload</h1>
        </header>

        <main className="flex-1 px-4 py-5 space-y-4 max-w-md mx-auto w-full">
          {/* Meta */}
          <div className="border border-line bg-paper-raised px-4 py-3 space-y-1 font-mono text-[11px]">
            <div className="flex justify-between"><span className="text-ink-soft">Exam</span><span>{examName || examId}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Question</span><span>{qId}</span></div>
            {studentId && <div className="flex justify-between"><span className="text-ink-soft">Student</span><span>{studentName || studentId}</span></div>}
          </div>

          {/* ── CAPTURE ── */}
          {step === "capture" && (
            <div className="space-y-4">
              <p className="text-[13px] text-ink-soft leading-relaxed">
                Take a clear photo of your handwritten answer sheet. Make sure it's well-lit and the writing is legible.
              </p>
              <label className="block w-full cursor-pointer border-2 border-dashed border-line-strong bg-paper-raised py-12 text-center hover:bg-paper">
                <div className="flex flex-col items-center gap-3">
                  <span className="text-4xl">📷</span>
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink">Take Photo / Choose from Gallery</span>
                  <span className="font-mono text-[9px] text-ink-soft">JPEG, PNG up to 20 MB</span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                       setRotation(0);
                       void loadFile(file);
                    }
                  }}
                />
              </label>
              {processing && (
                <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
                  <span className="h-2 w-2 animate-pulse bg-amber" />
                  Processing image…
                </div>
              )}
            </div>
          )}

          {/* ── PREVIEW ── */}
          {step === "preview" && previewUrl && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="font-mono text-[12px] uppercase tracking-widest">Adjust Page</h2>
                <span className="font-mono text-[10px] text-ink-soft bg-paper-raised px-2 py-1">Page {pages.length + 1}</span>
              </div>
              {/* Image preview */}
              <div className="border border-line overflow-hidden bg-ink">
                <img src={previewUrl} alt="Answer sheet preview" className="w-full object-contain max-h-[55vh]" />
              </div>

              {/* Editing tools */}
              <div className="border border-line p-3 space-y-2">
                <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Image tools</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setStep("crop")}
                    disabled={processing}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised disabled:opacity-60"
                  >
                    ✂ Crop
                  </button>
                  <button
                    onClick={() => void applyRotate(90)}
                    disabled={processing}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised disabled:opacity-60"
                  >
                    ↻ Rotate 90°
                  </button>
                  <button
                    onClick={() => void applyRotate(180)}
                    disabled={processing}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised disabled:opacity-60"
                  >
                    ↻ Rotate 180°
                  </button>
                  <button
                    onClick={() => void applyAutoCrop()}
                    disabled={processing}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised disabled:opacity-60"
                  >
                    ✦ Auto-crop edges
                  </button>
                  <button
                    onClick={() => {
                      setPreviewBlob(null);
                      setPreviewUrl(null);
                      if (pages.length > 0) setStep("review");
                      else setStep("capture");
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-paper-raised"
                  >
                    ✕ Cancel Page
                  </button>
                </div>
                {processing && (
                  <div className="flex items-center gap-2 font-mono text-[10px] text-ink-soft">
                    <span className="h-1.5 w-1.5 animate-pulse bg-amber" />
                    Applying…
                  </div>
                )}
              </div>

              {/* File size info */}
              {previewBlob && (
                <p className="font-mono text-[9px] text-ink-soft">
                  Image size: {(previewBlob.size / 1024).toFixed(0)} KB
                </p>
              )}

              <button
                onClick={() => {
                   setPages([...pages, { blob: previewBlob!, url: previewUrl! }]);
                   setPreviewBlob(null);
                   setPreviewUrl(null);
                   setStep("review");
                }}
                disabled={processing}
                className="w-full border border-forest bg-forest py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60"
              >
                Confirm Page
              </button>
            </div>
          )}

          {/* ── REVIEW ── */}
          {step === "review" && pages.length > 0 && (
            <div className="space-y-4">
              <h2 className="font-mono text-[12px] uppercase tracking-widest">Review Pages ({pages.length})</h2>
              <div className="grid grid-cols-2 gap-3">
                {pages.map((p, i) => (
                  <div key={i} className="relative border border-line bg-paper-raised aspect-[3/4]">
                    <img src={p.url} alt={`Page ${i+1}`} className="w-full h-full object-cover" />
                    <div className="absolute top-2 left-2 bg-black/60 text-white font-mono text-[10px] px-2 py-0.5 rounded">
                      Page {i+1}
                    </div>
                    <button
                      onClick={() => setPages(pages.filter((_, idx) => idx !== i))}
                      className="absolute top-2 right-2 bg-alert text-white w-6 h-6 flex items-center justify-center rounded-full text-[12px]"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                
                {pages.length < 10 && (
                  <button
                    onClick={() => setStep("capture")}
                    className="border-2 border-dashed border-line-strong bg-paper flex flex-col items-center justify-center text-ink-soft hover:bg-paper-raised hover:text-ink aspect-[3/4]"
                  >
                    <span className="text-2xl mb-1">+</span>
                    <span className="font-mono text-[9px] uppercase tracking-wider">Add Page</span>
                  </button>
                )}
              </div>

              <div className="pt-4 border-t border-line">
                <button
                  onClick={() => void doUpload()}
                  disabled={pages.length === 0}
                  className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60"
                >
                  Submit Answer ({pages.length} Pages) →
                </button>
              </div>
            </div>
          )}

          {/* ── UPLOADING ── */}
          {step === "uploading" && (
            <div className="space-y-4 py-6 text-center">
              <div className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">Uploading answer…</div>
              {/* Progress bar */}
              <div className="h-2 w-full bg-line overflow-hidden">
                <div
                  className="h-full bg-maroon transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="font-mono text-[10px] text-ink-soft">{progress}%</p>
            </div>
          )}

          {/* ── DONE ── */}
          {step === "done" && (
            <div className="py-8 space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center border-2 border-success bg-success/10">
                <span className="text-3xl text-success">✓</span>
              </div>
              <div>
                <p className="font-mono text-[12px] uppercase tracking-wider font-bold text-success">Upload complete</p>
                <p className="mt-2 text-[13px] text-ink-soft">Your answer has been received by the exam server. You may now close this tab.</p>
              </div>
              {uploadedUrl && (
                <div className="border border-line bg-paper-raised p-3">
                  <p className="font-mono text-[9px] text-ink-soft mb-1">Uploaded image</p>
                  <img src={uploadedUrl} alt="Uploaded answer" className="w-full max-h-48 object-contain" />
                </div>
              )}
              <div className="border border-line px-4 py-2 bg-paper-raised">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                  You can now safely close this tab or window.
                </p>
              </div>
            </div>
          )}

          {/* ── ERROR ── */}
          {step === "error" && (
            <div className="py-6 space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center border-2 border-alert bg-alert/10">
                <span className="text-3xl text-alert">✕</span>
              </div>
              <div>
                <p className="font-mono text-[12px] uppercase tracking-wider font-bold text-alert">Upload failed</p>
                <p className="mt-2 text-[13px] text-ink-soft">{errorMsg || "An error occurred. Please try again."}</p>
              </div>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => pages.length > 0 ? void doUpload() : setStep("capture")}
                  className="border border-maroon bg-maroon px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
                >
                  Retry upload
                </button>
                <button
                  onClick={() => setStep(pages.length > 0 ? "review" : "capture")}
                  className="border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wider"
                >
                  Go Back
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
