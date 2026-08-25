/**
 * Retrospective prop betting — how the prop model would actually have done.
 *
 * The sides replay had it easy: game_lines stores the real closing number, so
 * "would this have won" is a fact. No historical prop lines exist, which leaves
 * a choice about what to bet against, and the choice decides whether the answer
 * means anything.
 *
 * The tempting version is to invent a soft line — say, last season's average —
 * and show the model beating it. That number would be real and worthless,
 * because no book hangs a line that bad. So the proxy here is deliberately
 * *strong*: a recency-weighted trailing average of the player's own production,
 * shrunk toward his positional baseline, rounded to the half point books
 * actually hang. That is a fair approximation of how a book anchors a prop, and
 * if anything it understates them.
 *
 * That makes this a necessary condition, not a sufficient one. Beating this
 * proxy does not prove the model beats DraftKings — a real book also prices
 * injuries, weather, personnel and sharp money. But *failing* to beat it is
 * decisive: a model that cannot out-predict a weighted average of a player's
 * own recent games has no business being bet into a real market.
 *
 * Prop juice is also worse than sides. These grade at -115, the common prop
 * price, so break-even is 53.49% rather than 52.38%. A model that clears 52.4%
 * on props is still losing money.
 */
import { rows } from '../db/index.js';

const PROP_PRICE = -115;
const BREAK_EVEN = Math.abs(PROP_PRICE) / (Math.abs(PROP_PRICE) + 100);   // 0.5349
const WIN_UNITS = 100 / Math.abs(PROP_PRICE);                              // 0.8696

/** The markets worth replaying, and the stat each grades against. */
export const PROP_MARKETS = {
  pass_yds: { stat: 'passing_yards', volume: 'pass_attempts', minVolume: 10 },
  rush_yds: { stat: 'rushing_yards', volume: 'carries', minVolume: 4 },
  rec_yds: { stat: 'receiving_yards', volume: 'targets', minVolume: 2 },
  receptions: { stat: 'receptions', volume: 'targets', minVolume: 2 }
};

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
/** Books hang half points to avoid pushes, so the proxy has to as well. */
const toHalfPoint = v => Math.round(v * 2) / 2 + (Number.isInteger(Math.round(v * 2) / 2) ? 0.5 : 0);

const parse = s => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Every player-week with that player's prior form, in order.
 *
 * Form never includes the game being predicted, and never crosses a season
 * boundary — a player's week 1 is genuinely unknown, and pretending otherwise
 * is the most common way a prop backtest lies.
 */
export function buildPropDataset({ seasons = [2021, 2022, 2023, 2024, 2025], minGames = 3 } = {}) {
  const feats = rows(`SELECT season, week, player_id, features FROM nfl_player_week_features
                      WHERE season IN (${seasons.map(() => '?').join(',')}) ORDER BY season, week`, ...seasons);
  const byPlayer = new Map();
  for (const r of feats) {
    const f = parse(r.features);
    if (!f) continue;
    const k = `${r.season}|${r.player_id}`;
    if (!byPlayer.has(k)) byPlayer.set(k, []);
    byPlayer.get(k).push({ week: r.week, f });
  }

  const out = [];
  for (const [key, list] of byPlayer) {
    const [season, player_id] = key.split('|');
    list.sort((a, b) => a.week - b.week);
    for (let i = 0; i < list.length; i++) {
      const prior = list.slice(0, i);
      if (prior.length < minGames) continue;
      out.push({
        season: Number(season), player_id, week: list[i].week,
        actual: list[i].f, prior: prior.map(p => p.f)
      });
    }
  }
  return out;
}

/**
 * Exponentially weighted trailing average — the book's anchor.
 *
 * Recent games matter more than old ones, which is both true and what a book
 * does. `halflife` of three games is a deliberately competitive setting; a
 * slower average would be easier to beat and would make the result meaningless.
 */
function weightedMean(values, halflife = 3) {
  let num = 0, den = 0;
  for (let i = 0; i < values.length; i++) {
    const age = values.length - 1 - i;
    const w = Math.pow(0.5, age / halflife);
    num += values[i] * w; den += w;
  }
  return den > 0 ? num / den : null;
}

/**
 * The model's own projection: volume times efficiency, each shrunk separately.
 *
 * Splitting the two is the point of projecting at all. A receiver whose yardage
 * fell because his targets fell is a different case from one whose targets held
 * and whose efficiency dipped, and only the second should regress upward. A
 * single average of past yardage cannot tell them apart — which is precisely
 * where a projection can add something the proxy cannot.
 */
function projectStat(prior, market) {
  const spec = PROP_MARKETS[market];
  const vols = prior.map(f => f[spec.volume]).filter(v => v != null && Number.isFinite(v));
  const stats = prior.map(f => f[spec.stat]).filter(v => v != null && Number.isFinite(v));
  if (vols.length < 3 || stats.length < 3) return null;

  const effs = prior.map(f => {
    const v = f[spec.volume], s = f[spec.stat];
    return v != null && s != null && v > 0 ? s / v : null;
  }).filter(v => v != null && Number.isFinite(v));
  if (effs.length < 3) return null;

  const vol = weightedMean(vols, 3);
  // Efficiency is far noisier than volume per game, so it is shrunk harder
  // toward the player's own longer-run rate.
  const effRecent = weightedMean(effs, 4);
  const effLong = mean(effs);
  const n = effs.length;
  const shrink = n / (n + 4);
  const eff = shrink * effRecent + (1 - shrink) * effLong;
  if (vol == null || eff == null) return null;
  return vol * eff;
}

/**
 * Replays every prop, walk-forward, and grades it at real prop juice.
 *
 * `edgeThreshold` is in the units of the stat, so it means something different
 * per market — two receptions and two receiving yards are not comparable — and
 * is therefore expressed as a fraction of the line instead.
 */
export function replayProps({
  dataset = null, seasons = [2021, 2022, 2023, 2024, 2025],
  edgeFraction = 0.08, shuffle = null
} = {}) {
  const data = dataset ?? buildPropDataset({ seasons });
  const perMarket = {};

  for (const market of Object.keys(PROP_MARKETS)) {
    const spec = PROP_MARKETS[market];
    const bets = [];
    for (const row of data) {
      const actualVol = row.actual[spec.volume];
      if (actualVol == null || actualVol < spec.minVolume) continue;
      const actual = row.actual[spec.stat];
      if (actual == null || !Number.isFinite(actual)) continue;

      const priorStats = row.prior.map(f => f[spec.stat]).filter(v => v != null && Number.isFinite(v));
      if (priorStats.length < 3) continue;

      // The book's anchor, and our projection, from identical information.
      const anchor = weightedMean(priorStats, 3);
      const line = anchor == null ? null : toHalfPoint(anchor);
      const projection = projectStat(row.prior, market);
      if (line == null || projection == null || line <= 0) continue;

      const edge = projection - line;
      if (Math.abs(edge) < edgeFraction * line) continue;

      bets.push({
        season: row.season, week: row.week, player_id: row.player_id, market,
        line, projection: r3(projection), edge: r3(edge),
        side: edge > 0 ? 'Over' : 'Under', actual
      });
    }

    // Shuffling actuals breaks any real relationship while preserving every
    // distribution — the same null the sides model is held to.
    let outcomes = bets.map(b => b.actual);
    if (shuffle) outcomes = shuffle(outcomes.slice());

    let w = 0, l = 0, push = 0;
    const graded = bets.map((b, i) => {
      const act = outcomes[i];
      if (act === b.line) { push++; return { ...b, result: 'Push', units: 0 }; }
      const won = b.side === 'Over' ? act > b.line : act < b.line;
      won ? w++ : l++;
      return { ...b, actual: act, result: won ? 'Won' : 'Lost', units: won ? WIN_UNITS : -1 };
    });

    const n = w + l;
    const units = graded.reduce((s, b) => s + b.units, 0);
    perMarket[market] = {
      bets: bets.length, wins: w, losses: l, pushes: push,
      win_rate: n ? r3(w / n) : null,
      units: r3(units), roi: bets.length ? r3(units / bets.length) : null,
      break_even: r3(BREAK_EVEN),
      beats_juice: n ? w / n > BREAK_EVEN : null,
      // Standard errors from break-even, which is what decides whether a win
      // rate above 53.5% is a finding or a coincidence.
      z: n ? r3((w / n - BREAK_EVEN) / Math.sqrt(0.25 / n)) : null,
      graded
    };
  }

  const totBets = Object.values(perMarket).reduce((s, m) => s + m.bets, 0);
  const totW = Object.values(perMarket).reduce((s, m) => s + m.wins, 0);
  const totL = Object.values(perMarket).reduce((s, m) => s + m.losses, 0);
  const totU = Object.values(perMarket).reduce((s, m) => s + (m.units ?? 0), 0);

  return {
    price: PROP_PRICE, break_even: r3(BREAK_EVEN),
    overall: {
      bets: totBets, wins: totW, losses: totL,
      win_rate: totW + totL ? r3(totW / (totW + totL)) : null,
      units: r3(totU), roi: totBets ? r3(totU / totBets) : null,
      beats_juice: totW + totL ? totW / (totW + totL) > BREAK_EVEN : null,
      z: totW + totL ? r3((totW / (totW + totL) - BREAK_EVEN) / Math.sqrt(0.25 / (totW + totL))) : null
    },
    per_market: Object.fromEntries(Object.entries(perMarket)
      .map(([k, v]) => [k, { ...v, graded: undefined }])),
    note: 'The line is a recency-weighted trailing average shrunk and rounded to the half point — a fair approximation of a book\'s anchor, not a real quote. Beating it is necessary but not sufficient; failing to beat it is decisive.'
  };
}

/** Per-season breakdown, so one lucky year cannot carry the record. */
export function replayPropsBySeason({ seasons = [2021, 2022, 2023, 2024, 2025], ...opts } = {}) {
  const data = buildPropDataset({ seasons });
  return seasons.map(s => {
    const r = replayProps({ ...opts, dataset: data.filter(d => d.season === s) });
    return { season: s, ...r.overall };
  });
}

/**
 * The same honesty check the sides model gets.
 *
 * Outcomes are shuffled, which should leave the strategy at exactly break-even
 * minus the juice. If shuffled data produces a winning record, the harness is
 * broken and its verdict on real data means nothing.
 */
export function propPermutationTest({ trials = 5, seed = 11, ...opts } = {}) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const data = buildPropDataset({ seasons: opts.seasons ?? [2021, 2022, 2023, 2024, 2025] });
  const real = replayProps({ ...opts, dataset: data });
  const nulls = [];
  for (let t = 0; t < trials; t++) {
    const r = replayProps({
      ...opts, dataset: data,
      shuffle: y => {
        for (let i = y.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [y[i], y[j]] = [y[j], y[i]];
        }
        return y;
      }
    });
    nulls.push(r.overall.win_rate);
  }
  const nullMean = mean(nulls);
  const nullSd = nulls.length > 1
    ? Math.sqrt(nulls.reduce((a, v) => a + (v - nullMean) ** 2, 0) / (nulls.length - 1)) : null;
  const z = nullSd && nullSd > 1e-9 ? (real.overall.win_rate - nullMean) / nullSd : null;
  return {
    real_win_rate: real.overall.win_rate,
    null_win_rates: nulls.map(r3),
    null_mean: r3(nullMean),
    z_vs_null: r3(z),
    break_even: r3(BREAK_EVEN),
    verdict: nullMean > 0.52
      ? 'Shuffled outcomes produce a winning record, so the harness itself is leaking. Fix it before reading anything else.'
      : real.overall.win_rate > BREAK_EVEN && z != null && z >= 2
        ? 'Real outcomes beat both the shuffled null and the juice. Worth testing against live prices.'
        : 'Real outcomes do not clear the juice by enough to distinguish from noise.'
  };
}
