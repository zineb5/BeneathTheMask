// Central game store: session, room state, realtime channel, and every
// backend action. One channel per room, created here, driving all
// transitions via postgres_changes + broadcast events.

import { create } from 'zustand';
import { call, loadSession, saveSession, clearSession, hasSupabaseEnv } from '../lib/api';
import { getRealtimeClient, type RealtimeChannel } from '../lib/realtime';
import type {
  ActiveQuestion,
  AdvanceResponse,
  LeaderboardEntry,
  Player,
  Room,
  Round,
  RoundResult,
  Session,
} from '../lib/types';

const HEARTBEAT_MS = 12_000;
const TOTAL_QUESTIONS = 12;
// Must match supabase/functions/_shared/client.ts API_VERSION. The backend
// echoes it in every response; a missing/mismatched value means the deployed
// functions are stale — the game shows a banner instead of failing silently.
export const EXPECTED_API_VERSION = 'btm-v4';

export interface Prefs {
  question_timer_s: number;
  subjects_limit: number | null;
}

interface SyncResponse {
  room: Room;
  players: Player[];
  round?: Round | null;
  question?: {
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
  } | null;
  my_answers?: number[];
  results?: RoundResult | null;
  version?: string;
}

interface CreateResponse {
  room: Room;
  player: Player;
}

interface JoinResponse extends CreateResponse {
  players: Player[];
}

interface StartRoundResponse {
  round_id: string;
  idx: number;
  ends_at: string;
}

interface NextRoundResponse {
  round?: Round | null;
  room_status: Room['status'];
  leaderboard?: LeaderboardEntry[];
}

interface ComputeRevealResponse {
  result: RoundResult;
}

interface GameState {
  session: Session | null;
  room: Room | null;
  players: Player[];
  round: Round | null;
  question: ActiveQuestion | null;
  myAnswers: number[];
  results: RoundResult | null;
  leaderboard: LeaderboardEntry[] | null;
  beat: number;
  momentum: Record<number, number>;
  connected: boolean;
  backendStale: boolean;
  error: string | null;
  notice: string | null;
  prefs: Prefs;

  bootstrap: () => void;
  createRoom: (input: { display_name: string; hue: string; avatar_variant: 'F' | 'M' }) => Promise<Session>;
  joinRoom: (code: string, input: { display_name: string; hue: string; avatar_variant: 'F' | 'M' }) => Promise<Session>;
  attach: (session: Session) => void;
  detach: () => void;
  resync: () => Promise<void>;
  leave: () => void;

  setPrefs: (prefs: Partial<Prefs>) => void;
  clearError: () => void;
  dismissNotice: () => void;
  noteBackendVersion: (version: string | undefined) => void;

  startGame: () => Promise<void>;
  beginQuestions: () => Promise<void>;
  advance: (force?: boolean) => Promise<void>;
  subjectStep: (delta: number) => Promise<void>;
  submitAnswer: (chosen: number) => Promise<void>;
  computeReveal: () => Promise<void>;
  nextRound: () => Promise<void>;
  sendBeat: (beat: number) => void;
}

let channel: RealtimeChannel | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let advancing = false;
let fallbackAdvancedRoundId: string | null = null;
let revealComputingRoundId: string | null = null;

const DEFAULT_PREFS: Prefs = { question_timer_s: 40, subjects_limit: null };

function normalizeQuestion(
  raw: SyncResponse['question'] | AdvanceResponse,
): ActiveQuestion | null {
  if (raw && typeof raw === 'object' && 'status' in raw) {
    if (raw.status !== 'question') return null;
    return {
      idx: raw.idx,
      q: raw.q,
      options: raw.options,
      ends_at: raw.ends_at,
      room_idx: raw.room_idx,
      answered: raw.answered,
      expected: raw.expected,
      voted: raw.voted,
      pending: raw.pending,
      option_counts: raw.option_counts,
      subject_answered: raw.subject_answered,
      subject_complete: raw.subject_complete,
    };
  }
  if (raw && typeof raw === 'object' && 'options' in raw && raw.options) {
    const q = raw as {
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
    };
    return {
      idx: q.idx,
      q: q.q,
      options: q.options,
      ends_at: q.ends_at,
      room_idx: q.room_idx,
      answered: q.answered,
      expected: q.expected,
      voted: q.voted,
      pending: q.pending,
      option_counts: q.option_counts,
      subject_answered: q.subject_answered,
      subject_complete: q.subject_complete,
    };
  }
  return null;
}

export const useGame = create<GameState>()((set, get) => ({
  session: loadSession(),
  room: null,
  players: [],
  round: null,
  question: null,
  myAnswers: [],
  results: null,
  leaderboard: null,
  beat: 1,
  momentum: {},
  connected: false,
  backendStale: false,
  error: null,
  notice: null,
  prefs: DEFAULT_PREFS,

  bootstrap: () => {
    set({ session: loadSession() });
  },

  createRoom: async (input) => {
    const { prefs } = get();
    const data = await call<CreateResponse>('create-room', {
      ...input,
      question_timer_s: prefs.question_timer_s,
      subjects_limit: prefs.subjects_limit,
    });
    const session: Session = { player_id: data.player.id, room_id: data.room.id, code: data.room.code };
    saveSession(session);
    set({ session, room: data.room, players: [data.player], error: null });
    get().attach(session);
    return session;
  },

  joinRoom: async (code, input) => {
    const data = await call<JoinResponse>('join-room', { code: code.toUpperCase().trim(), ...input });
    const session: Session = { player_id: data.player.id, room_id: data.room.id, code: data.room.code };
    saveSession(session);
    set({ session, room: data.room, players: data.players, error: null });
    get().attach(session);
    return session;
  },

  attach: (session) => {
    get().detach();
    fallbackAdvancedRoundId = null;
    revealComputingRoundId = null;

    const client = getRealtimeClient();
    if (!client) {
      // No env vars (e.g. local compile check): poll with plain sync-state.
      set({ connected: hasSupabaseEnv ? false : true });
      heartbeatTimer = setInterval(() => {
        void get().resync().catch(() => undefined);
      }, HEARTBEAT_MS);
      void get().resync().catch(() => undefined);
      return;
    }

    channel = client
      .channel(`room:${session.code}`, { config: { broadcast: { self: false } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (payload) => {
        const room = payload.new as Room | undefined;
        if (room && room.id === session.room_id) {
          set({ room });
          if (room.status === 'LOBBY') {
            set({ round: null, question: null, results: null, beat: 1, momentum: {}, leaderboard: null });
          } else {
            void get().resync().catch(() => undefined);
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, (payload) => {
        const player = payload.new as Player | undefined;
        if (!player || player.room_id !== session.room_id) return;
        set((state) => {
          const others = state.players.filter((p) => p.id !== player.id);
          const byOrder = (a: Player, b: Player) =>
            (a.subject_order_idx ?? Number.MAX_SAFE_INTEGER) - (b.subject_order_idx ?? Number.MAX_SAFE_INTEGER);
          return { players: [...others, player].sort(byOrder) };
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds' }, (payload) => {
        const round = payload.new as Round | undefined;
        if (round && round.room_id === session.room_id) {
          void get().resync().catch(() => undefined);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'round_results' }, (payload) => {
        const result = payload.new as RoundResult | undefined;
        if (result && result.revealed_at) {
          void get().resync().catch(() => undefined);
        }
      })
      .on('broadcast', { event: 'momentum' }, ({ payload }) => {
        const p = payload as { q?: number; opt?: number } | undefined;
        const { question } = get();
        if (!p || typeof p.q !== 'number' || typeof p.opt !== 'number') return;
        if (!question || p.q !== (question.room_idx ?? question.idx)) return;
        set((state) => {
          const next = { ...state.momentum };
          next[p.opt as number] = (next[p.opt as number] ?? 0) + 1;
          return { momentum: next };
        });
      })
      .on('broadcast', { event: 'beat' }, ({ payload }) => {
        const p = payload as { beat?: number } | undefined;
        if (p && typeof p.beat === 'number' && p.beat >= 1 && p.beat <= 3) {
          set({ beat: p.beat });
        }
      })
      .subscribe((status) => {
        set({ connected: status === 'SUBSCRIBED' });
      });

    heartbeatTimer = setInterval(() => {
      call('heartbeat', { room_id: session.room_id, player_id: session.player_id }).catch(() => undefined);
    }, HEARTBEAT_MS);
  },

  detach: () => {
    if (channel) {
      const client = getRealtimeClient();
      if (client) void client.removeChannel(channel);
      channel = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    set({ connected: false });
  },

  resync: async () => {
    const { session, round } = get();
    if (!session) return;
    const data = await call<SyncResponse>('sync-state', {
      room_id: session.room_id,
      player_id: session.player_id,
    });
    get().noteBackendVersion(data.version);

    const nextRound = data.room.status === 'LOBBY' ? null : (data.round ?? null);
    const question = normalizeQuestion(data.question);
    const results = data.results ?? (nextRound && nextRound.id === round?.id ? get().results : null);

    const roundChanged = nextRound?.id !== round?.id;
    const nextBeat = roundChanged || data.room.status !== 'ROUND_REVEAL' ? 1 : get().beat;
    const momentum = question?.option_counts
      ? Object.fromEntries(question.option_counts.map((count, index) => [index, count]))
      : question && question.idx !== get().question?.idx ? {} : get().momentum;

    set({
      room: data.room,
      players: data.players,
      round: nextRound,
      question,
      myAnswers: data.my_answers ?? [],
      results,
      beat: nextBeat,
      momentum,
    });

    // Fallback: question loop active but the server never handed us a question
    // (e.g. start-round only flips status). The host fetches it once.
    if (
      data.room.status === 'QUESTION_LOOP' &&
      !question &&
      nextRound &&
      session.player_id === data.room.host_player_id &&
      fallbackAdvancedRoundId !== nextRound.id &&
      !advancing
    ) {
      fallbackAdvancedRoundId = nextRound.id;
      await get().advance();
    }

    // A guesser may be the client that switches the room to ROUND_REVEAL.
    // Always let the host finish the server-side calculation when it notices
    // that transition, rather than leaving every screen at "Tallying".
    if (
      data.room.status === 'ROUND_REVEAL' &&
      nextRound &&
      !results &&
      session.player_id === data.room.host_player_id &&
      revealComputingRoundId !== nextRound.id &&
      !advancing
    ) {
      revealComputingRoundId = nextRound.id;
      void get().computeReveal().finally(() => {
        revealComputingRoundId = null;
      });
    }
  },

  leave: () => {
    get().detach();
    clearSession();
    set({
      session: null,
      room: null,
      players: [],
      round: null,
      question: null,
      myAnswers: [],
      results: null,
      leaderboard: null,
      beat: 1,
      momentum: {},
      error: null,
      notice: null,
    });
  },

  setPrefs: (prefs) => {
    set((state) => ({ prefs: { ...state.prefs, ...prefs } }));
    // Best-effort: the parallel backend may expose update-room; if it does
    // not, lobby edits simply stay local (applied on room creation).
    const { session, room, prefs: next } = get();
    if (!session || !room || session.player_id !== room.host_player_id) return;
    call('update-room', {
      room_id: session.room_id,
      player_id: session.player_id,
      question_timer_s: next.question_timer_s,
      subjects_limit: next.subjects_limit,
    }).catch(() => undefined);
  },

  clearError: () => set({ error: null }),
  dismissNotice: () => set({ notice: null }),
  noteBackendVersion: (version) => {
    if (!version || version !== EXPECTED_API_VERSION) {
      set({ backendStale: true });
    }
  },

  startGame: async () => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      await call('start-game', { room_id: session.room_id, player_id: session.player_id });
      await get().resync();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not start the game.' });
    } finally {
      advancing = false;
    }
  },

  beginQuestions: async () => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      await call<StartRoundResponse>('start-round', {
        room_id: session.room_id,
        player_id: session.player_id,
      });
      await get().resync();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not start the questions.' });
    } finally {
      advancing = false;
    }
  },

  advance: async (force = false) => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      const data = await call<AdvanceResponse>('advance-question', {
        room_id: session.room_id,
        player_id: session.player_id,
        ...(force ? { force: true } : {}),
      });
      get().noteBackendVersion((data as { version?: string }).version);
      if (data.status === 'reveal') {
        const { room } = get();
        if (room && room.host_player_id === session.player_id) {
          await get().computeReveal();
        }
        await get().resync();
      } else {
        await get().resync();
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not load the next question.' });
    } finally {
      advancing = false;
    }
  },

  subjectStep: async (delta) => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      const data = await call<AdvanceResponse>('subject-step', {
        room_id: session.room_id,
        player_id: session.player_id,
        delta,
      });
      get().noteBackendVersion((data as { version?: string }).version);
      if (data.status === 'question') {
        set({ question: normalizeQuestion(data), momentum: {} });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not move to the next question.' });
    } finally {
      advancing = false;
    }
  },

  submitAnswer: async (chosen) => {
    const { session, question } = get();
    if (!session || !question) return;
    try {
      const data = await call<{ ok: boolean; reason?: string; version?: string }>('submit-answer', {
        room_id: session.room_id,
        player_id: session.player_id,
        question_idx: question.idx,
        chosen_index: chosen,
      });
      get().noteBackendVersion(data.version);
      if (!data.ok) {
        set({ notice: data.reason ?? 'Answer was not accepted.' });
        return;
      }
      set((state) => {
        const myAnswers = [...state.myAnswers];
        while (myAnswers.length <= question.idx) myAnswers.push(-1);
        myAnswers[question.idx] = chosen;
        return { myAnswers };
      });
      // Read the server-derived, anonymous option totals immediately. Unlike
      // a realtime browser broadcast this survives reconnects and reflects
      // every player's vote, not just the latest client event.
      void get().resync().catch(() => undefined);
      // Self-driving loop: this vote may complete the room — ask the server to
      // advance. No-op until every connected guesser has voted (the subject's
      // private answer never gates the room).
      // The shared screen advances only when the host chooses to move on.
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not submit your answer.' });
    }
  },

  computeReveal: async () => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      const data = await call<ComputeRevealResponse>('compute-reveal', {
        room_id: session.room_id,
        player_id: session.player_id,
      });
      set({ results: data.result });
      await get().resync();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not compute the reveal.' });
    } finally {
      advancing = false;
    }
  },

  nextRound: async () => {
    const { session } = get();
    if (!session || advancing) return;
    advancing = true;
    try {
      const data = await call<NextRoundResponse>('next-round', {
        room_id: session.room_id,
        player_id: session.player_id,
      });
      if (data.leaderboard) set({ leaderboard: data.leaderboard });
      set({ beat: 1, momentum: {}, results: null, question: null });
      await get().resync();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not advance the game.' });
    } finally {
      advancing = false;
    }
  },

  sendBeat: (beat) => {
    if (channel) {
      set({ beat });
      void channel.send({ type: 'broadcast', event: 'beat', payload: { beat } });
    } else {
      set({ beat });
    }
  },
}));

export { TOTAL_QUESTIONS };
