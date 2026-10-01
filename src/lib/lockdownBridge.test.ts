import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLaunchUrl, hydrateSessionFromDeepLink, onVignanDeepLink, openStudentSide } from "./lockdownBridge";

const { invoke, listen, setSession } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), setSession: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./supabase", () => ({ getSupabase: () => ({ auth: { setSession } }) }));

describe("lockdown deep-link handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("receives macOS open-URL events, not just second-process arguments", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    listen.mockImplementation(async (name, cb) => {
      handlers.set(name, cb);
      return unlisten;
    });
    const onUrl = vi.fn();
    const dispose = await onVignanDeepLink(onUrl);
    const url = "vignan-exam://open?exam=exam-1&roll=student-1";

    expect(handlers.has("deep-link://new-url")).toBe(true);
    handlers.get("deep-link://new-url")!({ payload: [url] });
    expect(onUrl).toHaveBeenCalledWith(url);
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("still receives the custom event from earlier kiosk shells", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listen.mockImplementation(async (name, cb) => {
      handlers.set(name, cb);
      return vi.fn();
    });
    const onUrl = vi.fn();
    const dispose = await onVignanDeepLink(onUrl);
    handlers.get("vignan-deeplink")!({ payload: "vignan-exam://open?exam=exam-2" });
    expect(onUrl).toHaveBeenCalledWith("vignan-exam://open?exam=exam-2");
    dispose();
  });

  it("reads the cold-start URL through IPC", async () => {
    invoke.mockResolvedValue("vignan-exam://open?exam=exam-1");
    expect(await getLaunchUrl()).toBe("vignan-exam://open?exam=exam-1");
    expect(invoke).toHaveBeenCalledWith("vignan_launch_url");
  });

  it("restores the existing student session from a native launch fragment", async () => {
    setSession.mockResolvedValue({ error: null });
    const url = "vignan-exam://open?exam=exam-1#access_token=access-token&refresh_token=refresh-token";
    expect(await hydrateSessionFromDeepLink(url)).toBe(true);
    expect(setSession).toHaveBeenCalledWith({ access_token: "access-token", refresh_token: "refresh-token" });
  });

  it("opens the browser student console through the native shell", async () => {
    invoke.mockResolvedValue(undefined);
    expect(await openStudentSide("/student/exams")).toBe(true);
    const call = invoke.mock.calls.find(([command]) => command === "open_student_side");
    expect(call?.[1]).toEqual({
      url: `${(import.meta.env.VITE_APP_BASE_URL ?? window.location.origin).replace(/\/$/, "")}/student/exams`,
    });
  });

  it("does not call native APIs in a normal browser", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(await getLaunchUrl()).toBeNull();
    (await onVignanDeepLink(vi.fn()))();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
