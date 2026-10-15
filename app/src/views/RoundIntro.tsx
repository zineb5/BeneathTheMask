import { useGame } from '../store/game';
import { Avatar } from '../components/atoms';
import { resolveControllerId } from '../lib/types';

export function RoundIntro({ isHost: _ignored }: { isHost: boolean }) {
  const players = useGame((s) => s.players);
  const round = useGame((s) => s.round);
  const session = useGame((s) => s.session);
  const beginQuestions = useGame((s) => s.beginQuestions);

  const subject = players.find((p) => p.id === round?.subject_player_id);
  // start-round requires the round controller (dynamic rule, mirrored from the
  // players list). The subject never gets flow controls, even as room host.
  const controllerId = resolveControllerId(players, subject?.id ?? null);
  const isController = Boolean(session && controllerId && session.player_id === controllerId) && subject?.id !== session?.player_id;

  return (
    <div className="round-intro">
      <p className="eyebrow">Round {round?.seq ?? ''}</p>
      {subject ? (
        <>
          <div className="intro-avatar">
            <Avatar masked size={140} hue={subject.hue} />
          </div>
          <h1 className="intro-headline">
            This round, everyone predicts <span style={{ color: subject.hue }}>{subject.display_name}</span>
          </h1>
          <p className="muted">
            {subject.display_name} answers for themselves. Everyone else tries to get inside their head.
          </p>
        </>
      ) : (
        <p className="muted">Drawing the next subject…</p>
      )}
      {isController && (
        <button type="button" className="btn btn-primary btn-big" onClick={() => void beginQuestions()}>
          Ask the first question
        </button>
      )}
    </div>
  );
}
