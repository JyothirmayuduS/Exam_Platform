// LiveKit voice announcements — "speak to that candidate".
//
// Teacher / proctor consoles open a broadcast handle on a *per-candidate*
// channel:  voice-<examId>-<roll>.  The livekit-token Edge Function only lets
// staff publish on voice rooms, so students can never talk back into them; each
// student's exam screen subscribes to their own channel and plays the audio.
//
// Degrades gracefully: without LiveKit config both sides resolve to null and
// the UI falls back to a text warning.

import { Room, RoomEvent, createLocalTracks } from "livekit-client";

// The exact track type createLocalTracks returns — derived so we never drift
// from whatever livekit-client exports for the installed version.
type CreatedMicTrack = Awaited<ReturnType<typeof createLocalTracks>>[number];
import { env, livekitConfigured } from "./env";
import { getSupabase } from "./supabase";

/** Build the per-candidate announcement room, sanitized for LiveKit. */
export function voiceRoom(examId: string, roll: string): string {
  return `voice-${examId}-${roll}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
}

async function mintVoiceToken(room: string): Promise<{ token: string; url: string } | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db.functions.invoke("livekit-token", { body: { room } });
  if (error || !data?.token) return null;
  return { token: data.token as string, url: (data.url as string) || env.livekitUrl };
}

// ── Staff side: push-to-talk broadcast ───────────────────────────────────────

export type VoiceBroadcastHandle = {
  /** Whether the mic is currently published (talking). */
  speaking: boolean;
  /** Publish (true) or unpublish (false) the microphone into the channel. */
  setSpeaking: (on: boolean) => Promise<void>;
  stop: () => void;
};

/**
 * Connect staff to a candidate's voice channel. The microphone is acquired
 * lazily on the first `setSpeaking(true)` call (i.e. inside the button's click),
 * so the permission prompt is always user-gesture driven. Returns null when
 * LiveKit isn't configured.
 */
export async function startVoiceBroadcast(
  room: string,
  onError?: (message: string) => void,
): Promise<VoiceBroadcastHandle | null> {
  if (!livekitConfigured) {
    onError?.("Live voice isn't configured — use a text warning instead.");
    return null;
  }
  const creds = await mintVoiceToken(room);
  if (!creds) {
    onError?.("Could not open the voice channel — use a text warning instead.");
    return null;
  }

  const lk = new Room({ adaptiveStream: true, dynacast: true });
  try {
    await lk.connect(creds.url, creds.token);
  } catch (err) {
    void lk.disconnect();
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }

  let localTrack: CreatedMicTrack | null = null;
  let speaking = false;

  const ensureTrack = async (): Promise<boolean> => {
    if (localTrack) return true;
    try {
      const tracks = await createLocalTracks({ audio: true, video: false });
      localTrack = tracks[0];
      return !!localTrack;
    } catch {
      return false;
    }
  };

  return {
    speaking,
    setSpeaking: async (on: boolean) => {
      if (on === speaking) return;
      if (on) {
        if (!(await ensureTrack()) || !localTrack) {
          onError?.("Microphone unavailable — check the mic permission.");
          return;
        }
        try {
          await lk.localParticipant.publishTrack(localTrack, { source: "microphone", name: "proctor-voice" });
          speaking = true;
        } catch (err) {
          onError?.(err instanceof Error ? err.message : String(err));
        }
      } else if (localTrack) {
        try {
          await lk.localParticipant.unpublishTrack(localTrack, true);
        } catch { /* already gone */ }
        speaking = false;
      }
    },
    stop: () => {
      try {
        localTrack?.stop();
      } catch { /* ignore */ }
      void lk.disconnect();
    },
  };
}

// ── Student side: listener for the invigilator's voice ───────────────────────

export type VoiceListenHandle = {
  stop: () => void;
};

/**
 * Subscribe to the candidate's own announcement channel and play the single
 * staff audio track. `onSpeaking` flips as the staff member starts / stops
 * talking. Returns null when LiveKit isn't configured.
 */
export async function startVoiceListen(opts: {
  room: string;
  onSpeaking?: (speaking: boolean) => void;
  onError?: (message: string) => void;
}): Promise<VoiceListenHandle | null> {
  if (!livekitConfigured) return null;
  const creds = await mintVoiceToken(opts.room);
  if (!creds) return null;

  const lk = new Room({ adaptiveStream: false, dynacast: false });
  let attached: HTMLAudioElement | null = null;

  lk.on(RoomEvent.TrackSubscribed, (track: any) => {
    if (track?.kind !== "audio") return;
    try {
      attached = track.attach() as HTMLAudioElement;
      attached.autoplay = true;
      attached.volume = 1;
      void attached.play().catch(() => { /* browser autoplay policy — a click usually follows */ });
      opts.onSpeaking?.(true);
    } catch (err) {
      opts.onError?.(err instanceof Error ? err.message : String(err));
    }
  });
  lk.on(RoomEvent.TrackUnsubscribed, (track: any) => {
    if (track?.kind !== "audio") return;
    try {
      track.detach();
    } catch { /* ignore */ }
    attached = null;
    opts.onSpeaking?.(false);
  });

  try {
    await lk.connect(creds.url, creds.token);
  } catch {
    void lk.disconnect();
    return null;
  }

  return {
    stop: () => {
      try {
        attached?.remove();
      } catch { /* ignore */ }
      attached = null;
      void lk.disconnect();
      opts.onSpeaking?.(false);
    },
  };
}
