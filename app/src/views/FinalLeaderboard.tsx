import { useNavigate } from 'react-router-dom';
import { useGame } from '../store/game';
import { Avatar, Medal } from '../components/atoms';
import type { LeaderboardEntry } from '../lib/types';

export function FinalLeaderboard({ isHost }: { isHost: boolean }) {
  const players = useGame((s) => s.players);
  const leaderboard = useGame((s) => s.leaderboard);
  const leave = useGame((s) => s.leave);
  const navigate = useNavigate();

  const entries: LeaderboardEntry[] =
    leaderboard && leaderboard.length > 0
      ? [...leaderboard].sort(compareEntries)
      : players
          .map((p) => ({
            player_id: p.id,
            display_name: p.display_name,
            hue: p.hue,
            avatar_variant: p.avatar_variant,
            total_score: p.total_score,
            best_predictor_badges: p.best_predictor_badges,
          }))
          .sort(compareEntries);

  const winner = entries[0];
  const tieAtTop = entries.length > 1 && entries[1].total_score === winner?.total_score;

  return (
    <div className="final-board">
      <p className="eyebrow">Final leaderboard</p>
      {winner && (
        <h1 className="winner-headline">
          <span style={{ color: winner.hue }}>{winner.display_name}</span> knows this group best
        </h1>
      )}
      {tieAtTop && <p className="muted">Dead heat — ties break on best-predictor badges, then who joined first.</p>}

      <ol className="board">
        {entries.map((entry, i) => (
          <li key={entry.player_id} className={`board-row ${i === 0 ? 'board-row-top' : ''}`}>
            <span className="board-rank">{i + 1}</span>
            <span className="avatar-ring" style={{ boxShadow: `0 0 0 2px ${entry.hue}` }}>
              <Avatar masked size={38} />
            </span>
            <span className="board-name">{entry.display_name}</span>
            <Medal count={entry.best_predictor_badges} />
            <span className="board-score">{entry.total_score}</span>
          </li>
        ))}
      </ol>

      <p className="muted">Same mask, next time? Start a fresh room.</p>
      <button
        type="button"
        className="btn btn-primary btn-big"
        onClick={() => {
          leave();
          navigate('/');
        }}
      >
        Play again
      </button>
      {!isHost && <p className="muted">That’s a wrap — thanks for playing.</p>}
    </div>
  );
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (b.total_score !== a.total_score) return b.total_score - a.total_score;
  if (b.best_predictor_badges !== a.best_predictor_badges) return b.best_predictor_badges - a.best_predictor_badges;
  return a.display_name.localeCompare(b.display_name);
}
