import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLaunchUrl, onVignanDeepLink } from "./lockdownBridge";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

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

  it("does not call native APIs in a normal browser", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(await getLaunchUrl()).toBeNull();
    (await onVignanDeepLink(vi.fn()))();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
