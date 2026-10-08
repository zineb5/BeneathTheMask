// Beneath the Mask — update-room: host adjusts lobby settings (timer, subjects).

import { handleOptions, HttpError, json, readBody, requirePost } from '../_shared/http.ts';
import { Room, requireHost, serviceClient } from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const sb = serviceClient();
    const { room } = await requireHost(sb, body.room_id, body.player_id);
    if (room.status !== 'LOBBY') throw new HttpError(400, 'settings can only change in the lobby');

    const patch: Record<string, unknown> = {};
    if (typeof body.question_timer_s === 'number' && Number.isFinite(body.question_timer_s)) {
      patch.question_timer_s = Math.min(45, Math.max(30, Math.round(body.question_timer_s)));
    }
    if (body.subjects_limit === null) {
      patch.subjects_limit = null;
    } else if (typeof body.subjects_limit === 'number' && Number.isFinite(body.subjects_limit)) {
      const n = Math.round(body.subjects_limit);
      patch.subjects_limit = n >= 1 && n <= 10 ? n : null;
    }

    const { data, error } = await sb.from('rooms').update(patch).eq('id', room.id).select().single();
    if (error) throw new HttpError(500, error.message);
    return json({ room: data as Room });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
