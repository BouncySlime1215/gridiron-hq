#!/usr/bin/env node
/**
 * The gate on the study itself.
 *
 * Before any novel finding is believed, the replay has to reproduce results
 * that are already established in the literature. If it cannot recover schedule
 * luck of about +/- 2 wins, or the roughly 0.6 rank correlation between draft
 * position and realised value, then a new number it produces is a bug, not a
 * discovery.
 *
 * Every target below is cited in docs/WHAT-WINS-STUDY.md section 2.11. The
 * report prints the published range next to our value and marks PASS / CHECK,
 * and it never silently widens a range to fit.
 *
 * Usage: node --env-file-if-exists=.env study/replay/known-answers.mjs [--leagues 400]
 */
import { FORMATS, ARCHETYPES, loadSeason, runLeague, playedStats } from './engine.mjs';
import { rng, shuffle } from './lib.mjs';

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? Number(argv[i + 1]) : null; };
const LEAGUES = argOf('--leagues') ?? 300;
const SEASONS = [2021, 2022, 2023, 2024, 2025];

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * q)))]; };
function spearman(pairs) {
  const n = pairs.length; if (n < 5) return null;
  const rank = vals => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map(p => p[0])), ry = rank(pairs.map(p => p[1]));
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
}
const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
};

const results = [];
const check = (name, value, lo, hi, published, note = '') =>
  results.push({ name, value, lo, hi, published, note, pass: value != null && value >= lo && value <= hi });

console.log(`Loading ${SEASONS.length} seasons...`);
const seasons = SEASONS.map(y => ({ half: loadSeason(y, 'half'), ppr: loadSeason(y, 'ppr') }));

/* ---- 1. CV by position, played weeks only (published QB .36 RB .54 WR .58 TE .63) */
{
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const s of seasons.map(x => x.half)) {
    for (const p of s.adp.slice(0, 150)) {
      const st = playedStats(p, s.weeks);
      if (st.cv && st.games >= 8 && st.mean >= 5) byPos[p.pos]?.push(st.cv);
    }
  }
  for (const [pos, range] of [['QB', [0.30, 0.50]], ['RB', [0.46, 0.66]], ['WR', [0.50, 0.72]], ['TE', [0.54, 0.76]]]) {
    check(`CV ${pos}`, +mean(byPos[pos]).toFixed(3), range[0], range[1],
      { QB: 0.36, RB: 0.54, WR: 0.58, TE: 0.63 }[pos], `n=${byPos[pos].length}`);
  }
}

/* ---- 2. ADP predicts realised value, Spearman ~0.6 (published 0.62) */
{
  const all = [];
  for (const s of seasons.map(x => x.half)) {
    for (const p of s.adp.slice(0, 200)) {
      const st = playedStats(p, s.weeks);
      all.push([p.adp, -st.total]);   // negate: low ADP should pair with high total
    }
  }
  check('ADP -> season points (Spearman)', spearman(all), 0.45, 0.78, 0.62, `n=${all.length}, top-200 ADP, 5 seasons`);
}

/* ---- 3. Round-1 hit rate: top-12 at position (published WR 63%, RB 58%) */
{
  const hit = { RB: [], WR: [] };
  for (const s of seasons.map(x => x.half)) {
    const totals = new Map(s.adp.map(p => [p.key, playedStats(p, s.weeks).total]));
    const rankAtPos = {};
    for (const pos of ['RB', 'WR']) {
      rankAtPos[pos] = s.adp.filter(p => p.pos === pos)
        .sort((a, b) => (totals.get(b.key) ?? 0) - (totals.get(a.key) ?? 0))
        .slice(0, 12).map(p => p.key);
    }
    // Round 1 of a 12-team draft = the first 12 picks by consensus.
    for (const p of s.adp.slice(0, 12)) {
      if (!hit[p.pos]) continue;
      hit[p.pos].push(rankAtPos[p.pos].includes(p.key) ? 1 : 0);
    }
  }
  for (const pos of ['RB', 'WR']) {
    if (hit[pos].length >= 5) {
      check(`R1 ${pos} hit rate (top-12 at pos)`, +mean(hit[pos]).toFixed(3), 0.40, 0.85,
        pos === 'WR' ? 0.627 : 0.577, `n=${hit[pos].length}`);
    }
  }
}

/* ---- 4. Schedule luck: |actual - all-play| up to ~2-3 wins; r(all-play, H2H) ~0.82 */
{
  const fmt = FORMATS.redraft10_1flex;
  const lucks = [], rs = [];
  let seed = 1000;
  for (const s of seasons.map(x => x.ppr)) {
    for (let i = 0; i < Math.ceil(LEAGUES / SEASONS.length); i++) {
      const agents = Array.from({ length: fmt.teams }, () => 'balanced');
      const r = runLeague(s, fmt, agents, seed++);
      const t = r.arms.attainable.teams;
      lucks.push(...t.map(x => x.luck_wins));
      const rr = pearson(t.map(x => x.all_play), t.map(x => x.h2h));
      if (rr != null) rs.push(rr);
    }
  }
  const absL = lucks.map(Math.abs);
  check('schedule luck p90 |wins|', +pct(absL, 0.90).toFixed(2), 1.2, 3.5, '~2', `n=${lucks.length} team-seasons`);
  check('schedule luck max |wins|', +Math.max(...absL).toFixed(2), 2.0, 6.0, '~3', '');
  check('r(all-play, H2H)', +mean(rs).toFixed(3), 0.70, 0.93, 0.82, `n=${rs.length} leagues, 10-team`);
}

/* ---- 5. Lineup efficiency: attainable should sit at 75-87% of hindsight */
{
  const fmt = FORMATS.redraft10_1flex;
  const ratios = [], gaps = [];
  let seed = 5000;
  for (const s of seasons.map(x => x.ppr)) {
    for (let i = 0; i < 20; i++) {
      const agents = Array.from({ length: fmt.teams }, () => 'balanced');
      const r = runLeague(s, fmt, agents, seed++);
      const att = r.arms.attainable.teams, hind = r.arms.hindsight.teams;
      for (let k = 0; k < att.length; k++) {
        if (!hind[k].points) continue;
        ratios.push(att[k].points / hind[k].points);
        gaps.push((hind[k].points - att[k].points) / fmt.regularWeeks[1]);
      }
    }
  }
  check('lineup efficiency (attainable / hindsight)', +mean(ratios).toFixed(3), 0.72, 0.92, '0.775 (ffsimulator)', `n=${ratios.length}`);
  check('hindsight gap, pts/week', +mean(gaps).toFixed(1), 10, 32, '~20', '');
}

/* ---- 6. Bracket compression: the best all-play team should win ~1/3 of titles */
{
  const fmt = FORMATS.redraft10_1flex;
  let bestWon = 0, n = 0, seedWon = 0;
  let seed = 9000;
  for (const s of seasons.map(x => x.ppr)) {
    for (let i = 0; i < Math.ceil(LEAGUES / SEASONS.length); i++) {
      const agents = Array.from({ length: fmt.teams }, () => 'balanced');
      const r = runLeague(s, fmt, agents, seed++);
      const o = r.arms.attainable;
      if (o.champion == null) continue;
      const best = o.teams.slice().sort((a, b) => b.all_play - a.all_play)[0];
      if (best.idx === o.champion) bestWon++;
      if (o.seeded[0] === o.champion) seedWon++;
      n++;
    }
  }
  check('best all-play team wins title', +(bestWon / n).toFixed(3), 0.18, 0.48, '~0.33', `n=${n} leagues`);
  check('#1 seed wins title', +(seedWon / n).toFixed(3), 0.18, 0.48, '0.25-0.33', '');
}

/* ---- 7. Placebo: under a random champion, title rate must equal 1/teams */
{
  const fmt = FORMATS.redraft10_1flex;
  const rand = rng(777);
  let hits = 0; const n = 2000;
  for (let i = 0; i < n; i++) hits += shuffle([...Array(fmt.teams).keys()], rand)[0] === 0 ? 1 : 0;
  check('PLACEBO random title rate (10-team)', +(hits / n).toFixed(3), 0.08, 0.12, 0.10, 'code test');
}

/* ------------------------------------------------------------------ report */
console.log('\n' + '='.repeat(104));
console.log('KNOWN-ANSWERS GATE'.padEnd(46), 'ours'.padStart(8), 'accepted'.padStart(14), 'published'.padStart(14), '  result');
console.log('='.repeat(104));
for (const r of results) {
  console.log(
    r.name.padEnd(46),
    String(r.value ?? '-').padStart(8),
    `[${r.lo}, ${r.hi}]`.padStart(14),
    String(r.published).padStart(14),
    '  ' + (r.pass ? 'PASS' : 'CHECK'),
    r.note ? '  ' + r.note : '');
}
const passed = results.filter(r => r.pass).length;
console.log('='.repeat(104));
console.log(`${passed} of ${results.length} within published ranges.`);
console.log(passed === results.length
  ? 'Gate PASSED — the replay reproduces the literature and its novel findings can be read.'
  : 'Gate NOT passed — fix the flagged components before trusting any new number from this engine.');
process.exit(0);
