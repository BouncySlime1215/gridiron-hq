import path from 'node:path';
import { fileURLToPath } from 'node:url';
import colors from 'tailwindcss/colors.js';
import plugin from 'tailwindcss/plugin.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * App-wide dark mode. Every Tailwind colour family the pages use reads a CSS variable, so one
 * attribute (<html data-theme="dark">, set by state/theme.tsx and index.html before first paint)
 * turns every page dark without editing it. Light is Tailwind's own palette, unchanged. Dark:
 *  - neutrals (slate, gray) are hand-set to the design tokens' dark set (styles/tokens.css), so
 *    bg-slate-50 is the soft surface, border-slate-200 the line, text-slate-900 the ink;
 *  - colour families mirror: a pale -50/-100/-200/-300 background becomes a low-alpha tint of the
 *    hue over the dark card, and dark -600..-950 text becomes its light counterpart, so every
 *    pale-tint-with-dark-text pair keeps its contrast.
 * `white` stays white (it is text on solid colour); bg-white becomes the card (see the plugin).
 */
const NEUTRALS = ['slate', 'gray'];
const HUES = ['emerald', 'amber', 'rose', 'sky', 'violet', 'indigo', 'red', 'blue', 'green', 'orange', 'yellow', 'teal', 'purple', 'pink', 'cyan', 'lime', 'fuchsia'];
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const NEUTRAL_DARK = {
  50: '#171a21', 100: '#1c2029', 200: '#272c36', 300: '#363c48', 400: '#747b8a', 500: '#8c93a2',
  600: '#a4abb8', 700: '#c6cad4', 800: '#dadde4', 900: '#eceef3', 950: '#f5f6f8'
};
const CARD = [18, 20, 25]; // --c-card, dark

const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const triple = c => c.join(' ');
const over = (hex, a) => rgb(hex).map((v, i) => Math.round(v * a + CARD[i] * (1 - a)));
const hueDark = (fam, s) => {
  const p = colors[fam];
  switch (s) {
    case '50': return over(p[500], 0.12);
    case '100': return over(p[500], 0.18);
    case '200': return over(p[500], 0.28);
    case '300': return over(p[500], 0.45);
    case '600': return rgb(p[500]);
    case '700': return rgb(p[300]);
    case '800': return rgb(p[200]);
    case '900': return rgb(p[100]);
    case '950': return rgb(p[50]);
    default: return rgb(p[s]); // 400, 500 read on both backgrounds
  }
};

const varColors = Object.fromEntries([...NEUTRALS, ...HUES].map(fam => [fam,
  Object.fromEntries(SHADES.map(s => [s, `rgb(var(--tw-${fam}-${s}) / <alpha-value>)`]))]));

// Solid hue fills (-600 and darker) carry white text: in dark mode they keep their light-mode
// colour instead of mirroring to a pale one (a mirrored fill would put white on pastel).
const solidFills = Object.fromEntries(HUES.flatMap(fam => ['600', '700', '800', '900', '950'].map(s =>
  [`[data-theme="dark"] .bg-${fam}-${s}`, { backgroundColor: colors[fam][s] }])));

const light = {}, dark = {};
for (const fam of [...NEUTRALS, ...HUES]) for (const s of SHADES) {
  light[`--tw-${fam}-${s}`] = triple(rgb(colors[fam][s]));
  dark[`--tw-${fam}-${s}`] = triple(NEUTRALS.includes(fam) ? rgb(NEUTRAL_DARK[s]) : hueDark(fam, s));
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(dir, 'index.html'), path.join(dir, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        field: '#1a4d2e',
        ...varColors
      }
    }
  },
  plugins: [plugin(({ addBase }) => {
    addBase({
      ':root, [data-theme="light"]': light,
      '[data-theme="dark"]': dark,
      // Surfaces that are dark in both modes (a deep panel, a slate-900/950 block) keep the light
      // palette inside, so their pale text stays pale on them.
      '[data-theme="dark"] .surface-deep, [data-theme="dark"] .bg-slate-900, [data-theme="dark"] .bg-slate-950': light,
      ...solidFills,
      // A white surface is the card in dark mode; white text on solid colour stays white.
      '[data-theme="dark"] .bg-white, [data-theme="dark"] .hover\\:bg-white:hover': { backgroundColor: 'var(--c-card)' },
      '[data-theme="dark"] .bg-white\\/60, [data-theme="dark"] .bg-white\\/70': { backgroundColor: 'rgb(18 20 25 / .7)' }
    });
  })]
};
