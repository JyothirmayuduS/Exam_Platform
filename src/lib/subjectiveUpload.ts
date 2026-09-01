import { getSupabase } from "./supabase";

// ── Upload a subjective answer image to Supabase Storage ──────────────────────
// Path: exam-records/{examId}/{studentId}/subjective/q{questionId}_{timestamp}.jpg
// Falls back to a simulated upload if Supabase isn't configured.

export type UploadResult =
  | { ok: true; path: string; publicUrl: string }
  | { ok: false; error: string };

export async function uploadSubjectiveAnswer(opts: {
  examId: string;
  studentId: string;
  questionId: number | string;
  blob: Blob;
  onProgress?: (pct: number) => void;
}): Promise<UploadResult> {
  const { examId, studentId, questionId, blob, onProgress } = opts;
  const ts = Date.now();
  const path = `${examId}/${studentId}/subjective/q${questionId}_${ts}.jpg`;
  const bucketName = import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";

  onProgress?.(10);

  const supabase = getSupabase();
  if (!supabase) {
    // Simulate upload for dev mode
    await new Promise((r) => setTimeout(r, 1200));
    onProgress?.(100);
    return { ok: true, path, publicUrl: URL.createObjectURL(blob) };
  }

  try {
    onProgress?.(30);
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(path, blob, {
        contentType: "image/jpeg",
        upsert: true,
      });

    onProgress?.(90);
    if (error) return { ok: false, error: error.message };

    const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(data.path);
    onProgress?.(100);
    return { ok: true, path: data.path, publicUrl: urlData.publicUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
  }
}

// ── Image processing utilities ────────────────────────────────────────────────

/** Compress and optionally resize an image File/Blob → JPEG Blob */
export async function compressImage(
  source: File | Blob,
  opts: { maxWidth?: number; maxHeight?: number; quality?: number } = {}
): Promise<Blob> {
  const { maxWidth = 1920, maxHeight = 2560, quality = 0.82 } = opts;

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;

      // Scale down if needed
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;

      // White background (for answer sheets)
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob failed"));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

/** Auto-detect and crop white/empty border from an answer-sheet image */
export async function autoCropWhiteEdges(blob: Blob, threshold = 245): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);

      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;

      const isWhiteish = (px: number) =>
        data[px] > threshold && data[px + 1] > threshold && data[px + 2] > threshold;

      let top = 0, bottom = height - 1, left = 0, right = width - 1;

      // Scan rows from top
      outer_top: for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!isWhiteish((y * width + x) * 4)) { top = y; break outer_top; }
        }
      }
      // Scan rows from bottom
      outer_bottom: for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
          if (!isWhiteish((y * width + x) * 4)) { bottom = y; break outer_bottom; }
        }
      }
      // Scan cols from left
      outer_left: for (let x = 0; x < width; x++) {
        for (let y = top; y <= bottom; y++) {
          if (!isWhiteish((y * width + x) * 4)) { left = x; break outer_left; }
        }
      }
      // Scan cols from right
      outer_right: for (let x = width - 1; x >= 0; x--) {
        for (let y = top; y <= bottom; y++) {
          if (!isWhiteish((y * width + x) * 4)) { right = x; break outer_right; }
        }
      }

      const pad = 12;
      const cropX = Math.max(0, left - pad);
      const cropY = Math.max(0, top - pad);
      const cropW = Math.min(width, right + pad) - cropX;
      const cropH = Math.min(height, bottom + pad) - cropY;

      const out = document.createElement("canvas");
      out.width = cropW;
      out.height = cropH;
      const outCtx = out.getContext("2d")!;
      outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      out.toBlob(
        (b) => { if (b) resolve(b); else resolve(blob); },
        "image/jpeg",
        0.9
      );
    };
    img.onerror = () => resolve(blob); // fallback: return original
    img.src = url;
  });
}

/** Rotate an image blob by 90/180/270 degrees */
export async function rotateImage(blob: Blob, degrees: 90 | 180 | 270): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: h } = img;
      const canvas = document.createElement("canvas");
      const swap = degrees === 90 || degrees === 270;
      canvas.width = swap ? h : w;
      canvas.height = swap ? w : h;
      const ctx = canvas.getContext("2d")!;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(img, -w / 2, -h / 2);
      canvas.toBlob(
        (b) => { if (b) resolve(b); else reject(new Error("Rotate failed")); },
        "image/jpeg",
        0.92
      );
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}
