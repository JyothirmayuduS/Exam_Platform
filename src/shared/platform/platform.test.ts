import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadUrl, probeInstaller } from "@/shared/platform/platform";
vi.mock("@/shared/data/env", () => ({ env: {} }));
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
function bytes(data: Uint8Array, status = 206) {
  return new Response(data as unknown as BodyInit, { status, headers: { "content-type": "application/octet-stream", "content-length": String(data.length) } });
}
describe("installer download gate", () => {
  it("uses the documented staged installer filenames", () => {
    expect(downloadUrl("windows")).toBe("/downloads/VignanExam_setup.exe");
    expect(downloadUrl("macos")).toBe("/downloads/VignanExam.dmg");
    expect(downloadUrl("linux")).toBe("/downloads/VignanExam.AppImage");
  });
  it("does not offer a missing or SPA-fallback binary as a download", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    expect(await probeInstaller("/downloads/missing.dmg", "macos")).toBe("missing");
    fetchMock.mockResolvedValueOnce(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
    expect(await probeInstaller("/downloads/missing.dmg", "macos")).toBe("missing");
  });
  it("rejects placeholder Windows and Linux headers", async () => {
    fetchMock.mockResolvedValueOnce(bytes(new Uint8Array([0x4d, 0x5a])))
      .mockResolvedValueOnce(bytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0])));
    expect(await probeInstaller("/downloads/app.exe", "windows")).toBe("missing");
    expect(await probeInstaller("/downloads/app.AppImage", "linux")).toBe("missing");
  });
  it("recognizes koly at the START of the final 512-byte DMG trailer", async () => {
    const trailer = new Uint8Array(512);
    trailer.set([0x6b, 0x6f, 0x6c, 0x79]);
    fetchMock.mockResolvedValueOnce(bytes(new Uint8Array(512))).mockResolvedValueOnce(bytes(trailer));
    expect(await probeInstaller("/downloads/app.dmg", "macos")).toBe("ready");
    expect(fetchMock).toHaveBeenLastCalledWith("/downloads/app.dmg", expect.objectContaining({ headers: { Range: "bytes=-512" } }));
  });
  it("uses an explicit last-byte range on servers that mishandle suffix ranges", async () => {
    const head = bytes(new Uint8Array(512));
    head.headers.set("content-range", "bytes 0-511/4096");
    const trailer = new Uint8Array(512);
    trailer.set([0x6b, 0x6f, 0x6c, 0x79]);
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce(bytes(trailer));
    expect(await probeInstaller("/downloads/app.dmg", "macos")).toBe("ready");
    expect(fetchMock).toHaveBeenLastCalledWith("/downloads/app.dmg", expect.objectContaining({
      headers: { Range: "bytes=3584-4095" }, cache: "no-store",
    }));
  });

  it("rejects a corrupt DMG rather than unconditionally accepting it", async () => {
    fetchMock.mockResolvedValueOnce(bytes(new Uint8Array(512))).mockResolvedValueOnce(bytes(new Uint8Array(512)));
    expect(await probeInstaller("/downloads/app.dmg", "macos")).toBe("missing");
  });
});
