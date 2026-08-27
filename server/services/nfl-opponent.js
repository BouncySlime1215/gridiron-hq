/**
 * Opponent adjustment, second attempt — on efficiency, not volume.
 *
 * The first attempt (`nfl-context-heads.js`, 80 defense-vs-position variants)
 * did not merely fail to help; it got monotonically WORSE as more weight was
 * applied — passing-yards MAE 70.56 at weight 0 rising to 90.81 at weight 1,
 * on every stat. A signal that is merely uninformative degrades gracefully.
 * One that degrades monotonically is being applied in the wrong place.
 *
 * The likely cause is double counting. `gameScriptFor` already shifts volume
 * using the betting line, and the line ALREADY prices the opponent — a team
 * facing a great defense is an underdog, throws more, and the game-script
 * layer has handled that. Multiplying volume by an opponent factor on top of
 * a line that already knows the opponent applies the same information twice,
 * in the same direction, with no shrinkage between them.
 *
 * So this attempt adjusts the other half of `volume x efficiency`: how many
 * yards a defense allows PER opportunity. That is the part the market line
 * does not directly encode, and it is where a defense's actual effect on a
 * player's stat line lives — a good secondary does not usually reduce a
 * receiver's targets, it reduces his yards per target.
 *
 * Everything is cutoff-safe (prior seasons only), shrunk toward neutral by
 * sample weight, and — as with every candidate here — validated out of sample
 * before being given any authority. The prior attempt's failure is the reason
 * this one is structured as a hypothesis rather than a fix.
 */
import { playerWeeks } from './nfl-pbp.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const shrink = (observed, prior, weight, k) => ((observed * weight) + (prior * k)) / (weight + k);
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Efficiency allowed by each defense, per position, relative to league
 * average — built from seasons strictly before `throughSeason`.
 *
 * Rate stats, not totals: totals confound "this defense is good" with "this
 * defense faced few plays". A defense that allows 6.0 yards per attempt is
 * making a statement about efficiency regardless of how often it was thrown on.
 */
const cache = new Map();
export function opponentEfficiency(metricKey, throughSeason) {
  const key = `${metricKey}|${throughSeason}`;
  if (cache.has(key)) return cache.get(key);

  const NUM = { pass_yds: 'passing_yards', rush_yds: 'rushing_yards', rec_yds: 'receiving_yards', receptions: 'receptions' };
  const DEN = { pass_yds: 'pass_attempts', rush_yds: 'carries', rec_yds: 'targets', receptions: 'targets' };
  const num = NUM[metricKey], den = DEN[metricKey];
  if (!num) throw new Error(`no opponent-efficiency config for ${metricKey}`);

  const weightOf = s => ({ [throughSeason - 1]: 1, [throughSeason - 2]: 0.6, [throughSeason - 3]: 0.35 })[s] ?? 0;
  const bucket = new Map();     // `${opp}|${pos}` -> {num, den, w}
  const league = new Map();     // pos -> {num, den, w}
  for (const s of [throughSeason - 1, throughSeason - 2, throughSeason - 3]) {
    const w = weightOf(s);
    if (!w) continue;
    for (const r of playerWeeks(s)) {
      const n = r.features[num], d = r.features[den];
      if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || !r.opponent || !r.position) continue;
      const k = `${r.opponent}|${r.position}`;
      const b = bucket.get(k) ?? { num: 0, den: 0, w: 0 };
      b.num += n * w; b.den += d * w; b.w += d * w;
      bucket.set(k, b);
      const l = league.get(r.position) ?? { num: 0, den: 0 };
      l.num += n * w; l.den += d * w;
      league.set(r.position, l);
    }
  }
  const leagueRate = new Map([...league].map(([pos, l]) => [pos, l.den > 0 ? l.num / l.den : null]));
  const table = new Map();
  for (const [k, b] of bucket) {
    const pos = k.split('|')[1];
    const lg = leagueRate.get(pos);
    if (!lg || b.den <= 0) continue;
    table.set(k, { rate: b.num / b.den, ratio: (b.num / b.den) / lg, weight: b.w });
  }
  const out = { table, leagueRate };
  cache.set(key, out);
  return out;
}

/** Shrunk multiplier for one defense/position, 1 when we have no read. */
export function opponentEfficiencyMult(metricKey, throughSeason, opponent, position, k = 400) {
  const { table } = opponentEfficiency(metricKey, throughSeason);
  const b = table.get(`${opponent}|${position}`);
  if (!b) return 1;
  return shrink(b.ratio, 1, b.weight, k);
}

/**
 * Does adjusting EFFICIENCY by opponent beat not adjusting?
 *
 * Deliberately tested standalone — predicting a player's per-opportunity rate
 * from his own prior rate, with and without the opponent multiplier — rather
 * than layered onto the full engine. If the signal cannot improve the
 * narrowest, cleanest version of its own question, layering it into a
 * pipeline that already contains game script would only obscure why.
 */
export function validateOpponentEfficiency({ fitThrough = 2024, testSeason = 2025, kValues = [100, 200, 400, 800, 1600] } = {}) {
  const NUM = { pass_yds: 'passing_yards', rush_yds: 'rushing_yards', rec_yds: 'receiving_yards', receptions: 'receptions' };
  const DEN = { pass_yds: 'pass_attempts', rush_yds: 'carries', rec_yds: 'targets', receptions: 'targets' };
  const MIN_DEN = { pass_yds: 10, rush_yds: 3, rec_yds: 2, receptions: 2 };

  const out = {};
  for (const metricKey of Object.keys(NUM)) {
    const num = NUM[metricKey], den = DEN[metricKey], minDen = MIN_DEN[metricKey];
    const history = new Map();
    const rowsOut = [];
    const weeks = playerWeeks(testSeason).filter(r => r.week >= 2)
      .sort((a, b) => a.week - b.week);
    for (const r of weeks) {
      const n = r.features[num], d = r.features[den];
      const usable = Number.isFinite(n) && Number.isFinite(d) && d >= minDen && r.opponent && r.position;
      if (usable) {
        const hist = history.get(r.player_id);
        if (hist && hist.length >= 2) {
          const ownRate = hist.reduce((s, x) => s + x, 0) / hist.length;
          rowsOut.push({ player_id: r.player_id, position: r.position, opponent: r.opponent,
            own_rate: ownRate, actual_rate: n / d, opportunities: d });
        }
        const arr = history.get(r.player_id) ?? [];
        arr.push(n / d);
        history.set(r.player_id, arr);
      }
    }
    if (rowsOut.length < 50) { out[metricKey] = { error: `too few rows (${rowsOut.length})` }; continue; }

    const errBase = rowsOut.map(x => Math.abs(x.own_rate - x.actual_rate));
    const mae = a => r4(a.reduce((s, x) => s + x, 0) / a.length);
    const perK = {};
    for (const k of kValues) {
      const errAdj = rowsOut.map(x =>
        Math.abs(x.own_rate * opponentEfficiencyMult(metricKey, testSeason, x.opponent, x.position, k) - x.actual_rate));
      const test = pairedBootstrapDiff(errBase, errAdj, { iterations: 2000, seed: 17 });
      perK[k] = { adjusted_mae: mae(errAdj), bootstrap: test,
        improves: test.significant === true && test.mean_diff < 0 };
    }
    const best = Object.entries(perK).sort((a, b) => a[1].adjusted_mae - b[1].adjusted_mae)[0];
    out[metricKey] = {
      n: rowsOut.length, unadjusted_mae: mae(errBase), by_shrinkage: perK,
      best_k: Number(best[0]), best: best[1],
      any_improves: Object.values(perK).some(v => v.improves)
    };
  }
  return { fit_through: fitThrough, test_season: testSeason, metrics: out,
    note: 'Per-opportunity RATE, predicted from the player\'s own prior rate this season, with and ' +
      'without a shrunk opponent multiplier built from prior seasons only. Standalone by design: ' +
      'the volume-side attempt failed because game script already prices the opponent.' };
}
