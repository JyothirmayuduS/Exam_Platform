// LiveKit proctoring — viewer (proctor / teacher) side.
//
// The invigilator subscribes to the same LiveKit room the student publishes to
// and receives their camera (and, if published, screen) tracks. The access
// token is minted server-side by the `livekit-token` Edge Function, which only
// grants `canSubscribe` to authenticated proctor/teacher/admin roles — a
// student's token can never watch another student.
//
// Throws a clear Error when LiveKit/Supabase is missing or the token/connect
// fails, so the console can show the real reason instead of a silent blank wall.

import { Room, RoomEvent } from "livekit-client";
import { env, livekitConfigured, resolveLivekitUrl } from "@/shared/data/env";
import { getSupabase } from "@/shared/data/supabase";

export type ViewerState = "connecting" | "connected" | "reconnecting" | "disconnected";

/** One remote participant's attached media, keyed by their LiveKit identity. */
export type RemoteFeed = {
  identity: string;
  // Both are separate video elements when the student publishes camera + screen.
  camera: HTMLVideoElement | null;
  screen: HTMLVideoElement | null;
  cameraTrack: any | null;
  screenTrack: any | null;
  audioTrack: any | null;
  /** LiveKit's measure of the student's link: excellent / good / poor / lost. */
  quality: "excellent" | "good" | "poor" | "lost" | "unknown";
};

export type ViewerHandle = {
  room: InstanceType<typeof Room> | null;
  /** Live room stats for the console status line: participants we see and the
   *  number of their published (remote) tracks. Turns the old "0 feeds" dead
   *  end into an answer: room empty? / students not connected; tracks 0 but
   *  participants 1? / student connected but not publishing. */
  diagnostics: () => { participants: number; remoteTracks: number };
  stop: () => void;
};

/** Ask the Edge Function for a proctor (subscribe-capable) token. */
async function fetchViewerToken(
  room: string,
): Promise<{ token: string; url: string; identity: string }> {
  const db = getSupabase();
  if (!db) throw new Error("Supabase is not configured in this build.");
  const { data, error } = await db.functions.invoke("livekit-token", {
    body: { room, canSubscribe: true, canPublish: false },
  });
  if (error || !data?.token) {
    console.error("[proctor-viewer] Edge Function error:", error, "| data:", data);
    let detail = error?.message || "livekit-token returned no token";
    try {
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        const body = await ctx.clone().json() as { error?: string };
        if (body?.error) detail = body.error;
      }
    } catch { /* keep detail */ }
    if (data && typeof data === "object" && "error" in data && (data as { error?: string }).error) {
      detail = String((data as { error?: string }).error);
    }
    throw new Error(`LiveKit token failed — ${detail}`);
  }
  const url = resolveLivekitUrl(data.url as string | undefined, env.livekitUrl);
  if (!url) {
    throw new Error(
      "LiveKit URL is invalid — set LIVEKIT_URL (Supabase secret) and VITE_LIVEKIT_URL to a wss:// host, then redeploy.",
    );
  }
  return {
    token: data.token as string,
    url,
    identity: (data.identity as string) ?? "proctor",
  };
}

/**
 * Connect to a room as a viewer and stream every student's video into a
 * caller-managed map. `onFeeds` is called whenever the set of live feeds
 * changes (participant joins/leaves, track published/unpublished) so the UI can
 * re-render its tiles. Returns null when LiveKit isn't configured.
 */
export async function startProctorViewing(opts: {
  room: string;
  onState?: (s: ViewerState) => void;
  onFeeds?: (feeds: RemoteFeed[]) => void;
}): Promise<ViewerHandle> {
  console.warn("[proctor-viewer] [start] START — livekitConfigured:", livekitConfigured, "| supabaseUrl:", env.supabaseUrl ? "[ok] SET" : "[fail] MISSING", "| room:", opts.room);
  if (!livekitConfigured) {
    throw new Error("VITE_LIVEKIT_URL is missing from this build — set it on Vercel and redeploy.");
  }
  console.debug("[proctor-viewer] fetching token for room:", opts.room);
  const creds = await fetchViewerToken(opts.room);
  console.warn("[proctor-viewer] [ok] token received — identity:", creds.identity, "url:", creds.url, "| token starts with:", creds.token.slice(0, 30) + "...");

  // adaptiveStream pauses tracks attached to off-screen elements. Viewers only
  // attach inside visible tiles, so keep full resolution.
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const feeds = new Map<string, RemoteFeed>();

  const emit = () => opts.onFeeds?.([...feeds.values()]);
  const ensure = (identity: string): RemoteFeed => {
    let f = feeds.get(identity);
    if (!f) { f = { identity, camera: null, screen: null, cameraTrack: null, screenTrack: null, audioTrack: null, quality: "unknown" }; feeds.set(identity, f); }
    return f;
  };

  opts.onState?.("connecting");
  room.on(RoomEvent.Reconnecting, () => opts.onState?.("reconnecting"));
  room.on(RoomEvent.Reconnected, () => opts.onState?.("connected"));
  room.on(RoomEvent.Disconnected, () => opts.onState?.("disconnected"));

  room.on(RoomEvent.ParticipantConnected, (p: any) => console.debug("[proctor-viewer] participant joined:", p?.identity));
  room.on(RoomEvent.ConnectionQualityChanged, (quality: string, participant: any) => {
    const feed = feeds.get(String(participant?.identity ?? ""));
    if (!feed || feed.quality === quality) return;
    feed.quality = (quality as RemoteFeed["quality"]) ?? "unknown";
    emit();
  });

  // Store the track only. Tiles attach it to their own <video> — an extra
  // off-DOM attach() with adaptiveStream left feeds paused/black.
  room.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
    console.debug("[proctor-viewer] track subscribed:", track?.kind, "source:", track?.source, "from:", participant?.identity);
    const feed = ensure(String(participant?.identity ?? "unknown"));
    if (participant?.connectionQuality) feed.quality = participant.connectionQuality;
    if (track?.kind === "video") {
      const isScreen = String(track?.source ?? "").includes("screen");
      if (isScreen) { feed.screenTrack = track; }
      else { feed.cameraTrack = track; }
      emit();
    } else if (track?.kind === "audio") {
      feed.audioTrack = track;
      emit();
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: any, _pub: any, participant: any) => {
    try { track?.detach?.(); } catch { /* ignore */ }
    const feed = feeds.get(String(participant?.identity ?? "unknown"));
    if (feed && track?.kind === "video") {
      const isScreen = String(track?.source ?? "").includes("screen");
      if (isScreen) { feed.screen = null; feed.screenTrack = null; }
      else { feed.camera = null; feed.cameraTrack = null; }
      emit();
    } else if (feed && track?.kind === "audio") {
      feed.audioTrack = null;
      emit();
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant: any) => {
    feeds.delete(String(participant?.identity ?? "unknown"));
    emit();
  });

  const attachExisting = () => {
    // Tracks published before we joined don't always re-fire TrackSubscribed
    // depending on livekit-client version — walk remote participants once.
    const remotes =
      (room as unknown as { remoteParticipants?: Map<string, any> }).remoteParticipants ??
      new Map<string, any>();
    for (const participant of remotes.values()) {
      const pubs =
        participant?.trackPublications ??
        participant?.videoTrackPublications ??
        new Map();
      const list = pubs instanceof Map ? [...pubs.values()] : Object.values(pubs ?? {});
      for (const pub of list as any[]) {
        const track = pub?.track;
        if (!track || pub?.isSubscribed === false) continue;
        const feed = ensure(String(participant?.identity ?? "unknown"));
        if (participant?.connectionQuality) feed.quality = participant.connectionQuality;
        if (track.kind === "video") {
          const isScreen = String(track?.source ?? pub?.source ?? "").includes("screen");
          if (isScreen) { feed.screenTrack = track; }
          else { feed.cameraTrack = track; }
        } else if (track.kind === "audio") {
          feed.audioTrack = track;
        }
      }
    }
    emit();
  };

  try {
    console.warn("[proctor-viewer] Attempting room.connect() to", creds.url, "...");
    await room.connect(creds.url, creds.token);
    console.warn("[proctor-viewer] [ok] room.connect() succeeded! room:", opts.room);
    opts.onState?.("connected");
    attachExisting();
  } catch (err) {
    void room.disconnect();
    console.error("[proctor-viewer] [fail] room.connect() FAILED:", err);
    const message = err instanceof Error ? err.message : "room.connect failed";
    throw new Error(`LiveKit connect failed — ${message}`);
  }

  const diagnostics = () => {
    // livekit-client 2.x exposes remote participants on `remoteParticipants`.
    const participants =
      (room as unknown as { remoteParticipants?: Map<string, unknown> }).remoteParticipants ??
      (room as unknown as { participants?: Map<string, unknown> }).participants ??
      new Map<string, unknown>();
    let remoteTracks = 0;
    for (const p of participants.values()) {
      const rp = p as { videoTrackPublications?: { size?: number }; audioTrackPublications?: { size?: number } };
      remoteTracks += (rp.videoTrackPublications?.size ?? 0) + (rp.audioTrackPublications?.size ?? 0);
    }
    return { participants: participants.size, remoteTracks };
  };

  return { room, diagnostics, stop: () => { console.debug("[proctor-viewer] stopping"); void room.disconnect(); } };
}

/** Extract a display roll from a LiveKit identity like `student:<uuid>`. */
export function identityLabel(identity: string): string {
  const [, rest] = identity.split(":");
  return rest ?? identity;
}
