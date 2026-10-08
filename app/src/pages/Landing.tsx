import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FAMILY_META, avatarSrc, TYPE_CODES } from '../content/types';
import { HuePicker } from '../components/atoms';
import { useGame } from '../store/game';
import { ApiError } from '../lib/api';

const EXTRA_HUES = ['#C94F6D', '#3E8FCF', '#8A8F98'];
const HUES = [...Object.values(FAMILY_META).map((f) => f.hue), ...EXTRA_HUES];
const PREVIEW_TYPE = TYPE_CODES[Math.floor(Math.random() * TYPE_CODES.length)];

export function Landing() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const createRoom = useGame((s) => s.createRoom);
  const joinRoom = useGame((s) => s.joinRoom);

  const [name, setName] = useState('');
  const [hue, setHue] = useState(HUES[0]);
  const [variant, setVariant] = useState<'F' | 'M'>('F');
  const [joinCode, setJoinCode] = useState(params.get('join') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validName = name.trim().length > 0;

  const run = async (fn: () => Promise<{ code: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const session = await fn();
      navigate(`/r/${session.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <header className="landing-hero">
        <h1 className="wordmark">
          Beneath <span>the</span> Mask
        </h1>
        <p className="tagline">Your friends think they know you. Prove them wrong, 12 questions at a time.</p>
      </header>

      <form
        className="card join-card"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <label className="field">
          <span className="field-label">Your name</span>
          <input
            type="text"
            value={name}
            maxLength={18}
            placeholder="What the group calls you"
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
          />
        </label>

        <div className="field">
          <span className="field-label">Your color</span>
          <HuePicker hues={HUES} value={hue} onChange={setHue} />
        </div>

        <div className="field">
          <span className="field-label">Your avatar</span>
          <div className="variant-row">
            <img
              src={avatarSrc(PREVIEW_TYPE, variant)}
              alt="avatar preview"
              className="variant-preview"
              width={88}
              height={88}
              draggable={false}
            />
            <div className="variant-toggle" role="radiogroup" aria-label="avatar variant">
              <button
                type="button"
                role="radio"
                aria-checked={variant === 'F'}
                className={`btn btn-toggle ${variant === 'F' ? 'active' : ''}`}
                onClick={() => setVariant('F')}
              >
                She
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={variant === 'M'}
                className={`btn btn-toggle ${variant === 'M' ? 'active' : ''}`}
                onClick={() => setVariant('M')}
              >
                He
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-big"
          disabled={!validName || busy}
          onClick={() => void run(() => createRoom({ display_name: name.trim(), hue, avatar_variant: variant }))}
        >
          Create a room
        </button>

        <div className="divider">
          <span>or join one</span>
        </div>

        <div className="join-row">
          <input
            type="text"
            value={joinCode}
            maxLength={6}
            placeholder="CODE"
            className="join-code-input"
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!validName || joinCode.trim().length < 4 || busy}
            onClick={() =>
              void run(() => joinRoom(joinCode.trim(), { display_name: name.trim(), hue, avatar_variant: variant }))
            }
          >
            Join
          </button>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="muted">2–10 players. One shared screen for the host, everyone else plays on their phone.</p>
      </form>
    </div>
  );
}
