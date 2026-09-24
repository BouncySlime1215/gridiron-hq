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
import { espnStatusById } from './player-availability.js';
import { AVAILABILITY_FIT_BASIS, DEFAULT_DURABILITY_PRIOR } from './availability-basis.js';
import { activeInjuryFlagIds } from './injury-flags.js';
import { availHorizonFlag, availHorizonPreviewFields, servedReturnCurve } from './availability-return.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
// A starter has to have missed this many games for the split to mean anything.
const MIN_MISSED = 3;
/**
 * How much observed opportunity the WITH-starter side has to carry before a
 * beneficiary's multiplier is worth publishing.
 *
 * The multiplier is a ratio, and `shrink` below is given the sample size of the
 * WITHOUT-starter games — never the sample size of the divisor, which is the
 * quantity that actually makes a ratio unstable. So a beneficiary who was barely
 * used alongside the starter keeps a tiny divisor and the shrink toward 1 cannot
 * tame it: Jordan Whittington behind Puka Nacua published ×26.38 off a 0.11 base,
 * a whole with-starter sample holding about one observed target.
 *
 * The number is not a round one picked to make that case go away. A mean rate
 * estimated from a count of k observed events carries a relative standard error
 * of about 1/√k, and the ratio inherits the divisor's error directly. Nine is
 * where that relative error reaches one third — below it a ×2 and a ×3 are not
 * distinguishable from the sample the divisor was built on, so the ratio is not a
 * measurement of anything.
 *
 * A cap would have been the wrong instrument. Joe Flacco behind Joe Burrow
 * publishes ×7.49 off a 3.67 base built from eleven observed attempts, and a
 * backup quarterback really does go from mop-up duty to a starter's workload.
 * Clipping that would replace a correct number with a wrong one. What separates
 * the two cases is how much the divisor was estimated from, not how large the
 * result is.
 *
 * The rule is not a clean line and should not be described as one. Mac Jones
 * behind Brock Purdy sits at eight observed attempts against the threshold of
 * nine, so his ×10.24 is withheld by one opportunity. On the 2024 and 2025 fits
 * the rule withholds 15 of 203 beneficiary multipliers in each — 7.4% — and the
 * largest surviving ratio falls from ×26.38 to ×4.37 and from ×10.57 to ×7.49.
 */
const MIN_DENOMINATOR_OPPORTUNITIES = 9;
// Who can inherit whose workload. Receivers and tight ends share a target pool; backs
// share carries; quarterbacks are a closed shop.
const INHERITS = { QB: ['QB'], RB: ['RB'], WR: ['WR', 'TE'], TE: ['TE', 'WR'] };

/* ------------------------------------------------------------ availability */

/**
 * Probability a player is available in a given week.
 *
 * Built from observed games-played rate rather than from injury reports: a player's
 * own history is the better base rate, and the live week's report and ESPN
 * designation are applied later (weekDesignation). The current Sleeper injury flag,
 * when set and not stale (services/injury-flags.js), applies a penalty on top.
 */
export function availability({ through = SEASON - 1 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, COUNT(*) AS games, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')
                    GROUP BY u.player_id, u.season`, through);
  const flagged = activeInjuryFlagIds();

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

/* ----------------------------------------------------------- designation */

/*
 * THIS WEEK'S DESIGNATION DOMINATES THE ROLE PRIOR (play-chance-live, 2026-09-18).
 *
 * The rates are fitted on the NFL injury report, and that report is all the fit and
 * the replays ever see. Live, it is late and incomplete: mid-week it carries practice
 * rows but almost no game statuses (6 of 230 week-2 rows on Friday morning), and it
 * never lists players on injured reserve or a reserve list. ESPN's own status, which
 * is what Nick's leagues show, does: on the 2026-W2 sync Zach Charbonnet was ESPN OUT
 * and priced 0.805 to play, A.J. Brown was on ESPN injured reserve (0.959 with role
 * rates), and four ESPN-Questionable starters with no NFL game status would have been
 * started on the healthy-starter role cell (~0.95).
 *
 * So the week's designation is the MORE SEVERE of the NFL game status and ESPN's
 * current status, and it picks the fitted cell; the role (tier, games missed) and the
 * team's dialect for that designation refine it. ESPN is read only for the payloads'
 * current scoring period (liveEspnStatuses), so no replay or fit ever sees it: there is
 * no pregame ESPN status history on file to fit or backtest it on. The mapping is the
 * designation ESPN itself shows; DAY_TO_DAY, an ESPN doubt label with no NFL
 * equivalent, is treated as Questionable. Gate and numbers: docs/tdd/play-chance-live.tdd.md.
 */
const ESPN_DESIGNATION_LABEL = Object.freeze({
  OUT: 'Out (ESPN)',
  INJURY_RESERVE: 'Out (ESPN injured reserve)',
  SUSPENSION: 'Out (ESPN suspension)',
  DOUBTFUL: 'Doubtful (ESPN)',
  QUESTIONABLE: 'Questionable (ESPN)',
  DAY_TO_DAY: 'Questionable (ESPN day-to-day)'
});
const DESIGNATION_SEVERITY = { none: 0, questionable: 1, doubtful: 2, out: 3 };

/**
 * The report this week's chance to play is priced on: the NFL row, or a copy of it
 * (practice status kept) carrying ESPN's designation when ESPN's is more severe.
 *
 * @returns {{ report: object|null, designation: 'out'|'doubtful'|'questionable'|null, source: 'nfl'|'espn'|null }}
 */
export function weekDesignation({ report = null, espnStatus = null, team = null } = {}) {
  const nfl = report?.report_status ? normReportStatus(report.report_status) : 'none';
  const label = ESPN_DESIGNATION_LABEL[String(espnStatus ?? '').toUpperCase()] ?? null;
  const espn = label ? normReportStatus(label) : 'none';
  if (DESIGNATION_SEVERITY[espn] > DESIGNATION_SEVERITY[nfl]) {
    return {
      report: { ...(report ?? {}), team: report?.team || team, report_status: label,
        practice_status: report?.practice_status ?? null },
      designation: espn, source: 'espn'
    };
  }
  return { report, designation: nfl === 'none' ? null : nfl, source: nfl === 'none' ? null : 'nfl' };
}

/*
 * HOW A FAILED READ IS ALLOWED TO DEGRADE, shared by every reader below.
 *
 * One rule, because the alternative was measured in production: an absent table is a
 * NAMED state that is said once and carries on; every other read error is a real fault
 * and throws. Nothing in this file may turn a fault into "that source has nothing",
 * because every source here answers "is he playing?" and silence reads as "he is fine".
 */
const missingTable = error => /no such table/i.test(String(error?.message ?? error));
const _saidOnce = new Set();
const warnOnce = (key, message) => {
  if (_saidOnce.has(key)) return;
  _saidOnce.add(key);
  console.warn(message);
};

let _espnMemo = { key: null, periods: null, value: null };
/**
 * ESPN's current injury status per ESPN player id (player-availability.js#espnStatusById,
 * the freshest synced league payload wins), or null unless (season, week) is the
 * payloads' current ESPN scoring period. A status describes now, so it may only price
 * the live week. Memoised on each league's fetched_at (a sync rewrites payload and
 * fetched_at together); the payloads, ~2.5 MB each, are read only when one changes.
 */
export function liveEspnStatuses(season, week) {
  let key;
  try {
    key = JSON.stringify(rows('SELECT id, fetched_at FROM leagues WHERE payload IS NOT NULL ORDER BY id'));
  } catch (error) {
    // Same rule as fittedAvailability() below, for the same reason. `leagues` is
    // created by the legacy schema migration at import of server/db/index.js, so it
    // exists in every process that can reach this line: a bare catch here could only
    // ever swallow a REAL fault (a table from another schema, a locked database), and
    // swallowing it deletes the whole ESPN designation layer — an ESPN OUT or
    // INJURED RESERVE player has no NFL injury-report row, so he falls straight back
    // onto his healthy-starter role cell (0.006 -> 0.953 on the fixture in
    // test/availability-honest-degradation.test.js) and Start/Sit starts him.
    // 'no such table' is the one legitimate absent state (a database built before the
    // migration, e.g. a bare fixture), and it is said out loud, once.
    if (!missingTable(error)) throw error;
    warnOnce('espn-leagues-absent',
      '[contingency] ESPN designations are not being read: the `leagues` table is absent, so no ' +
      'ESPN OUT / INJURED RESERVE / QUESTIONABLE status can reach the chance to play. Every player ' +
      'is priced on the NFL injury report and his role alone.');
    return null;
  }
  if (_espnMemo.key !== key) {
    // The live period is the LATEST one on file, not any of them: a league whose sync
    // lags (or an old-season payload) still names a past week, and a union made that
    // week "live", so today's statuses priced its replay.
    const periods = rows(`SELECT json_extract(payload, '$.seasonId') AS s,
                                 json_extract(payload, '$.scoringPeriodId') AS w
                          FROM leagues WHERE payload IS NOT NULL`)
      .map(l => Number(l.s) * 100 + Number(l.w)).filter(Number.isFinite);
    const live = periods.length ? Math.max(...periods) : null;
    _espnMemo = { key, periods: live, value: live != null ? espnStatusById() : new Map() };
  }
  return _espnMemo.periods != null && _espnMemo.periods === season * 100 + week ? _espnMemo.value : null;
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
 * Designations priced at their own fitted rate, never a role or practice sub-cell: in
 * the fit seasons 1 of 1,066 in-scope Out rows and 1 of 213 Doubtful rows recorded
 * usage, every 2025 Out cell played 0.000, and the only non-trivial sub-cells were
 * single-hit artefacts (doubtful/limited/WR 0.073 from 1 of 10; out/none/TE/rotation/g0
 * 0.470 from 1 of 1). Role carries no information inside these designations.
 */
const NEAR_CERTAIN = new Set(['out', 'doubtful']);

/**
 * Role rates by hierarchical beta-binomial shrinkage, parent -> child:
 *   status -> status|practice -> [|position ->] |tier -> |tier|gap
 * p_child = (hits + k * p_parent) / (n + k); the root is its raw rate. Every
 * node is returned ('*' marks a pooled level) so a lookup of a combination the
 * fit never saw can fall back to its deepest fitted ancestor.
 *
 * Questionable rows also feed a PRACTICE-POOLED branch under the same root,
 * status -> [|position ->] |tier -> |tier|gap with practice '*', for a Questionable
 * player whose practice status is unknown (an ESPN designation with no NFL practice
 * line; see roleLookup). The practice 'none' cells of a designation are a rare report
 * state (questionable/none: 24 rows in 2021-2024), too thin to price on. The extra
 * branch changes no existing cell.
 *
 * @param observations [{ rs, ps, position, tier, gap ('g0'|'g1'|'g2'), active (0|1) }]
 */
export function fitRoleRates(observations, { k = 10, byPosition = false } = {}) {
  const path = o => byPosition
    ? [[o.rs, '*', '*', '*', '*'], [o.rs, o.ps, '*', '*', '*'], [o.rs, o.ps, o.position, '*', '*'],
       [o.rs, o.ps, o.position, o.tier, '*'], [o.rs, o.ps, o.position, o.tier, o.gap]]
    : [[o.rs, '*', '*', '*', '*'], [o.rs, o.ps, '*', '*', '*'],
       [o.rs, o.ps, '*', o.tier, '*'], [o.rs, o.ps, '*', o.tier, o.gap]];
  // Below the shared root only: the root is counted once, by path().
  const pooledPath = o => byPosition
    ? [[o.rs, '*', o.position, '*', '*'], [o.rs, '*', o.position, o.tier, '*'], [o.rs, '*', o.position, o.tier, o.gap]]
    : [[o.rs, '*', '*', o.tier, '*'], [o.rs, '*', '*', o.tier, o.gap]];
  const nodes = new Map();
  const walk = (o, steps, parent) => {
    for (const parts of steps) {
      const key = parts.join('|');
      const node = nodes.get(key) ?? nodes.set(key, { parts, n: 0, hits: 0, parent }).get(key);
      node.n++; node.hits += o.active ? 1 : 0;
      parent = key;
    }
  };
  for (const o of observations) {
    walk(o, path(o), null);
    if (o.rs === 'questionable') walk(o, pooledPath(o), [o.rs, '*', '*', '*', '*'].join('|'));
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
  let configError = null;
  for (const r of roleRates) {
    role.set([r.report_status, r.practice_status, r.position, r.tier, r.gap].join('|'), r);
    if (!roleConfig && !configError && r.config) {
      try { roleConfig = JSON.parse(r.config); } catch (error) { configError = error.message; }
    }
  }
  // An unreadable config falls back to the pooled chain, which is not what a
  // byPosition fit was graded on — so it is said out loud, never assumed quietly.
  if (configError) {
    console.warn(`[contingency] nfl_availability_role_rates.config is not JSON (${configError}); ` +
      'the role lookup falls back to pooled positions');
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
    configError,
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
      // Out / Doubtful: the designation's own rate (NEAR_CERTAIN). Questionable with no
      // practice status on file (an ESPN designation with no NFL practice line, or a
      // report row that lists none): every practice status of Questionable, still by
      // role, not the thin 'none' cells (fitRoleRates).
      const ps = status === 'questionable' && practice === 'none' ? '*' : practice;
      const chain = NEAR_CERTAIN.has(status) ? [[status, '*', '*', '*', '*']] : roleConfig.byPosition
        ? [[status, ps, position, tier, gap], [status, ps, position, tier, '*'],
           [status, ps, position, '*', '*'], [status, ps, '*', '*', '*'], [status, '*', '*', '*', '*']]
        : [[status, ps, '*', tier, gap], [status, ps, '*', tier, '*'],
           [status, ps, '*', '*', '*'], [status, '*', '*', '*', '*']];
      for (const parts of chain) {
        const r = role.get(parts.join('|'));
        if (r) return { p: r.p_active, n: r.n, basis: parts.filter(x => x !== '*').join('/') };
      }
      return null;
    }
  };
}

/**
 * The fitted availability tables, re-read whenever availabilityFitStamp() changes.
 *
 * Returns null when neither table has been built (fresh install, or
 * scripts/fit-availability.mjs has never run), and the caller falls back to the
 * legacy constants. With the league table but no role table, every number is
 * exactly what it was before the role layer existed.
 *
 * A missing table is a NAMED state, not a quiet one (review-fixes-2, finding 1):
 * production priced every player on the pooled path from 2026-09-18 00:07 because
 * the role table was never written, and a bare catch here made that, a missing
 * column and a locked database all look the same — healthy starters sat at ~0.81 to
 * play with no log line and no note on any page. Now: 'no such table' becomes
 * availabilityBasis() = 'role' | 'pooled' | 'constants', warned once per fit stamp
 * and carried on assetUniverse().context and lineupCall(); any other read error is
 * a real fault (a table from another schema version) and throws.
 */
let _fittedCache;
let _fittedStamp;
let _fittedBasis = null;
export function resetAvailabilityCache() {
  _fittedCache = undefined;
  _fittedStamp = undefined;
  _fittedBasis = null;
  _roleCache.clear();
  _espnMemo = { key: null, periods: null, value: null };
  _saidOnce.clear();
}
/**
 * Row count and newest fitted_at of both tables: which availability fit is live.
 * Keys the lookup below (it used to be held for the life of the process, so a refit
 * written by scripts/fit-availability.mjs in another process was never read until a
 * restart; two cheap reads per weeklyAvailability()), and is recorded by
 * scripts/fit-posture-calibration.mjs beside the dataset SPREAD_SCALE is fit on.
 */
export function availabilityFitStamp() {
  const part = table => {
    try {
      const r = rows(`SELECT COUNT(*) AS n, MAX(fitted_at) AS f FROM ${table}`)[0];
      return `${r?.n ?? 0}:${r?.f ?? ''}`;
    } catch (error) {
      if (missingTable(error)) return 'absent';
      throw error;
    }
  };
  return `${part('nfl_availability_rates')}|${part('nfl_availability_role_rates')}`;
}
function fittedAvailability() {
  const stamp = availabilityFitStamp();
  if (_fittedCache !== undefined && stamp === _fittedStamp) return _fittedCache;
  const read = sql => {
    try { return rows(sql); } catch (error) {
      if (missingTable(error)) return [];
      throw error;
    }
  };
  const rates = read('SELECT scope,team,report_status,practice_status,p_active,n FROM nfl_availability_rates');
  const roleRates = read(`SELECT report_status,practice_status,position,tier,gap,p_active,n,config
                          FROM nfl_availability_role_rates`);
  const lookup = rates.length || roleRates.length ? buildAvailabilityLookup({ rates, roleRates }) : null;
  const missing = [['nfl_availability_rates', rates], ['nfl_availability_role_rates', roleRates]]
    .filter(([, list]) => !list.length).map(([table]) => table);
  // Emitted from AVAILABILITY_FIT_BASIS rather than written out here, so the
  // strings have one definition. This is the PROCESS basis (which fit tables
  // are loaded), not a row's `availability_basis` — see availability-basis.js.
  const [ROLE_FIT, POOLED_FIT, NO_FIT] = AVAILABILITY_FIT_BASIS;
  const basis = lookup?.hasRole ? ROLE_FIT : lookup ? POOLED_FIT : NO_FIT;
  if (missing.length) {
    // Once per fit stamp: this function only re-reads when the stamp changes.
    console.warn(`[contingency] chance to play is priced on the '${basis}' path: ${missing.join(' and ')} ` +
      `${missing.length > 1 ? 'are' : 'is'} missing or empty (fit stamp ${stamp}). ` +
      'scripts/fit-availability.mjs writes both tables (docs/tdd/play-chance-live.tdd.md, section 6).');
  }
  // Set only after both reads succeeded, so a failed read is never cached as "no fit".
  _fittedStamp = stamp;
  _fittedCache = lookup;
  _fittedBasis = { basis, missing, stamp };
  return _fittedCache;
}

/**
 * Which availability model prices this process's chance-to-play numbers right now:
 * 'role' (fitted role layer), 'pooled' (league/team rates only) or 'constants' (no
 * fit on file), the fit tables that are missing or empty, and the fit stamp.
 */
export function availabilityBasis() {
  fittedAvailability();
  return { ..._fittedBasis, missing: [..._fittedBasis.missing] };
}

/**
 * The same basis, as something a page can print: null when the validated role layer is
 * the one pricing the numbers, and otherwise the inert layer WITH ITS REASON, the shape
 * counterparty-pricing.js uses for a source it cannot price on.
 *
 * This exists because the percentages themselves look identical either way. On the
 * pooled path a healthy starter reads 0.55-0.86 (Jayden Daniels 0.574 in production on
 * 2026-09-18, no injury of any kind) while starters of his role played about 95% of
 * weeks — so Start/Sit flags him "check before kickoff" over nothing. A number that is
 * known to be low must not be served looking like the validated one.
 *
 * @param basis availabilityBasis(), or whatever was carried alongside the numbers.
 */
export function availabilityDegradation(basis) {
  if (!basis || basis.basis === 'role') return null;
  const missing = (basis.missing ?? []);
  const named = missing.length ? missing.join(' and ') : 'the fitted availability tables';
  return {
    inert: 'the fitted chance-to-play role layer',
    basis: basis.basis,
    reason: `${named} ${missing.length > 1 ? 'are' : 'is'} missing or empty, so the role layer ` +
      'is not running (docs/tdd/play-chance.tdd.md)',
    effect: basis.basis === 'constants'
      ? 'no availability fit is on file at all, so every chance to play below is a hand-set constant ' +
        'and a career durability prior, not a measured rate'
      : 'every chance to play below is the pooled injury-report rate, which reads about 55-85% for a ' +
        'healthy starter who actually plays about 95% of weeks — read them as a known-low placeholder, ' +
        'not as a reason to sit anybody',
    fix: 'run scripts/fit-availability.mjs (docs/tdd/play-chance-live.tdd.md, section 6)',
    stamp: basis.stamp ?? null
  };
}

/**
 * One player's chance to be active, from whatever is on file. Shared by
 * weeklyAvailability and the fit script's gate, so what was validated is what runs.
 */
export function playerActiveProbability({
  fitted, report, prior, role = null, useRole = true, priorMeasured = true
}) {
  const status = String(report?.report_status ?? '').toLowerCase();
  const practice = String(report?.practice_status ?? '').toLowerCase();
  let active = prior;
  let source = report ? 'weekly injury report + durability prior' : 'durability prior only';
  // The machine-readable twin of `source`. `source` is display prose and free
  // to be reworded; this is the contract, from availability-basis.js. The two
  // must be set together at every branch below or a consumer is back to
  // guessing from the sentence.
  let basis = priorMeasured ? 'durability_prior' : 'default_durability';

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
    // The fit cell's own label, which goes in the display sentence. Not the
    // row's `availability_basis`, which is the contract value set below.
    let cellBasis = roleCell.basis;
    const tr = report ? fitted.teamRatio(report.team, status) : null;
    if (tr) { p *= tr.ratio; cellBasis += ` x ${tr.team}`; }
    active = p;
    source = `fitted availability by role (${cellBasis}, n=${roleCell.n})`;
    basis = 'role';
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
      basis = 'pooled';
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

  return { active: Math.max(0.001, Math.min(0.995, active)), source, basis };
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

/**
 * G2 of the play-chance-live gate (pre-registered 2026-09-18, before any 2025 number
 * broken out this way; docs/tdd/play-chance-live.tdd.md): the pooled gate above can
 * pass while one designation x role cell gets worse, and that cell is exactly where a
 * start/sit is decided (a Questionable starter). Cells: designation (report group:
 * noreport | none | questionable | doubtful | out) x role tier, plus each designation
 * pooled over roles ('*'). A cell with n >= minCell is gated and must satisfy BOTH
 *   (a) log loss non-inferiority: candidate <= current + logLossSlack;
 *   (b) calibration in the large: |mean p_candidate - actual| <= max(calibrationFloor,
 *       2 x binomial SE of the actual rate), OR no further from the truth than current.
 * 10-bin ECE is reported per cell for both arms and gated only overall (roleGateDecision):
 * on 50-300 rows a 10-bin ECE is mostly sampling noise. Smaller cells are reported only.
 */
/*
 * G2-v2, restructured 2026-09-19. The rule was written out in full and committed
 * before the fit was re-run under it: docs/tdd/play-chance-gate-v2.md.
 *
 * WHY IT CHANGED. v1 applied two conditions per cell, and they disagreed about
 * whether cell size matters. The calibration condition scaled its tolerance with the
 * cell's own sampling error (`max(calibrationFloor, 2 * SE)`, below). The log-loss
 * condition was a flat `candidate <= current + 0.02` for every cell, whatever its
 * size. So the half that ignored cell size was the half that could veto the whole
 * fit, which puts the loosest evidentiary standard and the greatest power to fire at
 * random in the same place: the smallest gated cell.
 *
 * WHAT CHANGED. Exactly one condition. The log-loss check now asks whether the cell's
 * own data can distinguish a degradation larger than `logLossSlack` from noise, using
 * the same bootstrap, clustering, draw count and seed the main gate's check 1 already
 * uses. `minCell` is NOT raised and `logLossSlack` is NOT widened; the same number is
 * used, and only the question asked of it changes. This is a relaxation of a noisy
 * cell's veto and the doc says so plainly rather than dressing it up.
 *
 * `logLossBootstrap: false` restores v1 exactly, which is how the tests prove the
 * diff is confined to this one condition.
 */
export const DESIGNATION_ROLE_GATE = Object.freeze({
  minCell: 50, logLossSlack: 0.02, calibrationFloor: 0.03, bins: 10,
  logLossBootstrap: true, bootstrapIterations: 2000, bootstrapSeed: 20260918,
  // pairedBootstrapDiff refuses below 10 paired rows. With minCell at 50 no gated
  // cell reaches the fallback; it exists so a cell that could not be evaluated can
  // never be silently passed.
  minBootstrapRows: 10,
  designations: Object.freeze(['noreport', 'none', 'questionable', 'doubtful', 'out']),
  roles: Object.freeze(['*', 'starter', 'rotation', 'depth', 'fringe', 'unknown'])
});

/** @param gateRows [{ player_id, y, p_current, p_candidate, rs, tier }] */
export function designationRoleGate(gateRows, gate = DESIGNATION_ROLE_GATE) {
  const groups = new Map();
  const add = (designation, role, row) => {
    const key = `${designation}|${role}`;
    (groups.get(key) ?? groups.set(key, { designation, role, rows: [] }).get(key)).rows.push(row);
  };
  for (const row of gateRows) { add(row.rs, row.tier ?? 'unknown', row); add(row.rs, '*', row); }
  const avg = (list, key) => list.reduce((s, r) => s + r[key], 0) / list.length;
  const order = (list, value) => { const i = list.indexOf(value); return i < 0 ? list.length : i; };
  const cells = [...groups.values()].map(({ designation, role, rows: list }) => {
    const n = list.length;
    const actual = list.reduce((s, r) => s + (r.y ? 1 : 0), 0) / n;
    const cur = availabilityScores(list.map(r => ({ p: r.p_current, y: r.y })), { bins: gate.bins });
    const cand = availabilityScores(list.map(r => ({ p: r.p_candidate, y: r.y })), { bins: gate.bins });
    const meanCurrent = avg(list, 'p_current'), meanCandidate = avg(list, 'p_candidate');
    const tolerance = Math.max(gate.calibrationFloor, 2 * Math.sqrt(actual * (1 - actual) / n));
    const biasCurrent = Math.abs(meanCurrent - actual), biasCandidate = Math.abs(meanCandidate - actual);
    const gated = n >= gate.minCell;

    // G2-v2: the cell vetoes on log loss only when its own data can distinguish a
    // degradation larger than `logLossSlack` from noise at 90%. `pairedBootstrapDiff`
    // bootstraps (B - A), so current is A and candidate is B and a positive diff is a
    // degradation; failing requires the whole 90% interval to sit above the slack.
    // The point comparison below is v1, kept for the un-bootstrappable fallback and
    // for `logLossBootstrap: false`.
    const pointPass = cand.log_loss <= cur.log_loss + gate.logLossSlack;
    let bootstrap = null;
    if (gate.logLossBootstrap && n >= (gate.minBootstrapRows ?? 10)) {
      bootstrap = pairedBootstrapDiff(
        list.map(r => rowLogLoss(r.p_current, r.y)),
        list.map(r => rowLogLoss(r.p_candidate, r.y)),
        { iterations: gate.bootstrapIterations, seed: gate.bootstrapSeed,
          groups: list.map(r => r.player_id) }
      );
      // An `error` from the helper means it declined to bootstrap; fall back rather
      // than read a ci90 that is not there.
      if (bootstrap?.error) bootstrap = null;
    }
    const logLossPass = bootstrap ? !(bootstrap.ci90[0] > gate.logLossSlack) : pointPass;
    const calibrationPass = biasCandidate <= tolerance || biasCandidate <= biasCurrent;
    return {
      designation, role, n, actual, mean_current: meanCurrent, mean_candidate: meanCandidate,
      log_loss_current: cur.log_loss, log_loss_candidate: cand.log_loss,
      ece_current: cur.ece, ece_candidate: cand.ece, tolerance, gated,
      log_loss_pass: logLossPass, calibration_pass: calibrationPass,
      // Reported so a reader can see which rule decided the cell and on what evidence,
      // rather than having to trust that the bootstrap ran.
      log_loss_basis: bootstrap ? 'bootstrap_ci90' : 'point_estimate',
      log_loss_point_pass: pointPass,
      log_loss_ci90: bootstrap ? bootstrap.ci90 : null,
      log_loss_mean_diff: bootstrap ? bootstrap.mean_diff : null,
      pass: !gated || (logLossPass && calibrationPass)
    };
  }).sort((a, b) => order(gate.designations, a.designation) - order(gate.designations, b.designation)
    || order(gate.roles, a.role) - order(gate.roles, b.role));
  return { pass: cells.every(c => c.pass), cells };
}

/**
 * Every skill player's chance to be active in (season, week), strictly pregame.
 *
 * `espn` (default on) merges ESPN's current designation (weekDesignation) — read only
 * when (season, week) is the synced payloads' current ESPN scoring period, so a replay
 * of any other week is the NFL report alone. `report_status` is the status the number
 * was priced on (an ESPN label such as 'Out (ESPN)' when ESPN's is the more severe);
 * `designation` / `designation_source` / `espn_status` say which and why.
 */
export function weeklyAvailability(season, week, { through = season - 1, useRole = true, espn = true } = {}) {
  const base = availability({ through });
  const players = rows(`SELECT p.id, p.name, p.position, p.gsis_id, p.espn_id, t.abbr AS team
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id
                        WHERE p.position IN ('QB','RB','WR','TE')`);
  const reports = new Map(rows(`SELECT * FROM nfl_injuries WHERE season=? AND week=?`, season, week)
    .map(r => [String(r.gsis_id), r]));
  const espnStatus = espn ? liveEspnStatuses(season, week) : null;
  const out = new Map();

  const fitted = fittedAvailability();
  // Role states are only read when fitted role rates exist; without them this
  // function is byte-for-byte the pre-role path.
  const roles = useRole && fitted?.hasRole ? roleStates(season, week) : null;
  // AVAIL-HORIZON (availability-return.js): for a week past the live anchor the role
  // state is frozen at today's games, so the one-week rate would be reused for every
  // remaining week. With the flag on, such a week is priced on the fitted
  // return-to-play curve instead. h = 0 (the live week, and every replay) is untouched.
  const horizon = roles ? weeksAhead(season, week) : 0;
  const hFlag = horizon >= 1 ? availHorizonFlag() : { on: false, preview: false };
  const curve = hFlag.on ? servedReturnCurve() : null;

  for (const p of players) {
    // No availability() row means no games on file through the cutoff, so there
    // is no measured durability prior to serve. The constant that stands in is
    // inside the range measured priors occupy, so the substitution has to be
    // stated on the row: a caller reading `durability_prior` alone cannot tell
    // a career measurement from this default.
    const measuredPrior = base.get(p.id)?.available ?? null;
    const prior = measuredPrior ?? DEFAULT_DURABILITY_PRIOR;
    const nflReport = p.gsis_id ? reports.get(String(p.gsis_id)) ?? null : null;
    const role = roles?.get(p.id) ?? null;
    const espnNow = espnStatus && p.espn_id != null ? espnStatus.get(String(p.espn_id))?.status ?? null : null;
    const week_ = weekDesignation({ report: nflReport, espnStatus: espnNow, team: p.team ?? role?.team ?? null });
    const report = week_.report;
    let { active, source, basis } = playerActiveProbability({
      fitted, report, prior, role, useRole, priorMeasured: measuredPrior != null
    });
    // No report can exist for a future week; the guard keeps a stray row authoritative.
    // AVAIL-HORIZON-2: only a player in a gap state (missed his team's last game, g1/g2)
    // reads the curve. A g0 player keeps today's calibrated one-week rate: the curve's g0
    // cells carry future injuries the sim's volume scale was already fitted without.
    const cell = curve && !report && role?.gap_bucket && role.gap_bucket !== 'g0'
      ? curve.lookup({ h: horizon, gap: role.gap_bucket, tier: role.tier }) : null;
    if (cell) {
      active = Math.max(0.001, Math.min(0.995, cell.p));
      source = `return-to-play curve (${cell.basis}, n=${cell.n}, ${horizon} week${horizon > 1 ? 's' : ''} past the last game on file)`;
      basis = 'role';
    }
    out.set(p.id, {
      player_id: p.id, name: p.name, position: p.position,
      active_probability: +active.toFixed(3),
      durability_prior: +prior.toFixed(3),
      durability_prior_measured: measuredPrior != null,
      availability_basis: basis,
      report_status: report?.report_status ?? null,
      practice_status: report?.practice_status ?? null,
      designation: week_.designation,
      designation_source: week_.source,
      espn_status: espnNow,
      injury: report?.injury ?? null,
      role: role ? {
        tier: role.tier, share: role.share == null ? null : +role.share.toFixed(3),
        gap: role.gap, in_scope: role.gap_bucket != null
      } : null,
      source,
      ...(cell ? { horizon: { weeks_ahead: horizon, basis: cell.basis }, ...availHorizonPreviewFields(hFlag) } : {})
    });
  }
  return out;
}

/**
 * How many NFL weeks `week` lies past the live anchor: the first week of `season` with no
 * usage rows before `week` (0 for a replayed week, whose previous week is on file).
 * Before any game of the season the anchor is week 1.
 */
export function weeksAhead(season, week) {
  const last = rows('SELECT MAX(week) AS w FROM player_week_usage WHERE season = ? AND week < ?', season, week)[0]?.w;
  const anchor = Number.isInteger(last) ? last + 1 : 1;
  return Math.max(0, week - anchor);
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
      // The gain is bounded by the observed without-starter mean and stands on its own.
      // The ratio does not: it is only reported when its divisor was estimated from
      // enough opportunity to mean something. See MIN_DENOMINATOR_OPPORTUNITIES.
      const supported = base > 0 && with_.opp >= MIN_DENOMINATOR_OPPORTUNITIES;
      beneficiaries.push({
        player_id: mateId, name: without.name, position: without.position,
        base_opportunity: +base.toFixed(2),
        opportunity_without: +boosted.toFixed(2),
        gain: +gain.toFixed(2),
        multiplier: supported ? +ratio.toFixed(3) : null,
        denominator_opportunities: with_.opp,
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
