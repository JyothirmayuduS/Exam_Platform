import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: "auto",
  endpoint: import.meta.env.VITE_S3_ENDPOINT || "",
  credentials: {
    accessKeyId: import.meta.env.VITE_S3_ACCESS_KEY || "",
    secretAccessKey: import.meta.env.VITE_S3_SECRET_KEY || "",
  },
});

/**
 * Upload the screen recording video to Cloudflare R2 ONLY.
 *
 * No PDF is generated, no per-second screenshots are uploaded, and no upload
 * goes to Supabase Storage. Everything is kept in one place: the R2 bucket
 * configured via VITE_S3_* env vars.
 */
export async function uploadExamRecords(opts: {
  examId: string;
  studentIdentifier: string;
  videoBlob: Blob;
}) {
  const { examId, studentIdentifier, videoBlob } = opts;

  // Single folder layout in R2: exam / student / recording.webm
  const videoPath = `${examId}/${studentIdentifier}/recording.webm`;

  const s3Bucket = import.meta.env.VITE_S3_BUCKET_NAME;
  if (!s3Bucket || !import.meta.env.VITE_S3_ENDPOINT) {
    console.warn("[examStorage] VITE_S3_BUCKET_NAME / VITE_S3_ENDPOINT not set — skipping R2 upload");
    return;
  }

  try {
    const videoCommand = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: videoPath,
      Body: videoBlob,
      ContentType: "video/webm",
    });
    await s3Client.send(videoCommand);
    console.log(`[examStorage] ✅ Uploaded recording to R2: ${videoPath}`);
  } catch (err) {
    console.error("[examStorage] R2 upload failed:", err);
  }
}
