import { afterEach, describe, expect, it, vi } from "vitest";
import { PART_RETRY_MS, partName, pieceTimeline, resumeLeftoverPieces, sortedParts, startPartUploads, stopLeftoverPieces } from "@/shared/services/recordingParts";
import { REFUSAL_LIMIT } from "@/shared/services/snapshotOutbox";
import type { SnapshotStore } from "@/shared/services/snapshotOutbox";

function disk(): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

afterEach(() => { vi.useRealTimers(); });

describe("recording pieces", () => {
  it("uploads each piece once under parts/, in order, with unique names", async () => {
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 5_000 });
    for (let i = 0; i < 3; i++) parts.enqueue(new Blob([`chunk${i}`]));
    expect(await parts.flush()).toBe(true);
    const names = upload.mock.calls.map(([o]) => o.name).sort();
    expect(names).toEqual([
      "parts/exam_0000000005000.webm",
      "parts/exam_0000000005001.webm",
      "parts/exam_0000000005002.webm",
    ]);
    parts.stop();
  });

  it("a recorder restarted after a reload never overwrites earlier pieces", async () => {
    const names: string[] = [];
    const upload = async (o: { name: string }) => { names.push(o.name); return o.name; };
    const before = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 1_000 });
    before.enqueue(new Blob(["a"]));
    before.enqueue(new Blob(["b"]));
    await before.flush();
    before.stop();
    const after = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 2_000 });
    after.enqueue(new Blob(["c"]));
    await after.flush();
    after.stop();
    expect(new Set(names).size).toBe(3);
  });

  it("a failed piece stays on the device and is retried until it uploads", async () => {
    vi.useFakeTimers();
    const store = disk();
    let online = false;
    const upload = vi.fn(async (o: { name: string }) => (online ? o.name : null));
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store, upload, now: () => 1 });
    parts.enqueue(new Blob(["piece"]));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(parts.pendingCount()).toBe(1));
    expect([...store.data.keys()]).toEqual(["Exam/R1/recordings/parts/exam_0000000000001.webm"]);
    online = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(parts.pendingCount()).toBe(0));
    expect(store.data.size).toBe(0);
    parts.stop();
  });

  it("waits on a weak link and uploads when it recovers; submit still drains", async () => {
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const store = disk();
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "screen", store, upload });
    parts.setPaused(true);
    parts.enqueue(new Blob(["one"]));
    await vi.waitFor(() => expect(store.data.size).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(upload).not.toHaveBeenCalled();
    parts.setPaused(false);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    parts.setPaused(true);
    parts.enqueue(new Blob(["two"]));
    expect(await parts.flush()).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    parts.stop();
  });

  it("picks up pieces already on disk from an earlier sitting", async () => {
    const store = disk();
    const left = "Exam/R2/recordings/parts/exam_1700000010000_1700000000000.webm";
    store.data.set(left, new Blob(["old"]));
    store.data.set("Exam/R2/recordings/parts/screen_1700000010000_1700000000000.webm", new Blob(["other family"]));
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const parts = startPartUploads({ folder: "Exam", owner: "R2", family: "exam", store, upload });
    expect(await parts.flush()).toBe(true);
    expect(upload.mock.calls.map(([o]) => o.name)).toEqual(["parts/exam_1700000010000_1700000000000.webm"]);
    expect(store.data.has(left)).toBe(false);
    expect(store.data.size).toBe(1);
    parts.stop();
  });

  it("on app start uploads the signed-in student's leftover pieces of every exam and leaves other evidence alone", async () => {
    const store = disk();
    const keys = [
      "Midterm/R3/recordings/parts/exam_1700000010000_1700000000000.webm",
      "Midterm/R3/recordings/parts/screen_1700000010000_1700000000000.webm",
      "Final/R4/recordings/parts/exam_00000001.webm",
    ];
    for (const k of keys) store.data.set(k, new Blob([k]));
    store.data.set("Final/R4/screenshots/snap_1.jpg", new Blob(["jpeg"]));
    const uploaded: string[] = [];
    const upload = vi.fn(async (o: { examId: string; ownerSegment: string; name: string }) => {
      uploaded.push(`${o.examId}/${o.ownerSegment}/recordings/${o.name}`);
      return o.name;
    });
    const report = await resumeLeftoverPieces({ owners: ["R3", "R4"], store, upload, log: () => {} });
    expect(report.waiting).toBe(0);
    expect(report.resumed.sort()).toEqual([
      "Final/R4/recordings/parts/exam_",
      "Midterm/R3/recordings/parts/exam_",
      "Midterm/R3/recordings/parts/screen_",
    ]);
    await vi.waitFor(() => expect(uploaded.sort()).toEqual([...keys].sort()));
    await vi.waitFor(() => expect([...store.data.keys()]).toEqual(["Final/R4/screenshots/snap_1.jpg"]));
  });

  it("restarting the recorder hands over to one uploader; no piece is uploaded twice", async () => {
    const store = disk();
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const slow = async (o: { name: string }) => { calls.push(o.name); await gate; return o.name; };
    const fast = async (o: { name: string }) => { calls.push(o.name); return o.name; };
    let t = 1_700_000_000_000;
    const now = () => (t += 1000);
    const first = startPartUploads({ folder: "Exam", owner: "R5", family: "screen", store, upload: slow, now });
    for (let i = 0; i < 5; i++) first.enqueue(new Blob([`piece${i}`]));
    await vi.waitFor(() => expect(calls.length).toBe(3));

    const second = startPartUploads({ folder: "Exam", owner: "R5", family: "screen", store, upload: fast, now });
    second.enqueue(new Blob(["after restart"]));
    first.enqueue(new Blob(["late chunk from the old recorder"]));
    await new Promise((r) => setTimeout(r, 20));
    // The new uploader waits for the old one's in-flight uploads.
    expect(calls.length).toBe(3);
    open();
    expect(await second.flush()).toBe(true);
    expect(calls).toHaveLength(7);
    expect(new Set(calls).size).toBe(7);
    expect(store.data.size).toBe(0);
    second.stop();
  });

  it("after submit keeps uploading on a weak link until every piece has landed", async () => {
    vi.useFakeTimers();
    const store = disk();
    let linkUp = false;
    const upload = vi.fn(async (o: { name: string }) => (linkUp ? o.name : null));
    const parts = startPartUploads({ folder: "Exam", owner: "R6", family: "exam", store, upload });
    parts.setPaused(true);
    const session = parts.beginSession();
    session.enqueue(new Blob(["a"]));
    session.enqueue(new Blob(["b"]));
    let drained = false;
    const drain = parts.drain().then(() => { drained = true; });
    session.enqueue(new Blob(["last chunk after submit"]));
    session.end();
    // Link down for a minute: every attempt fails, drain keeps retrying.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(PART_RETRY_MS);
      expect(drained).toBe(false);
      expect(parts.pendingCount()).toBe(3);
    }
    const attemptsWhileDown = upload.mock.calls.length;
    expect(attemptsWhileDown).toBeGreaterThan(6);
    // The link comes back but is still flagged weak; the kiosk must not wait.
    parts.setPaused(true);
    linkUp = true;
    await vi.advanceTimersByTimeAsync(PART_RETRY_MS * 2);
    await drain;
    expect(parts.pendingCount()).toBe(0);
    expect(store.data.size).toBe(0);
    expect(new Set(upload.mock.calls.slice(attemptsWhileDown).map(([o]) => o.name)).size).toBe(3);
    parts.stop();
  });

  it("drain waits for a recorder that is still delivering its last chunk", async () => {
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const parts = startPartUploads({ folder: "Exam", owner: "R7", family: "screen", store: disk(), upload });
    const session = parts.beginSession();
    let drained = false;
    const drain = parts.drain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    session.enqueue(new Blob(["final"]));
    session.end();
    await drain;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0].name).toMatch(/^parts\/screen_\d{13}_\d{13}\.webm$/);
    parts.stop();
  });
});

describe("pieces storage will not take", () => {
  it("stops retrying a piece after repeated permanent refusals, keeps it on disk and reports it", async () => {
    vi.useFakeTimers();
    const store = disk();
    const bad = "Exam/R8/recordings/parts/exam_1700000010000_1700000000000.webm";
    const upload = vi.fn(async (o: { name: string }) =>
      (o.name.startsWith("parts/exam_1700000010000") ? { refused: 400, reason: "invalid name" } : o.name));
    store.data.set(bad, new Blob(["refused"]));
    const parts = startPartUploads({ folder: "Exam", owner: "R8", family: "exam", store, upload });
    parts.enqueue(new Blob(["fine"]));
    let drained = false;
    const drain = parts.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(PART_RETRY_MS * (REFUSAL_LIMIT + 1));
    expect(drained).toBe(true);
    await drain;
    const attempts = upload.mock.calls.filter(([o]) => o.name === bad.slice("Exam/R8/recordings/".length)).length;
    expect(attempts).toBe(REFUSAL_LIMIT);
    expect(parts.pendingCount()).toBe(0);
    expect(parts.refusedPieces()).toEqual([{ key: bad, reason: "invalid name (HTTP 400)" }]);
    expect([...store.data.keys()]).toEqual([bad]);
    // No further attempts once given up.
    await vi.advanceTimersByTimeAsync(PART_RETRY_MS * 5);
    expect(upload.mock.calls.filter(([o]) => o.name === bad.slice("Exam/R8/recordings/".length)).length).toBe(REFUSAL_LIMIT);
    parts.stop();
  });

  it("never sends a piece whose name storage would reject", async () => {
    const store = disk();
    const bad = "Exam/R9/recordings/parts/exam_1700000010000_1700000000000 copy.webm";
    store.data.set(bad, new Blob(["x"]));
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const parts = startPartUploads({ folder: "Exam", owner: "R9", family: "exam", store, upload });
    expect(await parts.flush()).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(parts.refusedPieces().map((r) => r.reason)).toEqual(["invalid piece name (HTTP 400)"]);
    parts.stop();
  });
});

describe("leftover pieces of another student", () => {
  afterEach(() => { stopLeftoverPieces(); });

  it("are kept on disk and counted, not uploaded, until that student signs in", async () => {
    vi.useFakeTimers();
    const store = disk();
    const other = "Exam/OTHER1/recordings/parts/exam_1700000010000_1700000000000.webm";
    store.data.set(other, new Blob(["theirs"]));
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const log = vi.fn();
    const report = await resumeLeftoverPieces({ owners: ["ME1"], store, upload, log });
    expect(report).toEqual({ resumed: [], waiting: 1, waitingOwners: ["OTHER1"] });
    expect(log.mock.calls[0][0]).toContain("1 recording piece(s) from 1 other student(s) are waiting on this PC");
    await vi.advanceTimersByTimeAsync(PART_RETRY_MS * 6);
    expect(upload).not.toHaveBeenCalled();
    expect(store.data.has(other)).toBe(true);

    // That student signs in on this PC.
    const later = await resumeLeftoverPieces({ owners: ["OTHER1"], store, upload, log });
    expect(later.resumed).toEqual(["Exam/OTHER1/recordings/parts/exam_"]);
    await vi.waitFor(() => expect(store.data.size).toBe(0));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("stops at the first 403 instead of retrying every 10 seconds, and keeps the pieces", async () => {
    vi.useFakeTimers();
    const store = disk();
    const keys = [1, 2].map((i) => `Exam/OTHER2/recordings/parts/screen_170000001000${i}_1700000000000.webm`);
    for (const k of keys) store.data.set(k, new Blob([k]));
    const upload = vi.fn(async () => ({ refused: 403, reason: "forbidden" }));
    const log = vi.fn();
    // Signed in with an account the server does not consider the owner.
    await resumeLeftoverPieces({ owners: ["OTHER2"], store, upload, log });
    await vi.advanceTimersByTimeAsync(PART_RETRY_MS * 12);
    expect(upload.mock.calls.length).toBeLessThanOrEqual(keys.length);
    expect(log.mock.calls.some(([m]) => String(m).includes("HTTP 403"))).toBe(true);
    expect([...store.data.keys()].sort()).toEqual(keys);
    // Signing in again later tries once more.
    upload.mockImplementation(async () => ({ refused: 403, reason: "forbidden" }));
    const again = await resumeLeftoverPieces({ owners: ["OTHER2"], store, upload, log });
    expect(again.resumed).toEqual(["Exam/OTHER2/recordings/parts/screen_"]);
  });
});

describe("piece timeline", () => {
  const art = (name: string) => ({ key: `Exam/R1/recordings/parts/${name}`, kind: "recordings" });

  it("places a session started after a reload at its real time", () => {
    const a = 1_700_000_000_000;
    const b = a + 300_000;
    const sorted = sortedParts([
      art(partName("exam", b + 10_000, b)), art(partName("exam", a + 10_000, a)),
      art(partName("exam", a + 20_000, a)), art(partName("exam", b + 20_000, b)),
    ], "exam");
    const t = pieceTimeline(sorted);
    expect(t.originMs).toBe(a);
    expect(t.pieces.map((p) => [p.start, p.end, p.head, p.offsetMs, p.sessionMs])).toEqual([
      [0, 10, true, 0, 0], [10, 20, false, 0, 0], [300, 310, true, 300_000, 300_000], [310, 320, false, 300_000, 300_000],
    ]);
    expect(t.durationSec).toBe(320);
  });

  it("reads older counter pieces at 10 s each", () => {
    const t = pieceTimeline(sortedParts([art("seg_00000002.webm"), art("seg_00000001.webm")], "seg"));
    expect(t.originMs).toBeNull();
    expect(t.pieces.map((p) => [p.key.split("/").pop(), p.start, p.sessionMs])).toEqual([["seg_00000001.webm", 0, 0], ["seg_00000002.webm", 10, 0]]);
  });
});
