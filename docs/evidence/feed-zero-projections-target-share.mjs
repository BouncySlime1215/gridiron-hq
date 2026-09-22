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
const players = [...acc.values()].filter(a => a.unW > 0 && a.gW > 0);
for (const [who, a] of acc) {
  if (!(a.unW > 0 && a.gW > 0) || a.dropped === 0) continue;
  const un = a.un / a.unW, g = a.g / a.gW;
  const d = g - un;
  affected++; sumDelta += d; sumRel += un > 0 ? d / un : 0;
  if (d >= 0.005) over005++;
  if (d > largest.d) largest = { d, who: `${who} (${a.dropped} of ${a.rows} rows)` };
}
console.log(`through ${THROUGH}, seasons 2023-2024, rowWeight = ${DECAY} ** (through - season)`);
console.log(`rows entering the :492 gate      ${rowsSeen}`);
console.log(`  matched to a snap row          ${matched} (${(100 * matched / rowsSeen).toFixed(1)}%)`);
console.log(`  of those, offense_snaps == 0   ${zeroSnapRows}`);
console.log(`players with a usable mean       ${players.length}`);
console.log(`  affected (>= 1 zero-snap row)  ${affected} (${(100 * affected / players.length).toFixed(1)}%)`);
console.log(`mean understatement of tgtShareObs on an affected player  ${(sumDelta / affected).toFixed(4)} share`);
console.log(`  as a fraction of the value the site computes            ${(100 * sumRel / affected).toFixed(1)}%`);
console.log(`affected players moving >= 0.005 of share                 ${over005}`);
console.log(`largest single move                                       +${largest.d.toFixed(4)}  ${largest.who}`);
