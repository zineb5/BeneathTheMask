// Beneath the Mask — sync-state: reconnect resync. Returns the room, the roster,
// the current round, the live question payload, the caller's own answers, and
// the reveal results once they exist.

import { handleOptions, HttpError, json, readBody, requirePost, requireString } from '../_shared/http.ts';
import {
  currentRound,
  ensureDelivery,
  loadRoom,
  API_VERSION,
  questionPayload,
  requirePlayer,
  serviceClient,
  subjectAnswerProgress,
  voteCounts,
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
    const room = await loadRoom(sb, roomId);
    const player = await requirePlayer(sb, roomId, playerId);

    const { data: players, error: plErr } = await sb
      .from('players')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true });
    if (plErr) throw new HttpError(500, plErr.message);

    const round = await currentRound(sb, room);

    let question: unknown;
    let results: unknown;
    const myAnswers: number[] = Array(12).fill(-1);

    if (round) {
      if (round.status === 'question_loop') {
        // The subject browses their private questionnaire at their own cursor;
        // everyone else follows the room's current_question_idx. Deliveries are
        // created adaptively on demand (engine v2 PR2) — ensure, then read.
        const isSubject = player.id === round.subject_player_id;
        const roomIdx = round.current_question_idx ?? 0;
        const viewIdx = isSubject ? (round.subject_idx ?? 0) : roomIdx;
        const delivery = await ensureDelivery(sb, roomId, round, viewIdx);
        {
          const counts = await voteCounts(sb, room, round, roomIdx);
          const progress = await subjectAnswerProgress(sb, round.id);
          question = {
            ...questionPayload(delivery),
            answered: counts.answered,
            expected: counts.expected,
            voted: counts.voted,
            pending: counts.pending,
            // The group can see anonymous vote momentum, never identities or
            // choices. Subject completion remains private to the subject/host.
            option_counts: counts.option_counts,
            ...((isSubject || player.id === room.host_player_id)
              ? { subject_answered: progress.answered, subject_complete: progress.complete }
              : {}),
            room_idx: roomIdx,
          };
        }
      }

      if (player.id === round.subject_player_id) {
        const { data: ans } = await sb
          .from('subject_answers')
          .select('question_idx, chosen_index')
          .eq('round_id', round.id);
        for (const a of (ans ?? []) as Array<{ question_idx: number; chosen_index: number }>) {
          if (a.question_idx >= 0 && a.question_idx < 12) myAnswers[a.question_idx] = a.chosen_index;
        }
      } else {
        const { data: ans } = await sb
          .from('predictions')
          .select('question_idx, chosen_index')
          .eq('round_id', round.id)
          .eq('player_id', player.id);
        for (const a of (ans ?? []) as Array<{ question_idx: number; chosen_index: number }>) {
          if (a.question_idx >= 0 && a.question_idx < 12) myAnswers[a.question_idx] = a.chosen_index;
        }
      }

      const { data: rr } = await sb
        .from('round_results')
        .select('*')
        .eq('round_id', round.id)
        .not('revealed_at', 'is', null)
        .maybeSingle();
      if (rr) results = rr;
    }

    const out: Record<string, unknown> = { room, players: players ?? [], my_answers: myAnswers, version: API_VERSION };
    if (round) out.round = round;
    if (question !== undefined) out.question = question;
    if (results !== undefined) out.results = results;
    return json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal server error' }, 500);
  }
});
