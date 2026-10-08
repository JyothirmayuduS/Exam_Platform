// LiveKit proctoring — student side.
//
// The student's camera + mic (and optionally screen) are published to a LiveKit
// room that the invigilator watches from the proctor grid. Access tokens are
// ALWAYS minted server-side by the Supabase Edge Function `livekit-token`
// (see backend/supabase/functions/livekit-token). The browser never holds the LiveKit
// API secret.
//
// Everything degrades: with no LiveKit/Supabase config the caller falls back to
// a local-only camera preview so the exam UI still works in the prototype.

import { Room, RoomEvent, Track, createLocalTracks } from "livekit-client";
import { env, livekitConfigured, resolveLivekitUrl } from "@/shared/data/env";
import { getSupabase } from "@/shared/data/supabase";
import { cameraEncoding, screenEncoding, type VideoEncodingProfile } from "@/shared/services/lowBandwidth";

export type ProctorState = "connecting" | "connected" | "reconnecting" | "disconnected" | "local-only";

export type LinkQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export type ProctorHandle = {
  room: InstanceType<typeof Room> | null;
  stream: MediaStream | null;
  /** Weak link: lower the live camera/screen bitrate, frame rate and size. */
  setLowBandwidth: (on: boolean) => void;
  stop: () => void;
};

/** Re-encode a published track in place (no renegotiation, no new capture). */
async function applyEncoding(sender: RTCRtpSender | undefined, profile: VideoEncodingProfile): Promise<void> {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const enc of params.encodings) {
      enc.maxBitrate = profile.maxBitrate;
      enc.maxFramerate = profile.maxFramerate;
      enc.scaleResolutionDownBy = profile.scaleResolutionDownBy;
    }
    await sender.setParameters(params);
  } catch (err) {
    console.warn("[proctor] could not change video encoding:", err);
  }
}

/** Ask the Edge Function for a short-lived LiveKit access token. Throws with a
 *  readable reason (shown on the camera tile) instead of failing silently. */
export async function fetchProctorToken(
  room: string,
  identity: string,
): Promise<{ token: string; url: string } | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db.functions.invoke("livekit-token", {
    body: { room, identity, canPublish: true, canSubscribe: false },
  });
  if (error) {
    let detail = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === "function") {
      try { detail = `${ctx.status} ${(await ctx.text()).slice(0, 160)}`; } catch { /* body already read */ }
    }
    throw new Error(`video token request failed: ${detail}`);
  }
  if (!data?.token) throw new Error("video token request returned no token");
  const url = resolveLivekitUrl(data.url as string | undefined, env.livekitUrl);
  if (!url) throw new Error("no LiveKit server URL configured");
  return { token: data.token as string, url };
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
  /** LiveKit's measure of this student's own link. */
  onQuality?: (q: LinkQuality) => void;
}): Promise<ProctorHandle | null> {
  if (!livekitConfigured) return null;
  const creds = await fetchProctorToken(opts.room, opts.identity);
  if (!creds) return null;

  const room = new Room({ adaptiveStream: true, dynacast: true });
  // A room we tore down ourselves must not report "disconnected": the caller
  // treats that as a dropped link and reconnects, killing its newer room.
  let stopped = false;
  const report = (s: ProctorState) => { if (!stopped) opts.onState?.(s); };
  report("connecting");
  room.on(RoomEvent.Reconnecting, () => report("reconnecting"));
  room.on(RoomEvent.Reconnected, () => report("connected"));
  room.on(RoomEvent.Disconnected, () => report("disconnected"));
  room.on(RoomEvent.ConnectionQualityChanged, (quality: string, participant: { identity?: string } | undefined) => {
    if (stopped || participant?.identity !== room.localParticipant.identity) return;
    opts.onQuality?.(quality as LinkQuality);
  });
  const published: { camera?: { sender?: RTCRtpSender }; screen?: { sender?: RTCRtpSender } } = {};

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
      // Keep audio unmuted on the wire so proctors can listen.
      if (track.kind === "audio") track.enabled = true;
      const isScreen = source === Track.Source.ScreenShare;
      const profile = isScreen ? screenEncoding(false) : cameraEncoding(false);
      const pub = await room.localParticipant.publishTrack(track, {
        source,
        name,
        // One capped layer: simulcast adds extra uplink a weak link can't carry.
        simulcast: false,
        ...(track.kind === "video"
          ? isScreen
            ? { screenShareEncoding: { maxBitrate: profile.maxBitrate, maxFramerate: profile.maxFramerate } }
            : { videoEncoding: { maxBitrate: profile.maxBitrate, maxFramerate: profile.maxFramerate } }
          : {}),
      });
      if (track.kind === "video" && pub.track) published[isScreen ? "screen" : "camera"] = pub.track;
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
        const ok = await attemptPublish(clone, Track.Source.Camera, "camera");
        if (!ok) throw new Error("camera track publish failed");
      }
      if (micTrack) {
        const clone = micTrack.clone();
        ownedTracks.push(clone);
        const ok = await attemptPublish(clone, Track.Source.Microphone, "microphone");
        if (!ok) console.warn("[proctor] microphone publish failed — proctor cannot listen to this candidate");
      } else {
        console.warn("[proctor] no microphone track on localStream — proctor audio will be silent");
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
        const source = track.kind === "audio" ? Track.Source.Microphone : Track.Source.Camera;
        const ok = await attemptPublish(track.mediaStreamTrack, source, track.kind === "audio" ? "microphone" : "camera");
        if (track.kind === "video" && !ok) throw new Error("camera track publish failed");
        if (track.kind === "audio" && !ok) console.warn("[proctor] microphone publish failed");
      }
    }
    // Publish the already-granted screen-share track (if any) as a screen source
    // so the proctor grid can show each candidate's screen next to their camera.
    // A screen failure is logged but never takes down the camera feed.
    await attemptPublish(opts.screenStream?.getVideoTracks()[0], Track.Source.ScreenShare, "screen");
    report("connected");

    // The published local stream: caller's stream when reused (preview keeps
    // working even though LiveKit encodes the clones), else the tracks we
    // created.
    const previewStream = opts.localStream?.getTracks().length
      ? opts.localStream
      : new MediaStream(ownedTracks);
    let lowBandwidth = false;
    return {
      room,
      stream: previewStream ?? null,
      setLowBandwidth: (on) => {
        if (on === lowBandwidth || stopped) return;
        lowBandwidth = on;
        void applyEncoding(published.camera?.sender, cameraEncoding(on));
        void applyEncoding(published.screen?.sender, screenEncoding(on));
      },
      stop: () => {
        stopped = true;
        void room.disconnect();
        for (const t of ownedTracks) t.stop();
        ownedTracks = [];
      },
    };
  } catch (err) {
    // Connect / camera / publish failed — tear down and let the caller fall
    // back to a local-only preview, showing why.
    stopped = true;
    void room.disconnect();
    for (const t of ownedTracks) t.stop();
    console.warn("[proctor] LiveKit publishing failed, falling back to local-only:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
