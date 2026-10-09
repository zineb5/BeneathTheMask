// Shared row / payload shapes for the Beneath the Mask backend contract.
// All row IDs are UUID strings (Supabase gen_random_uuid()).

export type RoomStatus =
  | 'LOBBY'
  | 'ROUND_INTRO'
  | 'QUESTION_LOOP'
  | 'ROUND_REVEAL'
  | 'FINAL_LEADERBOARD';

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  current_round_seq: number;
  question_timer_s: number;
  subjects_limit: number | null;
  host_player_id: string;
}

export interface Player {
  id: string;
  room_id: string;
  display_name: string;
  hue: string;
  avatar_variant: 'F' | 'M';
  is_host: boolean;
  total_score: number;
  best_predictor_badges: number;
  subject_order_idx: number | null;
  connected: boolean;
}

export interface Round {
  id: string;
  room_id: string;
  seq: number;
  subject_player_id: string;
  question_ids: number[];
  status: 'intro' | 'question_loop' | 'reveal';
  current_question_idx: number;
  /** the subject's private cursor (their own questionnaire navigation). */
  subject_idx: number | null;
}

export type Axis = 'EI' | 'SN' | 'TF' | 'JP';

export interface AnalyzerFn {
  fn: string;
  score: number;
}

export interface AnalyzerEntry {
  axis: Axis;
  subjectLetter: string;
  groupLetter: string;
  mismatches: number;
  subjectFns: AnalyzerFn[];
  groupFns: AnalyzerFn[];
  copy: string;
}

export interface PerAxisVotes {
  EI: [number, number];
  SN: [number, number];
  TF: [number, number];
  JP: [number, number];
}

export interface RoundResult {
  round_id: string;
  per_player_correct: Record<string, number>;
  best_predictor_player_id: string | null;
  group_type: string | null;
  subject_type: string;
  per_axis: { subject: PerAxisVotes; group: PerAxisVotes };
  analyzer: AnalyzerEntry[];
  group_accuracy: { correct: number; total: number };
  /** One point for the subject when the group infers a different MBTI type. */
  subject_bonus?: number;
  /** +1 for EVERY guesser when the group's inferred type matched the subject's. */
  group_bonus?: number;
  /** Engine v2: 16-type subject ranking and its normalized top-two margin. */
  top2?: Array<{ type: string; score: number }>;
  type_confidence?: number;
  group_top2?: Array<{ type: string; score: number }>;
  group_type_confidence?: number;
  /** runner-up types (weakest-axis flips) + how confidently the mask fit. */
  alternates?: string[];
  confidence?: 'high' | 'medium' | 'low';
  revealed_at: string | null;
}

export interface LeaderboardEntry {
  player_id: string;
  display_name: string;
  hue: string;
  avatar_variant: 'F' | 'M';
  total_score: number;
  best_predictor_badges: number;
}

export interface Session {
  player_id: string;
  room_id: string;
  code: string;
}

// ---- Question payloads -------------------------------------------------

export interface ActiveQuestion {
  idx: number;
  q: string;
  options: string[];
  ends_at: string;
  /** the room's position — differs from idx when the subject browses ahead/behind. */
  room_idx?: number;
  /** vote status of the ROOM (subject excluded): counts + who voted / who's pending.
   *  Choices stay hidden until the reveal — names only. */
  answered?: number;
  expected?: number;
  voted?: string[];
  pending?: string[];
  /** Anonymous group totals, visible only to the host and subject. */
  option_counts?: number[];
  /** Private questionnaire progress, visible only to the host and subject. */
  subject_answered?: number;
  subject_complete?: boolean;
}

export interface AdvanceOk {
  status: 'question';
  idx: number;
  q: string;
  options: string[];
  ends_at: string;
  room_idx?: number;
  answered?: number;
  expected?: number;
  voted?: string[];
  pending?: string[];
  option_counts?: number[];
  subject_answered?: number;
  subject_complete?: boolean;
}

export interface AdvanceReveal {
  status: 'reveal';
}

export type AdvanceResponse = AdvanceOk | AdvanceReveal;

/** ends_at may be an ISO string or epoch millis. */
export function endsAtMs(endsAt: string | number | null | undefined): number {
  if (endsAt == null) return 0;
  if (typeof endsAt === 'number') return endsAt;
  const asNum = Number(endsAt);
  if (Number.isFinite(asNum) && /^\d+$/.test(endsAt)) return asNum;
  const parsed = Date.parse(endsAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Replace the bank's subject placeholder "X" (incl. possessive "X's") with a name,
 *  in questions AND options. 3rd person is kept for everyone — even the subject,
 *  who reads themselves as "Zizou keeps it" (funnier, and no conjugation issues). */
export function personalize(text: string, name: string): string {
  return text.replace(/\bX('s)?\b/g, (m) => (m.endsWith("'s") ? `${name}'s` : name));
}
