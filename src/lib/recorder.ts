import * as tus from "tus-js-client";
import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

export type RecorderHandle = { stop: () => void };

/**
 * Ask the Edge Function for a Cloudflare Stream TUS Upload URL.
 */
async function getCloudflareStreamUploadUrl(opts: {
  examId: string;
  studentId: string;
  kind: "camera" | "screen";
}): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const db = getSupabase();
  if (!db) return null;
  
  try {
    const { data, error } = await db.functions.invoke("cloudflare-stream-token", {
      body: {
        examId: opts.examId,
        studentId: opts.studentId,
        kind: opts.kind,
      },
    });
    if (error || !data?.url) return null;
    return data.url as string;
  } catch (err) {
    console.warn("[recorder] Failed to get Cloudflare Stream upload URL:", err);
    return null;
  }
}

/**
 * Start recording a MediaStream (camera or screen) and upload it to Cloudflare Stream
 * continuously using the TUS resumable protocol.
 */
export function startVideoRecording(opts: {
  stream: MediaStream;
  examId: string;
  studentId: string;
  kind: "camera" | "screen";
  chunkDurationMs?: number;
}): RecorderHandle {
  const { stream, examId, studentId, kind, chunkDurationMs = 1000 } = opts;
  
  // We will fetch the URL asynchronously
  let uploadUrl: string | null = null;
  getCloudflareStreamUploadUrl({ examId, studentId, kind }).then(url => {
    uploadUrl = url;
    if (!url) console.warn(`[recorder] Could not get Cloudflare Stream upload URL for ${kind}`);
    else startTusUpload();
  });

  // 2. Setup the MediaRecorder
  const mimeType = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find(type => MediaRecorder.isTypeSupported(type)) || 'video/webm';

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2500000, // 2.5 Mbps (HD quality)
  });

  // 3. Create a ReadableStream from the MediaRecorder
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const readableStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
    }
  });

  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const buffer = await e.data.arrayBuffer();
      streamController.enqueue(new Uint8Array(buffer));
    }
  };

  recorder.onstop = () => {
    streamController.close();
  };

  // 4. Initialize TUS Upload when we have the URL
  let upload: tus.Upload | null = null;
  const startTusUpload = () => {
    if (!uploadUrl) return;
    upload = new tus.Upload(readableStream, {
      endpoint: "NOT_USED_BECAUSE_WE_HAVE_UPLOAD_URL",
      uploadUrl,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: 5 * 1024 * 1024, // 5MB chunks
      uploadLengthDeferred: true,
      onError: function(error) {
        console.error(`[recorder] TUS upload failed for ${kind}:`, error);
      },
      onProgress: function(bytesUploaded) {
        console.log(`[recorder] ${kind} upload progress: ${bytesUploaded} bytes`);
      },
      onSuccess: function() {
        console.log(`[recorder] TUS upload complete for ${kind}`);
        const streamId = upload?.url?.split('/').pop();
        console.log(`[recorder] Cloudflare Stream Video ID: ${streamId}`);
      }
    });
    upload.start();
  };

  // Start recording
  recorder.start(chunkDurationMs);

  return {
    stop: () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }
  };
}
