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
 * actually taking, then by how much that absence is worth -- a flat
 * positional constant on offense, where nothing better exists, or (for
 * defensive positions PFR has charted) the player's own prior production.
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
import { normalize, nameSignature } from './nfl-player-value.js';

/**
 * What a snap is worth by position, relative to a generic offensive snap.
 *
 * A quarterback is not four times more valuable than a guard because he plays
 * more — they both play every down — but because his replacement is far worse.
 * These are replacement-level gaps, which is why QB dwarfs everything and why
 * interior linemen barely register.
 *
 * For the defensive slots below, this is the FALLBACK, not the final answer:
 * `defensiveProductionWeight()` further down replaces it with a per-player
 * prior-weeks production weight whenever `nfl_pfr_adv` has charted that
 * defender. Offense has no equivalent signal here, so it always uses this
 * table as-is.
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

/**
 * The defensive slots in POSITION_WEIGHT -- the only positions eligible for a
 * per-player production weight in place of the flat positional constant.
 * Offense keeps the flat table unconditionally: no equivalent per-player,
 * cutoff-safe production signal exists for it here.
 */
const DEFENSIVE_POSITIONS = new Set([
  'DE', 'DT', 'LB', 'CB', 'S', 'EDGE', 'NT', 'OLB', 'ILB', 'FS', 'SS', 'DB'
]);

// A starting edge rusher and a replacement-level one at the same snap share
// currently score identically -- POSITION_WEIGHT knows only that both play
// EDGE. `nfl_pfr_adv` (kind='def') is real per-player charting that can tell
// them apart, so these constants convert a defender's own prior-weeks
// production into a weight that REPLACES weightFor(position) for him.
// FLOOR stands in for "charted but otherwise unremarkable"; the coefficients
// are a monotone prior; the ensemble is free to prove them wrong.
const DEF_PRODUCTION_FLOOR = 0.3;
const DEF_PRODUCTION_WEIGHTS = { pressure: 0.05, sack: 0.15, tackle: 0.02, missed: 0.08 };

/**
 * A defender's own prior-weeks production weight, or null when PFR has
 * nothing usable to charge him against -- which the caller must then treat
 * exactly like today's flat `weightFor(position)`, unchanged.
 *
 * MATCHING reuses, rather than re-derives, the rule `nfl-player-value.js`'s
 * `priorAdvancedPerformance` already established for this exact table:
 * `normalize(name)` tried first for an exact match against `player_name`,
 * falling back to `nameSignature` (team + first-initial + surname, since PFR
 * abbreviates first names) only when it resolves to exactly one charted
 * identity. Writing a second copy of that rule here is precisely the
 * duplicated-normalization failure this codebase's own docs call out for
 * PFR/CLV matching, so both helpers are imported instead.
 *
 * CUTOFF SAFETY mirrors the snap-share query above it: strictly earlier weeks
 * of the same season, falling back to the entire prior season for week 1 --
 * the same shape, for the same reason. PFR charting is not subject to the
 * live-revision problem `nfl_injuries` has (no in-place rewrites to guard
 * against), so unlike that table this query needs no `cutoffAt` gate.
 *
 * COVERAGE. Real `def` rows exist only from the 2024 season on; 2021-2023
 * carry zero. Those seasons, and any player PFR genuinely never charted,
 * simply produce no rows here -- returning null, not a guess.
 */
function defensiveProductionWeight(season, week, team, playerName) {
  const pfrRows = week > 1
    ? rows(`SELECT player_name, stats FROM nfl_pfr_adv
            WHERE kind = 'def' AND team = ? AND season = ? AND week < ?`, team, season, week)
    : rows(`SELECT player_name, stats FROM nfl_pfr_adv
            WHERE kind = 'def' AND team = ? AND season = ?`, team, season - 1);
  if (!pfrRows.length) return null;

  const name = normalize(playerName);
  const exact = pfrRows.filter(r => normalize(r.player_name) === name);
  const signature = nameSignature(playerName);
  const signatureMatches = pfrRows.filter(r => nameSignature(r.player_name) === signature);
  const signatureNames = new Set(signatureMatches.map(r => normalize(r.player_name)));
  // Ambiguous signature matches (two different charted defenders sharing a
  // team + first-initial + surname) abstain rather than attach the wrong
  // player's stats -- same rule, same reason, as nfl-player-value.js.
  const matches = exact.length ? exact
    : signature && signatureNames.size === 1 ? signatureMatches : [];
  if (!matches.length) return null;

  const parsed = matches.map(r => { try { return JSON.parse(r.stats); } catch { return {}; } });
  const avg = key => {
    const values = parsed.map(s => s[key]).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  };
  const raw = DEF_PRODUCTION_FLOOR
    + avg('def_pressures') * DEF_PRODUCTION_WEIGHTS.pressure
    + avg('def_sacks') * DEF_PRODUCTION_WEIGHTS.sack
    + avg('def_tackles_combined') * DEF_PRODUCTION_WEIGHTS.tackle
    - avg('def_missed_tackles') * DEF_PRODUCTION_WEIGHTS.missed;
  // Never below half the floor, never negative: an unproductive or
  // butter-fingered charted defender still costs something when he sits.
  return Math.max(DEF_PRODUCTION_FLOOR / 2, raw);
}

let _cache = new Map();
export function clearAvailabilityCache() { _cache = new Map(); }

/**
 * Availability deficit per team for one season-week.
 *
 * Returns a Map of team to weighted lost snap share. Zero means everyone who
 * matters is playing; larger numbers mean more of the team's real production is
 * unavailable.
 */
export function availabilityDeficit(season, week, { cutoffAt = null } = {}) {
  // The cutoff belongs in the cache key: without it a historical replay and a
  // live call for the same week would hand each other the wrong answer.
  const key = `${season}|${week}|${cutoffAt ?? 'live'}`;
  if (_cache.has(key)) return _cache.get(key);

  // `nfl_injuries` is CURRENT STATE -- primary key (season, week, gsis_id),
  // updated in place, no version history. Live callers pass no cutoff and get
  // the table as it stands, which is correct for a game that has not started.
  // A HISTORICAL caller must not: a row rewritten after that game kicked off
  // may hold a later revision, and the text it carried beforehand is gone. So
  // a cutoff admits only rows untouched since before it -- the same rule
  // `research/betting/nfl/injury_admission.py` calls `unmodified_since`.
  // Measured on this database, ~96-99% of 2021-2024 rows survive that rule
  // per game, while 2025 and 2026 rows carry no `modified_at` at all and are
  // therefore entirely inadmissible for historical use.
  const injuries = cutoffAt
    ? rows(
      `SELECT team, full_name, position, report_status
       FROM nfl_injuries
       WHERE season = ? AND week = ? AND report_status IS NOT NULL
         AND modified_at IS NOT NULL AND modified_at <= ?`, season, week, cutoffAt)
    : rows(
      `SELECT team, full_name, position, report_status
       FROM nfl_injuries
       WHERE season = ? AND week = ? AND report_status IS NOT NULL`, season, week);

  const deficit = new Map();
  // Coverage of the per-player defensive production weight below, attached
  // to the Map instance rather than returned alongside it: every existing
  // caller destructures or iterates this as a plain Map, and the full test
  // suite was run to confirm none of them compares it by deep equality
  // against a hand-built Map, which an extra own property would break.
  deficit.pfrDefenseMatched = 0;
  deficit.pfrDefenseUnmatched = 0;
  if (!injuries.length) { _cache.set(key, deficit); return deficit; }

  // Snap shares from strictly EARLIER weeks of the same season, falling back to
  // the prior season for week 1 when there is no in-season history yet.
  // A player's playing-time share is whichever unit he actually plays, so
  // offense and defense are both read and the larger taken.
  //
  // This used to select `offense_pct` alone. `nfl_snaps` carries a fully
  // populated `defense_pct` too (25,271 of 25,271 rows in 2021, and the same
  // in every season since), so every defender -- about half of each roster --
  // matched nothing, fell through to the 0.15 default below, and was valued
  // by position alone. A starting cornerback and a fourth safety were the
  // same number. They are not the same number.
  const share = 'AVG(MAX(COALESCE(offense_pct, 0), COALESCE(defense_pct, 0)))';
  const snapRows = week > 1
    ? rows(`SELECT player, team, position, ${share} AS pct
            FROM nfl_snaps WHERE season = ? AND week < ? GROUP BY player, team, position`,
      season, week)
    : rows(`SELECT player, team, position, ${share} AS pct
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

    // A starter and a replacement-level player at the same position and the
    // same snap share currently cost the same -- fine for offense, wrong for
    // defense, where PFR charting can actually tell them apart. When a prior-
    // weeks production weight exists for this defender it REPLACES the flat
    // positional constant; anyone unmatched (wrong era, or genuinely
    // uncharted) keeps exactly today's weightFor(position) behavior.
    const position = String(inj.position ?? '').toUpperCase();
    let weight = weightFor(inj.position);
    if (DEFENSIVE_POSITIONS.has(position)) {
      const production = defensiveProductionWeight(season, week, team, inj.full_name);
      if (production != null) { weight = production; deficit.pfrDefenseMatched++; }
      else deficit.pfrDefenseUnmatched++;
    }

    const lost = effective * cost * weight;
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
export function availabilityEdge(season, week, home, away, { cutoffAt = null } = {}) {
  const d = availabilityDeficit(season, week, { cutoffAt });
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
      'factor (Out 1.0, Doubtful 0.75, Questionable 0.25) times a replacement weight. Offense always ' +
      'uses the flat positional table (QB 4.5 down to long snapper 0.05); defense uses that table ' +
      'only as a fallback, and otherwise uses the individual defender\'s own prior-weeks PFR charted ' +
      'production (pressures, sacks, tackles, missed tackles) whenever nfl_pfr_adv has him -- real ' +
      'rows exist from the 2024 season on. Snap shares and PFR production both come from strictly ' +
      'earlier weeks: a week-W number is only known after week W, whereas injury reports are ' +
      'published before kickoff and are legitimately available. Getting that backwards would read ' +
      'the future.'
  };
}
