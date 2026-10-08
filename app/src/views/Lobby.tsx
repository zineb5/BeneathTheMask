import { useGame } from '../store/game';
import { Avatar, Crown } from '../components/atoms';

export function Lobby({ isHost }: { isHost: boolean }) {
  const room = useGame((s) => s.room);
  const players = useGame((s) => s.players);
  const prefs = useGame((s) => s.prefs);
  const setPrefs = useGame((s) => s.setPrefs);
  const startGame = useGame((s) => s.startGame);
  const connected = useGame((s) => s.connected);

  if (!room) return null;
  const canStart = players.length >= 2;

  return (
    <div className="lobby">
      <p className="eyebrow">Room code</p>
      <div className="room-code" aria-label={`room code ${room.code}`}>
        {room.code.split('').map((c, i) => (
          <span key={i} className="room-code-char">
            {c}
          </span>
        ))}
      </div>
      <p className="muted">
        Everyone joins at this URL on their phone. {players.length}/10 players in.
      </p>

      <ul className="chips" aria-label="players">
        {players.map((p) => (
          <li key={p.id} className={`chip ${p.connected ? '' : 'chip-away'}`}>
            <span className="avatar-ring" style={{ boxShadow: `0 0 0 2px ${p.hue}` }}>
              <Avatar masked size={34} />
            </span>
            <span className="chip-name">{p.display_name}</span>
            {p.is_host && <Crown />}
            {!p.connected && <span className="chip-status">away</span>}
          </li>
        ))}
      </ul>

      {isHost ? (
        <div className="lobby-controls">
          <label className="field">
            <span className="field-label">Subjects this game</span>
            <select
              value={prefs.subjects_limit == null ? 'all' : String(prefs.subjects_limit)}
              onChange={(e) =>
                setPrefs({ subjects_limit: e.target.value === 'all' ? null : Number(e.target.value) })
              }
            >
              <option value="all">Everyone ({players.length})</option>
              {[2, 3, 4, 5, 6, 7, 8, 9].map(
                (n) =>
                  n <= players.length && (
                    <option key={n} value={n}>
                      {n} subjects
                    </option>
                  ),
              )}
            </select>
            <span className="field-hint">Plan roughly 12 minutes per subject.</span>
          </label>

          <button type="button" className="btn btn-primary btn-big" disabled={!canStart} onClick={() => void startGame()}>
            {canStart ? 'Start the game' : 'Waiting for one more player'}
          </button>
          {!connected && <p className="muted">Reconnecting…</p>}
        </div>
      ) : (
        <p className="waiting">Waiting for the host to start…</p>
      )}
    </div>
  );
}
