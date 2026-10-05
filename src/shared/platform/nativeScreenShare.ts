import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/platform/platform";

type CaptureHandle = {
  stream: MediaStream;
  stop: () => void;
};

/**
 * Capture the student's display inside the Exam Browser without the macOS
 * "Share This Window" picker. After Screen Recording is allowed (the same
 * system dialog as Camera/Microphone), frames come from a native screenshot
 * command and are published as a canvas MediaStream for LiveKit.
 */
export async function startNativeDisplayStream(): Promise<CaptureHandle | null> {
  if (!isTauri()) return null;
  await invoke("screen_capture_permission_prompt").catch(() => {});
  await invoke("set_window_sharing", { allow: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60));

  const first = await invoke<string>("capture_display_jpeg").catch(() => "");
  if (!first) return null;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = await decodeJpeg(first);
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const stream = canvas.captureStream(3);
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const jpeg = await invoke<string>("capture_display_jpeg");
      const frame = await decodeJpeg(jpeg);
      if (frame.width !== canvas.width || frame.height !== canvas.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      ctx.drawImage(frame, 0, 0);
    } catch {
      /* keep last frame */
    }
    if (!stopped) window.setTimeout(() => void tick(), 280);
  };
  void tick();
  return {
    stream,
    stop: () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

async function decodeJpeg(b64: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${b64}`;
  await img.decode();
  return img;
}
