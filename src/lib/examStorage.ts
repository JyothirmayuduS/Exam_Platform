import { getSupabase } from "./supabase";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: "auto",
  endpoint: import.meta.env.VITE_S3_ENDPOINT || "",
  credentials: {
    accessKeyId: import.meta.env.VITE_S3_ACCESS_KEY || "",
    secretAccessKey: import.meta.env.VITE_S3_SECRET_KEY || "",
  },
});

export async function uploadExamRecords(opts: {
  examId: string;
  studentIdentifier: string;
  pdfBlob: Blob;
  videoBlob: Blob;
}) {
  const { examId, studentIdentifier, pdfBlob, videoBlob } = opts;
  
  // Format requested: Exam folder / student folder / images pdf and recording video
  const pdfPath = `${examId}/${studentIdentifier}/images.pdf`;
  const videoPath = `${examId}/${studentIdentifier}/recording.webm`;
  
  const supabase = getSupabase();
  const bucketName = import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";
  
  // Upload to Supabase Storage
  if (supabase) {
    try {
      await supabase.storage.from(bucketName).upload(pdfPath, pdfBlob, { upsert: true, contentType: "application/pdf" });
      await supabase.storage.from(bucketName).upload(videoPath, videoBlob, { upsert: true, contentType: "video/webm" });
      console.log("Uploaded to Supabase successfully.");
    } catch (err) {
      console.error("Supabase upload failed:", err);
    }
  }

  // Upload to Cloudflare R2 / MinIO via S3 compatible API
  const s3Bucket = import.meta.env.VITE_S3_BUCKET_NAME;
  if (s3Bucket && import.meta.env.VITE_S3_ENDPOINT) {
    try {
      const pdfCommand = new PutObjectCommand({
        Bucket: s3Bucket,
        Key: pdfPath,
        Body: pdfBlob,
        ContentType: "application/pdf"
      });
      await s3Client.send(pdfCommand);

      const videoCommand = new PutObjectCommand({
        Bucket: s3Bucket,
        Key: videoPath,
        Body: videoBlob,
        ContentType: "video/webm"
      });
      await s3Client.send(videoCommand);
      console.log("Uploaded to S3/Cloudflare/MinIO successfully.");
    } catch (err) {
      console.error("S3 upload failed:", err);
    }
  }
}
