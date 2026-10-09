import { useState } from 'react';
import { useGame, TOTAL_QUESTIONS } from '../store/game';
import { Avatar } from '../components/atoms';
import { typeContent, UNOFFICIAL_NOTE } from '../content/types';
import type { Axis } from '../lib/types';
import { downloadShareCard } from '../share/card';

const AXES: Axis[] = ['EI', 'SN', 'TF', 'JP'];
const AXIS_LETTERS: Record<Axis, [string, string]> = {
  EI: ['E', 'I'],
  SN: ['S', 'N'],
  TF: ['T', 'F'],
  JP: ['J', 'P'],
};
const DISCLAIMER =
  'Beneath the Mask is a party game, not a clinical instrument. If you want the serious answer, take the official test.';

export function RoundReveal({ isHost }: { isHost: boolean }) {
  const results = useGame((s) => s.results);
  const players = useGame((s) => s.players);
  const round = useGame((s) => s.round);
  const beat = useGame((s) => s.beat);
  const sendBeat = useGame((s) => s.sendBeat);
  const nextRound = useGame((s) => s.nextRound);

  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(false);

  if (!results || !results.revealed_at) {
    return (
      <div className="reveal">
        <p className="waiting">Tallying the mask…</p>
      </div>
    );
  }

  const subject = players.find((p) => p.id === round?.subject_player_id);
  const subjectContent = typeContent(results.subject_type);
  const groupContent = typeContent(results.group_type ?? results.subject_type);
  const typesDiffer = results.group_type !== null && results.subject_type !== results.group_type;
  const bestPredictor = players.find((p) => p.id === results.best_predictor_player_id);
  const bestScore = bestPredictor ? (results.per_player_correct[String(bestPredictor.id)] ?? 0) : 0;
  // "Also suspected" runner-ups: 1 when the mask fit confidently, 3 when it was loose.
  const altCount = results.confidence === 'high' ? 1 : results.confidence === 'low' ? 3 : 2;
  const alternatesToShow = (results.alternates ?? []).slice(0, altCount);

  const share = () => {
    if (!subject) return;
    setSharing(true);
    setShareError(false);
    downloadShareCard({
      type: subjectContent,
      variant: subject.avatar_variant,
      subjectName: subject.display_name,
    })
      .catch(() => setShareError(true))
      .finally(() => setSharing(false));
  };

  return (
    <div className="reveal">
      <div className="beat-dots" aria-label={`reveal stage ${beat} of 3`}>
        {[1, 2, 3].map((b) => (
          <span key={b} className={`dot ${beat >= b ? 'now' : ''}`} />
        ))}
      </div>

      {beat === 1 && (
        <section className="beat beat-1">
          <div className="reveal-avatar">
            <Avatar
              code={results.subject_type}
              variant={subject?.avatar_variant ?? 'F'}
              hue={subjectContent.hue}
              size={isHost ? 260 : 180}
            />
          </div>
          <p className="eyebrow">According to your answers</p>
          <h1 className="reveal-code" style={{ color: subjectContent.hue }}>
            {subjectContent.code}
          </h1>
          <p className="reveal-nickname">{subjectContent.nickname}</p>
          <p className="reveal-tagline">“{subjectContent.tagline}”</p>
          {alternatesToShow.length > 0 && (
            <p className="reveal-alternates">
              Also suspected: {alternatesToShow.join(', ')} — the mask was ambiguous here.
            </p>
          )}
          {isHost && (
            <button type="button" className="btn btn-primary btn-big" onClick={() => sendBeat(2)}>
              Did the group see it?
            </button>
          )}
          <footer className="reveal-footer">{DISCLAIMER}</footer>
        </section>
      )}

      {beat === 2 && (
        <section className="beat beat-2">
          <h1 className="beat-title">According to the team</h1>
          <p className="beat-subtitle">
            {typesDiffer ? (
              <>
                You are <em style={{ color: subjectContent.hue }}>{subjectContent.code}</em> — your group sees{' '}
                <em style={{ color: groupContent.hue }}>{groupContent.code}</em>
              </>
            ) : (
              <>
                The group nailed it — <em style={{ color: subjectContent.hue }}>{subjectContent.code}</em> all the way
                down
              </>
            )}
          </p>

          {typesDiffer && (
            <div className="type-cards">
              <article className="type-card" style={{ borderColor: subjectContent.hue }}>
                <p className="type-card-label">Actually {subject?.display_name ?? 'them'}</p>
                <Avatar code={subjectContent.code} variant={subject?.avatar_variant ?? 'F'} hue={subjectContent.hue} size={84} />
                <h2 style={{ color: subjectContent.hue }}>{subjectContent.code}</h2>
                <p>{subjectContent.nickname}</p>
                <p className="muted">“{subjectContent.tagline}”</p>
              </article>
              <article className="type-card" style={{ borderColor: groupContent.hue }}>
                <p className="type-card-label">The group’s read</p>
                <Avatar code={groupContent.code} variant={subject?.avatar_variant ?? 'F'} hue={groupContent.hue} size={84} />
                <h2 style={{ color: groupContent.hue }}>{groupContent.code}</h2>
                <p>{groupContent.nickname}</p>
                <p className="muted">“{groupContent.tagline}”</p>
              </article>
            </div>
          )}

          <table className="axis-table">
            <thead>
              <tr>
                <th>Axis</th>
                <th>Subject</th>
                <th>Group</th>
                <th>Split</th>
              </tr>
            </thead>
            <tbody>
              {AXES.map((axis, i) => {
                const subjectLetter = results.subject_type[i] ?? '';
                const groupLetter = results.group_type?.[i] ?? '';
                const flipped = subjectLetter !== groupLetter;
                const [l0, l1] = AXIS_LETTERS[axis];
                const votes = results.per_axis?.group?.[axis] ?? [0, 0];
                return (
                  <tr key={axis} className={flipped ? 'axis-flipped' : ''}>
                    <td>{axis}</td>
                    <td className="axis-letter">{subjectLetter}</td>
                    <td className="axis-letter">{groupLetter}</td>
                    <td className="axis-split">
                      {l0} {votes[0]} · {l1} {votes[1]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="accuracy">
            The group read <strong>{results.group_accuracy.correct}</strong> of{' '}
            <strong>{results.group_accuracy.total}</strong> answers right.
          </p>

          {results.subject_bonus === 1 && (
            <p className="best-predictor">
              The subject kept the mask on: +1 point.
            </p>
          )}

          {results.group_bonus === 1 && (
            <p className="best-predictor">
              The room called your type — every guesser gets +1.
            </p>
          )}

          {bestPredictor && (
            <p className="best-predictor">
              🏅 <strong>{bestPredictor.display_name}</strong> actually gets you — {bestScore}/{TOTAL_QUESTIONS}
            </p>
          )}

          {typesDiffer && results.analyzer?.length > 0 && (
            <div className="analyzer">
              <p className="eyebrow">Where the mask slipped</p>
              {results.analyzer.map((entry) => (
                <p key={`${entry.axis}-${entry.subjectLetter}${entry.groupLetter}`} className="analyzer-copy">
                  {entry.copy}
                </p>
              ))}
            </div>
          )}

          {isHost && (
            <button type="button" className="btn btn-primary btn-big" onClick={() => sendBeat(3)}>
              Who else wears this face?
            </button>
          )}
          <footer className="reveal-footer">{DISCLAIMER}</footer>
        </section>
      )}

      {beat === 3 && (
        <section className="beat beat-3">
          <h1 className="beat-title">Famous {subjectContent.code}s</h1>
          <ul className="celebs">
            {subjectContent.celebrities.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="unofficial">{UNOFFICIAL_NOTE}</p>

          <button type="button" className="btn btn-primary" disabled={sharing} onClick={share}>
            {sharing ? 'Drawing your card…' : 'Download your share card'}
          </button>
          {shareError && <p className="muted">Could not draw the card — try again.</p>}

          {isHost && (
            <button type="button" className="btn btn-ghost btn-big" onClick={() => void nextRound()}>
              Next round
            </button>
          )}
          <footer className="reveal-footer">{DISCLAIMER}</footer>
        </section>
      )}
    </div>
  );
}
