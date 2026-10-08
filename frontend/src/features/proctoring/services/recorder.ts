// Screen recording, uploaded to Cloudflare R2 in 10 s pieces while the exam
// runs (see shared/services/recordingParts.ts). Pieces are the only stored
// copy: nothing is held in memory and no full file is uploaded at the end.
//
// Pieces land under:
//   ${examFolder}/${roll}/recordings/parts/screen_${seq}.webm
//
// where ${examFolder} is the slug of the exam NAME (fallback: exam id).

import { storageFolderSegment } from "@/shared/services/examStorage";
import { RECORDING_BITRATE } from "@/shared/services/lowBandwidth";
import { startPartUploads, type PartUploader } from "@/shared/services/recordingParts";

export const RECORDING_CHUNK_MS = 10_000;

export type RecorderHandle = {
  stop: () => void;
  /** Weak link: keep pieces on the device and upload them once it recovers. */
  setLowBandwidth: (on: boolean) => void;
  /** Upload every piece still on the device; true when nothing is pending. */
  flush: () => Promise<boolean>;
};

/** Record a screen MediaStream in pieces that upload as they are produced. */
export function startVideoRecording(opts: {
  stream: MediaStream;
  examId: string;
  examName?: string | null;
  roll: string;
  kind: "camera" | "screen";
  onError?: (message: string) => void;
  /** Test seam. */
  uploader?: PartUploader;
}): RecorderHandle {
  const { stream, examId, examName, roll, kind } = opts;
  const parts = opts.uploader ?? startPartUploads({
    folder: storageFolderSegment(examId, examName),
    owner: roll,
    family: kind === "screen" ? "screen" : "exam",
    onError: opts.onError,
  });

  const mimeType =
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: RECORDING_BITRATE[kind],
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) parts.enqueue(e.data);
  };
  recorder.onstop = () => { void parts.flush(); };
  recorder.start(RECORDING_CHUNK_MS);

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
    setLowBandwidth: (on) => parts.setPaused(on),
    flush: () => parts.flush(),
  };
}
