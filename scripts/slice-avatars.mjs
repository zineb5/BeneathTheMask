// One-off: slice the 32 avatar tiles from avatars_contact_sheet.png (4x8 grid, 704x1584).
// Output: app/public/avatars/[TYPE]_[MF].png (176x176, caption strip cropped).
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, '..', 'avatars_contact_sheet.png');
const OUT = path.join(root, 'app', 'public', 'avatars');

// Row-major order as labeled on the sheet (rows 1-8, 4 tiles each: F, M, F, M).
const ROWS = [
  ['INTJ', 'INTP'],
  ['ENTJ', 'ENTP'],
  ['INFJ', 'INFP'],
  ['ENFJ', 'ENFP'],
  ['ISTJ', 'ISFJ'],
  ['ESTJ', 'ESFJ'],
  ['ISTP', 'ISFP'],
  ['ESTP', 'ESFP'],
];

const W = 704, H = 1584, COLS = 4, ROW_COUNT = 8;
const TILE_W = W / COLS; // 176
const TILE_H = H / ROW_COUNT; // 198
const CAPTION = 22; // caption strip at the bottom of each tile
const SIZE = TILE_W; // square crop: top TILE_W pixels of (TILE_H - CAPTION)

await mkdir(OUT, { recursive: true });

const jobs = [];
ROWS.forEach((types, r) => {
  types.forEach((type, c) => {
    ['F', 'M'].forEach((variant, k) => {
      const col = c * 2 + k;
      const left = Math.round(col * TILE_W);
      const top = Math.round(r * TILE_H);
      const file = path.join(OUT, `${type}_${variant}.png`);
      jobs.push(
        sharp(SRC)
          .extract({ left, top, width: TILE_W, height: TILE_H - CAPTION })
          .resize(SIZE, SIZE, { fit: 'cover', position: 'top' })
          .png()
          .toFile(file)
          .then(() => console.log(`${type}_${variant}.png`))
      );
    });
  });
});

await Promise.all(jobs);
console.log(`Done: ${jobs.length} avatars -> ${OUT}`);
