// The review strip of periodic webcam snapshots. One snapshot a second is
// 7,200 frames for a 2-hour exam, so the strip shows one page of at most
// TIMELINE_PAGE frames: either every frame of a stretch of the exam, or one
// frame per `stepSec` across the whole exam. Only the frames on the page are
// signed and loaded.

export type TimelineFrame = { key: string; timestamp: number };

export const TIMELINE_PAGE = 120;
/** Sampling choices, in seconds between shown frames. 0 means "fit the whole exam on one page". */
export const TIMELINE_STEPS = [0, 1, 10, 30, 60] as const;

/** Frame time (epoch ms) from a stored name such as snap_1791000000000.jpg. */
export function snapshotTime(name: string): number | null {
  const m = name.match(/snap_(\d+)\.jpg$/);
  return m ? Number(m[1]) : null;
}

/** Seconds between shown frames so the whole exam fits on one page. */
export function wholeExamStep(frames: TimelineFrame[], size = TIMELINE_PAGE): number {
  if (frames.length <= size) return 1;
  const span = (frames[frames.length - 1].timestamp - frames[0].timestamp) / 1000;
  return Math.max(1, Math.ceil(span / (size - 1)));
}

/**
 * Frames sorted by time, thinned to at most one per `stepSec` (the first in
 * each step, so gaps in the recording stay visible as gaps).
 */
export function sampleFrames(frames: TimelineFrame[], stepSec: number): TimelineFrame[] {
  if (stepSec <= 1 || frames.length === 0) return frames;
  const out: TimelineFrame[] = [];
  const origin = frames[0].timestamp;
  let lastBucket = -1;
  for (const f of frames) {
    const bucket = Math.floor((f.timestamp - origin) / (stepSec * 1000));
    if (bucket !== lastBucket) { out.push(f); lastBucket = bucket; }
  }
  return out;
}

export type TimelinePage = { frames: TimelineFrame[]; page: number; pages: number; stepSec: number; total: number };

/** One page of the strip. `step` 0 fits the whole exam on one page. */
export function timelinePage(frames: TimelineFrame[], step: number, page: number, size = TIMELINE_PAGE): TimelinePage {
  const stepSec = step === 0 ? wholeExamStep(frames, size) : step;
  const sampled = sampleFrames(frames, stepSec);
  const pages = Math.max(1, Math.ceil(sampled.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { frames: sampled.slice(p * size, (p + 1) * size), page: p, pages, stepSec, total: sampled.length };
}

/** The page that shows the frame at or just before `atMs` for this sampling. */
export function pageAt(frames: TimelineFrame[], step: number, atMs: number, size = TIMELINE_PAGE): number {
  const stepSec = step === 0 ? wholeExamStep(frames, size) : step;
  const sampled = sampleFrames(frames, stepSec);
  let i = 0;
  while (i + 1 < sampled.length && sampled[i + 1].timestamp <= atMs) i++;
  return Math.floor(i / size);
}
