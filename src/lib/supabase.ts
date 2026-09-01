// Single shared Supabase client.
//
// `createClient` comes from the real package once you run `npm install`.
// Before install, the ambient stub in src/types/vendor.d.ts keeps tsc happy.
//
// The client is created lazily and only when real credentials exist, so the
// prototype still runs (with demo data) when no backend is configured.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, supabaseConfigured } from "./env";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

export { supabaseConfigured };
