// Beneath the Mask — create-room: host opens a new room in the lobby.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import { Player, Room, serviceClient } from '../_shared/client.ts';

// Unambiguous alphabet: no I, L, O, 0, 1.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const displayName = requireString(body, 'display_name');
    const hue = requireString(body, 'hue');
    const avatarVariant = body.avatar_variant;
    if (avatarVariant !== 'F' && avatarVariant !== 'M') {
      throw new HttpError(400, "avatar_variant must be 'F' or 'M'");
    }
    const rawTimer =
      typeof body.question_timer_s === 'number' && Number.isFinite(body.question_timer_s)
        ? body.question_timer_s
        : 40;
    const timer = Math.min(45, Math.max(30, Math.round(rawTimer)));
    const rawLimit =
      typeof body.subjects_limit === 'number' && Number.isFinite(body.subjects_limit)
        ? Math.round(body.subjects_limit)
        : null;
    const subjectsLimit = rawLimit !== null && rawLimit >= 1 && rawLimit <= 10 ? rawLimit : null;

    const sb = serviceClient();

    let room: Room | null = null;
    for (let attempt = 0; attempt < 3 && !room; attempt++) {
      const { data, error } = await sb
        .from('rooms')
        .insert({ code: makeCode(), status: 'LOBBY', question_timer_s: timer, subjects_limit: subjectsLimit })
        .select()
        .single();
      if (!error) {
        room = data as Room;
        continue;
      }
      if (error.code !== '23505') throw new HttpError(500, error.message); // not a code clash
    }
    if (!room) throw new HttpError(500, 'could not allocate a unique room code');

    const { data: playerRow, error: pErr } = await sb
      .from('players')
      .insert({
        room_id: room.id,
        display_name: displayName,
        hue,
        avatar_variant: avatarVariant,
        is_host: true,
      })
      .select()
      .single();
    if (pErr) throw new HttpError(500, pErr.message);
    const player = playerRow as Player;

    const { error: hErr } = await sb.from('rooms').update({ host_player_id: player.id }).eq('id', room.id);
    if (hErr) throw new HttpError(500, hErr.message);

    const { data: freshRoom, error: fErr } = await sb.from('rooms').select().eq('id', room.id).single();
    if (fErr) throw new HttpError(500, fErr.message);

    return json({ room: freshRoom, player });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
