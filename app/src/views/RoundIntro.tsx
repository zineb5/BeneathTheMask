import { useGame } from '../store/game';
import { Avatar } from '../components/atoms';

export function RoundIntro({ isHost }: { isHost: boolean }) {
  const players = useGame((s) => s.players);
  const round = useGame((s) => s.round);
  const beginQuestions = useGame((s) => s.beginQuestions);

  const subject = players.find((p) => p.id === round?.subject_player_id);

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
      {isHost && (
        <button type="button" className="btn btn-primary btn-big" onClick={() => void beginQuestions()}>
          Ask the first question
        </button>
      )}
    </div>
  );
}
