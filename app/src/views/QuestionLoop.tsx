import { useEffect } from 'react';
import { useGame, TOTAL_QUESTIONS } from '../store/game';
import { Dots } from '../components/atoms';
import { personalize } from '../lib/types';

const LETTERS = ['A', 'B', 'C', 'D'];

export function QuestionLoop({ isHost }: { isHost: boolean }) {
  const question = useGame((s) => s.question);
  const players = useGame((s) => s.players);
  const round = useGame((s) => s.round);
  const session = useGame((s) => s.session);
  const myAnswers = useGame((s) => s.myAnswers);
  const momentum = useGame((s) => s.momentum);
  const submitAnswer = useGame((s) => s.submitAnswer);
  const advance = useGame((s) => s.advance);
  const subjectStep = useGame((s) => s.subjectStep);

  // Light poll while the question loop runs: the vote tally is computed
  // server-side and votes don't touch any published table, so resync every
  // few seconds keeps "waiting for votes (n/m)" honest for everyone.
  useEffect(() => {
    const id = setInterval(() => {
      void useGame.getState().resync().catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const subject = players.find((p) => p.id === round?.subject_player_id);
  const amSubject = Boolean(subject && session && subject.id === session.player_id);
  const firstName = subject?.display_name.split(' ')[0] ?? 'they';

  if (!question) {
    return (
      <div className="question-loop">
        <p className="waiting">Unrolling the next question…</p>
      </div>
    );
  }

  const text = personalize(question.q, firstName);
  const selected = myAnswers[question.idx];
  const locked = selected !== undefined && selected >= 0;
  const answered = question.answered;
  const expected = question.expected;
  const tally = typeof answered === 'number' && typeof expected === 'number';
  const allGuessesIn = tally && expected > 0 && answered >= expected;
  const canSeeGauge = isHost || amSubject;

  return (
    <div className="question-loop">
      <div className="q-top">
        <Dots total={TOTAL_QUESTIONS} current={question.idx} />
        <span className="vote-tally" aria-live="polite">
          {tally ? `Waiting for votes (${answered}/${expected})` : 'Waiting for votes…'}
        </span>
      </div>

      {(question.voted?.length || question.pending?.length) && (
        <div className="vote-status" aria-label="who has voted">
          {question.voted && question.voted.length > 0 && (
            <span className="vote-group vote-group-done">
              {question.voted.map((n) => (
                <span key={n} className="vote-chip vote-chip-done">✓ {n}</span>
              ))}
            </span>
          )}
          {question.pending && question.pending.length > 0 && (
            <span className="vote-group vote-group-waiting">
              {question.pending.map((n) => (
                <span key={n} className="vote-chip vote-chip-waiting">⏳ {n}</span>
              ))}
            </span>
          )}
        </div>
      )}

      <p className="eyebrow">{amSubject ? 'You are the subject' : `Predicting ${subject?.display_name ?? '…'}`}</p>
      <h1 className="q-prompt">
        {amSubject
          ? 'Answer for yourself — nobody sees your picks until the reveal. Take your time; you move at your own pace.'
          : `What will ${firstName} pick?`}
      </h1>

      <p className="q-text">{text}</p>

      <div className="options" role="group" aria-label="answer options">
        {question.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            className={`option ${selected === i ? 'option-selected' : ''}`}
            onClick={() => void submitAnswer(i)}
          >
            <span className="option-letter">{LETTERS[i]}</span>
            <span className="option-text">{personalize(opt, firstName)}</span>
          </button>
        ))}
      </div>

      {locked && <p className="locked-note">🔒 Answer locked — tap another to change it.</p>}

      {amSubject && (
        <div className="subject-nav">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={question.idx === 0}
            onClick={() => void subjectStep(-1)}
          >
            ← Previous
          </button>
          <span className="subject-roompos">
            the room is on question {(question.room_idx ?? question.idx) + 1} of {TOTAL_QUESTIONS}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={question.idx >= TOTAL_QUESTIONS - 1}
            onClick={() => void subjectStep(1)}
          >
            Next question →
          </button>
        </div>
      )}

      {/* Choice leanings are visible to the host and the subject only. The
          subject is physically separated from the room, so no herding risk;
          guessers never see leanings (nor the subject's answers). */}
      {canSeeGauge && (
        <aside className="momentum" aria-label="anonymous momentum">
          <p className="momentum-label">the room is leaning…</p>
          <div className="momentum-bars">
            {question.options.map((_, i) => {
              const count = momentum[i] ?? 0;
              const max = Math.max(1, ...question.options.map((__, j) => momentum[j] ?? 0));
              return (
                <div key={i} className="momentum-row">
                  <span className="momentum-letter">{LETTERS[i]}</span>
                  <span className="momentum-track">
                    <span className="momentum-fill" style={{ width: `${(count / max) * 100}%` }} />
                  </span>
                  <span className="momentum-count">{count}</span>
                </div>
              );
            })}
          </div>
          {isHost && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!allGuessesIn}
                onClick={() => void advance()}
              >
                {allGuessesIn ? 'Next question' : 'Waiting for all guesses'}
              </button>
              {!allGuessesIn && (
                <button type="button" className="btn btn-ghost" onClick={() => void advance(true)}>
                  Skip unanswered
                </button>
              )}
            </>
          )}
        </aside>
      )}

      {isHost && allGuessesIn && question.subject_complete === false && (
        <p className="locked-note">The group is ready. Waiting for the subject to finish their private answers.</p>
      )}

      {amSubject && typeof question.subject_answered === 'number' && (
        <p className="locked-note">Your private answers: {question.subject_answered}/{TOTAL_QUESTIONS}</p>
      )}
    </div>
  );
}
