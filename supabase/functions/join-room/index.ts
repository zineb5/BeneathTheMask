// Beneath the Mask — join-room: a player joins a lobby by its 6-char code.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { Player, Room, serviceClient } from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const code = requireString(body, 'code').toUpperCase();
    const displayName = requireString(body, 'display_name');
    const hue = requireString(body, 'hue');
    const avatarVariant = body.avatar_variant;
    if (avatarVariant !== 'F' && avatarVariant !== 'M') {
      throw new HttpError(400, "avatar_variant must be 'F' or 'M'");
    }

    const sb = serviceClient();

    const { data: roomRow, error: rErr } = await sb
      .from('rooms')
      .select('*')
      .eq('code', code)
      .maybeSingle();
    if (rErr) throw new HttpError(500, rErr.message);
    if (!roomRow) throw new HttpError(404, 'room not found');
    const room = roomRow as Room;

    if (room.status !== 'LOBBY') throw new HttpError(409, 'game already started');

    const { count, error: cErr } = await sb
      .from('players')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', room.id);
    if (cErr) throw new HttpError(500, cErr.message);
    if ((count ?? 0) >= 10) throw new HttpError(409, 'room is full');

    const { data: playerRow, error: pErr } = await sb
      .from('players')
      .insert({
        room_id: room.id,
        display_name: displayName,
        hue,
        avatar_variant: avatarVariant,
        is_host: false,
      })
      .select()
      .single();
    if (pErr) throw new HttpError(500, pErr.message);

    const { data: players, error: plErr } = await sb
      .from('players')
      .select('*')
      .eq('room_id', room.id)
      .order('id');
    if (plErr) throw new HttpError(500, plErr.message);

    return json({ room, player: playerRow as Player, players: players ?? [] });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
