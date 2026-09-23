// RL-3-3 post-fix served-card count. Renders the fix tree's own RiskStrip (compiled with the
// repo's TypeScript) for every served side and reads the Ceiling cell's colour and text back out,
// so the count uses the shipped component, not a re-implementation of its rule.
// usage: cd <worktree> && node <this> <rows.json>
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const WT = process.cwd(); const req = createRequire(path.join(WT, 'package.json'));
const ts = req('typescript'); const React = req('react'); const { renderToStaticMarkup } = req('react-dom/server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl33-sum-'));
const w = (n, t) => { fs.writeFileSync(path.join(tmp, n), t); return pathToFileURL(path.join(tmp, n)).href; };
const rt = req.resolve('react/jsx-runtime');
const rtUrl = w('rt.mjs', `import { createRequire } from 'node:module'; const r = createRequire(${JSON.stringify(rt)})(${JSON.stringify(rt)}); export const jsx=r.jsx, jsxs=r.jsxs, Fragment=r.Fragment;`);
const src = fs.readFileSync(path.join(WT, 'client/src/components/trade/RiskStrip.tsx'), 'utf8');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const { default: RiskStrip } = await import(w('rs.mjs', out.split('"react/jsx-runtime"').join(`'${rtUrl}'`)));
const pkg = (p80, n) => ({ players: Array.from({ length: n }, (_, i) => ({ id: i })), seasons: 1, top24_seasons: 0, top12_seasons: 0, min_games: null, swing_pct: null, band_pct: null, points: null, p20: null, p80, headline_profile: null, headline_read: null, unreadable: 0 });
const sg = x => x == null || Math.abs(x) < 1e-9 ? 0 : x > 0 ? 1 : -1;
const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).rows;
let both = 0, contra = 0, textPair = 0, oldContra = 0, uneven = 0, cdLarger = 0, oldLarger = 0, textIsCd = 0;
for (const r of R) {
  if (r.strip_ceiling_out == null || r.strip_ceiling_in == null || r.weekly_ceiling_delta == null) continue;
  both++;
  const html = renderToStaticMarkup(React.createElement(RiskStrip, { risk: { out: pkg(r.strip_ceiling_out, r.n_give), in: pkg(r.strip_ceiling_in, r.n_get) }, ceilingDelta: r.weekly_ceiling_delta }));
  const cell = html.split('<div class="min-w-0"').find(c => c.includes('>Ceiling<'));
  const col = /text-good/.test(cell) ? 1 : /text-crit/.test(cell) ? -1 : 0;
  const text = cell.replace(/<[^>]+>/g, ' ').replace(/^[^>]*>/, '').replace(/\s+/g, ' ').trim();
  const wk = sg(r.weekly_ceiling_delta);
  if (col !== 0 && wk !== 0 && col !== wk) contra++;
  if (text.includes(`${r.weekly_ceiling_delta > 0 ? '+' : ''}${r.weekly_ceiling_delta.toFixed(1)} pts`)) textIsCd++;
  if (text.includes(Math.round(r.strip_ceiling_out).toLocaleString('en-US') + ' pts')) textPair++;
  const old = sg(r.strip_ceiling_in - r.strip_ceiling_out);
  if (old !== 0 && wk !== 0 && old !== wk) oldContra++;
  if (r.n_give !== r.n_get) { uneven++; const larger = sg(r.n_get - r.n_give); if (col === larger) cdLarger++; if (old === larger) oldLarger++; }
}
console.log(JSON.stringify({ rows: R.length, sides_with_both: both, old_rule_colour_vs_weekly_opposite: oldContra, new_cell_colour_vs_weekly_opposite: contra, new_cell_text_is_weekly_ceiling: textIsCd, new_cell_text_prints_summed_p80: textPair, uneven_sides: uneven, old_rule_green_for_larger_side: oldLarger, new_cell_green_for_larger_side: cdLarger }));
fs.rmSync(tmp, { recursive: true, force: true });
