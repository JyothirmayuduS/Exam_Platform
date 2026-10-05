// Bookkeeping for handwritten-answer uploads (QR phone scan or desktop).
//
// An upload path is applied to the answer exactly once. After that the
// student owns the answer: "Remove and retake" or typing over it must not be
// undone by a later poll that sees the same stored submission again.

export const UPLOAD_PREFIX = "[Uploaded answer: ";

export const uploadAnswer = (path: string) => `${UPLOAD_PREFIX}${path}]`;

export function uploadPathOf(answer: unknown): string | null {
  if (typeof answer !== "string" || !answer.startsWith(UPLOAD_PREFIX)) return null;
  return answer.slice(UPLOAD_PREFIX.length).replace(/\]$/, "").trim();
}

const key = (attemptId: string | null | undefined) => `vignan.uploads.handled.${attemptId ?? "pending"}`;

function read(attemptId: string | null | undefined): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key(attemptId)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function isUploadHandled(attemptId: string | null | undefined, path: string): boolean {
  return read(attemptId).has(path);
}

export function markUploadHandled(attemptId: string | null | undefined, path: string): void {
  const set = read(attemptId);
  if (set.has(path)) return;
  set.add(path);
  try {
    localStorage.setItem(key(attemptId), JSON.stringify([...set]));
  } catch {
    /* storage blocked: worst case an upload is re-applied once */
  }
}
