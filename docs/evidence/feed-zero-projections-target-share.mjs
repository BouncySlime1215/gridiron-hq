// The first LIVE consumer of the player_week_usage target_share zeros.
//
// projections.js:492 accumulates    if (u.target_share != null) { a.tgtShareW += roleW;
//                                     a.tgtShare += roleW * u.target_share; }
// and :522 divides                  tgtShareObs = a.tgtShare / a.tgtShareW
// over rows from history() (:294-300), which selects u.* from player_week_usage
// with NO snap filter. So weeks the player took zero offensive snaps enter the
// role mean as real zeros.
//
// Two other sites in the same codebase gate the identical column on > 0:
//   projections.js:395            (the positional prior)
//   shrinkage-fit.js:330          (the k fit)
// so the observation and the prior it is shrunk toward are on different supports.
//
// This reproduces tgtShareObs with the shipped weights (RECENCY.seasonDecay 0.35,
// weekHalfLife null => rowWeight = 0.35 ** (through - season)) for through = 2024,
// and compares it with the same mean over snap-positive rows only.
// TRUNCATION, stated: snap files exist here for 2023 and 2024 only, so seasons
// at back >= 2 are absent. Their weight is 0.35^2 = 0.1225 and below, i.e. under
// 9% of the total an untruncated run would carry.
import fs from 'node:fs';
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
const load = f => {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.length);
  const header = splitCsvLine(lines[0]);
  return { at: n => header.indexOf(n), rows: lines.slice(1).map(splitCsvLine) };
};
const norm = v => String(v ?? '').trim().toLowerCase();
const SKILL = new Set(['WR', 'TE', 'RB', 'FB']);
const THROUGH = 2024, DECAY = 0.35;

// name|week|team -> offense_snaps, per season
const snaps = new Map();
for (const season of [2023, 2024]) {
  const s = load(`${process.argv[2]}/snaps_${season}.csv`);
  const [iN, iW, iT, iO, iG] = ['player', 'week', 'team', 'offense_snaps', 'game_type'].map(s.at);
  for (const r of s.rows) {
    if (r[iG] !== 'REG') continue;
    snaps.set(`${season}|${norm(r[iN])}|${r[iW]}|${r[iT]}`, Number(r[iO]));
  }
}

// player -> weighted sums, ungated and snap-gated
const acc = new Map();
let rowsSeen = 0, matched = 0, zeroSnapRows = 0;
for (const season of [2023, 2024]) {
  const st = load(`${process.argv[2]}/stats_${season}.csv`);
  const [iN, iW, iT, iP, iS, iG] = ['player_display_name', 'week', 'team', 'position', 'target_share', 'season_type'].map(st.at);
  const w = Math.pow(DECAY, THROUGH - season);
  for (const r of st.rows) {
    if (r[iG] !== 'REG' || !SKILL.has(r[iP])) continue;
    const raw = r[iS];
    if (raw === '' || raw == null) continue;          // the != null gate at :492
    const share = Number(raw);
    if (!Number.isFinite(share)) continue;
    rowsSeen++;
    const key = norm(r[iN]);
    const a = acc.get(key) ?? { unW: 0, un: 0, gW: 0, g: 0, dropped: 0, rows: 0 };
    a.rows++;
    a.unW += w; a.un += w * share;
    const sn = snaps.get(`${season}|${key}|${r[iW]}|${r[iT]}`);
    if (sn != null) {
      matched++;
      if (sn === 0) { zeroSnapRows++; a.dropped++; }
      else { a.gW += w; a.g += w * share; }
    } else { a.gW += w; a.g += w * share; }   // unmatched: keep, do not invent a drop
    acc.set(key, a);
  }
}

let affected = 0, sumDelta = 0, sumRel = 0, over005 = 0, largest = { d: 0, who: '' };
let sumUn = 0;                       // for the RATIO OF MEANS, which is not the mean of ratios
const players = [...acc.values()].filter(a => a.unW > 0 && a.gW > 0);
const hits = [];                     // per-player rows, for the n-dependence question
for (const [who, a] of acc) {
  if (!(a.unW > 0 && a.gW > 0) || a.dropped === 0) continue;
  const un = a.un / a.unW, g = a.g / a.gW;
  const d = g - un;
  affected++; sumDelta += d; sumUn += un; sumRel += un > 0 ? d / un : 0;
  if (d >= 0.005) over005++;
  if (d > largest.d) largest = { d, who: `${who} (${a.dropped} of ${a.rows} rows)` };
  // n as the site uses it: :522 passes a.tgtShareW into pickK, i.e. the
  // RECENCY-WEIGHTED row count, not the raw one. Both are reported.
  hits.push({ who, d, un, n: a.rows, wn: a.unW, dropped: a.dropped });
}

// ---- the Auditor's question: shrinkage is n / (n + k), and the observation's n
// counts the zero rows while the prior's does not. A mean over all affected
// players would hide an n-dependence. Does the understatement rise with n?
const pearson = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
};
const rank = vs => { const idx = vs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(vs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
console.log(`through ${THROUGH}, seasons 2023-2024, rowWeight = ${DECAY} ** (through - season)`);
console.log(`rows entering the :492 gate      ${rowsSeen}`);
console.log(`  matched to a snap row          ${matched} (${(100 * matched / rowsSeen).toFixed(1)}%)`);
console.log(`  of those, offense_snaps == 0   ${zeroSnapRows}`);
console.log(`players with a usable mean       ${players.length}`);
console.log(`  affected (>= 1 zero-snap row)  ${affected} (${(100 * affected / players.length).toFixed(1)}%)`);
console.log(`mean understatement of tgtShareObs on an affected player  ${(sumDelta / affected).toFixed(4)} share`);
console.log(`  MEAN OF PER-PLAYER RATIOS (each player's own base)      ${(100 * sumRel / affected).toFixed(1)}%`);
console.log(`  RATIO OF MEANS (total understatement / total base)      ${(100 * sumDelta / sumUn).toFixed(1)}%`);
console.log(`  mean contaminated base across affected players          ${(sumUn / affected).toFixed(4)} share`);
console.log(`affected players moving >= 0.005 of share                 ${over005}`);
console.log(`largest single move                                       +${largest.d.toFixed(4)}  ${largest.who}`);

// ---- n-dependence
const ns = hits.map(h => h.n), ds = hits.map(h => h.d), wns = hits.map(h => h.wn);
console.log('--- does the understatement rise with n? (shrinkage is n/(n+k))');
console.log(`Pearson  r(n, understatement)   ${pearson(ns, ds).toFixed(3)}`);
console.log(`Spearman r(n, understatement)   ${pearson(rank(ns), rank(ds)).toFixed(3)}`);
console.log(`Pearson  r(weighted n, same)    ${pearson(wns, ds).toFixed(3)}   <- n as :522 passes it to pickK`);
console.log(`Spearman r(weighted n, same)    ${pearson(rank(wns), rank(ds)).toFixed(3)}`);
const buckets = [[1, 4], [5, 9], [10, 19], [20, 99]];
console.log('  n rows        players   mean understatement   mean base   ratio');
for (const [lo, hi] of buckets) {
  const b = hits.filter(h => h.n >= lo && h.n <= hi);
  if (!b.length) continue;
  const md = b.reduce((s, h) => s + h.d, 0) / b.length;
  const mb = b.reduce((s, h) => s + h.un, 0) / b.length;
  console.log(`  ${String(lo + '-' + hi).padEnd(8)} ${String(b.length).padStart(10)}   ${md.toFixed(4).padStart(17)}   ${mb.toFixed(4).padStart(9)}   ${(100 * md / mb).toFixed(1).padStart(5)}%`);
}
