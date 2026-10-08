// Lazily-created supabase-js client used ONLY for the realtime channel.
// REST calls go through lib/api.ts (plain fetch); this client exists so we
// get postgres_changes + broadcast on `room:{code}`.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv } from './api';

const SUPABASE_URL: string = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
const ANON_KEY: string = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';

let client: SupabaseClient | null = null;

export function getRealtimeClient(): SupabaseClient | null {
  if (!hasSupabaseEnv) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return client;
}

export type { RealtimeChannel };
