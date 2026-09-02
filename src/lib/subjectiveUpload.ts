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

/** Classify an image load error event into an actionable category. */
function classifyImageError(event: Event | string | unknown): string {
  // The browser fires an Event on <img> onerror — check it for clues.
  if (event instanceof Event) {
    const target = event.target as HTMLImageElement | null;
    const src = target?.src ?? "";
    if (src.startsWith("blob:")) return "blob-decode-error";
    if (src.startsWith("data:")) return "data-url-error";
  }
  // If the error is a string (some environments), return it directly.
  if (typeof event === "string") return event;
  return "unknown-image-error";
}

/** Compress and optionally resize an image File/Blob → JPEG Blob.
 *
 *  Fixes applied (audit issues #4, #6, #9):
 *  - Issue #4: onerror captures and classifies browser ErrorEvent details.
 *  - Issue #6: URL.revokeObjectURL is ALWAYS called (success AND error) via
 *              a shared `cleanup` closure — no blob memory leaks.
 *  - Issue #9: 10-second timeout races the img.load — promise rejects and blob
 *              is cleaned up if the browser hangs loading the image.
 */
export async function compressImage(
  source: File | Blob,
  opts: { maxWidth?: number; maxHeight?: number; quality?: number; timeoutMs?: number } = {}
): Promise<Blob> {
  const { maxWidth = 1920, maxHeight = 2560, quality = 0.82, timeoutMs = 10_000 } = opts;

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    let settled = false;

    // ── Issue #6: single cleanup function — ALWAYS called ─────────────────
    const cleanup = () => {
      URL.revokeObjectURL(url);
    };

    // ── Issue #9: timeout — never wait forever ─────────────────────────────
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        `compressImage timed out after ${timeoutMs}ms — image may be corrupt or too large`
      ));
    }, timeoutMs);

    const img = new Image();

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup(); // ✅ revoke on success

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

      // ── Issue #8 (canvas-side): guard against null context ────────────────
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable — browser may be under memory pressure"));
        return;
      }

      // White background (for answer sheets)
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob failed — canvas may be tainted or empty"));
        },
        "image/jpeg",
        quality
      );
    };

    // ── Issue #4: capture error details & #6: revoke on error ─────────────
    img.onerror = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup(); // ✅ revoke on error — fixes blob memory leak

      const category = classifyImageError(event);
      const message =
        category === "blob-decode-error"
          ? "Image could not be decoded — the file may be corrupt or an unsupported format"
          : "Failed to load image for compression";

      console.error("[subjectiveUpload] compressImage onerror:", { category, event });
      reject(new Error(`${message} (${category})`));
    };

    img.src = url;
  });
}

/** Auto-detect and crop white/empty border from an answer-sheet image */
export async function autoCropWhiteEdges(blob: Blob, threshold = 245): Promise<Blob> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const cleanup = () => URL.revokeObjectURL(url);

    const timer = setTimeout(() => { cleanup(); resolve(blob); }, 10_000);

    const img = new Image();
    img.onload = () => {
      clearTimeout(timer);
      cleanup();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(blob); return; }
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
      const outCtx = out.getContext("2d");
      if (!outCtx) { resolve(blob); return; }
      outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      out.toBlob(
        (b) => { if (b) resolve(b); else resolve(blob); },
        "image/jpeg",
        0.9
      );
    };
    img.onerror = (event) => {
      clearTimeout(timer);
      cleanup(); // ✅ always revoke
      console.warn("[subjectiveUpload] autoCropWhiteEdges failed, returning original:", event);
      resolve(blob); // fallback: return original
    };
    img.src = url;
  });
}

/** Rotate an image blob by 90/180/270 degrees */
export async function rotateImage(blob: Blob, degrees: 90 | 180 | 270): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const cleanup = () => URL.revokeObjectURL(url);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("rotateImage timed out after 10s"));
    }, 10_000);

    const img = new Image();
    img.onload = () => {
      clearTimeout(timer);
      cleanup();
      const { naturalWidth: w, naturalHeight: h } = img;
      const canvas = document.createElement("canvas");
      const swap = degrees === 90 || degrees === 270;
      canvas.width = swap ? h : w;
      canvas.height = swap ? w : h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas 2D context unavailable")); return; }
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(img, -w / 2, -h / 2);
      canvas.toBlob(
        (b) => { if (b) resolve(b); else reject(new Error("Rotate failed")); },
        "image/jpeg",
        0.92
      );
    };
    img.onerror = (event) => {
      clearTimeout(timer);
      cleanup(); // ✅ always revoke
      console.error("[subjectiveUpload] rotateImage onerror:", event);
      reject(new Error("Failed to load image for rotation"));
    };
    img.src = url;
  });
}
