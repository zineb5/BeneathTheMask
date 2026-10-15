// Beneath the Mask — shared Supabase client factory, row types, and room helpers.
//
// Identity model (accepted party-game trust, --no-verify-jwt): the caller sends
// their player_id; we load the row and check it belongs to the room (and that
// is_host is set where the endpoint requires the host).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  Bank,
  BankQuestion,
  mulberry32,
  selectQuestionsV2,
  shuffleOptions,
} from './engine.ts';
import { hashSeed, HttpError } from './http.ts';
import bankJson from './bank.json' with { type: 'json' };

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export const bank = bankJson as unknown as Bank;
export const BANK_BY_ID = new Map<number, BankQuestion>(bank.bank.map((q) => [q.id, q]));

// ---------------------------------------------------------------------------
// Row shapes (mirror supabase/migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface Room {
  id: string;
  code: string;
  status: 'LOBBY' | 'ROUND_INTRO' | 'QUESTION_LOOP' | 'ROUND_REVEAL' | 'FINAL_LEADERBOARD' | string;
  current_round_seq: number;
  host_player_id: string | null;
  created_at: string;
  question_timer_s: number;
  subjects_limit: number | null;
}

export interface Player {
  id: string;
  room_id: string;
  display_name: string;
  hue: string;
  avatar_variant: string;
  is_host: boolean;
  total_score: number;
  best_predictor_badges: number;
  subject_order_idx: number | null;
  connected: boolean;
  last_seen_at: string;
  created_at: string;
  head_to_head: Record<string, Record<string, number>>;
}

export interface Round {
  id: string;
  room_id: string;
  seq: number;
  subject_player_id: string;
  question_ids: number[];
  status: 'intro' | 'question_loop' | 'reveal' | 'SKIPPED' | string;
  created_at: string;
  current_question_idx: number | null;
  /** the subject's private cursor — independent of the room's current_question_idx. */
  subject_idx: number | null;
}

export interface Delivery {
  round_id: string;
  question_idx: number;
  question_id: number;
  shuffled_options: Array<{ i: number; t: string }>;
  ends_at: string | null;
}

export interface QuestionPayload {
  status: 'question';
  idx: number;
  q: string;
  options: string[];
  ends_at: string | null;
}

// ---------------------------------------------------------------------------
// Loaders / guards
// ---------------------------------------------------------------------------

export async function loadRoom(sb: SupabaseClient, roomId: string): Promise<Room> {
  if (!roomId) throw new HttpError(400, 'room_id is required');
  const { data, error } = await sb.from('rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'room not found');
  return data as Room;
}

export async function requirePlayer(sb: SupabaseClient, roomId: string, playerId: string): Promise<Player> {
  if (!playerId) throw new HttpError(400, 'player_id is required');
  const { data, error } = await sb.from('players').select('*').eq('id', playerId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'player not found');
  const player = data as Player;
  if (player.room_id !== roomId) throw new HttpError(403, 'player is not in this room');
  return player;
}

export async function requireHost(
  sb: SupabaseClient,
  roomId: string,
  playerId: string,
): Promise<{ room: Room; player: Player }> {
  const room = await loadRoom(sb, roomId);
  const player = await requirePlayer(sb, roomId, playerId);
  if (!player.is_host) throw new HttpError(403, 'host only');
  return { room, player };
}

// ---------------------------------------------------------------------------
// Dynamic round controller — resolved on the fly, never stored (playtest bug:
// host = subject used to block the round). Rule: the host controls the round
// while eligible (connected, non-subject, fresh heartbeat); otherwise the
// first connected non-subject by join time takes over. Fallback: the host.
// The SUBJECT never gets flow controls, even when they host the room.
// ---------------------------------------------------------------------------

const CONTROLLER_FRESHNESS_MS = 90_000;

export function controllerEligible(player: Player, subjectId: string, now: number): boolean {
  if (!player.connected || player.id === subjectId) return false;
  const seen = Date.parse(player.last_seen_at);
  // A null/garbage last_seen_at counts as fresh (heartbeat may be absent).
  return Number.isNaN(seen) || now - seen <= CONTROLLER_FRESHNESS_MS;
}

export async function resolveController(sb: SupabaseClient, room: Room, subjectId: string): Promise<Player | null> {
  const { data, error } = await sb
    .from('players')
    .select('*')
    .eq('room_id', room.id)
    .order('created_at', { ascending: true });
  if (error) throw new HttpError(500, error.message);
  const players = (data ?? []) as Player[];
  const now = Date.now();
  const host = players.find((p) => p.is_host);
  if (host && controllerEligible(host, subjectId, now)) return host;
  const firstEligible = players.find((p) => controllerEligible(p, subjectId, now));
  if (firstEligible) return firstEligible;
  return host ?? players[0] ?? null;
}

export async function requireController(
  sb: SupabaseClient,
  roomId: string,
  playerId: string,
): Promise<{ room: Room; player: Player; round: Round }> {
  const room = await loadRoom(sb, roomId);
  const player = await requirePlayer(sb, roomId, playerId);
  const round = await currentRound(sb, room);
  if (!round) throw new HttpError(400, 'no active round');
  const controller = await resolveController(sb, room, round.subject_player_id);
  if (!controller || controller.id !== player.id) throw new HttpError(403, 'round controller only');
  return { room, player, round };
}

/**
 * Shared tail of next-round / skip-subject: deal the next subject a new round,
 * or close the room with the final leaderboard. The skipped/revealed subject
 * is never re-quoted (subject_order_idx only moves forward).
 */
export async function advanceAfterRound(
  sb: SupabaseClient,
  room: Room,
  finishedRound: Round,
): Promise<{ round?: Round; room_status: string; leaderboard?: unknown[] }> {
  const { data: subjectRows } = await sb.from('players').select('*').eq('id', finishedRound.subject_player_id);
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
    return { round: newRound, room_status: 'ROUND_INTRO' };
  }

  const { error: fErr } = await sb.from('rooms').update({ status: 'FINAL_LEADERBOARD' }).eq('id', room.id);
  if (fErr) throw new HttpError(500, fErr.message);

  const { data: rosterRows, error: pErr } = await sb.from('players').select('*').eq('room_id', room.id);
  if (pErr) throw new HttpError(500, pErr.message);
  const roster = (rosterRows ?? []) as Player[];

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

  return { room_status: 'FINAL_LEADERBOARD', leaderboard };
}

/** The room's current round, or null when none exists yet (seq 0 in the lobby). */
export async function currentRound(sb: SupabaseClient, room: Room): Promise<Round | null> {
  const { data, error } = await sb
    .from('rounds')
    .select('*')
    .eq('room_id', room.id)
    .eq('seq', room.current_round_seq)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  return (data as Round | null) ?? null;
}

export async function loadDelivery(sb: SupabaseClient, roundId: string, idx: number): Promise<Delivery> {
  const { data, error } = await sb
    .from('question_deliveries')
    .select('*')
    .eq('round_id', roundId)
    .eq('question_idx', idx)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'question delivery not found');
  return data as Delivery;
}

/** Client-safe question payload: display texts only — never weights/fn/original indexes. */
export function questionPayload(delivery: Delivery): QuestionPayload {
  const question = BANK_BY_ID.get(delivery.question_id);
  return {
    status: 'question',
    idx: delivery.question_idx,
    q: question?.q ?? '',
    options: (delivery.shuffled_options ?? []).map((o) => o.t),
    ends_at: delivery.ends_at,
  };
}

// The per-question window is deliberately far-future: the loop advances when
// everyone connected has voted (or the host forces it). Expiry is only a
// theoretical safety net so a discussion is never cut mid-question.
export const QUESTION_WINDOW_MS = 6 * 60 * 60 * 1000;

// Bump when function contracts change. The frontend warns on mismatch so a
// stale function deploy is VISIBLE (banner) instead of silently breaking flow.
// btm-v3: bank v8.1 (98q) + slot selector v1.5 + vote status names + subject cursor.
export const API_VERSION = 'btm-v4';

/** Anonymous-on-choices vote status for the "waiting for votes" indicator.
 *  Reflects the ROOM only: the subject's private answers are never counted —
 *  they must not influence (or appear to influence) the guessers. WHAT each
 *  guesser picked stays hidden until the reveal; WHETHER they voted is shown
 *  by first name (a party room can nudge its stragglers). */
export async function voteCounts(
  sb: SupabaseClient,
  room: Room,
  round: Round,
  idx: number,
): Promise<{ answered: number; expected: number; voted: string[]; pending: string[]; option_counts: number[] }> {
  const { data: connected } = await sb
    .from('players')
    .select('id, display_name')
    .eq('room_id', room.id)
    .eq('connected', true)
    .neq('id', round.subject_player_id);
  const guessers = (connected ?? []) as Array<{ id: string; display_name: string }>;
  const predictorIds = guessers.map((p) => p.id);
  if (predictorIds.length === 0) return { answered: 0, expected: 0, voted: [], pending: [], option_counts: [0, 0, 0, 0] };
  const { data: preds } = await sb
    .from('predictions')
    .select('player_id, chosen_index')
    .eq('round_id', round.id)
    .eq('question_idx', idx)
    .in('player_id', predictorIds);
  const rows = (preds ?? []) as Array<{ player_id: string; chosen_index: number }>;
  const answeredIds = new Set(rows.map((r) => r.player_id));
  const optionCounts = [0, 0, 0, 0];
  for (const row of rows) {
    if (row.chosen_index >= 0 && row.chosen_index < optionCounts.length) optionCounts[row.chosen_index]++;
  }
  return {
    answered: answeredIds.size,
    expected: predictorIds.length,
    voted: guessers.filter((g) => answeredIds.has(g.id)).map((g) => g.display_name),
    pending: guessers.filter((g) => !answeredIds.has(g.id)).map((g) => g.display_name),
    option_counts: optionCounts,
  };
}

/** Whether the subject has completed their private 12-question questionnaire. */
export async function subjectAnswerProgress(
  sb: SupabaseClient,
  roundId: string,
): Promise<{ answered: number; complete: boolean }> {
  const { data, error } = await sb
    .from('subject_answers')
    .select('question_idx')
    .eq('round_id', roundId);
  if (error) throw new HttpError(500, error.message);
  const answered = new Set(((data ?? []) as Array<{ question_idx: number }>).map((row) => row.question_idx)).size;
  return { answered, complete: answered >= 12 };
}

// ---------------------------------------------------------------------------
// Round creation (shared by start-game and next-round)
// ---------------------------------------------------------------------------

async function collectUsedQuestionIds(sb: SupabaseClient, roomId: string): Promise<Set<number>> {
  const { data, error } = await sb.from('rounds').select('question_ids').eq('room_id', roomId);
  if (error) throw new HttpError(500, error.message);
  const used = new Set<number>();
  for (const row of data ?? []) {
    for (const id of (row.question_ids ?? []) as number[]) used.add(id);
  }
  return used;
}

/**
 * Select 12 unused-biased questions for the room, create the round plus its 12
 * question_deliveries rows, and move the room to ROUND_INTRO / current_round_seq.
 */
export async function createRoundWithDeliveries(
  sb: SupabaseClient,
  room: Room,
  subjectPlayerId: string,
  seq: number,
): Promise<Round> {
  const usedIds = await collectUsedQuestionIds(sb, room.id);
  const selection = selectQuestionsV2(bank, usedIds, mulberry32(hashSeed(`${room.id}:${seq}`)));

  const { data: roundRow, error } = await sb
    .from('rounds')
    .insert({
      room_id: room.id,
      seq,
      subject_player_id: subjectPlayerId,
      question_ids: selection.questions.map((q) => q.id),
      status: 'intro',
      current_question_idx: 0,
    })
    .select()
    .single();
  if (error) throw new HttpError(500, error.message);
  const round = roundRow as Round;

    const deliveries = selection.questions.map((q, i) => {
    const shuffled = shuffleOptions(q, mulberry32(hashSeed(`${round.id}:${i}`)));
    return {
      round_id: round.id,
      question_idx: i,
      question_id: q.id,
      // The option->original mapping lives entirely in shuffled_options ([{i,t}]).
      shuffled_options: shuffled.options,
    };
  });
  const { error: dErr } = await sb.from('question_deliveries').insert(deliveries);
  if (dErr) throw new HttpError(500, dErr.message);

  const { error: rErr } = await sb
    .from('rooms')
    .update({ status: 'ROUND_INTRO', current_round_seq: seq })
    .eq('id', room.id);
  if (rErr) throw new HttpError(500, rErr.message);

  return round;
}
