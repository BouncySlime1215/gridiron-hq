#!/usr/bin/env node
/**
 * MOBILE-PWA (plan item 59): draws the home-screen icons the web app manifest points at.
 *
 * No image dependency: a football on the brand accent (tokens.css --c-accent), rasterised with
 * 4x4 supersampling and written as an 8-bit RGBA PNG through node:zlib. Deterministic, so a
 * re-run on the same source rewrites the same bytes and `--check` can hold the committed
 * files to this drawing.
 *
 *   node scripts/pwa/make-icons.mjs           # write client/public/icons/*.png
 *   node scripts/pwa/make-icons.mjs --check   # exit 1 when a committed icon differs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ICON_DIR = path.join(ROOT, 'client', 'public', 'icons');

const ACCENT = [0x4b, 0x5b, 0xff];
const WHITE = [0xff, 0xff, 0xff];

/**
 * The icon set. `rounded` icons carry their own corner radius (purpose "any"); full-bleed ones
 * are for launchers that mask the shape themselves (maskable, and iOS's apple-touch-icon), so
 * the ball stays inside the 80% safe zone there.
 */
export const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, ball: 0.62 },
  { file: 'icon-512.png', size: 512, rounded: true, ball: 0.62 },
  { file: 'maskable-512.png', size: 512, rounded: false, ball: 0.5 },
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, ball: 0.56 }
];

/** Coverage colour of one sample point in unit coordinates (0..1 each way), or null outside. */
function sample(x, y, { rounded, ball }) {
  if (rounded) {
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  }
  // The ball: an ellipse on the diagonal, long axis `ball` of the icon.
  const a = Math.PI / 4;
  const dx = x - 0.5;
  const dy = y - 0.5;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  const ra = ball / 2;
  const rb = ball * 0.31;
  if ((u / ra) ** 2 + (v / rb) ** 2 > 1) return ACCENT;
  // Laces in accent across the ball: one seam along the long axis, four short stitches.
  const w = ball * 0.028;
  const seamHalf = ra * 0.36;
  if (Math.abs(v) < w && Math.abs(u) < seamHalf) return ACCENT;
  for (const s of [-0.75, -0.25, 0.25, 0.75]) {
    const su = s * seamHalf;
    if (Math.abs(u - su) < w && Math.abs(v) < rb * 0.34) return ACCENT;
  }
  // Two stripes near the tips.
  const tip = Math.abs(u) / ra;
  if (tip > 0.66 && tip < 0.74) return ACCENT;
  return WHITE;
}

/** RGBA pixels for one icon, 4x4 supersampled. */
export function drawIcon(spec) {
  const { size } = spec;
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let pxI = 0; pxI < size; pxI++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxI + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, spec);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; n++;
        }
      }
      const o = (py * size + pxI) * 4;
      if (n) {
        px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n);
      }
      px[o + 3] = Math.round((n / (SS * SS)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGBA PNG from raw pixels. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export function renderIcon(spec) {
  return encodePng(spec.size, drawIcon(spec));
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  if (!check) fs.mkdirSync(ICON_DIR, { recursive: true });
  for (const spec of ICONS) {
    const file = path.join(ICON_DIR, spec.file);
    const png = renderIcon(spec);
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(png);
      if (!same) { stale++; console.error(`stale: client/public/icons/${spec.file}`); }
    } else {
      fs.writeFileSync(file, png);
      console.log(`wrote client/public/icons/${spec.file} (${spec.size}px, ${png.length} bytes)`);
    }
  }
  if (check) {
    if (stale) { console.error('Run node scripts/pwa/make-icons.mjs'); process.exit(1); }
    console.log(`icons current (${ICONS.length})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
