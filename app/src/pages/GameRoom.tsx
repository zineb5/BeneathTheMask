import { useEffect, useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useGame } from '../store/game';
import { ApiError } from '../lib/api';
import { Lobby } from '../views/Lobby';
import { RoundIntro } from '../views/RoundIntro';
import { QuestionLoop } from '../views/QuestionLoop';
import { RoundReveal } from '../views/RoundReveal';
import { FinalLeaderboard } from '../views/FinalLeaderboard';

export function GameRoom() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const session = useGame((s) => s.session);
  const room = useGame((s) => s.room);
  const attach = useGame((s) => s.attach);
  const leave = useGame((s) => s.leave);
  const error = useGame((s) => s.error);
  const clearError = useGame((s) => s.clearError);
  const connected = useGame((s) => s.connected);
  const backendStale = useGame((s) => s.backendStale);

  const fatalRef = useRef(false);

  useEffect(() => {
    if (!session || session.code !== code || fatalRef.current) return;
    attach(session);
    // A failed first sync usually means the room is gone; send the player
    // back to the landing page rather than leaving them on a dead screen.
    useGame
      .getState()
      .resync()
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400 || err.status === 403)) {
          fatalRef.current = true;
          leave();
          navigate('/', { replace: true });
        }
      });
  }, [session, code, attach, leave, navigate]);

  if (!session || session.code !== code) {
    return <Navigate to={`/?join=${code}`} replace />;
  }

  const isHost = Boolean(room && session.player_id === room.host_player_id);

  return (
    <main className={`view ${isHost ? 'host-mode' : ''}`}>
      <header className="topbar">
        <span className="topbar-code">{code}</span>
        <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`} title={connected ? 'connected' : 'reconnecting…'} />
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            leave();
            navigate('/', { replace: true });
          }}
        >
          Leave
        </button>
      </header>

      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-ghost btn-small" onClick={clearError}>
            dismiss
          </button>
        </p>
      )}

      {backendStale && (
        <p className="form-error" role="alert">
          Backend functions are outdated — redeploy all of them (see README, Setup) and reload.
        </p>
      )}

      {!room ? (
        <p className="waiting">Stepping into the room…</p>
      ) : (
        (() => {
          switch (room.status) {
            case 'LOBBY':
              return <Lobby isHost={isHost} />;
            case 'ROUND_INTRO':
              return <RoundIntro isHost={isHost} />;
            case 'QUESTION_LOOP':
              return <QuestionLoop isHost={isHost} />;
            case 'ROUND_REVEAL':
              return <RoundReveal isHost={isHost} />;
            case 'FINAL_LEADERBOARD':
              return <FinalLeaderboard isHost={isHost} />;
          }
        })()
      )}
    </main>
  );
}
