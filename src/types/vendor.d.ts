// Fallback ambient type stubs.
// These let the project type-check BEFORE `npm install` pulls the real packages.
// After you run `npm install`, the real bundled types take precedence
// (Node resolution wins over ambient `declare module`), so you can leave these
// as-is. They only cover the surface this app actually uses.

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_LIVEKIT_URL: string;
  // Where the desktop lockdown app should boot straight into.
  readonly VITE_EXAM_ENTRY_PATH?: string;
  // "true" turns on per-second proctoring screenshot capture → R2.
  readonly VITE_PROCTOR_CAPTURE?: string;
  // Lockdown desktop app download destinations (see src/lib/platform.ts).
  readonly VITE_LOCKDOWN_DOWNLOAD_URL?: string;
  readonly VITE_LOCKDOWN_DOWNLOAD_WIN?: string;
  readonly VITE_LOCKDOWN_DOWNLOAD_MAC?: string;
  readonly VITE_LOCKDOWN_DOWNLOAD_LINUX?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "@supabase/supabase-js" {
  // Deliberately loose — real types replace this after `npm install`.
  export type SupabaseClient = any;
  export type RealtimeChannel = any;
  export type Session = any;
  export type User = any;
  export function createClient(url: string, key: string, options?: any): SupabaseClient;
}

declare module "livekit-client" {
  export const RoomEvent: any;
  export const Track: any;
  export const ConnectionState: any;
  export class Room {
    constructor(options?: any);
    localParticipant: any;
    state: any;
    connect(url: string, token: string, options?: any): Promise<void>;
    disconnect(): Promise<void>;
    on(event: any, cb: (...args: any[]) => void): this;
    off(event: any, cb: (...args: any[]) => void): this;
  }
  export function createLocalTracks(options?: any): Promise<any[]>;
  export function createLocalScreenTracks(options?: any): Promise<any[]>;
}
