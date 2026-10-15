// Beneath the Mask — advance-question: poll/advance driver for the question loop.
// Always returns 200 for well-formed requests; never 409. Any participant calls it.
//
// Advance triggers:
//   (a) the current delivery's ends_at has passed (far-future safety net), or
//   (b) every connected GUESSER has predicted — the subject answers privately
//       and never gates the room's flow, or
//   (c) anyone forces it (anti-AFK filet; the UI only shows it to the round
//       controller, but the CAS is the real gate).

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  currentRound,
  loadDelivery,
  loadRoom,
  API_VERSION,
  QUESTION_WINDOW_MS,
  questionPayload,
  requirePlayer,
  Room,
  Round,
  serviceClient,
  subjectAnswerProgress,
  voteCounts,
} from '../_shared/client.ts';

// The room advances when every CONNECTED guesser has voted — the subject is
// physically separated and answers privately, so their vote never gates the
// room's flow. Zero connected guessers: don't auto-advance, the host decides.
async function allGuessersAnswered(
  sb: SupabaseClient,
  room: Room,
  round: Round,
  idx: number,
): Promise<boolean> {
  const { data: connected } = await sb
    .from('players')
    .select('id')
    .eq('room_id', room.id)
    .eq('connected', true)
    .neq('id', round.subject_player_id);
  const predictorIds = ((connected ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (predictorIds.length === 0) return false;

  const { data: preds } = await sb
    .from('predictions')
    .select('player_id')
    .eq('round_id', round.id)
    .eq('question_idx', idx)
    .in('player_id', predictorIds);
  const answered = new Set(((preds ?? []) as Array<{ player_id: string }>).map((r) => r.player_id));
  return predictorIds.every((id) => answered.has(id));
}

Deno.serve(async (req: Request): Promise<Response> => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requirePost(req);
    const body = await readBody(req);
    const roomId = requireString(body, 'room_id');
    const playerId = requireString(body, 'player_id');

    const sb = serviceClient();
    const room = await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);

    // Any participant may force-advance (anti-AFK filet) — the CAS below is
    // the real gate, and the UI only surfaces the button to the round
    // controller. Never the subject's business: they answer privately.
    const force = body.force === true;

    const round = await currentRound(sb, room);
    if (!round) throw new HttpError(404, 'no active round');
    if (round.status === 'reveal') return json({ status: 'reveal', version: API_VERSION });
    if (round.status !== 'question_loop') return json({ status: 'intro', version: API_VERSION });

    const idx = round.current_question_idx ?? 0;
    const delivery = await loadDelivery(sb, round.id, idx);

    const expired = !force && delivery.ends_at != null && Date.now() >= Date.parse(delivery.ends_at);
    const allAnswered = expired || force ? false : await allGuessersAnswered(sb, room, round, idx);

    if (!expired && !allAnswered && !force) {
      const counts = await voteCounts(sb, room, round, idx);
      return json({ ...questionPayload(delivery), ...counts, room_idx: idx, version: API_VERSION }); // not triggered: current payload unchanged
    }

    // The final reveal is never allowed until the subject has completed all
    // twelve private answers. Guessers may finish earlier, but their result
    // must wait for the person being read.
    if (idx === 11) {
      const progress = await subjectAnswerProgress(sb, round.id);
      if (!progress.complete) {
        const counts = await voteCounts(sb, room, round, idx);
        const canSeeGauge = player.id === room.host_player_id || player.id === round.subject_player_id;
        return json({
          ...questionPayload(delivery),
          answered: counts.answered,
          expected: counts.expected,
          voted: counts.voted,
          pending: counts.pending,
          ...(canSeeGauge ? { option_counts: counts.option_counts } : {}),
          ...(canSeeGauge ? { subject_answered: progress.answered, subject_complete: false } : {}),
          room_idx: idx,
          waiting_for_subject: true,
          version: API_VERSION,
        });
      }
    }

    if (idx < 11) {
      // CAS: only one concurrent caller wins the increment.
      const { data: cas } = await sb
        .from('rounds')
        .update({ current_question_idx: idx + 1 })
        .eq('id', round.id)
        .eq('current_question_idx', idx)
        .select('current_question_idx')
        .maybeSingle();
      if (cas) {
        const endsAt = new Date(Date.now() + QUESTION_WINDOW_MS).toISOString();
        await sb
          .from('question_deliveries')
          .update({ ends_at: endsAt })
          .eq('round_id', round.id)
          .eq('question_idx', idx + 1);
      }
      // Read back the winning idx (a rival caller may have advanced further).
      const { data: fresh } = await sb
        .from('rounds')
        .select('current_question_idx')
        .eq('id', round.id)
        .single();
      const newIdx = (fresh as { current_question_idx: number | null } | null)?.current_question_idx ?? idx + 1;
      const newDelivery = await loadDelivery(sb, round.id, newIdx);
      const counts = await voteCounts(sb, room, round, newIdx);
      return json({ ...questionPayload(newDelivery), ...counts, room_idx: newIdx, version: API_VERSION });
    }

    const { error: rErr } = await sb.from('rounds').update({ status: 'reveal' }).eq('id', round.id);
    if (rErr) throw new HttpError(500, rErr.message);
    const { error: rmErr } = await sb.from('rooms').update({ status: 'ROUND_REVEAL' }).eq('id', room.id);
    if (rmErr) throw new HttpError(500, rmErr.message);
    return json({ status: 'reveal', version: API_VERSION });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
