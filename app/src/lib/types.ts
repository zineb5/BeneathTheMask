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
  last_seen_at: string;
  created_at: string;
}

export interface Round {
  id: string;
  room_id: string;
  seq: number;
  subject_player_id: string;
  question_ids: number[];
  status: 'intro' | 'question_loop' | 'reveal' | 'SKIPPED';
  current_question_idx: number;
  /** the subject's private cursor (their own questionnaire navigation). */
  subject_idx: number | null;
}

/** Exact mirror of the backend's dynamic round-controller rule
 *  (requireController in _shared/client.ts): the host controls the round while
 *  eligible (connected, non-subject, fresh heartbeat), else the first
 *  connected non-subject by join time. Fallback: the host. Never the subject. */
export const CONTROLLER_FRESHNESS_MS = 90_000;

export function resolveControllerId(players: Player[], subjectId: string | null): string | null {
  const fresh = (p: Player): boolean => {
    if (!p.connected || p.id === subjectId) return false;
    const seen = Date.parse(p.last_seen_at);
    return Number.isNaN(seen) || Date.now() - seen <= CONTROLLER_FRESHNESS_MS;
  };
  const byJoin = [...players].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const host = byJoin.find((p) => p.is_host);
  if (host && fresh(host)) return host.id;
  return byJoin.find(fresh)?.id ?? host?.id ?? null;
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

/** Engine v2.4.7 additions, additive keys inside per_axis (no schema change). */
export interface V2AxisExtras {
  /** undecided axes where process evidence tipped the letter (spec §2). */
  tipped_axes?: Array<{ axis: Axis; selected: string; evidencePole: string; label: string }>;
  /** candidates under 0.05 probability — recoverable, listed honestly. */
  unlikely?: string[];
  /** group vote consensus 1 - H/log2(K); value 0 when nobody voted (spec §5). */
  consensus?: { value: number; per_question: number[] };
  /** Beat 1 order: function pattern first when confidence is Low (spec §6). */
  presentation?: 'function_first' | 'archetype_first';
  top_functions?: Array<{ fn: string; weight: number }>;
  /** the 4 signal constructs the route declared at build (spec §1 review 14). */
  route_targets?: string[];
}

export interface RoundResult {
  round_id: string;
  per_player_correct: Record<string, number>;
  best_predictor_player_id: string | null;
  group_type: string | null;
  subject_type: string;
  per_axis: { subject: PerAxisVotes; group: PerAxisVotes } & V2AxisExtras;
  analyzer: AnalyzerEntry[];
  group_accuracy: { correct: number; total: number };
  /** One point for the subject when the group infers a different MBTI type. */
  subject_bonus?: number;
  /** +1 for EVERY guesser when the group's inferred type matched the subject's. */
  group_bonus?: number;
  /** Engine v2: candidate probabilities (top-2) from the softmax distribution. */
  top2?: Array<{ type: string; score: number }>;
  /** Engine v2 §7: 0.65*margin + 0.20*coverage + 0.15*reliability - penalty. */
  type_confidence?: number;
  group_top2?: Array<{ type: string; score: number }>;
  group_type_confidence?: number;
  /** "Also suspected" — surviving candidates >= 0.05, best runner-ups first. */
  alternates?: string[];
  /** Engine v2 confidence band (Low < 0.40 | Moderate 0.40-0.69 | High >= 0.70). */
  confidence?: 'Low' | 'Moderate' | 'High';
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
