// @vitest-environment node
// Registration photo: one webcam photo per student, JPEG only, sensible size.
import { describe, expect, it } from "vitest";
import { createPhotoHandler, decodeJpeg, MAX_BYTES, MIN_BYTES, type PhotoStore } from "../_shared/photos/handler.ts";

const NOW = Date.parse("2026-10-10T06:00:00Z");
const jpegUrl = (size: number, head = [0xff, 0xd8, 0xff, 0xe0]) => {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/jpeg;base64,${btoa(bin)}`;
};

function makeStore(over: Partial<PhotoStore> = {}) {
  const photos = new Map<string, string>([["stu-has", "2026-10-01T00:00:00Z"]]);
  const saved: { id: string; bytes: number }[] = [];
  const audits: { studentId: string; bytes: number }[] = [];
  const store: PhotoStore = {
    studentByAuth: async (auth) => (auth.startsWith("auth-") ? { id: auth.replace("auth-", "stu-"), roll: "21BQ1" } : null),
    photo: async (id) => (photos.has(id) ? { captured_at: photos.get(id)! } : null),
    save: async (id, jpeg, nowIso) => {
      if (photos.has(id)) return "exists";
      photos.set(id, nowIso);
      saved.push({ id, bytes: jpeg.length });
      return { captured_at: nowIso };
    },
    writeAudit: async (e) => { audits.push(e); },
    ...over,
  };
  return { store, saved, audits };
}

const call = async (store: PhotoStore, body: unknown, who: string | null) => {
  const handler = createPhotoHandler({ store, actor: async () => (who ? { authId: who } : null), now: () => NOW });
  const res = await handler(new Request("https://x/registration-photo", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("decodeJpeg", () => {
  it("accepts a JPEG of a sensible size", () => {
    expect(decodeJpeg(jpegUrl(20_000))?.length).toBe(20_000);
  });

  it("rejects other formats, tiny or huge files and junk", () => {
    expect(decodeJpeg(jpegUrl(20_000, [0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(decodeJpeg(jpegUrl(MIN_BYTES - 1))).toBeNull();
    expect(decodeJpeg(jpegUrl(MAX_BYTES + 1))).toBeNull();
    expect(decodeJpeg(jpegUrl(20_000).replace("image/jpeg", "image/png"))).toBeNull();
    expect(decodeJpeg("data:image/jpeg;base64,@@@")).toBeNull();
    expect(decodeJpeg(42)).toBeNull();
  });
});

describe("registration-photo endpoint", () => {
  it("needs a signed-in user", async () => {
    const { store } = makeStore();
    expect((await call(store, { op: "status" }, null)).status).toBe(401);
  });

  it("tells students whether they still need a photo; staff never do", async () => {
    const { store } = makeStore();
    expect((await call(store, { op: "status" }, "auth-new")).body).toEqual({ required: true, hasPhoto: false, capturedAt: null });
    expect((await call(store, { op: "status" }, "auth-has")).body).toEqual({ required: true, hasPhoto: true, capturedAt: "2026-10-01T00:00:00Z" });
    expect((await call(store, { op: "status" }, "teacher-1")).body).toEqual({ required: false, hasPhoto: false, capturedAt: null });
  });

  it("stores the first photo once and logs it", async () => {
    const { store, saved, audits } = makeStore();
    const first = await call(store, { op: "upload", image: jpegUrl(30_000) }, "auth-new");
    expect(first.body).toEqual({ ok: true, capturedAt: new Date(NOW).toISOString() });
    expect(saved).toEqual([{ id: "stu-new", bytes: 30_000 }]);
    expect(audits).toEqual([{ actorId: "auth-new", studentId: "stu-new", bytes: 30_000 }]);
    expect((await call(store, { op: "upload", image: jpegUrl(30_000) }, "auth-new")).status).toBe(409);
    expect(audits).toHaveLength(1);
  });

  it("refuses bad images and non-students", async () => {
    const { store, saved } = makeStore();
    expect((await call(store, { op: "upload", image: jpegUrl(100) }, "auth-new")).status).toBe(400);
    expect((await call(store, { op: "upload", image: jpegUrl(30_000) }, "teacher-1")).status).toBe(403);
    expect(saved).toHaveLength(0);
  });
});
