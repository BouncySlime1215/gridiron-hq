/**
 * PLAYOFF-WEEK VALUE (batch D item 28): how hard each player's playoff-week opponents are,
 * read from THIS season's games, as a points delta on the title sim's own expected points
 * for those weeks. Research R6 as a TIEBREAKER only.
 *
 * Prior evidence says this is likely noise (matchups.js MATCHUP_EVIDENCE: DvP did not beat
 * no adjustment on held-out 2025; an early-season DvP read correlates r ~ 0.01 with weeks
 * 15-17). So nothing here moves a served number:
 *   - no multiplier enters season-sim.js#weekPool (matchups.js switches stay false);
 *   - the tiebreak on the served targets is LOGGED (`applied: false`), never applied.
 * SHADOW behind GRIDIRON_PLAYOFF_WEEK_VALUE: the producer writes `_run.inputs.playoff_week`
 * (ids only; the repo is public). The pass bar that would let a follow-up use the tiebreak:
 * docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md, graded by gradePlayoffWeek below
 * (scripts/rnd/playoff-week-grade.mjs on the local tables).
 */

import { shrink } from '../stats-util.js';
import { pairedBootstrapDiff } from '../backtest-significance.js';

export const PLAYOFF_WEEK_ENV = 'GRIDIRON_PLAYOFF_WEEK_VALUE';

/** 'off' | 'shadow'. Preview mode never turns it on; there is no served mode. */
export function playoffWeekMode(env = process.env) {
  const v = env[PLAYOFF_WEEK_ENV];
  return v === 'shadow' || v === '1' ? 'shadow' : 'off';
}

/** Every constant in one place, so a local run prints exactly what it used. */
export const PLAYOFF_WEEK_RULE = Object.freeze({
  version: 1,
  // matchups.js#computeDvp's method and constants: K 200 was fitted there (2023+2024);
  // the floors drop garbage-time lines that pull every defense to the same number.
  k: 200,
  floors: Object.freeze({ QB: 6, RB: 4, WR: 4, TE: 3 }),
  positions: Object.freeze(['QB', 'RB', 'WR', 'TE']),
  role: 'tiebreaker',
  // Two served targets tie when their title gains sit within this many combined SEs.
  tie_se: 1,
  basis: 'same-season defense vs position, shrunk (K 200); a tiebreaker, weight 0 until graded',
});

/** Pre-registered pass bar (docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md). Changing it after a run is a new version. */
export const PLAYOFF_WEEK_PASS_BAR = Object.freeze({
  as_of_week: 13,
  playoff_weeks: Object.freeze([15, 16, 17]),
  held_out: 2025,                               // P1: 90% CI of the MAE change entirely below 0
  no_reversal: Object.freeze([2023, 2024]),     // P2: mean MAE change <= 0
  min_player_weeks: 300,                        // P3: per season
  min_games: 4,                                 // baseline: games before the as-of week
  iterations: 2000, seed: 1,
});

const UNGRADED = Object.freeze({ status: 'ungraded',
  reason: 'no graded run yet: scripts/rnd/playoff-week-grade.mjs needs the local nflverse tables' });

const finite = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;

/**
 * Defense vs position from one season's lines (every game weighted 1), each game measured
 * against the player's own leave-one-out baseline, shrunk toward 1 with K.
 * lines: [{ player, position, opponent, week, pts }] (the caller picks the weeks).
 * @returns Map `${opponent}|${position}` -> { mult, observed, games, ratio_games }
 */
export function defenseRatios(lines, { k = PLAYOFF_WEEK_RULE.k, floors = PLAYOFF_WEEK_RULE.floors } = {}) {
  const useful = lines.filter(l => floors[l.position] != null && finite(l.pts) && l.pts >= floors[l.position] && l.opponent);
  const player = new Map();
  for (const l of useful) {
    const p = player.get(l.player) ?? { n: 0, pts: 0 };
    p.n++; p.pts += l.pts;
    player.set(l.player, p);
  }
  const bucket = new Map();
  for (const l of useful) {
    const key = `${l.opponent}|${l.position}`;
    const b = bucket.get(key) ?? { games: 0, ratioSum: 0, ratioN: 0 };
    b.games++;
    const p = player.get(l.player);
    // Leave-one-out: a defense is never graded against a number it helped produce.
    const base = p.n > 1 ? (p.pts - l.pts) / (p.n - 1) : null;
    if (base > 0) { b.ratioSum += l.pts / base; b.ratioN++; }
    bucket.set(key, b);
  }
  const out = new Map();
  for (const [key, b] of bucket) {
    const observed = b.ratioN ? b.ratioSum / b.ratioN : 1;
    out.set(key, { mult: r4(shrink(observed, 1, b.ratioN, k)), observed: r4(observed), games: b.games, ratio_games: b.ratioN });
  }
  return out;
}

/**
 * Per player, each of the league's playoff weeks: opponent, the world's expected points,
 * the read multiplier and delta = expected x (mult - 1).
 * world: { playoff_weeks, players: Map id -> { position, team_abbr }, expected: Map week -> Map id -> pts,
 *          schedule: Map team -> [{ week, opponent_abbr }] }
 */
export function playoffWeekRows(world, ratios, ids) {
  const want = [...new Set(ids.map(Number).filter(Number.isInteger))];
  return want.map(id => {
    const p = world.players.get(id);
    if (!p) return { player: id, status: 'unrated', reason: 'not in the simulated world (no projection)' };
    if (!PLAYOFF_WEEK_RULE.positions.includes(p.position)) {
      return { player: id, status: 'unrated', reason: `${p.position} is not read (QB / RB / WR / TE only)` };
    }
    const games = world.schedule.get(p.team_abbr) ?? [];
    let delta = 0, pts = 0, noRead = 0;
    const weeks = world.playoff_weeks.map(week => {
      const g = games.find(x => x.week === week);
      const expected = world.expected.get(week)?.get(id);
      if (!g || !finite(expected)) return { week, bye: true, opponent: g?.opponent_abbr ?? null, expected: null, mult: null, delta: null };
      const r = ratios.get(`${g.opponent_abbr}|${p.position}`);
      if (!r) noRead++;
      const mult = r ? r.mult : 1;
      const d = expected * (mult - 1);
      delta += d; pts += expected;
      return { week, opponent: g.opponent_abbr, expected: r2(expected), mult, read: !!r, delta: r2(d) };
    });
    return { player: id, status: 'ok', position: p.position, playoff_pts: r2(pts), delta_pts: r2(delta), no_read_weeks: noRead, weeks };
  });
}

/**
 * R6 as a tiebreaker, logged only: among the served targets whose gain_if_landed sits within
 * tie_se combined SEs of the top one, which the playoff-week delta would put first.
 * The served targets are read, never changed.
 */
export function tieBreak(targets, rows, { tieSe = PLAYOFF_WEEK_RULE.tie_se } = {}) {
  if (targets?.status !== 'ok' || !Array.isArray(targets.value) || !targets.value.length) {
    return { applied: false, reason: 'no served targets to break a tie between' };
  }
  const list = targets.value.map(t => ({ player: String(t.player), gain: t.gain_if_landed?.value, se: t.gain_if_landed?.se }))
    .filter(t => finite(t.gain));
  if (!list.length) return { applied: false, reason: 'no served target carries a title gain' };
  const top = list.reduce((a, b) => (b.gain > a.gain ? b : a));
  const tied = list.filter(t => t === top
    || (finite(t.se) && finite(top.se) && top.gain - t.gain <= tieSe * Math.sqrt(t.se ** 2 + top.se ** 2)));
  const delta = new Map(rows.filter(r => r.status === 'ok').map(r => [String(r.player), r.delta_pts]));
  // Highest playoff-week delta wins; a player with no read keeps his place (he cannot win a tie).
  const pick = tied.reduce((a, b) => ((delta.get(b.player) ?? -Infinity) > (delta.get(a.player) ?? -Infinity) ? b : a), top);
  return {
    applied: false, tie_se: tieSe, served_top: top.player, tied: tied.map(t => t.player),
    deltas: Object.fromEntries(tied.map(t => [t.player, delta.get(t.player) ?? null])),
    tiebreak_top: pick.player, would_change: pick.player !== top.player,
  };
}

/**
 * The shadow block for plans.json `_run.inputs.playoff_week`.
 * read: the adapter's playoffWeek() (lines + sources + the world view above);
 * ids: the players to read (Nick's roster and the entry's targets); targets: entry.targets.
 */
export function playoffWeekSummary(read, { ids, targets }) {
  const base = { lane: 'shadow', rule: PLAYOFF_WEEK_RULE, grade: UNGRADED, as_of_week: read.as_of_week ?? null,
    playoff_weeks: [...(read.playoff_weeks ?? [])] };
  const usage = read.sources?.usage;
  if (usage?.status !== 'ok') {
    return { ...base, status: 'no_read', reason: usage?.reason ?? 'no usage read', players: [], tie_break: { applied: false, reason: 'no read' } };
  }
  const ratios = defenseRatios(read.lines);
  const rows = playoffWeekRows(read, ratios, ids);
  const ok = rows.filter(r => r.status === 'ok');
  return {
    ...base, status: 'ok',
    ratios: { lines: read.lines.length, defenses_read: ratios.size,
      max_abs_mult: ratios.size ? r4(Math.max(...[...ratios.values()].map(v => Math.abs(v.mult - 1)))) : 0 },
    counts: { players: rows.length, rated: ok.length, unrated: rows.length - ok.length,
      no_read_weeks: ok.reduce((s, r) => s + r.no_read_weeks, 0) },
    players: rows,
    tie_break: tieBreak(targets, rows),
  };
}

/* ------------------------------------------------------------ the grade */

/** One season: the MAE change of baseline x mult vs baseline on the playoff weeks. */
function gradeSeason(lines, bar) {
  const before = lines.filter(l => l.week < bar.as_of_week);
  const ratios = defenseRatios(before);
  const hist = new Map();
  for (const l of before) {
    if (!finite(l.pts)) continue;
    const h = hist.get(l.player) ?? { n: 0, pts: 0 };
    h.n++; h.pts += l.pts;
    hist.set(l.player, h);
  }
  const errBase = [], errAdj = [], groups = [];
  for (const l of lines) {
    if (!bar.playoff_weeks.includes(l.week) || !finite(l.pts) || !PLAYOFF_WEEK_RULE.positions.includes(l.position)) continue;
    const h = hist.get(l.player);
    if (!h || h.n < bar.min_games) continue;
    const baseline = h.pts / h.n;
    const mult = ratios.get(`${l.opponent}|${l.position}`)?.mult ?? 1;
    errBase.push(Math.abs(l.pts - baseline));
    errAdj.push(Math.abs(l.pts - baseline * mult));
    groups.push(l.player);
  }
  const n = errBase.length;
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const diff = n >= 10 ? pairedBootstrapDiff(errBase, errAdj, { iterations: bar.iterations, seed: bar.seed, groups }) : null;
  return {
    n_player_weeks: n, n_players: new Set(groups).size, defenses_read: ratios.size,
    mae_base: n ? r4(mean(errBase)) : null, mae_adj: n ? r4(mean(errAdj)) : null,
    mae_change: diff && !diff.error
      ? { point: r4(mean(errAdj) - mean(errBase)), mean_diff: diff.mean_diff, ci90: diff.ci90 }
      : { point: n ? r4(mean(errAdj) - mean(errBase)) : null, mean_diff: null, ci90: null, reason: diff?.error ?? 'fewer than 10 player-weeks' },
  };
}

/**
 * Grade the rule against P1-P3.
 * bySeason: Map season -> lines [{ player, position, opponent, week, pts }] (whole seasons).
 * @returns { verdict: 'pass'|'fail', reason, bar, seasons: { [season]: gradeSeason } }
 */
export function gradePlayoffWeek(bySeason, bar = PLAYOFF_WEEK_PASS_BAR) {
  const seasons = {};
  for (const [s, lines] of bySeason) seasons[s] = gradeSeason(lines, bar);
  const fails = [];
  const need = [bar.held_out, ...bar.no_reversal];
  for (const s of need) {
    const g = seasons[s];
    if (!g) { fails.push(`P3: season ${s} not read`); continue; }
    if (g.n_player_weeks < bar.min_player_weeks) fails.push(`P3: ${s} has ${g.n_player_weeks} player-weeks < ${bar.min_player_weeks}`);
  }
  const held = seasons[bar.held_out];
  if (held) {
    const hi = held.mae_change.ci90?.[1];
    if (!finite(hi) || hi >= 0) fails.push(`P1: ${bar.held_out} MAE change 90% CI [${held.mae_change.ci90?.join(', ') ?? 'none'}] is not entirely below 0`);
  }
  for (const s of bar.no_reversal) {
    const d = seasons[s]?.mae_change.mean_diff;
    if (seasons[s] && (!finite(d) || d > 0)) fails.push(`P2: ${s} mean MAE change ${d ?? 'none'} > 0`);
  }
  return { verdict: fails.length ? 'fail' : 'pass', reason: fails.length ? fails.join('; ') : null, bar, seasons };
}
