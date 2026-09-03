// LiveKit proctoring — student side.
//
// The student's camera + mic (and optionally screen) are published to a LiveKit
// room that the invigilator watches from the proctor grid. Access tokens are
// ALWAYS minted server-side by the Supabase Edge Function `livekit-token`
// (see supabase/functions/livekit-token). The browser never holds the LiveKit
// API secret.
//
// Everything degrades: with no LiveKit/Supabase config the caller falls back to
// a local-only camera preview so the exam UI still works in the prototype.

import { Room, RoomEvent, createLocalTracks } from "livekit-client";
import { env, livekitConfigured } from "./env";
import { getSupabase } from "./supabase";

export type ProctorState = "connecting" | "connected" | "reconnecting" | "disconnected" | "local-only";

export type ProctorHandle = {
  room: InstanceType<typeof Room> | null;
  stream: MediaStream | null;
  stop: () => void;
};

/** Ask the Edge Function for a short-lived LiveKit access token. */
export async function fetchProctorToken(
  room: string,
  identity: string,
): Promise<{ token: string; url: string } | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db.functions.invoke("livekit-token", {
    body: { room, identity, canPublish: true, canSubscribe: false },
  });
  if (error || !data?.token) return null;
  return { token: data.token as string, url: (data.url as string) || env.livekitUrl };
}

/**
 * Connect to the proctor room and publish camera + mic. Returns a handle the
 * caller uses to stop. If LiveKit/Supabase aren't configured, resolves to
 * `null` so the UI can show a local-only preview instead.
 *
 * When `screenStream` is supplied (the exam already prompted the student for
 * screen share on the access screen), its video track is published too, tagged
 * as a screen-share source so proctors can tell the camera and screen apart.
 */
export async function startProctorPublishing(opts: {
  room: string;
  identity: string;
  screenStream?: MediaStream | null;
  onState?: (s: ProctorState) => void;
}): Promise<ProctorHandle | null> {
  if (!livekitConfigured) return null;
  const creds = await fetchProctorToken(opts.room, opts.identity);
  if (!creds) return null;

  const room = new Room({ adaptiveStream: true, dynacast: true });
  opts.onState?.("connecting");
  room.on(RoomEvent.Reconnecting, () => opts.onState?.("reconnecting"));
  room.on(RoomEvent.Reconnected, () => opts.onState?.("connected"));
  room.on(RoomEvent.Disconnected, () => opts.onState?.("disconnected"));

  try {
    await room.connect(creds.url, creds.token);
    // Publish camera + mic concurrently so exam start isn't delayed by an extra RTT.
    const tracks = await createLocalTracks({ audio: true, video: { facingMode: "user" } });
    await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track)));
    // Publish the already-granted screen-share track (if any) as a screen source
    // so the proctor grid can show each candidate's screen next to their camera.
    const screenTrack = opts.screenStream?.getVideoTracks?.()[0];
    if (screenTrack) {
      await room.localParticipant.publishTrack(screenTrack, { source: "screen_share", name: "screen" });
    }
    opts.onState?.("connected");

    const stream = new MediaStream(tracks.map((t) => t.mediaStreamTrack));
    return {
      room,
      stream,
      stop: () => { void room.disconnect(); tracks.forEach((t) => t.stop()); },
    };
  } catch (err) {
    // Connect / camera / publish failed — tear down and let the caller fall back
    // to a local-only preview instead of throwing an unhandled rejection.
    void room.disconnect();
    console.warn("[proctor] LiveKit publishing failed, falling back to local-only:", err);
    return null;
  }
}
