// Per-student evidence ZIP export (teacher + proctor side).
//
// "Generate report" bundles every candidate's Cloudflare R2 artifacts into ONE
// downloadable zip with a clear folder layout:
//
//   <ExamName>_evidence.zip
//   ├── 21VGN0314 - John Doe/
//   │   ├── recording/
//   │   │   ├── camera_full_exam.webm  (full exam, joined from its pieces)
//   │   │   ├── screen_full_exam.webm
//   │   │   └── camera_MISSING_PIECES.txt (only when a piece could not be fetched)
//   │   │       (older exams: the finished recording_….webm instead, or
//   │   │        recording-legacy_/camera-legacy_full_exam.webm from seg_/camera_ pieces)
//   │   ├── ss/
//   │   │   ├── snap_….jpg             (per-second screenshots)
//   │   │   └── violations/….jpg       (flagged frames)
//   │   └── report.pdf                 (per-candidate proctor PDF, if stored)
//   └── …
//
// The zip is streamed: students are processed one at a time, each recording
// is joined piece by piece straight into the archive, and finished bytes leave
// the JS heap as they are written (zipStream.createBlobSink). A full class
// never sits in memory at once. Links are signed in batches just before use
// and re-signed before they expire (pieceFetch).

import { listStudentArtifacts } from "@/shared/services/examStorage";
import { PIECE_FAMILIES, pieceTimeline, sortedParts } from "@/shared/services/recordingParts";
import { createPieceFetcher, describeMissing, joinPieces, PieceError, type PieceFetcher } from "@/shared/services/pieceFetch";
import { createBlobSink, ZipWriter, type ByteSink, type ZipEntryWriter } from "@/shared/services/zipStream";

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

const SMALL_FILE_CONCURRENCY = 6;

/** Stream a stored file's bytes into `write` without holding the whole body. */
async function streamFile(fetcher: PieceFetcher, key: string, write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  const res = await fetch(await fetcher.url(key));
  if (!res.ok) throw new PieceError(key, `could not be downloaded (HTTP ${res.status})`);
  const reader = res.body?.getReader?.();
  if (!reader) {
    await write(new Uint8Array(await res.arrayBuffer()));
    return;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) await write(value);
  }
}

/**
 * Download one zip containing every student's evidence, with the folder layout
 * described at the top of this file. `onProgress` (if given) reports the
 * current step. `sink` replaces the default download (a test seam).
 */
export async function downloadExamEvidenceZip(opts: {
  examId: string;
  examName?: string | null;
  students: ZipStudent[];
  /** Exact stored exam folder (e.g. "Test-3") — skips DB name resolution so
   *  the evidence archive can zip what the bucket actually holds. */
  folder?: string;
  onProgress?: (msg: string) => void;
  sink?: ByteSink;
}): Promise<{ studentCount: number; fileCount: number; errors: string[] }> {
  const { examId, examName, students, folder, onProgress } = opts;
  const errors: string[] = [];
  const sink = opts.sink ?? createBlobSink("application/zip");
  const zip = new ZipWriter(sink.write);
  let fileCount = 0;
  let studentCount = 0;

  for (const s of students) {
    const folderName = safeSegment(s.roll, "candidate");
    const withName = s.name ? `${folderName} - ${safeSegment(s.name, "")}` : folderName;
    const who = s.name || s.roll;
    onProgress?.(`${who}: reading artifacts…`);

    let artifacts;
    try {
      artifacts = await listStudentArtifacts(examId, s.roll, folder);
    } catch {
      errors.push(`${s.roll}: could not list stored artifacts`);
      continue;
    }
    if (!artifacts) {
      errors.push(`${s.roll}: could not list stored artifacts`);
      continue;
    }
    if (artifacts.length === 0) continue;

    const joined = PIECE_FAMILIES
      .map((f) => ({ label: f.label, timeline: pieceTimeline(sortedParts(artifacts, f.family)) }))
      .filter((j) => j.timeline.pieces.length > 0);
    const finished = joined.length === 0
      ? artifacts.filter((a) => a.kind === "recordings" && !a.key.includes("/parts/"))
      : [];
    const small: { path: string; key: string }[] = [];
    for (const sc of artifacts.filter((a) => a.kind === "screenshots")) {
      small.push({ path: `${withName}/ss/${safeSegment(sc.name, "snapshot.jpg")}`, key: sc.key });
    }
    for (const v of artifacts.filter((a) => a.kind === "violations")) {
      small.push({ path: `${withName}/ss/violations/${safeSegment(v.name, "violation.jpg")}`, key: v.key });
    }
    const report = artifacts.find((a) => a.kind === "report");
    if (report) small.push({ path: `${withName}/report.pdf`, key: report.key });
    if (joined.length === 0 && finished.length === 0 && small.length === 0) continue;
    studentCount += 1;

    const fetcher = createPieceFetcher({
      keys: [...joined.flatMap((j) => j.timeline.pieces.map((p) => p.key)), ...finished.map((f) => f.key), ...small.map((f) => f.key)],
    });

    // 1. Each recording as ONE full video, joined piece by piece into the zip.
    for (const j of joined) {
      const base = `${withName}/recording/${j.label}_full_exam`;
      let part = 1;
      let entry: ZipEntryWriter | null = null;
      const path = () => (part === 1 ? `${base}.webm` : `${base}_part${part}.webm`);
      const result = await joinPieces({
        timeline: j.timeline,
        fetcher,
        write: async (chunk) => {
          entry ??= await zip.begin(path());
          await entry.write(chunk);
        },
        nextFile: async () => {
          if (entry) { await entry.end(); fileCount += 1; entry = null; }
          part += 1;
        },
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) onProgress?.(`${who}: ${j.label} recording ${Math.round((done / total) * 100)}%`);
        },
      });
      const open = entry as ZipEntryWriter | null;
      if (open) { await open.end(); fileCount += 1; }
      if (result.missing.length > 0) {
        const lines = describeMissing(result.missing);
        errors.push(`${s.roll}: ${result.missing.length} piece(s) of the ${j.label} recording could not be included`);
        await zip.add(`${withName}/recording/${j.label}_MISSING_PIECES.txt`, new TextEncoder().encode(
          `${result.missing.length} of ${j.timeline.pieces.length} pieces of this recording could not be included.\n`
          + `The video skips these parts of the exam:\n\n${lines.join("\n")}\n`,
        ));
      }
    }

    // 2. Finished files from older exam browsers, streamed as they download.
    for (const r of finished) {
      const path = `${withName}/recording/${safeSegment(r.name, "recording.webm")}`;
      let entry: ZipEntryWriter | null = null;
      try {
        await streamFile(fetcher, r.key, async (chunk) => {
          entry ??= await zip.begin(path);
          await entry.write(chunk);
        });
        entry ??= await zip.begin(path);
        await (entry as ZipEntryWriter).end();
        fileCount += 1;
      } catch (err) {
        const open = entry as ZipEntryWriter | null;
        if (open) await open.end();
        errors.push(`${s.roll}: ${r.name} ${err instanceof PieceError ? err.reason : "could not be downloaded"}`);
      }
    }

    // 3. Screenshots, violation frames and the PDF: a few at a time.
    let done = 0;
    for (let i = 0; i < small.length; i += SMALL_FILE_CONCURRENCY) {
      const batch = small.slice(i, i + SMALL_FILE_CONCURRENCY);
      const got = await Promise.all(batch.map(async (t) => {
        try {
          return await fetcher.bytes(t.key);
        } catch (err) {
          errors.push(`${s.roll}: ${t.key} ${err instanceof PieceError ? err.reason : "could not be downloaded"}`);
          return null;
        }
      }));
      for (let k = 0; k < batch.length; k++) {
        const bytes = got[k];
        if (!bytes) continue;
        await zip.add(batch[k].path, bytes);
        fileCount += 1;
      }
      done += batch.length;
      onProgress?.(`${who}: downloading evidence ${Math.round((done / small.length) * 100)}%`);
    }
  }

  if (fileCount === 0) {
    await sink.abort?.();
    return { studentCount, fileCount, errors };
  }

  onProgress?.("Finishing zip…");
  await zip.finish();
  const blob = await sink.close();
  if (blob) {
    const base = safeSegment(examName || examId || "exam", "exam");
    triggerDownload(blob, `${base}_evidence.zip`);
  }
  return { studentCount, fileCount, errors };
}
