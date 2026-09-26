/**
 * SELL-HIGH FILTER (batch D item 12; ONE-PLAN section 4d night 5, spot-check row 1).
 *
 * One question, asked of Nick's roster: is a player's TD rate (TDs per opportunity) above his
 * expected TD rate (nflverse ffopportunity expected TDs per opportunity) by more than 1
 * percentage point over the last few weeks? If so he is a sell-high CANDIDATE: most TD surges
 * regress (79% of 10+ TD seasons in our nflverse 2016-2025 data).
 *
 * A LABEL with weight 0: nothing here moves a value, a price, a target or a served number.
 * SHADOW behind GRIDIRON_SELL_HIGH: the producer writes `_run.inputs.sell_high` (ids and counts
 * only; the repo is public) and nothing served reads it. The same `sellHighFlag` is what
 * `gradeSellHigh` grades, week by week, so the graded rule is exactly the shadow rule.
 *
 * Opportunities: QB pass attempts + carries; RB / WR / TE carries + targets.
 */

import { wilson } from '../reasoning/grade.js';
import { PINNED_NEVER_GIVE } from './never-give.js';

export const SELL_HIGH_ENV = 'GRIDIRON_SELL_HIGH';
export const sellHighEnabled = (env = process.env) => env[SELL_HIGH_ENV] === '1';

/** Every threshold in one place, so a local run prints exactly what it used. */
export const SELL_HIGH_RULE = Object.freeze({
  version: 1,
  basis: 'GUESS: 1pp gap from the plan; opportunity and week floors set by hand before any measurement',
  rate_gap: 0.01,        // flag when actual TD rate - expected TD rate > this (strictly)
  lookback: 4,           // weeks read before the as-of week (never the as-of week itself)
  min_games: 2,
  min_opportunities: 20,
  horizon: 4,            // grading: weeks read from the as-of week on
  min_forward_opportunities: 10,
  positions: Object.freeze(['QB', 'RB', 'WR', 'TE']),
});

/** Pre-registered pass bar (PR body "Pre-registration"). Changing it after a run is a new version. */
export const SELL_HIGH_PASS_BAR = Object.freeze({
  min_n: 40,             // distinct player-season flags (first as-of week each fires)
  min_hit_rate: 0.70,    // hit: forward TD-rate gap at most half the flagged gap
  min_ci_low: 0.60,      // Wilson 95% lower bound of the hit rate
  min_control_n: 100,    // unflagged player-seasons with enough opportunities
  // and the flagged group's mean forward TD-rate change must be below the control's (lift < 0)
});

const UNGRADED = Object.freeze({ status: 'ungraded',
  reason: 'no graded run yet: scripts/rnd/sell-high-grade.mjs needs the local nflverse tables' });

const finite = x => typeof x === 'number' && Number.isFinite(x);
const r4 = x => (finite(x) ? Math.round(x * 1e4) / 1e4 : null);
const pp = x => `${(Math.round(x * 1000) / 10).toFixed(1)}pp`;

/** Opportunities in one player-week row: QB attempts + carries, else carries + targets. */
export function opportunitiesOf(position, r) {
  const n = v => (finite(v) ? v : 0);
  return position === 'QB' ? n(r.attempts) + n(r.carries) : n(r.carries) + n(r.targets);
}

/**
 * Totals over a set of player-week rows ({ week, tds, xtd, opportunities }); weeks with no
 * expected-TD read are dropped whole, so both rates share one denominator.
 */
function totals(rows) {
  const read = rows.filter(r => finite(r.xtd) && finite(r.tds) && finite(r.opportunities));
  const opp = read.reduce((s, r) => s + r.opportunities, 0);
  const tds = read.reduce((s, r) => s + r.tds, 0);
  const xtd = read.reduce((s, r) => s + r.xtd, 0);
  return { games: read.length, opportunities: opp, tds, xtd,
    td_rate: opp > 0 ? tds / opp : null, expected_td_rate: opp > 0 ? xtd / opp : null,
    weeks: read.map(r => r.week) };
}

/**
 * The one rule. p: { player, position, rows: [{ week, tds, xtd, opportunities }] } for the
 * lookback window only (the caller picks the weeks).
 * @returns { player, status: 'flagged'|'not_flagged'|'unrated', gap, td_rate, expected_td_rate,
 *            opportunities, games, basis }
 */
export function sellHighFlag(p) {
  const rule = SELL_HIGH_RULE;
  const t = totals(p.rows ?? []);
  const out = { player: p.player, gap: null, td_rate: r4(t.td_rate), expected_td_rate: r4(t.expected_td_rate),
    opportunities: t.opportunities, games: t.games };
  if (!rule.positions.includes(p.position)) {
    return { ...out, status: 'unrated', basis: `no sell-high rule for position ${p.position ?? 'unknown'}` };
  }
  if (t.games < rule.min_games) {
    return { ...out, status: 'unrated', basis: `${t.games} games with expected TDs read, fewer than ${rule.min_games}` };
  }
  if (t.opportunities < rule.min_opportunities) {
    return { ...out, status: 'unrated', basis: `${t.opportunities} opportunities, fewer than ${rule.min_opportunities}` };
  }
  const gap = t.td_rate - t.expected_td_rate;
  // Strictly above the bar; 1e-9 absorbs float noise so exactly 1pp is not a flag.
  const flagged = gap - rule.rate_gap > 1e-9;
  const basis = `TD rate ${pp(t.td_rate)} vs expected ${pp(t.expected_td_rate)} on ${t.opportunities} opportunities `
    + `(${t.games} games): ${gap >= 0 ? '+' : ''}${pp(gap)}; ${flagged ? 'sell-high candidate' : 'not above the 1pp bar'}; label only, weight 0`;
  return { ...out, gap: r4(gap), status: flagged ? 'flagged' : 'not_flagged', basis };
}

/**
 * For `_run.inputs.sell_high`: Nick's roster only, ids and counts only (no names).
 * Nick's untouchables (the pinned never-give ids from never-give.js plus the adapter's untouchable
 * set) are never a sell-high candidate: they read 'untouchable', whatever their TD rate.
 * @param inputs readSellHighInputs() result: { players: Map id -> { player, position, rows }, sources }
 * @param opts.untouchable ids (adapter.untouchable); the pinned never-give ids are always added
 */
export function sellHighSummary(inputs, { grade = UNGRADED, untouchable = [] } = {}) {
  const keep = new Set([...PINNED_NEVER_GIVE, ...untouchable].map(String));
  const flags = [...inputs.players.values()].map(p => {
    const f = sellHighFlag(p);
    if (!keep.has(String(f.player))) return f;
    return { ...f, status: 'untouchable', basis: `untouchable (Nick's rule): never a sell candidate; ${f.basis}` };
  });
  const counts = { flagged: 0, not_flagged: 0, unrated: 0, untouchable: 0 };
  for (const f of flags) counts[f.status]++;
  return {
    lane: 'shadow', weight: 0, rule_version: SELL_HIGH_RULE.version, rule_basis: SELL_HIGH_RULE.basis,
    as_of_week: inputs.as_of_week ?? null, grade, counts, sources: inputs.sources ?? {},
    flags: flags.map(f => ({ player: f.player, status: f.status, gap: f.gap, td_rate: f.td_rate,
      expected_td_rate: f.expected_td_rate, opportunities: f.opportunities, basis: f.basis })),
  };
}

/**
 * Weekly grade. For every as-of week W and player: flag on weeks [W - lookback, W); outcome on
 * weeks [W, W + horizon). One flag per player-season (the first W it fires), so overlapping
 * windows do not count one surge several times. The control is every unflagged player-season
 * (first W with enough opportunities on both sides).
 *
 * hit: forward TD-rate gap <= half the flagged gap (the surge at least halves).
 * lift: flagged mean forward TD-rate change minus the control's; below 0 is what the label claims.
 *
 * @param seasons Map season -> Map player -> { position, rows: [{ week, tds, xtd, opportunities }] }
 * @param opts { asOfWeeks: number[] (default 5..14), bar }
 */
export function gradeSellHigh(seasons, { asOfWeeks = null, bar = SELL_HIGH_PASS_BAR } = {}) {
  const rule = SELL_HIGH_RULE;
  const weeks = asOfWeeks ?? Array.from({ length: 10 }, (_, i) => i + 5);
  const flagged = [], control = [], byWeek = new Map(weeks.map(w => [w, { week: w, n: 0, hits: 0 }]));
  for (const [season, players] of seasons) {
    for (const [player, p] of players) {
      let done = false, ctl = null;
      for (const w of weeks) {
        if (done) break;
        const window = p.rows.filter(r => r.week >= w - rule.lookback && r.week < w);
        const f = sellHighFlag({ player, position: p.position, rows: window });
        if (f.status === 'unrated') continue;
        const fwd = totals(p.rows.filter(r => r.week >= w && r.week < w + rule.horizon));
        if (fwd.opportunities < rule.min_forward_opportunities) continue;
        const change = fwd.td_rate - f.td_rate;
        const fwdGap = fwd.td_rate - fwd.expected_td_rate;
        if (f.status === 'flagged') {
          const hit = fwdGap <= f.gap / 2;
          flagged.push({ season, player, week: w, gap: f.gap, forward_gap: r4(fwdGap), change: r4(change), hit });
          const wk = byWeek.get(w); wk.n++; if (hit) wk.hits++;
          done = true;
        } else if (!ctl) ctl = { season, player, week: w, change: r4(change) };
      }
      if (!done && ctl) control.push(ctl);
    }
  }
  const n = flagged.length, hits = flagged.filter(f => f.hit).length;
  const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const hitRate = n ? hits / n : null;
  const ci = wilson(hits, n);
  const flagChange = mean(flagged.map(f => f.change)), ctlChange = mean(control.map(c => c.change));
  const lift = flagChange != null && ctlChange != null ? flagChange - ctlChange : null;
  let status, reason;
  if (n < bar.min_n || control.length < bar.min_control_n) {
    status = 'not_enough_data';
    reason = `n ${n} flags (needs ${bar.min_n}), ${control.length} controls (needs ${bar.min_control_n})`;
  } else if (hitRate >= bar.min_hit_rate && ci[0] >= bar.min_ci_low && lift < 0) {
    status = 'pass'; reason = 'every pre-registered bar met';
  } else {
    status = 'fail';
    reason = [hitRate < bar.min_hit_rate && `hit rate ${r4(hitRate)} < ${bar.min_hit_rate}`,
      ci[0] < bar.min_ci_low && `CI low ${r4(ci[0])} < ${bar.min_ci_low}`,
      !(lift < 0) && `lift ${r4(lift)} is not below 0`].filter(Boolean).join('; ');
  }
  return {
    status, reason, rule_version: rule.version, bar,
    n, hits, hit_rate: r4(hitRate), ci: ci ? ci.map(r4) : null,
    flagged_mean_change: r4(flagChange), control_mean_change: r4(ctlChange), control_n: control.length, lift: r4(lift),
    by_week: [...byWeek.values()].filter(w => w.n > 0).map(w => ({ ...w, hit_rate: r4(w.hits / w.n) })),
    flags: flagged,
  };
}
