/**
 * Availability and depth-chart cascades.
 *
 * Two questions that only make sense together:
 *
 *   1. How likely is this player to miss time?
 *   2. When he does, where do his touches actually go?
 *
 * The second is what makes handcuffs and contingent value computable instead of
 * folklore. Touches don't evaporate when a starter sits — a specific teammate absorbs
 * them, and how much he absorbs is measurable from games the starter actually missed.
 *
 * The cascade is estimated empirically: for every player, split his team's weeks into
 * ones where the starter played and ones where he didn't, and compare the backup's
 * usage across the two. That is a direct measurement of the handoff, rather than an
 * assumption that the next man on a depth chart inherits everything.
 */
import { rows } from '../db/index.js';
import { shrink, mean } from './stats-util.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
// A starter has to have missed this many games for the split to mean anything.
const MIN_MISSED = 3;
// Who can inherit whose workload. Receivers and tight ends share a target pool; backs
// share carries; quarterbacks are a closed shop.
const INHERITS = { QB: ['QB'], RB: ['RB'], WR: ['WR', 'TE'], TE: ['TE', 'WR'] };

/* ------------------------------------------------------------ availability */

/**
 * Probability a player is available in a given week.
 *
 * Built from observed games-played rate rather than from injury reports, because the
 * app has no live injury feed and a player's own history is the better base rate
 * anyway. The current injury flag, when set, applies a penalty on top.
 */
export function availability({ through = SEASON - 1 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, COUNT(*) AS games, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')
                    GROUP BY u.player_id, u.season`, through);
  const flagged = new Set(rows(`SELECT player_id FROM player_metrics WHERE source='injury_flag' AND value > 0`)
    .map(r => r.player_id));

  const byPlayer = new Map();
  for (const r of log) {
    const a = byPlayer.get(r.player_id) ?? { seasons: 0, games: 0, position: r.position, firstSeason: r.season };
    a.seasons++; a.games += r.games;
    a.firstSeason = Math.min(a.firstSeason, r.season);
    byPlayer.set(r.player_id, a);
  }
  // Durability's whole point is to penalize missed time — but `a.seasons` only
  // counts seasons with at least one logged game, so a player who missed an
  // ENTIRE season (season-ending injury, suspension) contributes no row for
  // it and silently disappears from that count instead of counting against
  // him. `tenureSeasons` is every season from his first appearance through
  // the cutoff, whether or not he has a row in it, so a fully-missed season
  // correctly adds 17 games of zero credit to the denominator rather than
  // shrinking the denominator itself to match his (thinner) attendance.
  const tenureSeasons = a => through - a.firstSeason + 1;

  // Position base rates — running backs miss more time than anyone, and it is not close.
  const posRate = {};
  for (const pos of SKILL) {
    const list = [...byPlayer.values()].filter(a => a.position === pos);
    posRate[pos] = list.length ? mean(list.map(a => a.games / (tenureSeasons(a) * 17))) : 0.75;
  }

  const out = new Map();
  for (const [pid, a] of byPlayer) {
    const observed = a.games / (tenureSeasons(a) * 17);
    const rate = shrink(observed, posRate[a.position] ?? 0.75, a.seasons, 1.2);
    // A live injury designation is worth roughly a fifth of a season of doubt.
    const penalty = flagged.has(pid) ? 0.82 : 1;
    out.set(pid, {
      player_id: pid, position: a.position,
      available: +Math.max(0.05, Math.min(0.99, rate * penalty)).toFixed(3),
      observed_rate: +observed.toFixed(3),
      seasons: a.seasons,
      flagged: flagged.has(pid)
    });
  }
  return out;
}

/**
 * Pregame probability that each player is active for one specific week.
 * Historical durability supplies the prior; the actual week injury and practice
 * designations supply the high-information update. No later-week report is ever
 * consulted, so the same function is safe in replay.
 *
 * The Questionable/Probable centers below are the real published rates, not the
 * nominal label read literally: Harvard Sports Analysis Collective (2013),
 * "Inaccuracies in the Injury Report Across the NFL," corroborated by a
 * follow-up ESPN study, found players tagged Questionable actually played 62%
 * of the time (not the ~50% the label implies) and Probable players played 89%
 * of the time (not ~75%).
 *
 * Re-validated with this file's own out-of-sample discipline: a trailing-3
 * baseline times each formula's active-probability, graded against actual
 * weekly opportunity INCLUDING a true zero for weeks a Questionable player did
 * not suit up at all (326 Questionable player-weeks, 2025 season, gated on the
 * pre-season durability prior only — no leakage). Both formulas dramatically
 * beat applying no availability discount at all (MAE 4.748 -> 3.71-3.66,
 * paired bootstrap p<0.001 either way). The recalibrated center here is
 * directionally better and less biased than the old 0.55-0.78/0.95 formula
 * (MAE 3.713 -> 3.658, bias +0.497 -> -0.426) but the difference between the
 * two formulas is not itself significant on this sample (p=0.772, 90% CI
 * [-0.178, 0.066] crosses zero) — it is still the correct number to encode,
 * since it is the measured real-world rate rather than a nominal assumption,
 * even where the two happen to be hard to distinguish on 326 rows.
 */

/**
 * Tables written by scripts/fit-availability.mjs. The DDL lives here so the fit
 * script, this loader and the tests share one definition.
 */
export const AVAILABILITY_RATES_DDL = `CREATE TABLE IF NOT EXISTS nfl_availability_rates (
  scope TEXT NOT NULL,            -- 'league' | 'team'
  team TEXT NOT NULL,             -- '' for league scope
  report_status TEXT NOT NULL,    -- normalised: out | doubtful | questionable | none
  practice_status TEXT NOT NULL,  -- normalised: dnp | limited | full | none | any
  p_active REAL NOT NULL,
  n INTEGER NOT NULL,
  raw_rate REAL,
  shrunk INTEGER NOT NULL,
  fitted_at TEXT NOT NULL,
  PRIMARY KEY (scope, team, report_status, practice_status))`;

export const AVAILABILITY_ROLE_RATES_DDL = `CREATE TABLE IF NOT EXISTS nfl_availability_role_rates (
  report_status TEXT NOT NULL,    -- noreport | none | questionable | doubtful | out
  practice_status TEXT NOT NULL,  -- dnp | limited | full | none | '*'
  position TEXT NOT NULL,         -- QB | RB | WR | TE | '*' (pooled unless the fit chose byPosition)
  tier TEXT NOT NULL,             -- starter | rotation | depth | fringe | unknown | '*'
  gap TEXT NOT NULL,              -- g0 | g1 | g2 | '*'
  p_active REAL NOT NULL,         -- shrunk toward the parent cell
  n INTEGER NOT NULL,
  raw_rate REAL,
  config TEXT NOT NULL,           -- JSON {k, byPosition, durabilityCap, fitSeasons, gate}
  fitted_at TEXT NOT NULL,
  PRIMARY KEY (report_status, practice_status, position, tier, gap))`;

/** Injury-report game status, normalised. A player with no report at all is the caller's 'noreport'. */
export function normReportStatus(s) {
  const t = String(s ?? '').toLowerCase();
  if (/out|reserve|\bir\b|pup|suspend/.test(t)) return 'out';
  if (/doubtful/.test(t)) return 'doubtful';
  if (/questionable/.test(t)) return 'questionable';
  return 'none';
}

/** Practice participation, normalised. */
export function normPracticeStatus(s) {
  const t = String(s ?? '').toLowerCase();
  if (/did not|dnp/.test(t)) return 'dnp';
  if (/limited/.test(t)) return 'limited';
  if (/full/.test(t)) return 'full';
  return 'none';
}

/* ------------------------------------------------------------------ role */

/*
 * WHO HE IS RIGHT NOW. The fitted rates above were built on injury-report rows
 * only, so the rate for "no game status" (0.831) is the play rate of players who
 * were ON the practice report — and it was being applied to every healthy player
 * who was not on the report at all, then capped at a career durability prior
 * that is shrunk toward a position mean full of backups. A healthy starter who
 * has never missed a game showed 0.57-0.86 on Start/Sit (Caleb Williams, 100% of
 * games played, showed 0.758).
 *
 * Two facts from games already played separate starters from everyone else, and
 * both are available before kickoff:
 *   - role tier: his offensive snap share over his last three appearances.
 *   - gap: how many of his team's games he has missed since he last appeared. A
 *     starter who sat last week is mostly still sitting (fit seasons 2021-2024:
 *     healthy-looking g0 starters recorded usage 95.3% of weeks, g1 29.7%).
 * Only seasons s-1 and s, and only weeks before `week`, are ever read.
 */
export const ROLE_MAX_GAP = 3;
const ROLE_RECENT_APPEARANCES = 3;
const ROLE_POSITIONS = "('QB','RB','WR','TE')";

export function roleTier(share) {
  if (share == null || !Number.isFinite(share)) return 'unknown';
  if (share >= 0.60) return 'starter';
  if (share >= 0.35) return 'rotation';
  if (share >= 0.15) return 'depth';
  return 'fringe';
}

/** g0 = played his team's last game, g1 = missed one, g2 = missed two or three; beyond that he is out of role scope. */
export function gapBucket(gap) {
  if (!Number.isInteger(gap) || gap < 0 || gap > ROLE_MAX_GAP) return null;
  return gap === 0 ? 'g0' : gap === 1 ? 'g1' : 'g2';
}

const _roleCache = new Map();
const ROLE_CACHE_MAX = 16;

/**
 * Role state for every skill player who has appeared in seasons s-1..s before
 * `week`. An appearance is a usage row or an offensive snap. His team is the
 * team on his most recent usage row; a team's games are the weeks it has any
 * usage row, so a bye is never counted as a game he missed.
 *
 * @returns Map<player_id, { player_id, position, team, share, tier, gap, gap_bucket, last_seen }>
 */
export function roleStates(season, week) {
  const prev = season - 1;
  const window = '(season = ? OR (season = ? AND week < ?))';
  // Keyed on the row counts it reads, so a load of new games is never served stale.
  const stamp = rows(`SELECT (SELECT COUNT(*) FROM player_week_usage WHERE ${window}) AS u,
                             (SELECT COUNT(*) FROM player_week_snaps WHERE ${window}) AS s`,
    prev, season, week, prev, season, week)[0];
  const key = `${season}|${week}|${stamp?.u}|${stamp?.s}`;
  if (_roleCache.has(key)) return _roleCache.get(key);

  const slot = (s, w) => s * 100 + w;
  const players = new Map();
  const entry = (id, position) => players.get(id)
    ?? players.set(id, { position, apps: new Map(), lastUsage: -1, team: null }).get(id);
  for (const u of rows(`SELECT u.player_id, u.season, u.week, u.team, p.position
                        FROM player_week_usage u JOIN players p ON p.id = u.player_id
                        WHERE p.position IN ${ROLE_POSITIONS}
                          AND (u.season = ? OR (u.season = ? AND u.week < ?))`, prev, season, week)) {
    const e = entry(u.player_id, u.position);
    const k = slot(u.season, u.week);
    if (!e.apps.has(k)) e.apps.set(k, null);
    if (u.team && k > e.lastUsage) { e.lastUsage = k; e.team = u.team; }
  }
  for (const s of rows(`SELECT s.player_id, s.season, s.week, s.offense_pct, p.position
                        FROM player_week_snaps s JOIN players p ON p.id = s.player_id
                        WHERE p.position IN ${ROLE_POSITIONS} AND s.offense_snaps > 0
                          AND (s.season = ? OR (s.season = ? AND s.week < ?))`, prev, season, week)) {
    entry(s.player_id, s.position).apps.set(slot(s.season, s.week), s.offense_pct);
  }
  const teamGames = new Map();
  for (const g of rows(`SELECT DISTINCT team, season, week FROM player_week_usage
                        WHERE team IS NOT NULL AND (season = ? OR (season = ? AND week < ?))`, prev, season, week)) {
    (teamGames.get(g.team) ?? teamGames.set(g.team, []).get(g.team)).push(slot(g.season, g.week));
  }

  const out = new Map();
  for (const [id, e] of players) {
    const apps = [...e.apps.keys()].sort((a, b) => b - a);
    const last = apps[0];
    const shares = apps.slice(0, ROLE_RECENT_APPEARANCES).map(k => e.apps.get(k)).filter(v => v != null);
    const share = shares.length ? shares.reduce((s, v) => s + v, 0) / shares.length : null;
    const games = e.team ? teamGames.get(e.team) ?? [] : null;
    const gap = games ? games.filter(g => g > last).length : null;
    out.set(id, {
      player_id: id, position: e.position, team: e.team,
      share, tier: roleTier(share), gap, gap_bucket: gapBucket(gap),
      last_seen: { season: Math.floor(last / 100), week: last % 100 }
    });
  }
  if (_roleCache.size >= ROLE_CACHE_MAX) _roleCache.delete(_roleCache.keys().next().value);
  _roleCache.set(key, out);
  return out;
}

/**
 * Role rates by hierarchical beta-binomial shrinkage, parent -> child:
 *   status -> status|practice -> [|position ->] |tier -> |tier|gap
 * p_child = (hits + k * p_parent) / (n + k); the root is its raw rate. Every
 * node is returned ('*' marks a pooled level) so a lookup of a combination the
 * fit never saw can fall back to its deepest fitted ancestor.
 *
 * @param observations [{ rs, ps, position, tier, gap ('g0'|'g1'|'g2'), active (0|1) }]
 */
export function fitRoleRates(observations, { k = 10, byPosition = false } = {}) {
  const path = o => byPosition
    ? [[o.rs, '*', '*', '*', '*'], [o.rs, o.ps, '*', '*', '*'], [o.rs, o.ps, o.position, '*', '*'],
       [o.rs, o.ps, o.position, o.tier, '*'], [o.rs, o.ps, o.position, o.tier, o.gap]]
    : [[o.rs, '*', '*', '*', '*'], [o.rs, o.ps, '*', '*', '*'],
       [o.rs, o.ps, '*', o.tier, '*'], [o.rs, o.ps, '*', o.tier, o.gap]];
  const nodes = new Map();
  for (const o of observations) {
    let parent = null;
    for (const parts of path(o)) {
      const key = parts.join('|');
      const node = nodes.get(key) ?? nodes.set(key, { parts, n: 0, hits: 0, parent }).get(key);
      node.n++; node.hits += o.active ? 1 : 0;
      parent = key;
    }
  }
  // A parent is always inserted before its first child, so insertion order is top-down.
  const p = new Map();
  for (const [key, node] of nodes) {
    p.set(key, node.parent == null ? node.hits / node.n : (node.hits + k * p.get(node.parent)) / (node.n + k));
  }
  return [...nodes].map(([key, node]) => ({
    report_status: node.parts[0], practice_status: node.parts[1], position: node.parts[2],
    tier: node.parts[3], gap: node.parts[4], p_active: p.get(key), n: node.n, raw_rate: node.hits / node.n
  }));
}

/**
 * The lookup over fitted rows. Pure, so the fit script scores exactly the code
 * path the app runs.
 */
export function buildAvailabilityLookup({ rates = [], roleRates = [] } = {}) {
  const league = new Map();      // "status|practice" and "status|any"
  const team = new Map();        // "TEAM|status"
  for (const r of rates) {
    if (r.scope === 'league') league.set(`${r.report_status}|${r.practice_status}`, r);
    else team.set(`${String(r.team).toUpperCase()}|${r.report_status}`, r);
  }
  const role = new Map();
  let roleConfig = null;
  for (const r of roleRates) {
    role.set([r.report_status, r.practice_status, r.position, r.tier, r.gap].join('|'), r);
    if (!roleConfig && r.config) { try { roleConfig = JSON.parse(r.config); } catch { roleConfig = null; } }
  }
  roleConfig ??= { byPosition: false, durabilityCap: false };

  // Team enters as a RATIO to its league status rate, so the team effect and
  // the practice (or role) effect compose instead of one replacing the other.
  const teamRatio = (teamAbbr, rs) => {
    const statusLeague = league.get(`${rs}|any`);
    const tc = teamAbbr ? team.get(`${String(teamAbbr).toUpperCase()}|${rs}`) : null;
    if (!tc || !(statusLeague?.p_active > 0)) return null;
    return { ratio: tc.p_active / statusLeague.p_active, team: String(teamAbbr).toUpperCase() };
  };

  return {
    hasRole: role.size > 0,
    roleConfig,
    lookup(teamAbbr, statusRaw, practiceRaw) {
      const rs = normReportStatus(statusRaw), ps = normPracticeStatus(practiceRaw);
      const cell = league.get(`${rs}|${ps}`) ?? league.get(`${rs}|any`);
      if (!cell) return null;
      let p = cell.p_active;
      let basis = `${rs}/${ps}`;
      const tr = teamRatio(teamAbbr, rs);
      if (tr) { p *= tr.ratio; basis += ` x ${tr.team}`; }
      return { p: Math.max(0.001, Math.min(0.995, p)), basis, n: cell.n };
    },
    teamRatio(teamAbbr, statusRaw) {
      return teamRatio(teamAbbr, normReportStatus(statusRaw));
    },
    /** status is a report group ('noreport' when he is not on the report); gap is a bucket. */
    roleLookup({ status, practice, position, tier, gap }) {
      const chain = roleConfig.byPosition
        ? [[status, practice, position, tier, gap], [status, practice, position, tier, '*'],
           [status, practice, position, '*', '*'], [status, practice, '*', '*', '*'], [status, '*', '*', '*', '*']]
        : [[status, practice, '*', tier, gap], [status, practice, '*', tier, '*'],
           [status, practice, '*', '*', '*'], [status, '*', '*', '*', '*']];
      for (const parts of chain) {
        const r = role.get(parts.join('|'));
        if (r) return { p: r.p_active, n: r.n, basis: parts.filter(x => x !== '*').join('/') };
      }
      return null;
    }
  };
}

/**
 * The fitted availability tables, loaded once per process.
 *
 * Returns null when neither table has been built (fresh install, or
 * scripts/fit-availability.mjs has never run), and the caller falls back to the
 * legacy constants. Absent is a normal state, not an error. With the league
 * table but no role table, every number is exactly what it was before the role
 * layer existed.
 */
let _fittedCache;
export function resetAvailabilityCache() {
  _fittedCache = undefined;
  _roleCache.clear();
}
function fittedAvailability() {
  if (_fittedCache !== undefined) return _fittedCache;
  let rates = [], roleRates = [];
  try {
    rates = rows('SELECT scope,team,report_status,practice_status,p_active,n FROM nfl_availability_rates');
  } catch { rates = []; }
  try {
    roleRates = rows(`SELECT report_status,practice_status,position,tier,gap,p_active,n,config
                      FROM nfl_availability_role_rates`);
  } catch { roleRates = []; }
  _fittedCache = rates.length || roleRates.length ? buildAvailabilityLookup({ rates, roleRates }) : null;
  return _fittedCache;
}

/**
 * One player's chance to be active, from whatever is on file. Shared by
 * weeklyAvailability and the fit script's gate, so what was validated is what runs.
 */
export function playerActiveProbability({ fitted, report, prior, role = null, useRole = true }) {
  const status = String(report?.report_status ?? '').toLowerCase();
  const practice = String(report?.practice_status ?? '').toLowerCase();
  let active = prior;
  let source = report ? 'weekly injury report + durability prior' : 'durability prior only';

  const roleCell = useRole && fitted?.hasRole && role?.gap_bucket
    ? fitted.roleLookup({
        status: report ? normReportStatus(status) : 'noreport', practice: normPracticeStatus(practice),
        position: role.position, tier: role.tier, gap: role.gap_bucket
      })
    : null;

  if (roleCell) {
    // Fitted on 2021-2024, selected on 2024, scored ONCE on 2025 against the
    // path below under the gate in scripts/fit-availability.mjs (8,657 in-scope
    // player-weeks): log loss 0.551 -> 0.396 (player-clustered bootstrap 90% CI
    // of the change [-0.170, -0.141]), calibration error 0.074 -> 0.017, listed
    // Q/D/Out rows 0.289 -> 0.257. Healthy starters (no report, starter tier,
    // played last game) actually played 94.5%; the old path said 0.708, this 0.952.
    // Known weak spot: week 1, where the role comes from last season (2025 wk 1
    // log loss 0.554 -> 0.721) — see docs/tdd/play-chance.tdd.md.
    // Same team ratio as the league path, for a listed player only.
    let p = roleCell.p;
    let basis = roleCell.basis;
    const tr = report ? fitted.teamRatio(report.team, status) : null;
    if (tr) { p *= tr.ratio; basis += ` x ${tr.team}`; }
    active = p;
    source = `fitted availability by role (${basis}, n=${roleCell.n})`;
    // Only if the fit's own selection (on 2024, never 2025) chose it.
    if (!report && fitted.roleConfig?.durabilityCap) active = Math.min(active, prior);
  } else {
    const measured = fitted ? fitted.lookup(report?.team, status, practice) : null;
    if (measured) {
      // Measured rates, fitted on 2021-2024 and validated out-of-sample on 2025
      // (16.5% better log loss than the constants below). Two of those constants
      // were badly wrong: Doubtful was set at 0.15 against a measured 0.004, and
      // Out at 0.01 against 0.001. The team term is a shrunk ratio, because most
      // of the apparent inter-team spread in how Questionable is used turns out
      // to be small-sample noise; the fitted shrinkage keeps only the part that
      // survives a held-out season.
      active = measured.p;
      source = `fitted availability (${measured.basis}, n=${measured.n})`;
    } else {
      if (/out|reserve|ir|pup|suspend/.test(status)) active = 0.01;
      else if (/doubtful/.test(status)) active = Math.min(active, 0.15);
      else if (/questionable/.test(status)) active = Math.min(0.75, Math.max(0.45, active * 0.70));
      else if (/probable/.test(status)) active = Math.max(active, 0.89);

      if (!/out|reserve|ir|pup|suspend/.test(status)) {
        if (/did not|dnp/.test(practice)) active *= 0.72;
        else if (/limited/.test(practice)) active *= 0.92;
        else if (/full/.test(practice) && !/doubtful/.test(status)) active = Math.max(active, 0.96);
      }
    }
    // The durability prior still matters for a player with no report at all:
    // someone who has missed half of every season is not an 0.83 just because
    // nobody listed him this week.
    if (!report) active = Math.min(active, prior);
  }

  return { active: Math.max(0.001, Math.min(0.995, active)), source };
}

/* ------------------------------------------------------------- scoring */

/** Per-row log loss, p clipped to [0.001, 0.999]. */
export function rowLogLoss(p, y) {
  const q = Math.max(0.001, Math.min(0.999, p));
  return y ? -Math.log(q) : -Math.log(1 - q);
}

/**
 * Log loss, Brier, expected calibration error and the calibration table
 * (predicted vs actual play rate by equal-width bin of predicted p).
 */
export function availabilityScores(pairs, { bins = 10 } = {}) {
  const table = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sum: 0, hits: 0 }));
  let ll = 0, brier = 0;
  for (const { p, y } of pairs) {
    ll += rowLogLoss(p, y);
    brier += (p - (y ? 1 : 0)) ** 2;
    const b = table[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))];
    b.n++; b.sum += p; b.hits += y ? 1 : 0;
  }
  const n = pairs.length;
  const filled = table.filter(b => b.n).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, mean_p: b.sum / b.n, rate: b.hits / b.n }));
  return {
    n,
    log_loss: n ? ll / n : null,
    brier: n ? brier / n : null,
    ece: n ? filled.reduce((s, b) => s + (b.n / n) * Math.abs(b.mean_p - b.rate), 0) : null,
    table: filled
  };
}

/**
 * The pre-registered ship rule for the role layer (written 2026-09-18 before
 * any 2025 number for it was computed; never moved after):
 *   1. log loss improves AND the player-clustered paired bootstrap of per-row
 *      log loss (b - a, candidate minus current) has its 90% interval below 0;
 *   2. expected calibration error (10 equal-width bins) improves;
 *   3. guard: on rows listed Questionable/Doubtful/Out, candidate log loss is
 *      no more than 0.01 worse than current.
 * All three or nothing ships.
 */
export const ROLE_GATE = Object.freeze({
  seed: 20260918, iterations: 2000, bins: 10, guardSlack: 0.01,
  guardStatuses: Object.freeze(['questionable', 'doubtful', 'out'])
});

/** @param gateRows [{ player_id, y, p_current, p_candidate, rs }] */
export function roleGateDecision(gateRows, gate = ROLE_GATE) {
  const current = availabilityScores(gateRows.map(r => ({ p: r.p_current, y: r.y })), { bins: gate.bins });
  const candidate = availabilityScores(gateRows.map(r => ({ p: r.p_candidate, y: r.y })), { bins: gate.bins });
  const bootstrap = pairedBootstrapDiff(
    gateRows.map(r => rowLogLoss(r.p_current, r.y)),
    gateRows.map(r => rowLogLoss(r.p_candidate, r.y)),
    { iterations: gate.iterations, seed: gate.seed, groups: gateRows.map(r => r.player_id) });
  const listed = gateRows.filter(r => gate.guardStatuses.includes(r.rs));
  const meanLL = key => listed.length ? listed.reduce((s, r) => s + rowLogLoss(r[key], r.y), 0) / listed.length : null;
  const guardCurrent = meanLL('p_current'), guardCandidate = meanLL('p_candidate');
  const checks = {
    log_loss: {
      current: current.log_loss, candidate: candidate.log_loss, bootstrap,
      pass: candidate.log_loss < current.log_loss && !bootstrap.error && bootstrap.ci90[1] < 0
    },
    calibration: { current: current.ece, candidate: candidate.ece, pass: candidate.ece < current.ece },
    guard: {
      n: listed.length, current: guardCurrent, candidate: guardCandidate, slack: gate.guardSlack,
      pass: listed.length === 0 || guardCandidate <= guardCurrent + gate.guardSlack
    }
  };
  return { pass: checks.log_loss.pass && checks.calibration.pass && checks.guard.pass, checks, current, candidate };
}

export function weeklyAvailability(season, week, { through = season - 1, useRole = true } = {}) {
  const base = availability({ through });
  const players = rows(`SELECT id, name, position, gsis_id FROM players
                        WHERE position IN ('QB','RB','WR','TE')`);
  const reports = new Map(rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=?`, season, week)
    .map(r => [String(r.gsis_id), r]));
  const out = new Map();

  const fitted = fittedAvailability();
  // Role states are only read when fitted role rates exist; without them this
  // function is byte-for-byte the pre-role path.
  const roles = useRole && fitted?.hasRole ? roleStates(season, week) : null;

  for (const p of players) {
    const prior = base.get(p.id)?.available ?? 0.92;
    const report = p.gsis_id ? reports.get(String(p.gsis_id)) : null;
    const role = roles?.get(p.id) ?? null;
    const { active, source } = playerActiveProbability({ fitted, report, prior, role, useRole });
    out.set(p.id, {
      player_id: p.id, name: p.name, position: p.position,
      active_probability: +active.toFixed(3),
      durability_prior: +prior.toFixed(3),
      report_status: report?.report_status ?? null,
      practice_status: report?.practice_status ?? null,
      injury: report?.injury ?? null,
      role: role ? {
        tier: role.tier, share: role.share == null ? null : +role.share.toFixed(3),
        gap: role.gap, in_scope: role.gap_bucket != null
      } : null,
      source
    });
  }
  return out;
}

/* --------------------------------------------------------------- cascade */

/**
 * Who absorbs a player's workload when he sits.
 *
 * @returns Map<player_id, { beneficiaries: [{ player_id, name, share_gain, ... }] }>
 */
export function cascades({ through = SEASON - 1, minGames = 6 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, u.week, u.team, u.targets, u.carries, u.attempts,
                           p.name, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season <= ? AND u.season >= ? AND u.team IS NOT NULL
                      AND p.position IN ('QB','RB','WR','TE')`, through, through - 2);

  // Index by team-week so "did he play" is answerable.
  const teamWeeks = new Map();     // `${team}|${season}|${week}` -> [rows]
  const playerTeams = new Map();   // player -> Set of `${team}|${season}`
  for (const u of log) {
    const k = `${u.team}|${u.season}|${u.week}`;
    (teamWeeks.get(k) ?? teamWeeks.set(k, []).get(k)).push(u);
    const pk = `${u.team}|${u.season}`;
    (playerTeams.get(u.player_id) ?? playerTeams.set(u.player_id, new Set()).get(u.player_id)).add(pk);
  }

  // All weeks a team appeared, so absence is detectable as a missing row.
  const teamAllWeeks = new Map();  // `${team}|${season}` -> Set(week)
  for (const k of teamWeeks.keys()) {
    const [team, season, week] = k.split('|');
    const tk = `${team}|${season}`;
    (teamAllWeeks.get(tk) ?? teamAllWeeks.set(tk, new Set()).get(tk)).add(Number(week));
  }

  const opportunity = u => (u.targets ?? 0) + (u.carries ?? 0) + (u.attempts ?? 0);
  const out = new Map();

  for (const [starterId, teamKeys] of playerTeams) {
    const withStarter = new Map();   // teammate id -> { n, opp }
    const withoutStarter = new Map();
    let missed = 0, played = 0, starterOpp = 0;
    let starterName = null, starterPos = null, starterTeam = null;

    for (const tk of teamKeys) {
      const [team, season] = tk.split('|');
      const weeks = teamAllWeeks.get(tk);
      if (!weeks) continue;

      // Only the span he was actually on this roster counts. Treating every week with
      // no row as an absence would score the weeks before he was signed and after he
      // was traded as "games he missed", which manufactures cascades between players
      // who were never teammates.
      const appearances = [...weeks].filter(w =>
        (teamWeeks.get(`${team}|${season}|${w}`) ?? []).some(u => u.player_id === starterId));
      if (!appearances.length) continue;
      const first = Math.min(...appearances), last = Math.max(...appearances);

      for (const week of weeks) {
        if (week < first || week > last) continue;
        const list = teamWeeks.get(`${team}|${season}|${week}`) ?? [];
        const starter = list.find(u => u.player_id === starterId);
        if (starter) {
          starterName ??= starter.name; starterPos ??= starter.position; starterTeam = team;
          starterOpp += opportunity(starter);
        }
        const bucket = starter ? withStarter : withoutStarter;
        if (starter) played++; else missed++;
        for (const u of list) {
          if (u.player_id === starterId) continue;
          const b = bucket.get(u.player_id) ?? { n: 0, opp: 0, name: u.name, position: u.position };
          b.n++; b.opp += opportunity(u);
          bucket.set(u.player_id, b);
        }
      }
    }

    if (missed < MIN_MISSED || played < minGames || !starterName) continue;
    // Only real contributors have a workload worth inheriting.
    if (starterOpp / played < 6) continue;

    const beneficiaries = [];
    for (const [mateId, without] of withoutStarter) {
      const with_ = withStarter.get(mateId);
      if (!with_ || with_.n < 3 || without.n < MIN_MISSED) continue;
      // Touches only transfer within a position group. A receiver missing does not hand
      // carries to a running back, and it certainly does not hand pass attempts to the
      // backup quarterback — that pattern is roster churn showing through, not football.
      if (!INHERITS[starterPos]?.includes(without.position)) continue;
      const base = with_.opp / with_.n;
      const boosted = without.opp / without.n;
      if (base <= 0.5 && boosted <= 0.5) continue;
      const gain = boosted - base;
      // Shrink the multiplier toward "no change" — a three-game split is thin evidence.
      const ratio = base > 0 ? shrink(boosted / base, 1, without.n, 4) : 1;
      if (ratio <= 1.03) continue;
      beneficiaries.push({
        player_id: mateId, name: without.name, position: without.position,
        base_opportunity: +base.toFixed(2),
        opportunity_without: +boosted.toFixed(2),
        gain: +gain.toFixed(2),
        multiplier: +ratio.toFixed(3),
        games_observed: without.n
      });
    }
    if (!beneficiaries.length) continue;
    beneficiaries.sort((a, b) => b.gain - a.gain);
    out.set(starterId, {
      player_id: starterId, name: starterName, position: starterPos, team: starterTeam,
      games_missed: missed, games_played: played,
      beneficiaries: beneficiaries.slice(0, 4)
    });
  }
  return out;
}

/**
 * Contingent value: how much a player is worth *because of* who he backs up.
 *
 * A backup with no path to touches is worth nothing; one snap away from twenty carries
 * is worth a great deal, and the difference is invisible to any market value or
 * projection that only prices expected usage.
 */
export function handcuffValue({ through = SEASON - 1 } = {}) {
  const casc = cascades({ through });
  const avail = availability({ through });
  const byBackup = new Map();

  // Opportunity is not comparable across positions — a pass attempt is worth a fraction
  // of a PPR target. Without converting to points the list is just "backup quarterbacks",
  // because they inherit forty attempts while a backup back inherits ten carries.
  const ppo = {};
  for (const r of rows(`SELECT p.position,
                               SUM(COALESCE(u.passing_yards,0))*0.04 + SUM(COALESCE(u.passing_tds,0))*4
                             + SUM(COALESCE(u.rushing_yards,0))*0.1 + SUM(COALESCE(u.rushing_tds,0))*6
                             + SUM(COALESCE(u.receptions,0)) + SUM(COALESCE(u.receiving_yards,0))*0.1
                             + SUM(COALESCE(u.receiving_tds,0))*6 AS pts,
                               SUM(COALESCE(u.attempts,0)+COALESCE(u.carries,0)+COALESCE(u.targets,0)) AS opp
                        FROM player_week_usage u JOIN players p ON p.id = u.player_id
                        WHERE u.season <= ? GROUP BY p.position`, through)) {
    ppo[r.position] = r.opp > 0 ? r.pts / r.opp : 0.5;
  }

  for (const c of casc.values()) {
    const starterAvail = avail.get(c.player_id)?.available ?? 0.8;
    const missRate = 1 - starterAvail;
    for (const b of c.beneficiaries) {
      const entry = byBackup.get(b.player_id) ?? {
        player_id: b.player_id, name: b.name, position: b.position, paths: []
      };
      entry.paths.push({
        starter: c.name, starter_id: c.player_id,
        starter_miss_rate: +missRate.toFixed(3),
        opportunity_gain: b.gain,
        multiplier: b.multiplier,
        // Expected extra opportunity per game across the season, and the same figure
        // converted to fantasy points so positions can be ranked against each other.
        expected_gain: +(missRate * b.gain).toFixed(2),
        expected_points: +(missRate * b.gain * (ppo[b.position] ?? 0.5)).toFixed(2)
      });
      byBackup.set(b.player_id, entry);
    }
  }
  for (const e of byBackup.values()) {
    e.paths.sort((a, b) => b.expected_points - a.expected_points);
    e.contingent_score = +e.paths.reduce((s, p) => s + p.expected_points, 0).toFixed(2);
  }
  return [...byBackup.values()].sort((a, b) => b.contingent_score - a.contingent_score);
}
