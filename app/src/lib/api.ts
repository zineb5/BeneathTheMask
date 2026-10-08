// Edge-function caller + per-tab session persistence.

import type { Session } from './types';

const SUPABASE_URL: string = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
const ANON_KEY: string = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';

export const hasSupabaseEnv = Boolean(SUPABASE_URL && ANON_KEY);

const SESSION_KEY = 'btm:session';

// A party is often tested with several tabs on one laptop. localStorage is
// shared by every tab, which made every tab silently become the last player
// who joined. sessionStorage is isolated per tab while still surviving a
// refresh, so each browser tab/device retains its own player identity.
function readSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.player_id === 'string' && typeof parsed.room_id === 'string' && typeof parsed.code === 'string') {
      return { player_id: parsed.player_id, room_id: parsed.room_id, code: parsed.code };
    }
  } catch {
    // Treat malformed persisted state as no session.
  }
  return null;
}

export function loadSession(): Session | null {
  const current = readSession(sessionStorage.getItem(SESSION_KEY));
  if (current) return current;

  // One-time migration for players with a session from older builds. Remove
  // the shared copy immediately so it cannot overwrite another tab's player.
  const legacy = readSession(localStorage.getItem(SESSION_KEY));
  if (legacy) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(legacy));
    localStorage.removeItem(SESSION_KEY);
  }
  return legacy;
}

export function saveSession(session: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.removeItem(SESSION_KEY);
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** POST to a supabase edge function. Throws ApiError with the server's
 *  `{error}` message when the call fails. */
export async function call<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body (e.g. a 502 from the gateway)
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}
