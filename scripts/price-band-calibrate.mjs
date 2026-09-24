#!/usr/bin/env node
/**
 * PRICE-BAND-01 step 2 of 2: fit the V2 accept band on Sleeper 2021-22 and grade it,
 * next to the legacy band, on 2023-24 held out.
 *
 *   node scripts/price-band-calibrate.mjs --trades <trades.csv> [--emit] [--check]
 *
 * <trades.csv> comes from scripts/price-band-extract.py (columns season, league_key,
 * week, r, r_ros, n_get, n_give). Any row with season >= 2025 is a hard error: 2025
 * is never used.
 *   --emit   also print the FITTED_BAND literal for server/services/price-band.js
 *   --check  exit 1 unless (a) pooled 2023-24 V2 coverage is within 0.80 +/- 0.05 and
 *            (b) the refit equals the FITTED_BAND constants the server serves.
 * Output is aggregate JSON only (no league keys).
 */
import fs from 'node:fs';
import {
  FITTED_BAND, LEGACY_BAND, bandFromFit, fitConformalBand, bandCoverage, clusteredShareCI
} from '../server/services/price-band.js';

export const FIT_SEASONS = [2021];
export const CAL_SEASONS = [2022];
export const GRADE_SEASONS = [2023, 2024];
export const TARGET = { nominal: 0.80, tol: 0.05 };

export function parseTrades(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const need = ['season', 'league_key', 'r', 'n_get', 'n_give'];
  for (const c of need) if (!cols.includes(c)) throw new Error(`trades csv: missing column ${c}`);
  return lines.filter(Boolean).map(l => {
    const v = l.split(',');
    const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    const season = Number(o.season);
    if (!Number.isInteger(season)) throw new Error(`trades csv: bad season ${o.season}`);
    if (season >= 2025) throw new Error(`trades csv: season ${season} present; 2025+ is never used`);
    return { season, key: o.league_key, r: Number(o.r),
      r_ros: o.r_ros === '' || o.r_ros == null ? NaN : Number(o.r_ros),
      n_get: Number(o.n_get), n_give: Number(o.n_give) };
  });
}

const r3 = x => (x == null || !Number.isFinite(x) ? x : +x.toFixed(3));

function grade(rows, band, col = 'r') {
  const xs = rows.filter(t => Number.isFinite(t[col]));
  const cov = bandCoverage(xs.map(t => t[col]), band);
  const ci = (pred) => {
    const c = clusteredShareCI(xs.map(t => ({ key: t.key, hit: pred(t[col]) ? 1 : 0 })));
    return [r3(c.est), r3(c.lo), r3(c.hi)];
  };
  return {
    n: cov.n, leagues: new Set(xs.map(t => t.key)).size,
    inside: ci(r => r >= band.lo && r <= band.hi),
    below: ci(r => r < band.lo),
    above: ci(r => r > band.hi)
  };
}

export function calibrate(trades) {
  const pick = seasons => trades.filter(t => seasons.includes(t.season));
  const fit = fitConformalBand(pick(FIT_SEASONS).map(t => t.r), pick(CAL_SEASONS).map(t => t.r), FITTED_BAND.alpha);
  const band = bandFromFit({ ...fit, version: 'refit' });
  const graded = pick(GRADE_SEASONS);
  const splits = {
    '2021-22 (fit+cal, descriptive)': pick([...FIT_SEASONS, ...CAL_SEASONS]),
    2023: pick([2023]), 2024: pick([2024]), '2023-24 pooled (HEADLINE)': graded
  };
  const out = { fit, band: { lo: band.lo, center: band.center, hi: band.hi, nominal: band.nominal },
    legacy_band: { lo: LEGACY_BAND.lo, hi: LEGACY_BAND.hi }, splits: {} };
  for (const [k, rows] of Object.entries(splits)) {
    out.splits[k] = { legacy: grade(rows, LEGACY_BAND), v2: grade(rows, band) };
  }
  const oneForOne = graded.filter(t => t.n_get === 1 && t.n_give === 1);
  const uneven = graded.filter(t => t.n_get !== t.n_give);
  out.subgroups_2023_24 = {
    one_for_one: { legacy: grade(oneForOne, LEGACY_BAND), v2: grade(oneForOne, band) },
    uneven_counts: { legacy: grade(uneven, LEGACY_BAND), v2: grade(uneven, band) },
    realized_ros_sensitivity: { legacy: grade(graded, LEGACY_BAND, 'r_ros'), v2: grade(graded, band, 'r_ros') }
  };
  const pooled = out.splits['2023-24 pooled (HEADLINE)'].v2.inside[0];
  out.target = { ...TARGET, pooled_v2: pooled, met: Math.abs(pooled - TARGET.nominal) <= TARGET.tol };
  out.matches_served_constants = fit.log_center === FITTED_BAND.log_center
    && fit.half_width === FITTED_BAND.half_width && fit.fit_n === FITTED_BAND.fit_n && fit.cal_n === FITTED_BAND.cal_n;
  return out;
}

function main(argv) {
  const at = argv.indexOf('--trades');
  if (at < 0 || !argv[at + 1]) {
    console.error('usage: node scripts/price-band-calibrate.mjs --trades <trades.csv> [--emit] [--check]');
    process.exit(2);
  }
  const out = calibrate(parseTrades(fs.readFileSync(argv[at + 1], 'utf8')));
  console.log(JSON.stringify(out, null, 2));
  if (argv.includes('--emit')) {
    const f = out.fit;
    console.log(`\nexport const FITTED_BAND = Object.freeze({\n  version: 'v2-conformal-2021-22', alpha: ${f.alpha},\n`
      + `  log_center: ${f.log_center}, half_width: ${f.half_width},\n`
      + `  fit_n: ${f.fit_n}, cal_n: ${f.cal_n}, fit_seasons: ${JSON.stringify(FIT_SEASONS)}, cal_seasons: ${JSON.stringify(CAL_SEASONS)}\n});`);
  }
  if (argv.includes('--check') && !(out.target.met && out.matches_served_constants)) {
    console.error(`CHECK FAILED: target met=${out.target.met}, served constants match refit=${out.matches_served_constants}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
