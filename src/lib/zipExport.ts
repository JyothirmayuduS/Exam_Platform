// Per-student evidence ZIP export (teacher + proctor side).
//
// "Generate report" bundles every candidate's Cloudflare R2 artifacts into ONE
// downloadable zip with a clear folder layout:
//
//   <ExamName>_evidence.zip
//   ├── 21VGN0314 - John Doe/
//   │   ├── recording/
//   │   │   ├── recording_1756….webm   (finished full video, preferred)
//   │   │   └── parts/…                (crash-safe segments, only when no
//   │   │                                finished video exists)
//   │   ├── ss/
//   │   │   ├── snap_….jpg             (per-second screenshots)
//   │   │   └── violations/….jpg       (flagged frames)
//   │   └── report.pdf                 (per-candidate proctor PDF, if stored)
//   └── …
//
// Everything is fetched through the server-signed R2 read path
// (examStorage.getArtifactObjectUrl) — the browser never holds credentials.

import { zip, type AsyncZippable } from "fflate";
import { listStudentArtifacts, getArtifactObjectUrl } from "./examStorage";

export type ZipStudent = {
  roll: string;
  name: string;
};

/** Make a string safe to use as a zip folder/file segment. */
// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]+/g;
function safeSegment(s: string, fallback: string): string {
  const clean = s
    .replace(UNSAFE_SEGMENT, "_")
    .replace(/^_+|_+$/g, "")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

function wrapZip(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      zip(files, (err, data) => (err ? reject(err) : resolve(data)));
    } catch (err) {
      reject(err);
    }
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Download one zip containing every student's evidence, with the folder layout
 * described at the top of this file. Students are processed one at a time and
 * artifacts are fetched sequentially so a large class never floods the network
 * at once; `onProgress` (if given) reports the current step.
 */
export async function downloadExamEvidenceZip(opts: {
  examId: string;
  examName?: string | null;
  students: ZipStudent[];
  /** Exact stored exam folder (e.g. "Test-3") — skips DB name resolution so
   *  the evidence archive can zip what the bucket actually holds. */
  folder?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ studentCount: number; fileCount: number; errors: string[] }> {
  const { examId, examName, students, folder, onProgress } = opts;
  const errors: string[] = [];
  const files: AsyncZippable = {};
  let fileCount = 0;
  let studentCount = 0;

  for (const s of students) {
    const folderName = safeSegment(s.roll, "candidate");
    const withName = s.name ? `${folderName} - ${safeSegment(s.name, "")}` : folderName;
    onProgress?.(`${s.name || s.roll}: reading artifacts…`);

    let artifacts;
    try {
      artifacts = await listStudentArtifacts(examId, s.roll, folder);
    } catch {
      errors.push(`${s.roll}: could not list stored artifacts`);
      continue;
    }
    if (!artifacts || artifacts.length === 0) continue;

    // Finished recordings are preferred; crash-safe /parts/ segments are only
    // included when no finished video exists (they are the same content).
    const finished = artifacts.filter(
      (a) => a.kind === "recordings" && !a.key.includes("/parts/"),
    );
    const parts = artifacts.filter(
      (a) => a.kind === "recordings" && a.key.includes("/parts/"),
    );
    const screenshots = artifacts.filter((a) => a.kind === "screenshots");
    const violations = artifacts.filter((a) => a.kind === "violations");
    const report = artifacts.find((a) => a.kind === "report");

    const recordingItems = finished.length > 0 ? finished : parts;
    const recordingSubdir = finished.length > 0 ? "recording" : "recording/parts";

    const targets: { path: string; key: string }[] = [];
    for (const r of recordingItems) {
      targets.push({ path: `${withName}/${recordingSubdir}/${safeSegment(r.name, "recording.webm")}`, key: r.key });
    }
    for (const sc of screenshots) {
      targets.push({ path: `${withName}/ss/${safeSegment(sc.name, "snapshot.jpg")}`, key: sc.key });
    }
    for (const v of violations) {
      targets.push({ path: `${withName}/ss/violations/${safeSegment(v.name, "violation.jpg")}`, key: v.key });
    }
    if (report) {
      targets.push({ path: `${withName}/report.pdf`, key: report.key });
    }
    if (targets.length === 0) continue;

    studentCount += 1;
    for (const t of targets) {
      try {
        const url = await getArtifactObjectUrl(t.key);
        if (!url) {
          errors.push(`${s.roll}: could not sign URL for ${t.key}`);
          continue;
        }
        const res = await fetch(url);
        if (!res.ok) {
          errors.push(`${s.roll}: HTTP ${res.status} for ${t.key}`);
          continue;
        }
        files[t.path] = new Uint8Array(await res.arrayBuffer());
        fileCount += 1;
        onProgress?.(`${s.name || s.roll}: packed ${t.path}`);
      } catch {
        errors.push(`${s.roll}: failed to download ${t.key}`);
      }
    }
  }

  if (fileCount === 0) {
    return { studentCount, fileCount, errors };
  }

  onProgress?.("Compressing zip…");
  const zipped = await wrapZip(files);
  const blob = new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  const base = safeSegment(examName || examId || "exam", "exam");
  triggerDownload(blob, `${base}_evidence.zip`);
  return { studentCount, fileCount, errors };
}