import { useState, useRef } from "react";
import { getSupabase } from "../../lib/supabase";
import { compressImage } from "../../lib/subjectiveUpload";

type Props = {
  examId: string;
  attemptId?: string;
  studentId: string | null;
  questionId: string;
  optionNumber?: number;
  onUploaded: (url: string) => void;
};

export default function DirectImageUpload({
  examId,
  attemptId,
  studentId,
  questionId,
  optionNumber,
  onUploaded,
}: Props) {
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please select an image file (JPEG, PNG, etc.)");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("File too large. Max 20 MB.");
      return;
    }

    setError(null);
    setUploading(true);
    setProgress(10);

    try {
      // Compress the image
      const compressed = await compressImage(file, {
        maxWidth: 1920,
        maxHeight: 2560,
        quality: 0.85,
      });
      setProgress(40);

      // Show preview
      const previewUrl = URL.createObjectURL(compressed);
      setPreview(previewUrl);
      setProgress(50);

      // Upload to Supabase Storage
      const db = getSupabase();
      const bucket = import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";
      const path = `${examId}/${studentId || "anon"}/subjective/q${questionId}_${Date.now()}.jpg`;

      if (db) {
        const buffer = await compressed.arrayBuffer();
        const safeBlob = new Blob([buffer], { type: "image/jpeg" });

        const { error: uploadError } = await db.storage
          .from(bucket)
          .upload(path, safeBlob, {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (uploadError) throw new Error(uploadError.message);
        setProgress(80);

        const { data: urlData } = db.storage.from(bucket).getPublicUrl(path);
        setProgress(100);

        // Also save the upload reference in student_answers table so teachers can find it
        if (attemptId && studentId) {
          await db.from("student_answers").upsert({
            attempt_id: attemptId,
            question_id: String(questionId),
            student_id: studentId,
            uploaded_image_url: urlData.publicUrl,
          }, { onConflict: "attempt_id,question_id" });
        }

        onUploaded(urlData.publicUrl);
      } else {
        // Dev mode: simulate upload
        await new Promise((r) => setTimeout(r, 800));
        setProgress(100);
        onUploaded(URL.createObjectURL(compressed));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mt-4 border border-line bg-paper-raised p-4">
      {optionNumber && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-medium mb-2">
          Option {optionNumber}: Upload image directly from desktop
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      {preview ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-forest font-mono font-bold">
            <span className="h-2 w-2 rounded-full bg-forest animate-pulse" />
            Image selected — ready to submit
          </div>
          <img src={preview} alt="Selected answer" className="w-full max-h-[400px] object-contain border border-line" />
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (preview) URL.revokeObjectURL(preview);
                setPreview(null);
                fileRef.current && (fileRef.current.value = "");
              }}
              className="border border-alert text-alert px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:bg-alert/10"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <label className="flex flex-col items-center gap-2 cursor-pointer py-6 border-2 border-dashed border-line-strong hover:border-forest hover:bg-paper transition-colors">
          <span className="text-3xl">📷</span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
            {uploading ? "Uploading..." : "Take Photo / Choose from Gallery"}
          </span>
          <span className="font-mono text-[9px] text-ink-soft">JPEG, PNG up to 20 MB</span>
        </label>
      )}

      {uploading && (
        <div className="mt-2">
          <div className="h-1.5 bg-paper border border-line overflow-hidden">
            <div
              className="h-full bg-forest transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1 font-mono text-[9px] text-ink-soft text-right">{progress}%</p>
        </div>
      )}

      {error && (
        <p className="mt-2 font-mono text-[11px] text-alert bg-alert/10 border border-alert/30 px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
