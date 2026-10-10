// Screen recording, uploaded to Cloudflare R2 in 10 s pieces while the exam
// runs (see shared/services/recordingParts.ts). Pieces are the only stored
// copy: nothing is held in memory and no full file is uploaded at the end.
//
// Pieces land under:
//   ${examFolder}/${roll}/recordings/parts/screen_${seq}_${session}.webm
//
// where ${examFolder} is the exam id.
// Restarting the recorder starts a new uploader, which retires the old one.

import { storageFolderSegment } from "@/shared/services/examStorage";
import { RECORDING_BITRATE } from "@/shared/services/lowBandwidth";
import { recordInto, startPartUploads, type PartUploader } from "@/shared/services/recordingParts";

export const RECORDING_CHUNK_MS = 10_000;

/**
 * A keyframe at least this often, so a seek, or the piece after a missing
 * one, shows a picture straight away instead of waiting for the next one.
 * Chromium (Windows WebView2, Chrome) honours it; engines without the option
 * ignore it and keep their own interval.
 */
export const RECORDING_KEYFRAME_MS = 3_000;

/** MediaRecorder options shared by the camera and screen recorders. */
export function recorderOptions(mimeType: string, videoBitsPerSecond: number): MediaRecorderOptions {
  return {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond,
    videoKeyFrameIntervalDuration: RECORDING_KEYFRAME_MS,
  } as MediaRecorderOptions;
}

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
  const { stream, examId, roll, kind } = opts;
  const parts = opts.uploader ?? startPartUploads({
    folder: storageFolderSegment(examId),
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

  const recorder = new MediaRecorder(stream, recorderOptions(mimeType, RECORDING_BITRATE[kind]));
  const recording = recordInto(recorder, parts, RECORDING_CHUNK_MS);

  return {
    stop: () => {
      recording.stop();
      // Keeps uploading until every piece on the device has landed.
      parts.stop();
    },
    setLowBandwidth: (on) => parts.setPaused(on),
    flush: () => parts.flush(),
  };
}
