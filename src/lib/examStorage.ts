import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

const s3Client = new S3Client({
  region: "auto",
  endpoint: import.meta.env.VITE_S3_ENDPOINT || "",
  credentials: {
    accessKeyId: import.meta.env.VITE_S3_ACCESS_KEY || "",
    secretAccessKey: import.meta.env.VITE_S3_SECRET_KEY || "",
  },
});

// Folder structure:
//   ${examName}/${studentId}/recordings/recording_${timestamp}.webm
//   ${examName}/${studentId}/screenshots/snap_${timestamp}.jpg
//   ${examName}/${studentId}/violations/${timestamp}_${type}.jpg
//   ${examName}/${studentId}/report/report_${timestamp}.pdf

function buildR2Path(
  examName: string,
  studentId: string,
  kind: "recordings" | "screenshots" | "violations" | "report",
  filename: string,
): string {
  return `${examName}/${studentId}/${kind}/${filename}`;
}

async function uploadToR2(path: string, blob: Blob, contentType: string): Promise<boolean> {
  const s3Bucket = import.meta.env.VITE_S3_BUCKET_NAME;
  if (!s3Bucket || !import.meta.env.VITE_S3_ENDPOINT) return false;
  try {
    const cmd = new PutObjectCommand({ Bucket: s3Bucket, Key: path, Body: blob, ContentType: contentType });
    await s3Client.send(cmd);
    console.log(`[examStorage] R2: ${path}`);
    return true;
  } catch (err) {
    console.warn(`[examStorage] R2 failed (${path}):`, err);
    return false;
  }
}

async function uploadToSupabase(path: string, blob: Blob, contentType: string): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const db = getSupabase();
  if (!db) return false;
  const bucket = import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";
  const { error } = await db.storage.from(bucket).upload(path, blob, { contentType, upsert: true });
  if (error) { console.warn(`[examStorage] Supabase failed (${path}):`, error.message); return false; }
  console.log(`[examStorage] Supabase: ${path}`);
  return true;
}

async function dualWrite(path: string, blob: Blob, contentType: string): Promise<void> {
  const r2ok = await uploadToR2(path, blob, contentType);
  if (!r2ok) await uploadToSupabase(path, blob, contentType);
}

export function captureFrame(video: HTMLVideoElement, quality = 0.6): Blob | null {
  const w = video.videoWidth; const h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"); if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  let b: Blob | null = null;
  c.toBlob((r) => { b = r; }, "image/jpeg", quality);
  return b;
}

export type ScreenshotHandle = {
  setVideo: (video: HTMLVideoElement | null) => void;
  stop: () => void;
  captureViolationSnapshot: (violationType: string) => Promise<Blob | null>;
};

export function startScreenshotCapture(opts: {
  examName: string;
  studentId: string;
  intervalMs?: number;
}): ScreenshotHandle {
  const { examName, studentId, intervalMs = 1000 } = opts;
  let video: HTMLVideoElement | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (!video) return;
    const blob = captureFrame(video); if (!blob) return;
    const path = buildR2Path(examName, studentId, "screenshots", `snap_${Date.now()}.jpg`);
    await dualWrite(path, blob, "image/jpeg");
  };

  void tick();
  const id = window.setInterval(() => void tick(), intervalMs);

  return {
    setVideo: (v) => { video = v; },
    stop: () => { stopped = true; window.clearInterval(id); video = null; },
    captureViolationSnapshot: async (violationType: string) => {
      if (!video) return null;
      const blob = captureFrame(video, 0.9); if (!blob) return null;
      const path = buildR2Path(examName, studentId, "violations", `${Date.now()}_${encodeURIComponent(violationType)}.jpg`);
      await dualWrite(path, blob, "image/jpeg");
      return blob;
    },
  };
}

export async function uploadExamRecords(opts: {
  examName: string;
  studentId: string;
  videoBlob: Blob;
  violationSnapshots?: { label: string; blob: Blob }[];
}): Promise<void> {
  const { examName, studentId, videoBlob, violationSnapshots = [] } = opts;
  const recFilename = `recording_${Date.now()}.webm`;
  const recPath = buildR2Path(examName, studentId, "recordings", recFilename);
  if (!await uploadToR2(recPath, videoBlob, "video/webm"))
    await uploadToSupabase(recPath, videoBlob, "video/webm");
  for (const snap of violationSnapshots) {
    const path = buildR2Path(examName, studentId, "violations", `${Date.now()}_${encodeURIComponent(snap.label)}.jpg`);
    if (!await uploadToR2(path, snap.blob, "image/jpeg"))
      await uploadToSupabase(path, snap.blob, "image/jpeg");
  }
  const pdfBlob = await generateProctorReport({ examName, studentId, violationSnapshots, recordingPath: recPath });
  const pdfPath = buildR2Path(examName, studentId, "report", `report_${Date.now()}.pdf`);
  if (!await uploadToR2(pdfPath, pdfBlob, "application/pdf"))
    await uploadToSupabase(pdfPath, pdfBlob, "application/pdf");
}


async function generateProctorReport(opts: {
  examName: string;
  studentId: string;
  violationSnapshots?: { label: string; blob: Blob }[];
  recordingPath: string;
}): Promise<Blob> {
  const { examName, studentId, violationSnapshots = [], recordingPath } = opts;
  const W = 595; const H = 842; const M = 40; const CW = W - M * 2;
  const pages: HTMLCanvasElement[] = [];

  const c1 = makeCanvas(W, H);
  const ctx1 = c1.getContext("2d")!;
  let y = M;

  ctx1.fillStyle = "#1a3a2a";
  ctx1.fillRect(M, y, CW, 52);
  ctx1.fillStyle = "#ffffff";
  ctx1.font = "bold 15px serif";
  ctx1.fillText("VIGNAN'S INSTITUTE OF INFORMATION TECHNOLOGY", M + 12, y + 22);
  ctx1.font = "11px monospace";
  ctx1.fillText("  PROCTORING EXAMINATION REPORT", M + 12, y + 40);

  ctx1.fillStyle = "#f0ebe0";
  ctx1.fillRect(W - M - 170, M, 170, 52);
  ctx1.fillStyle = "#1a1a1a";
  ctx1.font = "10px monospace";
  const now = new Date();
  ctx1.fillText(`Exam: ${examName}`, W - M - 160, M + 18);
  ctx1.fillText(`Date: ${now.toLocaleDateString()}`, W - M - 160, M + 32);
  ctx1.fillText(`Time: ${now.toLocaleTimeString()}`, W - M - 160, M + 46);

  y += 70;
  ctx1.fillStyle = "#1a3a2a"; ctx1.fillRect(M, y, CW, 2); y += 16;

  ctx1.fillStyle = "#1a1a1a"; ctx1.font = "bold 13px serif";
  ctx1.fillText("STUDENT DETAILS", M, y); y += 20;
  const details: [string, string][] = [
    ["Student Name:", studentId.split("_")[0] || studentId],
    ["Roll / ID:", studentId],
    ["Exam:", examName],
    ["Violations:", violationSnapshots.length > 0 ? `${violationSnapshots.length} flag(s) detected` : "None"],
  ];
  details.forEach(([label, value]) => {
    ctx1.fillStyle = "#555"; ctx1.font = "bold 11px monospace"; ctx1.fillText(label, M, y);
    ctx1.fillStyle = "#1a1a1a"; ctx1.font = "11px sans-serif"; ctx1.fillText(value, M + 140, y);
    y += 18;
  });

  y += 12; ctx1.fillStyle = "#1a3a2a"; ctx1.fillRect(M, y, CW, 2); y += 18;
  ctx1.fillStyle = "#1a1a1a"; ctx1.font = "bold 13px serif";
  ctx1.fillText("SCREEN SNAPSHOT TIMELINE", M, y); y += 18;
  ctx1.fillStyle = "#666"; ctx1.font = "10px monospace";
  ctx1.fillText("Periodic screen captures taken every second during the exam.", M, y); y += 22;

  const snapW = (CW - 20) / 3; const snapH = snapW * 0.62;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const sx = M + c * (snapW + 10); const sy = y + r * (snapH + 30);
      ctx1.strokeStyle = "#cccccc"; ctx1.lineWidth = 1; ctx1.fillStyle = "#e8e4dc";
      ctx1.fillRect(sx, sy, snapW, snapH); ctx1.strokeRect(sx, sy, snapW, snapH);
      ctx1.fillStyle = "#888"; ctx1.font = "8px monospace";
      ctx1.fillText(`Snap #${r * 3 + c + 1}`, sx + 4, sy + snapH / 2);
      ctx1.fillText(`~${r * 3 + c + 1}s`, sx + 4, sy + snapH / 2 + 12);
    }
  }
  y += 3 * (snapH + 30);

  y += 10; ctx1.fillStyle = "#1a3a2a"; ctx1.fillRect(M, y, CW, 2); y += 18;
  ctx1.fillStyle = "#1a1a1a"; ctx1.font = "bold 13px serif";
  ctx1.fillText("VIOLATION SUMMARY", M, y); y += 20;
  if (violationSnapshots.length === 0) {
    ctx1.fillStyle = "#2a7a2a"; ctx1.font = "11px monospace";
    ctx1.fillText("No violations detected during this exam session.", M, y);
  } else {
    violationSnapshots.forEach((v, i) => {
      ctx1.fillStyle = "#cc0000"; ctx1.font = "bold 10px monospace";
      ctx1.fillText(`WARNING: ${v.label}`, M, y);
      ctx1.fillStyle = "#666"; ctx1.font = "10px monospace";
      ctx1.fillText(`  (see page ${Math.floor(i / 4) + 2} for details)`, M + 200, y); y += 16;
    });
    ctx1.fillStyle = "#555"; ctx1.font = "9px monospace";
    ctx1.fillText("Violation moments are highlighted in RED in the recording.", M, y);
  }

  pages.push(c1);

  if (violationSnapshots.length > 0) {
    for (let vi = 0; vi < violationSnapshots.length; vi += 4) {
      const c = makeCanvas(W, H);
      const ctx = c.getContext("2d")!;
      let py = M;

      ctx.fillStyle = "#cc0000"; ctx.fillRect(M, py, CW, 38);
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 16px serif";
      ctx.fillText(`VIOLATION REPORT - Page ${Math.floor(vi / 4) + 1}`, M + 10, py + 25); py += 55;

      const pageSnaps = violationSnapshots.slice(vi, vi + 4);
      pageSnaps.forEach((snap, i) => {
        ctx.fillStyle = "#fff0f0"; ctx.strokeStyle = "#cc0000"; ctx.lineWidth = 1.5;
        ctx.fillRect(M, py, CW, 100); ctx.strokeRect(M, py, CW, 100);
        ctx.fillStyle = "#cc0000"; ctx.font = "bold 11px monospace";
        ctx.fillText(`Violation #${vi + i + 1}`, M + 8, py + 18);
        ctx.fillStyle = "#1a1a1a"; ctx.font = "12px sans-serif";
        ctx.fillText(`Type: ${snap.label}`, M + 8, py + 36);
        ctx.fillStyle = "#555"; ctx.font = "10px monospace";
        ctx.fillText("Highlighted in RED in the recording timeline.", M + 8, py + 54);
        ctx.fillStyle = "#e8e4dc"; ctx.fillRect(M + 220, py + 14, 120, 72); ctx.strokeRect(M + 220, py + 14, 120, 72);
        ctx.fillStyle = "#888"; ctx.font = "9px monospace"; ctx.fillText("Snapshot", M + 255, py + 55);
        py += 112; ctx.fillStyle = "#ddd"; ctx.fillRect(M, py, CW, 1); py += 10;
      });

      ctx.fillStyle = "#1a3a2a"; ctx.fillRect(M, H - 30, CW, 1);
      ctx.fillStyle = "#888"; ctx.font = "9px monospace";
      ctx.fillText("Vignan's Institute of Information Technology - Proctoring Report", M, H - 12);
      pages.push(c);
    }
  }

  return buildPDFBlob(pages);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}


function buildPDFBlob(pages: HTMLCanvasElement[]): Blob {
  const objects: string[] = [];
  let objNo = 1;
  const addObj = (content: string) => { objects.push(content); return objNo++; };

  pages.forEach((canvas, i) => {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const streamData = dataUrl.replace("data:image/jpeg;base64,", "");
    const imgObjNo = addObj(
      `${objNo} 0 obj
<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /Filter /DCTDecode /ColorSpace /DeviceRGB /BitsPerComponent 8 >>\nstream
${atob(streamData)}
endstream
endobj\n`,
    );
    const pageObjNo = addObj(
      `${objNo} 0 obj
<< /Type /Page /Parent 1 0 R /MediaBox [0 0 ${canvas.width} ${canvas.height}] /Contents ${objNo + 1} 0 R /Resources << /XObject << /Img${i + 1} ${imgObjNo} 0 R >> >> >>
endobj\n`,
    );
    const drawCmd = `q ${canvas.width} 0 0 ${canvas.height} 0 0 cm /Img${i + 1} Do Q`;
    addObj(`${objNo} 0 obj
<< /Length ${drawCmd.length} >>\nstream
${drawCmd}
endstream
endobj\n`);
  });

  const catalogNo = addObj(`${objNo} 0 obj
<< /Type /Catalog /Pages 1 0 R >>\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const xref: number[] = [];
  objects.forEach((obj) => { xref.push(pdf.length); pdf += obj + "\n"; });
  const xrefOffset = pdf.length;
  xref.push(xrefOffset);
  pdf += `xref
0 ${objects.length + 2}
0000000000 65535 f 
`;
  xref.forEach((off) => { pdf += `${String(off).padStart(10, "0")} 00000 n 
`; });
  pdf += `trailer
<< /Size ${objects.length + 2} /Root ${catalogNo - 1} 0 R >>\nstartxref\n${xrefOffset}
%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  return new Blob([bytes], { type: "application/pdf" });
}
