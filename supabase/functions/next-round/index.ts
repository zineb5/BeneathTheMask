// Beneath the Mask — next-round (host only): either deals the next subject a new
// round, or closes the room with the final leaderboard.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  createRoundWithDeliveries,
  currentRound,
  Player,
  requireHost,
  serviceClient,
} from '../_shared/client.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    const { room } = await requireHost(sb, roomId, playerId);
    if (room.status !== 'ROUND_REVEAL') throw new HttpError(400, 'room is not in ROUND_REVEAL');

    const round = await currentRound(sb, room);
    if (!round) throw new HttpError(400, 'no current round');

    // Next subject = lowest subject_order_idx above the current subject's.
    const { data: subjectRows } = await sb.from('players').select('*').eq('id', round.subject_player_id);
    const currentSubject = ((subjectRows ?? []) as Player[])[0];
    const currentIdx = currentSubject?.subject_order_idx ?? -1;

    const { data: nextRows } = await sb
      .from('players')
      .select('*')
      .eq('room_id', room.id)
      .gt('subject_order_idx', currentIdx)
      .order('subject_order_idx', { ascending: true })
      .limit(1);
    const next = ((nextRows ?? []) as Player[])[0];

    if (next) {
      const newRound = await createRoundWithDeliveries(sb, room, next.id, room.current_round_seq + 1);
      return json({ round: newRound, room_status: 'ROUND_INTRO' });
    }

    const { error: fErr } = await sb.from('rooms').update({ status: 'FINAL_LEADERBOARD' }).eq('id', room.id);
    if (fErr) throw new HttpError(500, fErr.message);

    const { data: rosterRows, error: pErr } = await sb
      .from('players')
      .select('*')
      .eq('room_id', room.id);
    if (pErr) throw new HttpError(500, pErr.message);
    const roster = (rosterRows ?? []) as Player[];

    // Tie-break: total_score desc, then best_predictor_badges desc, then the
    // player's summed head-to-head wins desc, then display_name asc.
    const winsById = new Map<string, number>(
      roster.map((p) => {
        let sum = 0;
        for (const inner of Object.values(p.head_to_head ?? {})) {
          for (const v of Object.values(inner as Record<string, number>)) sum += Number(v) || 0;
        }
        return [p.id, sum];
      }),
    );

    const leaderboard = roster
      .map((p) => ({
        player_id: p.id,
        display_name: p.display_name,
        hue: p.hue,
        avatar_variant: p.avatar_variant,
        total_score: p.total_score,
        best_predictor_badges: p.best_predictor_badges,
      }))
      .sort(
        (a, b) =>
          b.total_score - a.total_score ||
          b.best_predictor_badges - a.best_predictor_badges ||
          (winsById.get(b.player_id) ?? 0) - (winsById.get(a.player_id) ?? 0) ||
          a.display_name.localeCompare(b.display_name),
      );

    return json({ room_status: 'FINAL_LEADERBOARD', leaderboard });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
