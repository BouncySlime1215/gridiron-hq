/**
 * Why the model likes a pick.
 *
 * The rationale here is *derived*, not narrated. Each factor is a real
 * comparison between the two teams on one variable, scored by how far apart
 * they are in league-relative terms, and the text simply reports the numbers
 * that produced the edge. Nothing is invented after the fact to justify a
 * pick the model already made.
 *
 * Opposing evidence is surfaced with equal weight. A pick whose case is thin,
 * or that the market has already moved against, should look thin — that is the
 * whole point of reading the reasoning before betting it.
 *
 * On public betting percentages: there is no free, licensed feed for ticket or
 * handle splits. Rather than scrape one, this uses line movement, which is the
 * signal those percentages are usually a proxy for anyway — where the number
 * opened, where it sits now, and whether it moved toward the side the model
 * likes. `publicSignal()` documents exactly where a real splits feed would drop
 * in if one is ever licensed.
 */
import { rows } from '../db/index.js';
import { teamFeatureVector } from './nfl-features.js';
import { teamWeeks } from './nfl-pbp.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => {
  const m = avg(a);
  return m == null ? null : Math.sqrt(avg(a.map(v => (v - m) ** 2)));
};

/**
 * The variables a human would actually cite when arguing a side. Deliberately
 * a curated subset of the full catalog — a rationale listing 340 numbers is not
 * a rationale. `higherIsBetter` says which direction favours the team.
 */
const EXPLAINERS = [
  { key: 'off_epa_neutral_wp', label: 'offensive efficiency (garbage time removed)', better: 'higher', unit: 'EPA/play', markets: ['spread', 'moneyline', 'total'] },
  { key: 'def_epa_neutral_wp', label: 'defensive efficiency (garbage time removed)', better: 'lower', unit: 'EPA/play allowed', markets: ['spread', 'moneyline', 'total'] },
  { key: 'off_success_rate_neutral_wp', label: 'offensive success rate', better: 'higher', unit: '', markets: ['spread', 'moneyline'] },
  { key: 'off_explosive_play_rate', label: 'explosive play rate', better: 'higher', unit: '', markets: ['spread', 'total'] },
  { key: 'def_explosive_play_rate', label: 'explosive plays allowed', better: 'lower', unit: '', markets: ['spread', 'total'] },
  { key: 'def_havoc_rate', label: 'defensive havoc rate', better: 'higher', unit: '', markets: ['spread', 'moneyline'] },
  { key: 'off_pressure_epa_delta', label: 'resilience under pressure', better: 'higher', unit: 'EPA', markets: ['spread'] },
  { key: 'off_drive_scoring_rate', label: 'drive scoring rate', better: 'higher', unit: '', markets: ['spread', 'total'] },
  { key: 'def_drive_scoring_rate', label: 'drive scoring rate allowed', better: 'lower', unit: '', markets: ['spread', 'total'] },
  { key: 'off_three_and_out_rate', label: 'three-and-out rate', better: 'lower', unit: '', markets: ['spread', 'total'] },
  { key: 'off_red_zone_td_rate', label: 'red zone touchdown rate', better: 'higher', unit: '', markets: ['spread', 'total'] },
  { key: 'off_third_down_rate', label: 'third down conversion rate', better: 'higher', unit: '', markets: ['spread'] },
  { key: 'net_turnover_rate', label: 'turnover margin', better: 'higher', unit: '', markets: ['spread', 'moneyline'] },
  { key: 'off_avg_drive_start', label: 'average starting field position', better: 'higher', unit: 'yd', markets: ['spread'] },
  { key: 'off_epa_q4_close', label: 'late-game execution in one-score games', better: 'higher', unit: 'EPA/play', markets: ['spread', 'moneyline'] },
  { key: 'off_epa_volatility', label: 'week-to-week volatility', better: 'lower', unit: '', markets: ['spread'] },
  { key: 'off_seconds_per_drive', label: 'pace (time per drive)', better: 'lower', unit: 's', markets: ['total'] },
  { key: 'off_proe', label: 'pass rate over expected', better: 'higher', unit: '', markets: ['total'] },
  { key: 'off_yards_per_drive', label: 'yards per drive', better: 'higher', unit: 'yd', markets: ['total'] },
  { key: 'opp_adj_net_epa', label: 'opponent-adjusted net efficiency', better: 'higher', unit: 'EPA/play', markets: ['spread', 'moneyline'] },
  { key: 'sos_played', label: 'strength of schedule faced', better: 'higher', unit: '', markets: ['spread'] }
];

/** League mean and spread for each explainer, so a gap can be scored not just stated. */
function leagueNorms(season, week) {
  const all = teamWeeks(season).filter(t => t.week < week);
  const norms = {};
  for (const { key } of EXPLAINERS) {
    const vals = all.map(t => t.features[key]).filter(v => v != null);
    if (vals.length >= 20) norms[key] = { mean: avg(vals), sd: sd(vals) || 1 };
  }
  return norms;
}

const fmt = (v, unit) => {
  if (v == null) return '—';
  if (unit === '') return `${(v * 100).toFixed(1)}%`;
  return `${v.toFixed(unit === 'EPA/play' || unit === 'EPA' ? 3 : 1)}${unit ? ' ' + unit : ''}`;
};

/**
 * Compares the picked team against its opponent across the explainer set and
 * splits the result into evidence for and against.
 */
function factorAnalysis(season, week, pickTeam, oppTeam, market) {
  const a = teamFeatureVector(season, week, pickTeam);
  const b = teamFeatureVector(season, week, oppTeam);
  const norms = leagueNorms(season, week);

  const factors = [];
  for (const ex of EXPLAINERS) {
    if (!ex.markets.includes(market)) continue;
    const va = a[ex.key], vb = b[ex.key];
    if (va == null || vb == null) continue;
    const n = norms[ex.key];
    if (!n) continue;
    // Positive edge always means "this favours the team we picked".
    const raw = ex.better === 'higher' ? va - vb : vb - va;
    const z = raw / n.sd;
    factors.push({
      key: ex.key, label: ex.label, unit: ex.unit,
      pick_value: r2(va), opponent_value: r2(vb),
      pick_display: fmt(va, ex.unit), opponent_display: fmt(vb, ex.unit),
      edge: r2(raw), strength: r2(Math.abs(z)), favors_pick: raw > 0
    });
  }
  factors.sort((x, y) => y.strength - x.strength);
  return {
    supporting: factors.filter(f => f.favors_pick).slice(0, 6),
    opposing: factors.filter(f => !f.favors_pick).slice(0, 4),
    considered: factors.length
  };
}

/* ------------------------------------------------------- market sentiment */

/**
 * What the market has done since the line opened.
 *
 * This stands in for public betting splits, which have no free licensed feed.
 * Movement is the more decision-relevant half of that signal anyway: a line
 * moving *away* from the popular side is the classic sign that sharper money
 * disagrees with the crowd.
 */
export function publicSignal(season, week, team, market) {
  const g = rows(`SELECT spread, total, open_spread, open_total, moneyline, book_count
                  FROM game_lines WHERE season=? AND week=? AND team=?`, season, week, team)[0];
  if (!g) return null;

  const out = {
    availability: 'line movement only',
    note: 'Public ticket and handle splits require a licensed feed (none is free). Line movement is used instead — it is what those splits are usually a proxy for.',
    books_quoted: g.book_count ?? null
  };

  if (market === 'total' && g.open_total != null && g.total != null) {
    const move = +(g.total - g.open_total).toFixed(1);
    out.opened = g.open_total; out.current = g.total; out.movement = move;
    out.direction = move > 0 ? 'up' : move < 0 ? 'down' : 'flat';
    out.interpretation = move === 0
      ? 'The total has not moved since it opened — no strong money on either side.'
      : `The total has moved ${Math.abs(move)} point${Math.abs(move) === 1 ? '' : 's'} ${move > 0 ? 'up' : 'down'}, so money has come in on the ${move > 0 ? 'over' : 'under'}.`;
  } else if (g.open_spread != null && g.spread != null) {
    const move = +(g.spread - g.open_spread).toFixed(1);
    out.opened = g.open_spread; out.current = g.spread; out.movement = move;
    // Spread is stated from this team's perspective, negative = favoured, so a
    // decrease means the number moved toward this team.
    out.direction = move < 0 ? 'toward this team' : move > 0 ? 'away from this team' : 'flat';
    out.interpretation = move === 0
      ? 'The spread has not moved since it opened.'
      : `The spread has moved ${Math.abs(move)} point${Math.abs(move) === 1 ? '' : 's'} ${move < 0 ? 'toward' : 'away from'} this team since opening, meaning money has come in ${move < 0 ? 'on them' : 'against them'}.`;
  }
  return out;
}

/* ---------------------------------------------------------------- explain */

/**
 * A complete, evidence-backed case for one pick: the model's number, what the
 * market says, the factors driving the gap, the honest counter-argument, and
 * how the line has moved.
 */
export function explainPick({ season, week, market, pickTeam, oppTeam, side, line,
                              modelProbability, impliedProbability, detail }) {
  const fa = pickTeam && oppTeam ? factorAnalysis(season, week, pickTeam, oppTeam, market) : { supporting: [], opposing: [], considered: 0 };
  const sentiment = pickTeam ? publicSignal(season, week, pickTeam, market) : null;

  const edge = modelProbability != null && impliedProbability != null
    ? modelProbability - impliedProbability : null;

  // Totals already carry the number in `side` ("Over 38.5"); appending `line`
  // again produced "Over 38.5 38.5".
  const label = line != null && !String(side).includes(String(line))
    ? `${side} ${line}` : String(side);
  const headline = edge == null
    ? `Model likes ${label}.`
    : `Model gives ${label} a ${(modelProbability * 100).toFixed(1)}% chance versus ${(impliedProbability * 100).toFixed(1)}% priced in — a ${(edge * 100).toFixed(1)}-point disagreement.`;

  // Does the market's own movement agree with us, or is it a warning?
  let marketAgreement = null;
  if (sentiment?.movement != null && sentiment.movement !== 0) {
    const movedToward = market === 'total'
      ? (/over/i.test(side) ? sentiment.movement > 0 : sentiment.movement < 0)
      : sentiment.movement < 0;
    marketAgreement = movedToward
      ? 'The line has moved in the same direction as this pick, so the market is drifting toward our side — the edge may be closing.'
      : 'The line has moved against this pick. Either we are early and the market is wrong, or money knows something the model does not. Treat with extra caution.';
  }

  const bullets = fa.supporting.map(f =>
    `${cap(f.label)}: ${f.pick_display} vs ${f.opponent_display} for the opponent.`);
  const counters = fa.opposing.map(f =>
    `${cap(f.label)}: ${f.pick_display} vs ${f.opponent_display} — this favours the other side.`);

  // Week 1 has no prior games to compare, so there is genuinely nothing to
  // reason from. Saying that is better than an empty panel labelled "contested".
  const noHistory = fa.considered === 0;

  return {
    headline,
    model_probability: modelProbability, implied_probability: impliedProbability,
    edge: edge == null ? null : r2(edge),
    projection_note: detail ?? null,
    factors_considered: fa.considered,
    no_history: noHistory,
    no_history_note: noHistory
      ? `No games have been played yet in ${season} before week ${week}, so there is no team-vs-team evidence to weigh. This pick rests on the ratings carried over from prior seasons.`
      : null,
    supporting: fa.supporting, opposing: fa.opposing,
    supporting_text: bullets, opposing_text: counters,
    market_sentiment: sentiment,
    market_agreement: marketAgreement,
    confidence: noHistory ? 'no in-season evidence yet' : confidenceLabel(edge, fa)
  };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Confidence blends the size of the disagreement with how one-sided the
 * evidence is. A big edge supported by one lonely factor is not the same bet
 * as a modest edge where everything points the same way.
 */
function confidenceLabel(edge, fa) {
  if (edge == null) return 'unpriced';
  const support = fa.supporting.reduce((s, f) => s + f.strength, 0);
  const against = fa.opposing.reduce((s, f) => s + f.strength, 0);
  const ratio = support / Math.max(0.5, support + against);
  const e = Math.abs(edge);
  if (e >= 0.08 && ratio >= 0.65) return 'strong';
  if (e >= 0.05 && ratio >= 0.55) return 'moderate';
  if (ratio < 0.45) return 'contested — the evidence is split';
  return 'lean';
}

/** Batch helper: attach reasoning to a list of board rows. */
export function explainBoard(season, week, board) {
  return board.map(b => ({
    ...b,
    reasoning: explainPick({
      season, week, market: b.market,
      pickTeam: b.market === 'total' ? b.home_team : b.selection,
      oppTeam: b.market === 'total'
        ? b.away_team
        : (b.selection === b.home_team ? b.away_team : b.home_team),
      side: b.side, line: b.line,
      modelProbability: b.model_probability,
      impliedProbability: b.implied_probability,
      detail: b.detail
    })
  }));
}
