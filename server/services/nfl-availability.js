/**
 * How much of a team is actually going to play.
 *
 * The spread model has never known about injuries. `nfl-ensemble.js` and
 * `nfl-auto-picks.js` contain zero references to the injury table, and the
 * pregame snapshot that does carry them is attached to a pick as display
 * metadata — `pregame_snapshot_at`, `pregame_context` — and never enters the
 * number. Seventeen thousand injury rows have been sitting in a table the
 * forecasting model has never read.
 *
 * The naive fix is to count injured players, and it is worthless: a team
 * missing four special-teamers is fine and a team missing its quarterback is
 * not. What matters is the share of actual playing time that walks out the
 * door, so this weights every absence by the snap share that player was
 * actually taking, then again by how much a snap at his position is worth.
 *
 * CUTOFF SAFETY, which is the whole reason this can be trusted. Injury reports
 * are published Wednesday through Friday for a Sunday game, so a week-W report
 * is legitimately known before the week-W kickoff and using it is not
 * leakage. Snap shares are the opposite — a player's week-W snaps are only
 * known afterwards — so weighting uses strictly EARLIER weeks. Getting this
 * backwards would produce a model that looks brilliant and is reading the
 * future.
 */
import { rows } from '../db/index.js';

/**
 * What a snap is worth by position, relative to a generic offensive snap.
 *
 * A quarterback is not four times more valuable than a guard because he plays
 * more — they both play every down — but because his replacement is far worse.
 * These are replacement-level gaps, which is why QB dwarfs everything and why
 * interior linemen barely register.
 */
const POSITION_WEIGHT = {
  QB: 4.5, RB: 0.8, WR: 1.0, TE: 0.7,
  T: 0.9, G: 0.5, C: 0.6,
  DE: 1.0, DT: 0.7, LB: 0.7, CB: 1.0, S: 0.7,
  EDGE: 1.0, NT: 0.6, OLB: 0.9, ILB: 0.6, FS: 0.7, SS: 0.7, DB: 0.7, OL: 0.6,
  K: 0.2, P: 0.1, LS: 0.05, FB: 0.2
};
const weightFor = pos => POSITION_WEIGHT[String(pos ?? '').toUpperCase()] ?? 0.5;

/** How much a report status actually costs, in expected absence. */
const STATUS_COST = { OUT: 1.0, DOUBTFUL: 0.75, QUESTIONABLE: 0.25 };
const costFor = status => STATUS_COST[String(status ?? '').toUpperCase()] ?? 0;

let _cache = new Map();
export function clearAvailabilityCache() { _cache = new Map(); }

/**
 * Availability deficit per team for one season-week.
 *
 * Returns a Map of team to weighted lost snap share. Zero means everyone who
 * matters is playing; larger numbers mean more of the team's real production is
 * unavailable.
 */
export function availabilityDeficit(season, week) {
  const key = `${season}|${week}`;
  if (_cache.has(key)) return _cache.get(key);

  const injuries = rows(
    `SELECT team, full_name, position, report_status
     FROM nfl_injuries
     WHERE season = ? AND week = ? AND report_status IS NOT NULL`, season, week);

  const deficit = new Map();
  if (!injuries.length) { _cache.set(key, deficit); return deficit; }

  // Snap shares from strictly EARLIER weeks of the same season, falling back to
  // the prior season for week 1 when there is no in-season history yet.
  const snapRows = week > 1
    ? rows(`SELECT player, team, position, AVG(offense_pct) AS pct
            FROM nfl_snaps WHERE season = ? AND week < ? GROUP BY player, team, position`,
      season, week)
    : rows(`SELECT player, team, position, AVG(offense_pct) AS pct
            FROM nfl_snaps WHERE season = ? GROUP BY player, team, position`, season - 1);

  const snaps = new Map();
  for (const s of snapRows) {
    snaps.set(`${String(s.team).toUpperCase()}|${String(s.player).toLowerCase()}`, s.pct ?? 0);
  }

  for (const inj of injuries) {
    const cost = costFor(inj.report_status);
    if (!cost) continue;
    const team = String(inj.team).toUpperCase();
    const share = snaps.get(`${team}|${String(inj.full_name).toLowerCase()}`);
    // A player with no snap history is either a rookie, a practice-squad
    // call-up, or a defender (nfl_snaps only carries offensive percentages).
    // Charging him a default rather than zero keeps defensive injuries from
    // being invisible, but the default is deliberately small.
    const effective = Number.isFinite(share) && share > 0 ? share : 0.15;
    const lost = effective * cost * weightFor(inj.position);
    deficit.set(team, (deficit.get(team) ?? 0) + lost);
  }
  _cache.set(key, deficit);
  return deficit;
}

/**
 * The matchup-level feature: how much more of its production one team is
 * missing than the other.
 *
 * Positive means the AWAY team is more depleted, which should favour the home
 * side — the same sign convention the rest of the ensemble uses for margin.
 */
export function availabilityEdge(season, week, home, away) {
  const d = availabilityDeficit(season, week);
  // No injury report for the week is missing evidence, not "everyone healthy".
  // A silent zero here is exactly the guardrail the data-consistency audit
  // forbids; return null so consumers abstain instead of reading a clean bill.
  if (!d.size) return null;
  const h = d.get(String(home).toUpperCase()) ?? 0;
  const a = d.get(String(away).toUpperCase()) ?? 0;
  return a - h;
}

/**
 * What the feature looks like across a season, so it can be sanity-checked
 * before anything is fitted on it.
 *
 * A feature nobody has looked at is a feature nobody should trust. If the
 * biggest deficits are not recognisable as real injury situations, the join is
 * broken and every downstream coefficient is noise.
 */
export function availabilityAudit({ season = 2024 } = {}) {
  const weeks = rows(`SELECT DISTINCT week FROM nfl_injuries WHERE season = ? ORDER BY week`, season)
    .map(r => r.week);
  if (!weeks.length) {
    return { error: `no injury reports stored for ${season}`,
      seasons_available: rows(`SELECT DISTINCT season FROM nfl_injuries ORDER BY season`).map(r => r.season) };
  }

  const all = [];
  for (const w of weeks) {
    for (const [team, def] of availabilityDeficit(season, w)) all.push({ week: w, team, deficit: def });
  }
  const vals = all.map(a => a.deficit);
  const mean = vals.reduce((x, y) => x + y, 0) / (vals.length || 1);
  const sorted = [...vals].sort((a, b) => a - b);

  return {
    season, weeks_covered: weeks.length, team_weeks: all.length,
    mean_deficit: +mean.toFixed(3),
    median_deficit: +(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(3),
    p90_deficit: +(sorted[Math.floor(sorted.length * 0.9)] ?? 0).toFixed(3),
    max_deficit: +Math.max(...vals).toFixed(3),
    worst_situations: all.sort((a, b) => b.deficit - a.deficit).slice(0, 10)
      .map(a => ({ week: a.week, team: a.team, deficit: +a.deficit.toFixed(2) })),
    note: 'Weighted lost snap share: each absence costs its prior-weeks snap rate times a status ' +
      'factor (Out 1.0, Doubtful 0.75, Questionable 0.25) times a positional replacement weight ' +
      '(QB 4.5 down to long snapper 0.05). Snap shares come from strictly earlier weeks: a week-W snap ' +
      'count is only known after week W, whereas injury reports are published before kickoff and are ' +
      'legitimately available. Getting that backwards would read the future.'
  };
}
