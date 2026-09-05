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

  // MediaStreamTracks WE own (created or cloned) — stopped on teardown. The
  // caller's original stream tracks are NEVER stopped.
  let ownedTracks: MediaStreamTrack[] = [];

  // One publish attempt for a track. A missing track is not a failure (e.g. no
  // mic granted); a rejected publish is a REAL failure we must not swallow —
  // silently "connecting" without a camera in the room is exactly the bug that
  // made proctors see 0 feeds while the student UI showed "PROCTOR LIVE".
  const attemptPublish = async (
    track: MediaStreamTrack | undefined,
    source: string,
    name: string,
  ): Promise<boolean> => {
    if (!track) return true;
    try {
      await room.localParticipant.publishTrack(track, { source, name });
      return true;
    } catch (err) {
      console.warn(`[proctor] publish ${name} FAILED:`, err);
      return false;
    }
  };

  try {
    await room.connect(creds.url, creds.token);
    if (opts.localStream?.getTracks().length) {
      // Reuse the caller's camera+mic stream, publishing CLONES of its tracks:
      // a MediaStreamTrack can be owned by one encoder path at a time, and the
      // caller keeps recording the original locally — publishing the clone lets
      // LiveKit encode independently and reconnect cleanly on phones.
      const camTrack = opts.localStream.getVideoTracks()[0];
      const micTrack = opts.localStream.getAudioTracks()[0];
      if (camTrack) {
        const clone = camTrack.clone();
        ownedTracks.push(clone);
        const ok = await attemptPublish(clone, "camera", "camera");
        if (!ok) throw new Error("camera track publish failed");
      }
      if (micTrack) {
        const clone = micTrack.clone();
        ownedTracks.push(clone);
        await attemptPublish(clone, "microphone", "microphone");
      }
    } else {
      // No caller stream — acquire camera + mic here (capped so the phone CPU
      // isn't asked to analyse/encode 1080p; 640x480 is plenty for proctoring).
      const tracks = await createLocalTracks({
        audio: true,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      });
      ownedTracks = tracks.map((t) => t.mediaStreamTrack);
      for (const track of tracks) {
        const ok = await attemptPublish(track.mediaStreamTrack, String(track.kind), track.kind);
        if (track.kind === "video" && !ok) throw new Error("camera track publish failed");
      }
    }
    // Publish the already-granted screen-share track (if any) as a screen source
    // so the proctor grid can show each candidate's screen next to their camera.
    // A screen failure is logged but never takes down the camera feed.
    await attemptPublish(opts.screenStream?.getVideoTracks()[0], "screen_share", "screen");
    opts.onState?.("connected");

    // The published local stream: caller's stream when reused (preview keeps
    // working even though LiveKit encodes the clones), else the tracks we
    // created.
    const published = opts.localStream?.getTracks().length
      ? opts.localStream
      : new MediaStream(ownedTracks);
    return {
      room,
      stream: published ?? null,
      stop: () => {
        void room.disconnect();
        for (const t of ownedTracks) t.stop();
        ownedTracks = [];
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
