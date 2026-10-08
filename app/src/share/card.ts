// Share card: draws a 1080x1350 PNG (canvas) for the reveal moment and
// triggers a browser download.

import { avatarSrc, UNOFFICIAL_NOTE, type TypeContent } from '../content/types';

export interface ShareCardInput {
  type: TypeContent;
  variant: 'F' | 'M';
  subjectName: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

export async function downloadShareCard(input: ShareCardInput): Promise<void> {
  const { type, variant, subjectName } = input;
  const W = 1080;
  const H = 1350;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  // Background: family soft tint with a deep vignette band at the bottom.
  ctx.fillStyle = type.soft;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 480, 60, W / 2, 480, 700);
  glow.addColorStop(0, 'rgba(255,255,255,0.75)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#17131F';
  ctx.fillRect(0, H - 250, W, 250);

  // Avatar in a ring.
  const avatar = await loadImage(avatarSrc(type.code, variant));
  const avSize = 460;
  const avX = (W - avSize) / 2;
  const avY = 210;
  ctx.save();
  ctx.shadowColor = 'rgba(23,19,31,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(W / 2, avY + avSize / 2, avSize / 2 + 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(W / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, avX, avY, avSize, avSize);
  ctx.restore();
  ctx.strokeStyle = type.hue;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(W / 2, avY + avSize / 2, avSize / 2 + 26, 0, Math.PI * 2);
  ctx.stroke();

  // Type code.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#17131F';
  ctx.font = '900 150px system-ui, Segoe UI, sans-serif';
  ctx.fillText(type.code, W / 2, 880);
  ctx.font = '600 54px Georgia, serif';
  ctx.fillStyle = type.hue;
  ctx.fillText(type.nickname, W / 2, 960);

  // Tagline, wrapped.
  ctx.font = '400 40px Georgia, serif';
  ctx.fillStyle = '#3A3344';
  const words = type.tagline.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > 880 && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, W / 2, 1030 + i * 52));

  // Wordmark + subject + attribution footer.
  ctx.fillStyle = '#F4F1FA';
  ctx.font = '700 44px Georgia, serif';
  ctx.fillText('Beneath the Mask', W / 2, H - 160);
  ctx.font = '400 34px system-ui, Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(244,241,250,0.75)';
  ctx.fillText(`${subjectName} — ${type.code}, ${type.nickname}`, W / 2, H - 104);
  ctx.font = '300 26px system-ui, Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(244,241,250,0.5)';
  ctx.fillText(UNOFFICIAL_NOTE, W / 2, H - 52);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not render PNG');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `beneath-the-mask-${type.code.toLowerCase()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
