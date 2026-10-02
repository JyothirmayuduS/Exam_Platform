import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getLaunchUrl, subscribe, render } = vi.hoisted(() => ({
  getLaunchUrl: vi.fn(),
  subscribe: vi.fn(),
  render: vi.fn(),
}));
vi.mock("@/shared/platform/lockdownBridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/platform/lockdownBridge")>(),
  getLaunchUrl,
  onVignanDeepLink: subscribe,
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("./App.tsx", () => ({ default: () => null }));
vi.mock("./features/auth/auth", () => ({ AuthProvider: () => null }));
vi.mock("./shared/components/ErrorBoundary.tsx", () => ({ ErrorBoundary: () => null }));
vi.mock("./shared/pages/ErrorPage.tsx", () => ({ default: () => null }));

describe("native deep-link boot order", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("VITE_LOGROCKET_ID", "");
    vi.stubEnv("VITE_EXAM_ENTRY_PATH", "/student/exam");
    window.history.replaceState(null, "", "/");
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    getLaunchUrl.mockResolvedValue(null);
    subscribe.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("waits for subscription before reading a cold-start URL and mounting", async () => {
    let registered!: () => void;
    subscribe.mockReturnValue(new Promise<void>((resolve) => { registered = resolve; }));
    getLaunchUrl.mockResolvedValue("vignan-exam://open?exam=exam-one&roll=R1");
    await import("./main");
    expect(subscribe).toHaveBeenCalledOnce();
    expect(getLaunchUrl).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    registered();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(window.location.pathname + window.location.search).toBe("/student/exam?examId=exam-one&roll=R1");
  });

  it("routes late macOS cold-start and subsequent warm-start events", async () => {
    await import("./main");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const onUrl = subscribe.mock.calls[0][0] as (url: string) => void;
    const onPopState = vi.fn();
    window.addEventListener("popstate", onPopState);
    try {
      onUrl("vignan-exam://open?exam=exam-one");
      expect(window.location.search).toBe("?examId=exam-one");
      onUrl("vignan-exam://open?exam=exam-two");
      expect(window.location.search).toBe("?examId=exam-two");
      expect(onPopState).toHaveBeenCalledTimes(2);
      onUrl("https://open?exam=untrusted");
      expect(window.location.search).toBe("?examId=exam-two");
      expect(onPopState).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("popstate", onPopState);
    }
  });

  it("never lands on a relative route when the entry path env is blank", async () => {
    // The exact production trap: Vercel CLI writes VITE_EXAM_ENTRY_PATH="".
    vi.stubEnv("VITE_EXAM_ENTRY_PATH", "");
    getLaunchUrl.mockResolvedValue("vignan-exam://open?exam=exam-one&roll=R1");
    await import("./main");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    // Must be the absolute exam route — not "/" (landing) and not a bare
    // "?examId=…" that would resolve against the current path (/login).
    expect(window.location.pathname + window.location.search).toBe("/student/exam?examId=exam-one&roll=R1");
    expect(window.location.pathname).not.toBe("/");
    expect(window.location.pathname).not.toBe("/login");
  });

  it("keeps the exam route when a warm link arrives with a blank entry path", async () => {
    vi.stubEnv("VITE_EXAM_ENTRY_PATH", "");
    await import("./main");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const onUrl = subscribe.mock.calls[0][0] as (url: string) => void;
    onUrl("vignan-exam://open?exam=warm-one");
    expect(window.location.pathname).toBe("/student/exam");
    expect(window.location.search).toBe("?examId=warm-one");
  });

  it("mounts normally without native APIs in a browser", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await import("./main");
    expect(render).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(getLaunchUrl).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
});
