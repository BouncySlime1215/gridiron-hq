/**
 * Colour contrast for the design tokens (item 58, ACCESSIBILITY PASS).
 *
 * Reads client/src/styles/tokens.css, resolves the light set (:root) and the dark set
 * ([data-theme="dark"], falling back to light for anything it leaves out), and checks every
 * pair the app actually draws text or a focus ring with against WCAG 2.2 AA:
 *   - text tokens on every surface: 4.5:1 (1.4.3);
 *   - accent ink on the accent fill (primary buttons): 4.5:1;
 *   - a status colour on its own tint laid over a card (chips, toned cards): 4.5:1;
 *   - the focus ring (accent) against the page and a card: 3:1 (1.4.11 non-text).
 * Alpha colours are composited over their surface before measuring. Pure: no fs here.
 */

export const TEXT_TOKENS = Object.freeze(['ink', 'ink2', 'muted', 'subtle', 'accent', 'green', 'amber', 'red']);
export const SURFACES = Object.freeze(['bg', 'card', 'soft', 'raised']);
export const STATUS = Object.freeze(['accent', 'green', 'amber', 'red']);
export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;

function block(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return '';
  const open = css.indexOf('{', at), close = css.indexOf('}', open);
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
}

function vars(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/--c-([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** { light, dark } token maps (name without the --c- prefix -> CSS colour text). */
export function parseTokens(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = vars(block(css, ':root'));
  const dark = { ...light, ...vars(block(css, '[data-theme="dark"]')) };
  if (!Object.keys(light).length) throw new Error('tokens.css: no :root block with --c-* colours');
  return { light, dark };
}

/** '#rrggbb' | '#rgb' | 'rgb(r g b / a)' | 'rgb(r, g, b)' -> [r, g, b, a]; throws on anything else. */
export function parseColor(text) {
  const t = String(text).trim();
  let m = t.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = t.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1);
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/i);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  throw new Error(`unparseable colour: ${t}`);
}

/** Lay a (possibly translucent) colour over an opaque one. */
export function over(fg, bg) {
  const [r, g, b, a] = fg;
  return [0, 1, 2].map(i => [r, g, b][i] * a + bg[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const lin = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of fg over bg (fg composited first if translucent). */
export function contrastRatio(fgText, bgText) {
  const bg = parseColor(bgText);
  if (bg[3] < 1) throw new Error(`background must be opaque: ${bgText}`);
  const fg = over(parseColor(fgText), bg);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every checked pair for one theme: { theme, fg, bg, ratio, min, ok }. */
export function themePairs(theme, t) {
  const rows = [];
  const need = (name, v) => { if (!t[v]) throw new Error(`${theme}: --c-${v} missing (${name})`); return t[v]; };
  const push = (fg, bg, fgText, bgText, min) => {
    const ratio = contrastRatio(fgText, bgText);
    rows.push({ theme, fg, bg, ratio: Math.round(ratio * 100) / 100, min, ok: ratio >= min });
  };
  for (const s of SURFACES) if (t[s]) for (const f of TEXT_TOKENS) push(f, s, need('text', f), t[s], AA_TEXT);
  push('accent-ink', 'accent', need('text', 'accent-ink'), need('fill', 'accent'), AA_TEXT);
  for (const s of STATUS) {
    const tint = over(parseColor(need('tint', `${s}-tint`)), parseColor(need('card', 'card')));
    push(s, `${s}-tint on card`, t[s], `rgb(${tint.slice(0, 3).map(Math.round).join(' ')})`, AA_TEXT);
  }
  for (const s of ['bg', 'card']) push('accent (focus ring)', s, t.accent, t[s], AA_NON_TEXT);
  return rows;
}

export function checkContrast(css) {
  const { light, dark } = parseTokens(css);
  const rows = [...themePairs('light', light), ...themePairs('dark', dark)];
  return { rows, failures: rows.filter(r => !r.ok) };
}
