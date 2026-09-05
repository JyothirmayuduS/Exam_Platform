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

// The created local tracks. We only ever stop the tracks WE created (never the
// caller's reused stream) — derive the type from createLocalTracks so it can't
// drift from the installed livekit-client version.
type CreatedLocalTracks = Awaited<ReturnType<typeof createLocalTracks>>;
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
  /**
   * A camera+mic stream the caller already acquired at the device gate. When
   * supplied the SAME tracks are published — never a second getUserMedia — so
   * phones/iOS keep a single capture session and the feed the proctor sees is
   * byte-for-byte the one the local AI analyses. Ownership stays with the
   * caller: these tracks are NOT stopped on teardown.
   */
  localStream?: MediaStream | null;
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

  // Tracks WE created (createLocalTracks) are stopped on teardown; tracks that
  // arrived via localStream belong to the caller and are left running.
  let owned: CreatedLocalTracks | null = null;

  try {
    await room.connect(creds.url, creds.token);
    const camTrack = opts.localStream?.getVideoTracks?.()[0];
    const micTrack = opts.localStream?.getAudioTracks?.()[0];
    if (camTrack || micTrack) {
      // Reuse the caller's stream: publish the camera + mic tracks as-is.
      const pubs: Promise<unknown>[] = [];
      if (camTrack) {
        pubs.push(
          room.localParticipant.publishTrack(camTrack, { source: "camera", name: "camera" }).catch((e: unknown) => {
            console.warn("[proctor] camera publish failed:", e);
          }),
        );
      }
      if (micTrack) {
        pubs.push(
          room.localParticipant.publishTrack(micTrack, { source: "microphone", name: "microphone" }).catch((e: unknown) => {
            console.warn("[proctor] mic publish failed:", e);
          }),
        );
      }
      await Promise.all(pubs);
    } else {
      // No caller stream — acquire camera + mic here (capped so the phone CPU
      // isn't asked to analyse/encode 1080p; 640x480 is plenty for proctoring).
      const tracks = await createLocalTracks({
        audio: true,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      });
      owned = tracks;
      await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track)));
    }
    // Publish the already-granted screen-share track (if any) as a screen source
    // so the proctor grid can show each candidate's screen next to their camera.
    const screenTrack = opts.screenStream?.getVideoTracks?.()[0];
    if (screenTrack) {
      await room.localParticipant.publishTrack(screenTrack, { source: "screen_share", name: "screen" });
    }
    opts.onState?.("connected");

    // The published local stream: caller's stream when reused, else the tracks
    // we created (only used for the preview element — never stopped externally).
    const published = opts.localStream?.getTracks().length
      ? opts.localStream
      : new MediaStream((owned ?? []).map((t) => t.mediaStreamTrack));
    return {
      room,
      stream: published ?? null,
      stop: () => {
        void room.disconnect();
        owned?.forEach((t) => t.stop());
        owned = null;
      },
    };
  } catch (err) {
    // Connect / camera / publish failed — tear down and let the caller fall back
    // to a local-only preview instead of throwing an unhandled rejection.
    void room.disconnect();
    console.warn("[proctor] LiveKit publishing failed, falling back to local-only:", err);
    return null;
  }
}
