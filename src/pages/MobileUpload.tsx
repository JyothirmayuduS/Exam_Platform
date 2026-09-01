import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ImageCropper from "../components/ImageCropper";
import {
  uploadSubjectiveAnswer,
  compressImage,
  autoCropWhiteEdges,
  rotateImage,
} from "../lib/subjectiveUpload";

type UploadStep = "capture" | "preview" | "crop" | "uploading" | "done" | "error";

export default function MobileUpload() {
  const [searchParams] = useSearchParams();
  const examId = searchParams.get("examId") || "EXAM";
  const qId = searchParams.get("qId") || "1";
  const studentId = searchParams.get("student") || "";

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
    if (!previewBlob) return;
    setStep("uploading");
    setProgress(0);
    setErrorMsg(null);

    const result = await uploadSubjectiveAnswer({
      examId,
      studentId,
      questionId: qId,
      blob: previewBlob,
      onProgress: setProgress,
    });

    if (result.ok) {
      setUploadedUrl(result.publicUrl);
      setStep("done");
    } else {
      setErrorMsg(result.error);
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
            <div className="flex justify-between"><span className="text-ink-soft">Exam</span><span>{examId}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Question</span><span>{qId}</span></div>
            {studentId && <div className="flex justify-between"><span className="text-ink-soft">Roll No</span><span>{studentId}</span></div>}
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
                    if (file) void loadFile(file);
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
                      setStep("capture");
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-paper-raised"
                  >
                    ✕ Retake
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
                onClick={() => void doUpload()}
                disabled={processing}
                className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper disabled:opacity-60"
              >
                Submit Answer →
              </button>
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
              <button
                onClick={() => {
                  setStep("capture");
                  setPreviewBlob(null);
                  setPreviewUrl(null);
                  setProgress(0);
                }}
                className="border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-paper-raised"
              >
                Upload another photo
              </button>
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
                  onClick={() => previewBlob && void doUpload()}
                  className="border border-maroon bg-maroon px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
                >
                  Retry upload
                </button>
                <button
                  onClick={() => setStep("capture")}
                  className="border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wider"
                >
                  Retake photo
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
