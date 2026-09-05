// LiveKit proctoring — viewer (proctor / teacher) side.
//
// The invigilator subscribes to the same LiveKit room the student publishes to
// and receives their camera (and, if published, screen) tracks. The access
// token is minted server-side by the `livekit-token` Edge Function, which only
// grants `canSubscribe` to authenticated proctor/teacher/admin roles — a
// student's token can never watch another student.
//
// Degrades gracefully: with no LiveKit/Supabase config `startProctorViewing`
// resolves to `null` and the UI shows placeholder tiles instead of live feeds.

import { Room, RoomEvent } from "livekit-client";
import { env, livekitConfigured } from "./env";
import { getSupabase } from "./supabase";

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
};

export type ViewerHandle = {
  room: InstanceType<typeof Room> | null;
  stop: () => void;
};

/** Ask the Edge Function for a proctor (subscribe-capable) token. */
async function fetchViewerToken(
  room: string,
): Promise<{ token: string; url: string; identity: string } | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db.functions.invoke("livekit-token", {
    body: { room, canSubscribe: true, canPublish: false },
  });
  if (error || !data?.token) {
    console.error("[proctor-viewer] Edge Function error:", error, "| data:", data);
    return null;
  }
  return {
    token: data.token as string,
    url: (data.url as string) || env.livekitUrl,
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
}): Promise<ViewerHandle | null> {
  console.warn("[proctor-viewer] [start] START — livekitConfigured:", livekitConfigured, "| supabaseUrl:", env.supabaseUrl ? "[ok] SET" : "[fail] MISSING", "| room:", opts.room);
  if (!livekitConfigured) {
    console.error("[proctor-viewer] [fail] ABORT: livekitConfigured=false — VITE_LIVEKIT_URL is missing on Vercel");
    return null;
  }
  console.debug("[proctor-viewer] fetching token for room:", opts.room);
  const creds = await fetchViewerToken(opts.room);
  if (!creds) {
    console.error("[proctor-viewer] [fail] ABORT: token fetch returned null — Edge Function call failed or returned no token");
    return null;
  }
  console.warn("[proctor-viewer] [ok] token received — identity:", creds.identity, "url:", creds.url, "| token starts with:", creds.token.slice(0, 30) + "...");

  const room = new Room({ adaptiveStream: true, dynacast: true });
  const feeds = new Map<string, RemoteFeed>();

  const emit = () => opts.onFeeds?.([...feeds.values()]);
  const ensure = (identity: string): RemoteFeed => {
    let f = feeds.get(identity);
    if (!f) { f = { identity, camera: null, screen: null, cameraTrack: null, screenTrack: null, audioTrack: null }; feeds.set(identity, f); }
    return f;
  };

  opts.onState?.("connecting");
  room.on(RoomEvent.Reconnecting, () => opts.onState?.("reconnecting"));
  room.on(RoomEvent.Reconnected, () => opts.onState?.("connected"));
  room.on(RoomEvent.Disconnected, () => opts.onState?.("disconnected"));

  room.on(RoomEvent.ParticipantConnected, (p: any) => console.debug("[proctor-viewer] participant joined:", p?.identity));

  // A remote track became available — attach it to a fresh media element and
  // route it to the camera or screen slot depending on its source.
  room.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
    console.debug("[proctor-viewer] track subscribed:", track?.kind, "source:", track?.source, "from:", participant?.identity);
    const feed = ensure(String(participant?.identity ?? "unknown"));
    if (track?.kind === "video") {
      const el = track.attach() as HTMLVideoElement;
      el.muted = true;
      el.playsInline = true;
      const isScreen = String(track?.source ?? "").includes("screen");
      if (isScreen) { feed.screen = el; feed.screenTrack = track; }
      else { feed.camera = el; feed.cameraTrack = track; }
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

  try {
    console.warn("[proctor-viewer] Attempting room.connect() to", creds.url, "...");
    await room.connect(creds.url, creds.token);
    console.warn("[proctor-viewer] [ok] room.connect() succeeded! room:", opts.room);
    opts.onState?.("connected");
  } catch (err) {
    void room.disconnect();
    console.error("[proctor-viewer] [fail] room.connect() FAILED:", err);
    return null;
  }

  return { room, stop: () => { console.debug("[proctor-viewer] stopping"); void room.disconnect(); } };
}

/** Extract a display roll from a LiveKit identity like `student:<uuid>`. */
export function identityLabel(identity: string): string {
  const [, rest] = identity.split(":");
  return rest ?? identity;
}
