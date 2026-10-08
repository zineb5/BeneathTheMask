// Shared UI atoms.

import { useEffect, useState } from 'react';
import { avatarSrc } from '../content/types';
import { endsAtMs } from '../lib/types';

/** Sliced avatar art, or a mystery mask before the type is known. */
export function Avatar({
  code,
  variant,
  hue,
  masked = false,
  size = 48,
}: {
  code?: string | null;
  variant?: 'F' | 'M';
  hue?: string;
  masked?: boolean;
  size?: number;
}) {
  const style = { width: size, height: size, fontSize: size * 0.52 };
  if (masked || !code) {
    return (
      <span className="avatar avatar-mask" style={style} aria-hidden>
        🎭
      </span>
    );
  }
  return (
    <span className="avatar" style={{ ...style, boxShadow: `0 0 0 3px ${hue ?? 'var(--accent)'}` }}>
      <img src={avatarSrc(code, variant ?? 'F')} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

export function HuePicker({
  hues,
  value,
  onChange,
}: {
  hues: string[];
  value: string;
  onChange: (h: string) => void;
}) {
  return (
    <div className="hue-picker" role="radiogroup" aria-label="Pick your color">
      {hues.map((h) => (
        <button
          key={h}
          type="button"
          role="radio"
          aria-checked={value === h}
          className={`hue-swatch ${value === h ? 'active' : ''}`}
          style={{ background: h }}
          onClick={() => onChange(h)}
        />
      ))}
    </div>
  );
}

export function Countdown({
  endsAt,
  onExpire,
}: {
  endsAt: string | number | null | undefined;
  onExpire?: () => void;
}) {
  const [left, setLeft] = useState(0);
  const end = endsAtMs(endsAt);
  useEffect(() => {
    if (!end) {
      setLeft(0);
      return;
    }
    let expired = false;
    const tick = () => {
      const remain = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft((prev) => (prev !== remain ? remain : prev));
      if (remain <= 0 && !expired) {
        expired = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [end, onExpire]);
  const urgent = left <= 5 && left > 0;
  return (
    <div className={`countdown ${urgent ? 'countdown-urgent' : ''}`} aria-live="polite">
      {left > 0 ? left : '⏱'}
    </div>
  );
}

export function Dots({ total, current }: { total: number; current: number }) {
  return (
    <div className="dots" aria-label={`question ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`dot ${i < current ? 'done' : ''} ${i === current ? 'now' : ''}`} />
      ))}
    </div>
  );
}

export function Medal({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="medal" title={`${count} best-predictor badge${count === 1 ? '' : 's'}`}>
      🏅{count > 1 ? `×${count}` : ''}
    </span>
  );
}

export function Crown() {
  return (
    <span className="crown" title="host" aria-label="host">
      👑
    </span>
  );
}
