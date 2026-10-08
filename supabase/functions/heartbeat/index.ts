// Beneath the Mask — heartbeat: keeps a player's last_seen_at fresh and marks
// them connected again after a reconnect.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { loadRoom, requirePlayer, serviceClient } from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);

    const { error } = await sb
      .from('players')
      .update({ last_seen_at: new Date().toISOString(), connected: true })
      .eq('id', player.id);
    if (error) throw new HttpError(500, error.message);

    return json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
