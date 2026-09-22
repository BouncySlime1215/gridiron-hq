/**
 * Manager archetypes - revealed preference, measured from the league history.
 *
 * WHAT THIS IS FOR. The trade engine prices both sides with OUR model. The edge
 * lives in the gap between our valuation and the counterparty's, so the engine
 * needs a model of the counterparty. manager-signals.js already carries what he
 * SAYS (chat) and what he has DONE SINCE 2026-09-17 (transactions). This file
 * carries the one thing we have years of: what he DID on draft day, and how the
 * season then treated him.
 *
 * WHY THE DRAFT IS WORTH THIS MUCH WORK. A draft is 16-17 forced, timed,
 * public choices against a published consensus, repeated every year by the same
 * person. That is a cleaner revealed-preference instrument than anything else in
 * the file: no negotiation, no counterparty, no ambiguity about who chose. 1,738
 * picks over 12 league-seasons exist in league_draft_picks right now.
 *
 * WHAT IS DELIBERATELY NOT HERE. Lineup-set timing, waiver reaction latency,
 * counter-offer behaviour and proposal response time. ESPN serves roughly three
 * days of transactions, so that history is not retrievable; forward capture into
 * league_transactions_raw started 2026-09-17. Inventing a proxy for those from
 * draft data would produce a number with no observation behind it, which is
 * worse than an empty field. study/features/archetypes.md says when there will
 * be enough of it.
 *
 * LEAK GUARANTEE, and its one hole. Every draft-side metric compares a pick
 * against information published at or just after that draft:
 *   - consensus rank comes from nfl_historical_adp, which keeps ONE row per
 *     (season, player) - the LAST preseason scrape, not an early-August one.
 *     Measured: 2025 = 2025-08-08 (before the draft, clean), but 2024 =
 *     2024-08-30 and 2023 = 2023-09-01, which are at or AFTER the late-August
 *     drafts they are used to score. So a 2023/2024 consensus rank can reflect
 *     final-cut and preseason-injury news the manager did not have. It is a
 *     small forward peek and it is NOT fixable from this table, whose primary
 *     key is (season, source, player_key); the dated series that would fix it,
 *     nfl_historical_adp_scrape, exists but is empty (0 rows). Until it is
 *     populated and consensusFor() takes a draft date, treat every
 *     consensus-derived metric for 2023 and 2024 as slightly contaminated.
 *   - "name brand" uses the PRIOR season's consensus, which is a year older
 *     still, so it inherits none of the above;
 *   - player volatility is read at (season, week 1) - from player_week_usage of
 *     the prior season, and from the weekly feature store, whose history query
 *     is `season < S OR (season = S AND week < 1)`, i.e. prior seasons only.
 * Outcome metrics (record, all-play, luck) are outcomes by definition and are
 * tagged source='outcome' so no consumer mistakes them for draft-day knowledge.
 *
 * SUBSTRATE. Player-level volatility comes from nfl-weekly-feature-store.js
 * (base_total_yards__sd_6 / __mean_6 frozen at week 1), not from a second
 * feature pipeline built here. The one thing the store does not carry is fantasy
 * points, so the fantasy-scoring view of the same quantity uses scoring.js's
 * scoreLine over player_week_usage - the app's single scoring function, again
 * not a reimplementation.
 */
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { scoreLine } from './scoring.js';
import { buildPlayerFeatureVector } from './nfl-weekly-feature-store.js';

export const MANAGER_ARCHETYPE_VERSION = 'manager-archetypes-v1';

/** Positions with a real consensus rank. DEF has none in the FantasyPros
 *  offense-only feed (0/65 joined) and K's rank is noise past 200, so every
 *  value/reach metric is computed over skill positions only. */
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/** Career rows are stored in the same table under a reserved key rather than a
 *  second table, so one read gets a manager's season detail and his career
 *  summary together. */
const CAREER_LEAGUE = 0;
const CAREER_SEASON = 0;

// These mirror manager-signals.js, which also creates its own tables at import.
// A migration in server/db/schema/ would be the tidier home, but this module is
// additive and owns these two tables outright.
db.exec(`CREATE TABLE IF NOT EXISTS manager_archetypes (
  member_id TEXT NOT NULL,
  league_id INTEGER NOT NULL,   -- 0 = career roll-up across leagues
  season INTEGER NOT NULL,      -- 0 = career roll-up across seasons
  metric TEXT NOT NULL,
  value REAL,
  label TEXT,                   -- for metrics whose answer is a name, e.g. the homer team
  n INTEGER NOT NULL,           -- observations behind THIS number, never implied
  source TEXT NOT NULL,         -- draft | outcome | career
  version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (member_id, league_id, season, metric))`);
db.exec(`CREATE TABLE IF NOT EXISTS manager_archetype_jev (
  member_id TEXT NOT NULL,
  question TEXT NOT NULL,
  outcome TEXT NOT NULL,        -- choice key, score level, or 'true' for a boolean
  probability REAL,
  -- basis is the honest half of this table: 'draft' means the state Jev read
  -- contains evidence bearing on the question; 'inference_only' means it does
  -- not, and the number is a prior dressed as a probability until transaction
  -- history exists.
  basis TEXT NOT NULL,
  n_seasons INTEGER, n_picks INTEGER,
  model TEXT, state_chars INTEGER, evaluated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, question, outcome))`);

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = xs => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};

/** Midranks, so a Pearson over them is Spearman. */
const ranks = xs => {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const tied = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = tied;
    i = j + 1;
  }
  return out;
};

/**
 * Consensus for one season, as a DENSE RANK over skill positions only.
 *
 * Two sources, deliberately not mixed inside a season:
 *   fpecr  - nfl_historical_adp, preseason FantasyPros consensus, 2021-2025.
 *   espn   - espn_player_market.adp, the only consensus we hold for 2026.
 * Both are re-ranked 1..N within the season's skill-position universe before
 * use, because an ECR rank over ~600 offensive players and an ESPN average draft
 * position over 1,000 players including kickers and defences are not the same
 * unit. Ranking within a common universe makes "nth skill player the market
 * expected" comparable across sources and league sizes.
 *
 * The ESPN snapshot carries one caveat that belongs on every 2026 number it
 * touches: it was fetched during the season, not frozen before the draft. ESPN's
 * ADP is formed by drafts, which finish in August, so it is preseason in
 * substance - but it is not a dated preseason artefact the way the FantasyPros
 * scrape is.
 *
 * NOTE, corrected 2026-09-17: an earlier version of this comment claimed 2026
 * was "excluded from anything graded". It is not. metricRepeatability() pairs
 * every consecutive season on file, so 23 of its 58 pairs take their SECOND
 * value from 2026 - i.e. from this ESPN board, against a 2025 FantasyPros one.
 * Measured effect on the two metrics that looked alive: dropping 2026 moves
 * pos_lean_rb from 0.34 to 0.49 and pos_lean_wr from 0.33 to 0.40, so it is
 * depressing them rather than manufacturing them. Either way the claim of
 * exclusion was false and is withdrawn rather than quietly made true.
 */
export function consensusFor(season) {
  const fp = rows(`SELECT player_key, name, position, team, ecr_rank FROM nfl_historical_adp
                   WHERE season = ? AND position IN ('QB','RB','WR','TE') ORDER BY ecr_rank`, season);
  if (fp.length >= 100) {
    const byKey = new Map();
    fp.forEach((r, i) => byKey.set(r.player_key, { rank: i + 1, team: r.team, position: r.position }));
    return { source: 'fpecr', size: fp.length, byName: byKey, byEspnId: null };
  }
  const espn = rows(`SELECT m.espn_id, m.adp, p.position FROM espn_player_market m
                     JOIN players p ON p.espn_id = m.espn_id
                     WHERE m.season = ? AND m.adp IS NOT NULL AND p.position IN ('QB','RB','WR','TE')
                     ORDER BY m.adp`, season);
  if (!espn.length) return null;
  const byEspnId = new Map();
  espn.forEach((r, i) => byEspnId.set(r.espn_id, { rank: i + 1, team: null, position: r.position }));
  return { source: 'espn_current', size: espn.length, byName: null, byEspnId };
}

const consensusCache = new Map();
const consensus = season => {
  if (!consensusCache.has(season)) consensusCache.set(season, consensusFor(season));
  return consensusCache.get(season);
};
function consensusRank(season, pick) {
  const c = consensus(season);
  if (!c) return null;
  const hit = c.byName ? c.byName.get(normalizePlayerName(pick.name)) : c.byEspnId.get(pick.player_id);
  return hit?.rank ?? null;
}

/**
 * Weekly PPR coefficient of variation in the season BEFORE the draft - the
 * volatility a manager could actually have known about when he picked.
 *
 * Using the drafted season's own CV would measure the outcome, not the
 * preference, and would let the future into a draft-day metric.
 */
const cvCache = new Map();
function priorSeasonFantasyCv(season) {
  if (cvCache.has(season)) return cvCache.get(season);
  const out = new Map();
  const byPlayer = new Map();
  for (const u of rows(`SELECT * FROM player_week_usage WHERE season = ?`, season - 1)) {
    if (!byPlayer.has(u.player_id)) byPlayer.set(u.player_id, []);
    byPlayer.get(u.player_id).push(Number(scoreLine(u)));
  }
  for (const [id, pts] of byPlayer) {
    // Six weeks is the floor: a CV from three games is a number about small
    // samples, not about a player.
    if (pts.length < 6) continue;
    const m = mean(pts), s = sd(pts);
    if (m == null || s == null || m < 3) continue;   // sub-3 ppg means the ratio explodes on noise
    out.set(id, s / m);
  }
  cvCache.set(season, out);
  return out;
}

/**
 * The same question asked of the feature store: how volatile was this player's
 * weekly YARDAGE, frozen at week 1 of the draft season. The store's cutoff
 * filter (`season < S OR (season = S AND week < 1)`) makes this prior-only by
 * construction, and using it here is the point - the volatility transforms
 * already exist and must not be rebuilt.
 */
const storeCvCache = new Map();
function storeYardageCv(season, gsisId) {
  if (!gsisId) return null;
  const key = `${season}|${gsisId}`;
  if (storeCvCache.has(key)) return storeCvCache.get(key);
  // No try/catch. A player the store has nothing on never throws — it answers
  // `{ error: 'no earlier player observations' }`, which the `?.vector ?? {}`
  // below turns into the honest null. So the only thing a catch here could
  // ever have caught was a genuine read fault (a dropped column, a locked
  // database), and flattening that to the same null is what made a store that
  // could not be read indistinguishable from a player with nothing to measure.
  // Table absence is asked about up front instead, by featureStoreState().
  let cv = null;
  const v = buildPlayerFeatureVector(season, 1, gsisId)?.vector ?? {};
  const m = v.base_total_yards__mean_6, s = v.base_total_yards__sd_6;
  if (Number.isFinite(m) && Number.isFinite(s) && m > 10) cv = s / m;
  storeCvCache.set(key, cv);
  return cv;
}

/**
 * WHAT `storeYardageCv()` READS, AND WHY IT CAN BE MISSING.
 *
 * `playerHistory()` (nfl-weekly-feature-store.js:215) reads these three tables
 * raw, so any one of them being absent takes the whole weekly-yardage read down
 * — not one player's worth of it.
 */
export const FEATURE_STORE_TABLES = Object.freeze([
  'nfl_player_week_features', 'nfl_ngs', 'nfl_pfr_adv',
]);

export const FEATURE_STORE_SOURCE =
  'server/services/nfl-weekly-feature-store.js reads them; they are filled by the '
  + 'weekly ingest jobs, so a fresh box or a database restored from before those '
  + 'migrations has them empty or absent';

/**
 * Are the weekly feature store's tables there, right now.
 *
 * Deliberately not cached, for the same reason as leagueHistoryState(): a
 * migration can create these inside the life of a process, and a cached absence
 * would outlive the thing that fixes it.
 */
export function featureStoreState() {
  const missing = FEATURE_STORE_TABLES.filter(t =>
    !rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t).length);
  if (!missing.length) return Object.freeze({ present: true, reason: null, source: FEATURE_STORE_SOURCE });
  return Object.freeze({
    present: false,
    reason: `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not on this database, so `
      + 'weekly yardage volatility cannot be read at all. This is "we cannot look", not '
      + '"this manager drafted nobody measurable".',
    source: FEATURE_STORE_SOURCE,
  });
}

/** roster_id -> espn_member_id for one league-season, used to attribute the
 *  ~20% of picks ESPN returns without a memberId. */
function teamMembers(leagueId, season) {
  return teamMembersState(leagueId, season).byRoster;
}

/**
 * WHAT CREATES `league_season_teams`, AND WHY IT CAN BE MISSING.
 *
 * Two routes, which is the whole problem. `server/migrations/064_league_history_tables.js:29`
 * creates it — its own comment names `managerProfile()` and `archetypesFor()`
 * as the readers it builds the member index for — and
 * `scripts/backfill-league-history.mjs` creates it too, for boxes that
 * backfilled before the migration existed. Migration 064 is not on `main`; it
 * arrives with PR #47, the base this work is stacked on. So on `main` today
 * `runMigrations()` leaves the table absent and every read below throws, and
 * after #47 it does not. A database restored from a backup older than 064 is
 * in the same state.
 *
 * A thrown `no such table` is the worst of the three possible answers. The
 * caller's nearest try/catch turns it into an empty result, and an empty
 * result is indistinguishable from "we looked and there is nothing here" —
 * the silent empty this module's whole as-of family exists to delete.
 */
export const LEAGUE_HISTORY_TABLE = 'league_season_teams';

export const LEAGUE_HISTORY_SOURCE =
  'server/migrations/064_league_history_tables.js (arrives with PR #47; not on main yet) '
  + 'and scripts/backfill-league-history.mjs, which creates the same table for boxes that '
  + 'backfilled before the migration existed';

/**
 * Is the table there, right now.
 *
 * DELIBERATELY NOT CACHED. A migration can create this table inside the life
 * of a process — `runMigrations()` runs at startup, and #47 merging is exactly
 * that event — so a cached absence would outlive the thing that fixes it and
 * the process would go on reporting a table it is sitting on top of.
 */
export function leagueHistoryState() {
  const [hit] = rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    LEAGUE_HISTORY_TABLE);
  if (hit) return Object.freeze({ present: true, reason: null, source: LEAGUE_HISTORY_SOURCE });
  return Object.freeze({
    present: false,
    reason: `${LEAGUE_HISTORY_TABLE} is not on this database, so roster-to-member identity cannot be `
      + 'read at all. This is "we cannot look", not "this manager is unknown".',
    source: LEAGUE_HISTORY_SOURCE,
  });
}

/**
 * roster_id -> team row for one league-season, WITH the reason when there is
 * none. Used to attribute the ~20% of picks ESPN returns without a memberId,
 * so an empty map here quietly unattributes a fifth of the draft.
 */
export function teamMembersState(leagueId, season) {
  const state = leagueHistoryState();
  if (!state.present) return Object.freeze({ ...state, byRoster: new Map() });
  return Object.freeze({
    ...state,
    byRoster: new Map(rows(`SELECT roster_id, espn_member_id, owner_name, team_name,
                                   wins, losses, points_for, final_rank
                            FROM league_season_teams WHERE league_id = ? AND season = ?`,
    leagueId, season).map(t => [String(t.roster_id), t])),
  });
}

/**
 * NFL team for a pick, SEASON-CORRECT ONLY.
 *
 * The FantasyPros feed carries the team a player was on at the time of that
 * season's scrape, which is the answer. `players.team_id` carries the team he is
 * on TODAY, which for a 2023 pick is three years of trades and free agency in
 * the future - a manager who drafted a Bronco in 2023 would read as a Jets homer
 * because that player moved in 2025. That fallback used to fire on 13-14% of
 * 2023-2025 picks; it is now refused, and those picks are simply excluded (the
 * homer metric already carries its own n, which drops accordingly).
 *
 * The current-roster table is used only for the CURRENT season, where "today"
 * and "at the draft" are the same roster.
 */
function nflTeamOf(season, pick, teamAbbr, currentSeason) {
  const c = consensus(season);
  const hit = c?.byName ? c.byName.get(normalizePlayerName(pick.name)) : null;
  if (hit?.team) return hit.team;
  return season === currentSeason ? (teamAbbr.get(pick.player_id) ?? null) : null;
}

/**
 * Every metric that can be computed from a manager's pick list.
 *
 * Split out from the season loop so the same code can be run on a HALF of his
 * picks. That is what makes the reliability check below possible, and a metric
 * that disagrees with itself across two halves of the same draft cannot be
 * expected to agree with itself across two years.
 */
function metricsForPicks(list, rounds) {
  const skill = list.filter(p => SKILL.has(p.position));
  const withDelta = skill.filter(p => p.delta != null);
  const deltas = withDelta.map(p => p.delta);
  const m = {
    picks_n: { v: list.length, n: list.length },
    auto_draft_rate: { v: mean(list.map(p => (p.is_auto ? 1 : 0))), n: list.length },
    consensus_coverage: { v: skill.length ? withDelta.length / skill.length : null, n: skill.length },
  };
  for (const [type, count] of Object.entries(list.filter(p => p.auto_draft_type_id)
    .reduce((a, p) => { a[p.auto_draft_type_id] = (a[p.auto_draft_type_id] ?? 0) + 1; return a; }, {}))) {
    m[`auto_type_${type}_share`] = { v: count / list.length, n: list.length };
  }
  if (deltas.length >= 4) {
    m.pick_minus_consensus_mean = { v: mean(deltas), n: deltas.length };
    // SD is the "does he draft off a list" measure: tight means he takes the
    // board as published, wide means he has opinions - in either direction.
    m.pick_minus_consensus_sd = { v: sd(deltas), n: deltas.length };
    m.reach_rate = { v: mean(deltas.map(d => (d <= -1 ? 1 : 0))), n: deltas.length };
  }
  for (const pos of SKILL) {
    const first = list.find(p => p.position === pos);
    // Censored, not missing: a manager who never took a TE is recorded at one
    // round past the end of the draft, and the n says it came from a draft
    // where he did not take one.
    m[`first_${pos.toLowerCase()}_round`] = { v: first ? first.round : rounds + 1, n: first ? 1 : 0 };
    const posDeltas = withDelta.filter(p => p.position === pos).map(p => p.delta);
    if (posDeltas.length >= 2 && deltas.length >= 4) {
      m[`pos_lean_${pos.toLowerCase()}`] = { v: mean(posDeltas) - mean(deltas), n: posDeltas.length };
    }
    m[`${pos.toLowerCase()}_through_6`] = {
      v: list.filter(p => p.position === pos && (p.round ?? 99) <= 6).length,
      n: list.filter(p => (p.round ?? 99) <= 6).length,
    };
  }
  const capital = list.reduce((a, p) => a + p.capital, 0);
  const shares = [...SKILL].map(pos => list.filter(p => p.position === pos)
    .reduce((a, p) => a + p.capital, 0) / (capital || 1));
  m.capital_hhi = { v: shares.reduce((a, s) => a + s * s, 0), n: list.length };

  // Name brand: how much later this year's market ranks the players he took
  // than last year's market did. Positive = he is buying names the market has
  // already faded, which is the behaviour the phrase describes. Only computed
  // when both years' ranks come from the SAME consensus source; an ESPN rank
  // minus a FantasyPros rank is a difference of two universes, not of two years.
  const brand = withDelta.filter(p => p.brand_gap != null).map(p => p.brand_gap);
  if (brand.length >= 4) m.name_brand_premium = { v: mean(brand), n: brand.length };

  const byNfl = list.filter(p => p.nfl_team)
    .reduce((a, p) => { a[p.nfl_team] = (a[p.nfl_team] ?? 0) + 1; return a; }, {});
  const top = Object.entries(byNfl).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const withTeam = list.filter(p => p.nfl_team).length;
    m.homer_top_team_share = { v: top[1] / withTeam, n: withTeam, label: top[0] };
  }

  const cvs = list.map(p => p.prior_cv).filter(Number.isFinite);
  if (cvs.length >= 4) m.risk_prior_fp_cv = { v: mean(cvs), n: cvs.length };
  const storeCvs = list.map(p => p.store_cv).filter(Number.isFinite);
  if (storeCvs.length >= 4) m.risk_store_yard_cv = { v: mean(storeCvs), n: storeCvs.length };
  return m;
}

/**
 * One league-season of draft behaviour, per manager.
 *
 * Board slot, not overall pick number. A pick's position is its index among the
 * SKILL picks of that draft, so that a league where four managers burn picks on
 * kickers does not read as a league of reachers.
 *
 * The delta is then divided by the draft's own skill-picks-per-round, so it is
 * measured in ROUNDS: positive means the market ranked him higher than where he
 * actually went (the manager waited and got value), negative is a reach, and a
 * 6-team league is comparable with a 10-team one. It is clipped at +/- 3 rounds
 * because the tail is a measurement artefact rather than behaviour - ESPN's 2026
 * ADP list ranks several hundred players nobody in an 8-team league will ever
 * draft, so a last-round flyer can otherwise score as a 20-round "reach" and
 * swamp a manager's mean. Clipping was added after exactly that happened.
 */
function draftSeason(leagueId, season, allPicks, teamAbbr, currentSeason, storePresent = true) {
  const picks = allPicks.filter(p => p.league_id === leagueId && p.season === season);
  if (!picks.length) return null;
  const members = teamMembers(leagueId, season);
  const cons = consensus(season);
  const priorCv = priorSeasonFantasyCv(season);
  const priorCons = consensus(season - 1);

  const ordered = [...picks].sort((a, b) => (a.overall_pick ?? 0) - (b.overall_pick ?? 0));
  const slotOf = new Map();
  let slot = 0;
  for (const p of ordered) if (SKILL.has(p.position)) slotOf.set(p.pick_id, ++slot);

  const rounds = Math.max(...picks.map(p => p.round ?? 0));
  const totalPicks = picks.length;
  const skillPerRound = Math.max(1, slot / Math.max(1, rounds));
  const sameSource = cons && priorCons && cons.source === priorCons.source;
  const byManager = new Map();
  for (const p of ordered) {
    const memberId = p.member_id || members.get(String(p.team_id))?.espn_member_id || null;
    if (!memberId) continue;
    if (!byManager.has(memberId)) byManager.set(memberId, []);
    const rank = SKILL.has(p.position) ? consensusRank(season, p) : null;
    const boardSlot = slotOf.get(p.pick_id) ?? null;
    const priorRank = sameSource && priorCons.byName
      ? priorCons.byName.get(normalizePlayerName(p.name))?.rank ?? null : null;
    const rawDelta = rank != null && boardSlot != null ? (boardSlot - rank) / skillPerRound : null;
    byManager.get(memberId).push({
      ...p,
      board_slot: boardSlot,
      consensus_rank: rank,
      delta: rawDelta == null ? null : Math.max(-3, Math.min(3, rawDelta)),
      brand_gap: rank != null && priorRank != null ? (rank - priorRank) / skillPerRound : null,
      nfl_team: nflTeamOf(season, p, teamAbbr, currentSeason),
      prior_cv: priorCv.get(p.app_player_id) ?? null,
      // Asked once per build rather than per player: with the store's tables
      // absent this would throw on every skill pick, and the answer is the same
      // for all of them. The absence is named on the build's own result.
      store_cv: storePresent && SKILL.has(p.position) ? storeYardageCv(season, p.gsis_id) : null,
      // Linear pick-value weight. Any decay curve here is a choice; a linear one
      // at least cannot be tuned after the fact to flatter a conclusion.
      capital: (totalPicks + 1 - (p.overall_pick ?? totalPicks)) / totalPicks,
    });
  }

  const out = [];
  for (const [memberId, list] of byManager) {
    out.push({
      member_id: memberId, league_id: leagueId, season,
      metrics: metricsForPicks(list, rounds),
      // Two halves of the same draft, for the reliability check.
      //
      // Split on ROUND PAIRS (1,4,5,8... against 2,3,6,7...), not odd-vs-even
      // picks. This draft snakes: in odd rounds a manager picks from his slot,
      // in even rounds from the mirror of it, so an odd/even split separates
      // early-turn picks from late-turn picks and any slot-driven quantity is
      // anti-correlated between the halves by construction. That is what the
      // first version of this check did, and it read every positional lean as
      // pure noise. This split puts equal numbers of odd and even rounds in each
      // half, so the halves differ only by which picks landed in them.
      halves: {
        odd: metricsForPicks(list.filter(p => [0, 3].includes(((p.round ?? 1) - 1) % 4)), rounds),
        even: metricsForPicks(list.filter(p => [1, 2].includes(((p.round ?? 1) - 1) % 4)), rounds),
      },
      owner: members.get(String(list[0].team_id))?.owner_name ?? null,
      picks: list, consensus_source: cons?.source ?? null,
    });
  }

  // League-season centring. A manager's top-team share, his average delta and
  // his players' volatility all sit on a baseline set by the league's size, its
  // scoring and the year's player pool. The excess against his own league-season
  // is the part that is about HIM. Top-team share especially: the maximum of a
  // multinomial is biased upward, so only the excess over the league's own mean
  // maximum is evidence of a homer.
  for (const metric of ['pick_minus_consensus_mean', 'homer_top_team_share', 'risk_prior_fp_cv',
    'risk_store_yard_cv', 'name_brand_premium', 'pick_minus_consensus_sd']) {
    const vals = out.map(o => o.metrics[metric]?.v).filter(Number.isFinite);
    if (vals.length < 3) continue;
    const base = mean(vals);
    for (const o of out) {
      const hit = o.metrics[metric];
      if (hit?.v != null) o.metrics[`${metric}_excess`] = { v: hit.v - base, n: hit.n };
    }
  }
  return out;
}

/**
 * Outcome metrics per manager-season, from the all-play panel.
 *
 * All-play is not recomputed here. scripts/luck-panel.mjs owns that measurement
 * and its benchmarks; the build script runs it and passes its --json output in.
 * luck_wins > 0 means the record flatters the scoring, which is the single most
 * actionable number in this file: that manager prices his roster off a record
 * the scoring does not support.
 */
function outcomeRows(luckPanel, membersByTeam) {
  const out = [];
  out.unownedSlots = 0;
  for (const season of luckPanel ?? []) {
    const members = membersByTeam(season.league_id, season.season);
    for (const t of season.teams_detail ?? []) {
      const team = members.get(String(t.roster_id));
      // A real ESPN state, not a fault -- saveTeams() (league-history.js)
      // writes espn_member_id null whenever ESPN's own `owners` array is
      // empty for that team. There is nobody to attribute an outcome metric
      // to, so the row is correctly excluded; the count is what keeps that
      // exclusion from being indistinguishable from a row that went missing.
      if (!team?.espn_member_id) { out.unownedSlots++; continue; }
      const games = (t.h2h_w ?? 0) + (t.h2h_l ?? 0);
      const m = {
        weeks_scored: { v: t.weeks, n: t.weeks },
        ppg: { v: t.ppg, n: t.weeks },
        score_cv: { v: t.cv, n: t.weeks },
        all_play: { v: t.all_play, n: (t.ap_w ?? 0) + (t.ap_l ?? 0) },
        h2h_pct: { v: t.h2h_pct, n: games },
        luck_wins: { v: t.luck_wins, n: games },
        beat_median_rate: { v: t.median_rate, n: t.weeks },
        wins: { v: team.wins, n: games },
        final_rank: { v: team.final_rank, n: 1 },
      };
      out.push({ member_id: team.espn_member_id, league_id: season.league_id, season: season.season,
        metrics: Object.fromEntries(Object.entries(m).filter(([, x]) => x.v != null)) });
    }
  }
  return out;
}

/**
 * Career roll-up. n-weighted, so a 16-pick season does not outvote a 17-pick
 * one by accident and a one-week 2026 outcome does not outvote a full 2023.
 */
function careerRows(seasonRows) {
  const byMember = new Map();
  for (const r of seasonRows) {
    if (!byMember.has(r.member_id)) byMember.set(r.member_id, []);
    byMember.get(r.member_id).push(r);
  }
  const out = [];
  for (const [memberId, list] of byMember) {
    const metrics = {};
    const names = new Set(list.flatMap(r => Object.keys(r.metrics)));
    for (const name of names) {
      const hits = list.map(r => r.metrics[name]).filter(x => x && Number.isFinite(x.v));
      if (!hits.length) continue;
      const weight = hits.reduce((a, x) => a + Math.max(1, x.n ?? 1), 0);
      metrics[name] = {
        v: hits.reduce((a, x) => a + x.v * Math.max(1, x.n ?? 1), 0) / weight,
        n: hits.reduce((a, x) => a + (x.n ?? 0), 0),
      };
      // Between-season spread of the manager's own value: the honest companion
      // to every career mean, and the thing a consumer needs before treating one
      // as a trait.
      const vals = hits.map(x => x.v);
      if (vals.length >= 2) metrics[`${name}_season_sd`] = { v: sd(vals), n: vals.length };
    }
    metrics.seasons_observed = { v: new Set(list.map(r => `${r.league_id}|${r.season}`)).size,
      n: list.length };
    out.push({ member_id: memberId, league_id: CAREER_LEAGUE, season: CAREER_SEASON, metrics });
  }
  return out;
}

/**
 * WHO CREATES `league_draft_picks`, AND WHY IT CAN BE MISSING.
 *
 * Nobody, in this repository — checked, not assumed. Both
 * `server/migrations/064_league_history_tables.js` and
 * `scripts/backfill-league-history.mjs` carry a comment claiming it "is owned
 * by scripts/collect-league-transactions.mjs's sibling collector". That file
 * exists and runs, but it creates `league_transactions_raw` — a different
 * table — and grepping every migration and every script here for
 * `CREATE TABLE ... league_draft_picks` finds nothing. Whatever wrote the
 * 1,738 live rows those comments cite is not part of this codebase, so a
 * guard here cannot lean on "the sibling will create it" being true.
 *
 * Same failure shape as `league_season_teams` (see `leagueHistoryState()`
 * above): a raw `no such table` thrown out of `buildManagerArchetypes()` is
 * worse than an empty result, because the nearest try/catch — scheduler.js's
 * job runner, or a shell around the CLI script — turns it into an opaque
 * failure that says nothing about which table or that the failure is
 * routine on a fresh box.
 */
export const LEAGUE_DRAFT_PICKS_TABLE = 'league_draft_picks';

export const LEAGUE_DRAFT_PICKS_SOURCE =
  'no migration or script in this repo creates it; the comments in '
  + '064_league_history_tables.js and backfill-league-history.mjs naming '
  + 'scripts/collect-league-transactions.mjs\'s sibling collector as the owner are wrong — '
  + 'that file creates only league_transactions_raw';

/** Is the table there, right now. Deliberately not cached — see leagueHistoryState(). */
export function leagueDraftPicksState() {
  const [hit] = rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    LEAGUE_DRAFT_PICKS_TABLE);
  if (hit) return Object.freeze({ present: true, reason: null, source: LEAGUE_DRAFT_PICKS_SOURCE });
  return Object.freeze({
    present: false,
    reason: `${LEAGUE_DRAFT_PICKS_TABLE} is not on this database, so draft-revealed preference `
      + 'cannot be measured at all. This is "we cannot look", not a claim that nobody drafted.',
    source: LEAGUE_DRAFT_PICKS_SOURCE,
  });
}

/**
 * Build every archetype metric and persist it.
 *
 * @param luckPanel parsed output of `node scripts/luck-panel.mjs --json`. The
 *   outcome half is simply omitted when it is absent, and its absence is
 *   reported rather than filled in.
 */
export function buildManagerArchetypes({ luckPanel = null } = {}) {
  const draftState = leagueDraftPicksState();
  const storeState = featureStoreState();
  let allPicks = [];
  let leagueSeasons = [];
  let currentSeason = null;
  const draftRows = [];
  if (draftState.present) {
    allPicks = rows(`SELECT d.league_id, d.season, d.pick_id, d.overall_pick, d.round, d.team_id,
                                d.member_id, d.player_id, d.auto_draft_type_id, d.is_auto,
                                p.id AS app_player_id, p.name, p.position, p.gsis_id, p.team_id AS nfl_team_id
                         FROM league_draft_picks d JOIN players p ON p.espn_id = d.player_id`);
    const teamAbbr = new Map();
    const abbrById = new Map(rows(`SELECT id, abbr FROM nfl_teams`).map(t => [t.id, t.abbr]));
    for (const p of allPicks) teamAbbr.set(p.player_id, abbrById.get(p.nfl_team_id) ?? null);

    leagueSeasons = rows(`SELECT DISTINCT league_id, season FROM league_draft_picks ORDER BY league_id, season`);
    // The newest season on file. players.team_id is a CURRENT roster, so it is
    // only an honest answer for this season; nflTeamOf refuses it for older ones.
    currentSeason = Math.max(...leagueSeasons.map(l => l.season));
    for (const { league_id, season } of leagueSeasons) {
      const got = draftSeason(league_id, season, allPicks, teamAbbr, currentSeason, storeState.present);
      if (got) draftRows.push(...got);
    }
  }
  const membersCache = new Map();
  const membersByTeam = (leagueId, season) => {
    const key = `${leagueId}|${season}`;
    if (!membersCache.has(key)) membersCache.set(key, teamMembers(leagueId, season));
    return membersCache.get(key);
  };
  const outRows = outcomeRows(luckPanel, membersByTeam);

  const tagged = [
    ...draftRows.map(r => ({ ...r, source: 'draft' })),
    ...outRows.map(r => ({ ...r, source: 'outcome' })),
  ];
  const career = careerRows(tagged).map(r => ({ ...r, source: 'career' }));

  const now = new Date().toISOString();
  const written = [];
  for (const r of [...tagged, ...career]) {
    for (const [metric, x] of Object.entries(r.metrics)) {
      if (x?.v == null || !Number.isFinite(x.v)) continue;
      written.push({ member_id: r.member_id, league_id: r.league_id, season: r.season,
        metric, value: x.v, label: x.label ?? null, n: x.n ?? 0, source: r.source });
    }
  }

  db.exec('BEGIN');
  try {
    run(`DELETE FROM manager_archetypes WHERE version = ?`, MANAGER_ARCHETYPE_VERSION);
    for (const w of written) {
      run(`INSERT OR REPLACE INTO manager_archetypes
             (member_id,league_id,season,metric,value,label,n,source,version,computed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
      w.member_id, w.league_id, w.season, w.metric, w.value, w.label, w.n, w.source,
      MANAGER_ARCHETYPE_VERSION, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return {
    version: MANAGER_ARCHETYPE_VERSION,
    // Two nulls kept apart, same as managerProfile()'s identity_state: absent
    // means the draft side of this build could not run at all, not that no
    // league-season had picks. Outcome metrics (all-play, luck, from luckPanel)
    // are unaffected — they never read league_draft_picks.
    draft_data_state: draftState.present ? 'present' : 'table_absent',
    draft_data_reason: draftState.reason,
    // Same two-nulls-apart rule for the weekly feature store: risk_store_yard_cv
    // is absent both when fewer than four skill picks had a computable CV and
    // when the store could not be read at all, and only this says which.
    feature_store_state: storeState.present ? 'present' : 'table_absent',
    feature_store_reason: storeState.reason,
    league_seasons: leagueSeasons.length,
    managers: new Set(tagged.map(r => r.member_id)).size,
    draft_manager_seasons: draftRows.length,
    outcome_manager_seasons: outRows.length,
    // Rosters with a real league_season_teams row but no ESPN member
    // attributed to them (an empty `owners` array on ESPN's side) -- not a
    // fault, so not in outcome_manager_seasons, but counted rather than left
    // to look like the same thing as "nothing to report".
    outcome_unowned_slots: outRows.unownedSlots,
    rows_written: written.length,
    consensus_sources: Object.fromEntries([...new Set(leagueSeasons.map(l => l.season))]
      .map(s => [s, consensus(s)?.source ?? 'none'])),
    picks_without_manager: allPicks.length - draftRows.reduce((a, r) => a + r.picks.length, 0),
    detail: draftRows,
  };
}

/**
 * 90% interval for a correlation, resampling league-season CLUSTERS rather than
 * pairs, per docs/TARGET-SPEC.md. Deterministic seed so a rerun that changes
 * nothing prints the same interval and a moved bound means moved data.
 */
function clusteredBootstrapR(xs, ys, clusters, draws = 2000) {
  const groups = new Map();
  for (let i = 0; i < xs.length; i++) {
    if (!groups.has(clusters[i])) groups.set(clusters[i], []);
    groups.get(clusters[i]).push(i);
  }
  const keys = [...groups.keys()];
  if (keys.length < 3) return null;
  let seed = 20260917;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const rs = [];
  for (let d = 0; d < draws; d++) {
    const bx = [], by = [];
    for (let k = 0; k < keys.length; k++) {
      for (const i of groups.get(keys[Math.floor(rand() * keys.length)])) { bx.push(xs[i]); by.push(ys[i]); }
    }
    const r = pearson(bx, by);
    if (r != null) rs.push(r);
  }
  if (rs.length < draws / 2) return null;
  rs.sort((a, b) => a - b);
  return { lo: r3(rs[Math.floor(rs.length * 0.05)]), hi: r3(rs[Math.floor(rs.length * 0.95)]) };
}

/**
 * Does a metric agree with ITSELF inside one draft?
 *
 * Two balanced halves of the same draft - rounds 1,4,5,8... against 2,3,6,7...
 * across every manager-season, Spearman-Brown corrected back up to full length.
 * The split is on round PAIRS rather than odd/even picks because this draft
 * snakes: odd rounds pick from the manager's slot and even rounds from its
 * mirror, so an odd/even split anti-correlates any slot-driven quantity by
 * construction. This is the check that makes a null
 * interpretable: a metric that cannot reproduce itself across two halves of the
 * same afternoon has no business being asked to reproduce itself across two
 * years, and its year-over-year zero says nothing about whether the trait
 * exists. Run over `summary.detail`, which carries the halves in memory - they
 * are diagnostics about the metric, not facts about a manager, so they are not
 * stored.
 */
export function splitHalfReliability(draftRows) {
  const names = new Set(draftRows.flatMap(r => Object.keys(r.metrics)));
  const out = [];
  for (const metric of names) {
    // Only statistics that are AVERAGES over picks survive halving. "Round of
    // his first TE" and "RBs through round 6" do not: drop half the picks and
    // the first TE moves later by construction, so odd-vs-even correlates
    // negatively for a reason that has nothing to do with measurement error.
    // Reporting a reliability for those would be a number about the split, not
    // about the metric.
    const applicable = !/^first_|_through_6$|^picks_n$|^seasons_observed$/.test(metric);
    // Centred on the league-season, for the same reason the year-over-year
    // correlation is: otherwise a difference between drafts reads as agreement
    // between halves.
    const groups = new Map();
    if (applicable) {
      for (const r of draftRows) {
        const a = r.halves?.odd?.[metric]?.v, b = r.halves?.even?.[metric]?.v;
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const k = `${r.league_id}|${r.season}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push([a, b]);
      }
    }
    const xs = [], ys = [];
    for (const [, pairs] of groups) {
      if (pairs.length < 3) continue;
      const ma = mean(pairs.map(p => p[0])), mb = mean(pairs.map(p => p[1]));
      for (const [a, b] of pairs) { xs.push(a - ma); ys.push(b - mb); }
    }
    const half = xs.length >= 10 ? pearson(xs, ys) : null;
    // A league-season-centred metric is its base metric minus a constant per
    // league-season, so it inherits the base metric's reliability rather than
    // having none; the halves are only computed for the uncentred form.
    if (metric.endsWith('_excess')) {
      const base = out.find(o => o.metric === metric.replace(/_excess$/, ''));
      if (base) { out.push({ ...base, metric, inherited_from: base.metric }); continue; }
    }
    out.push({
      metric, applicable, n: xs.length, half_r: r3(half),
      // Spearman-Brown, which lifts a half-length instrument's correlation to
      // full length. It is only defined for a positive half correlation; a
      // non-positive one means the metric carries no repeatable signal at all,
      // and is reported as zero rather than run through a formula that sends it
      // to -6.
      full_r: half == null ? null : (half <= 0 ? 0 : r3((2 * half) / (1 + half))),
    });
  }
  return out;
}

/**
 * Is a metric a TRAIT? A revealed preference is only worth the name if the same
 * person reproduces it next year.
 *
 * Pairs are within one league: the same manager, the same league, consecutive
 * seasons. Pairing across leagues would mix a change in the person with a change
 * in the room he is drafting in.
 *
 * `reliability` (from splitHalfReliability) disattenuates: an observed r is
 * bounded above by the metric's own reliability, so r_observed / r_reliable is
 * an estimate of the trait correlation free of measurement noise. It is an
 * estimate with a small denominator and is printed as such, never as the
 * headline.
 */
export function metricRepeatability({ minPairs = 6, reliability = [] } = {}) {
  const rel = new Map(reliability.map(r => [r.metric, r.full_r]));
  const all = rows(`SELECT member_id, league_id, season, metric, value FROM manager_archetypes
                    WHERE source = 'draft' AND version = ? ORDER BY member_id, league_id, season`,
  MANAGER_ARCHETYPE_VERSION);
  const byMetric = new Map();
  for (const r of all) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, []);
    byMetric.get(r.metric).push(r);
  }
  const out = [];
  for (const [metric, raw] of byMetric) {
    // Every value is centred on its own league-season before anything is
    // correlated. Without this, a metric that merely differs BETWEEN leagues -
    // an 8-team draft reaches more than a 10-team one, a 2026 board is shaped
    // differently from a 2023 one - correlates with itself year over year while
    // saying nothing about any manager. The question is whether he holds his
    // PLACE AMONG HIS PEERS, so his peers are the baseline.
    const base = new Map();
    for (const r of raw) {
      const k = `${r.league_id}|${r.season}`;
      if (!base.has(k)) base.set(k, []);
      base.get(k).push(r.value);
    }
    const centre = new Map([...base].map(([k, v]) => [k, mean(v)]));
    const list = raw.map(r => ({ ...r, value: r.value - centre.get(`${r.league_id}|${r.season}`) }));
    const byLeagueMember = new Map();
    const byMember = new Map();
    for (const r of list) {
      const k = `${r.member_id}|${r.league_id}`;
      if (!byLeagueMember.has(k)) byLeagueMember.set(k, []);
      byLeagueMember.get(k).push(r);
      if (!byMember.has(r.member_id)) byMember.set(r.member_id, []);
      byMember.get(r.member_id).push(r);
    }
    const xs = [], ys = [], clusters = [], pairMembers = [];
    for (const [, seasons] of byLeagueMember) {
      const sorted = [...seasons].sort((a, b) => a.season - b.season);
      for (let i = 1; i < sorted.length; i++) {
        // Adjacent in the sorted list is not the same as consecutive. A manager
        // who sat out a year would otherwise have his 2023 paired with his 2025
        // as if nothing had happened in between.
        if (sorted[i].season - sorted[i - 1].season !== 1) continue;
        xs.push(sorted[i - 1].value); ys.push(sorted[i].value);
        pairMembers.push(sorted[i].member_id);
        // The unit of inference is the league-season transition, not the pair.
        // Ten managers moving from 2024 to 2025 in one league share a player
        // pool and a draft; treating them as ten independent observations is
        // the standard way to manufacture significance here.
        clusters.push(`${sorted[i].league_id}|${sorted[i].season}`);
      }
    }
    const grand = mean(list.map(r => r.value));
    let within = 0, total = 0;
    for (const [, seasons] of byMember) {
      const m = mean(seasons.map(r => r.value));
      for (const r of seasons) { within += (r.value - m) ** 2; total += (r.value - grand) ** 2; }
    }
    const yoy = xs.length >= minPairs ? pearson(xs, ys) : null;
    const ci = yoy == null ? null : clusteredBootstrapR(xs, ys, clusters);
    const reliable = rel.get(metric);

    // LEVERAGE. The cluster bootstrap above protects against one DRAFT carrying
    // a correlation. It cannot protect against one PERSON carrying it, because a
    // manager who has played four seasons in the same league appears in three of
    // the seven clusters and is therefore resampled into nearly every draw.
    // With 45 managers and 58 pairs, one constant extremist is enough to
    // manufacture an r of 0.70 out of a cloud that is otherwise flat - and in
    // this dataset exactly that happens (see study/features/archetypes.md).
    // So: drop each manager's pairs in turn and keep the worst r, and report
    // Spearman beside Pearson, since a rank correlation cannot be levered by a
    // single far-out point the way a moment correlation can. A metric whose
    // yoy_r_min_loo or yoy_spearman is near zero has not shown a trait; it has
    // shown one person.
    const memberSet = [...new Set(pairMembers)];
    let looMin = null, looDropped = null;
    if (yoy != null && memberSet.length >= 3) {
      for (const m of memberSet) {
        const keep = pairMembers.map((p, i) => (p === m ? -1 : i)).filter(i => i >= 0);
        if (keep.length < minPairs) continue;
        const r = pearson(keep.map(i => xs[i]), keep.map(i => ys[i]));
        if (r != null && (looMin == null || r < looMin)) { looMin = r; looDropped = m; }
      }
    }
    const spearman = yoy == null ? null : pearson(ranks(xs), ranks(ys));
    out.push({
      metric, n_pairs: xs.length, n_rows: list.length, managers: byMember.size,
      clusters: new Set(clusters).size,
      year_over_year_r: r3(yoy),
      yoy_r_lo: ci?.lo ?? null, yoy_r_hi: ci?.hi ?? null,
      yoy_spearman: r3(spearman),
      yoy_r_min_loo: r3(looMin), yoy_loo_dropped: looDropped,
      reliability: reliable ?? null,
      // Only meaningful when the metric measures something to begin with.
      disattenuated_r: yoy != null && reliable != null && reliable > 0.3
        ? r3(Math.max(-1, Math.min(1, yoy / reliable))) : null,
      between_manager_share: total > 0 ? r3(1 - within / total) : null,
      sd_across_all: r3(sd(list.map(r => r.value))),
    });
  }
  return out.sort((a, b) => (b.year_over_year_r ?? -2) - (a.year_over_year_r ?? -2));
}

/** Everything stored about one manager, season detail plus career roll-up. */
export function managerProfile(memberId) {
  const seasons = new Map();
  for (const r of rows(`SELECT league_id, season, metric, value, label, n, source
                        FROM manager_archetypes WHERE member_id = ? AND version = ?
                        ORDER BY season, league_id`, memberId, MANAGER_ARCHETYPE_VERSION)) {
    const key = r.league_id === CAREER_LEAGUE && r.season === CAREER_SEASON
      ? 'career' : `${r.league_id}|${r.season}`;
    if (!seasons.has(key)) seasons.set(key, { metrics: {}, samples: {}, labels: {}, sources: {} });
    const s = seasons.get(key);
    s.metrics[r.metric] = r.value; s.samples[r.metric] = r.n;
    s.sources[r.metric] = r.source;
    if (r.label) s.labels[r.metric] = r.label;
  }
  const jev = {};
  for (const r of rows(`SELECT question, outcome, probability, basis, n_seasons, n_picks
                        FROM manager_archetype_jev WHERE member_id = ?`, memberId)) {
    jev[r.question] ??= { basis: r.basis, n_seasons: r.n_seasons, n_picks: r.n_picks, p: {} };
    jev[r.question].p[r.outcome] = r.probability;
  }
  // TWO NULLS THAT MEAN OPPOSITE THINGS, kept apart. `identity: null` with
  // the table present says this member is not in it — an ordinary answer. With
  // the table absent it says nothing could be looked up at all. Collapsed into
  // one null, "who is this?" silently becomes "nobody".
  const history = leagueHistoryState();
  const identity = history.present
    ? rows(`SELECT owner_name, team_name, league_id, season FROM league_season_teams
            WHERE espn_member_id = ? ORDER BY season DESC LIMIT 1`, memberId)[0] ?? null
    : null;
  const identity_state = !history.present ? 'table_absent' : (identity ? 'present' : 'no_row');
  return {
    member_id: memberId,
    identity,
    identity_state,
    identity_reason: history.present ? null : history.reason,
    seasons: Object.fromEntries(seasons),
    jev,
  };
}

/**
 * WHO WRITES THE TWO TABLES UNDER A MANAGER CARD, AND HOW OFTEN.
 *
 * Both are written by `buildManagerArchetypes()` and `storeJevAnswers()`, and
 * both are reached from exactly one place: `scripts/build-manager-archetypes.mjs`,
 * which a person runs. No route, no scheduler job and no refresh tick calls
 * either. So a card is always built from whatever was last produced by hand.
 */
export const ARCHETYPE_BUILDER =
  'scripts/build-manager-archetypes.mjs (run by hand; nothing on the deployed app writes these tables)';

/**
 * The sources the trade path prices off: this league-season's own draft
 * behaviour and its outcomes. `career` is excluded deliberately — it is keyed
 * (member, 0, 0) and travels across leagues, so a career row landing on the
 * same query would date a league-season by evidence from another one.
 *
 * NO METRIC ALLOWLIST, and that is the point of this constant existing here.
 * `manager-signals.js:271` (`archetypeIndex`) derives its own `asOf` from the
 * same rows, but updates it INSIDE the row loop, after a `continue` that drops
 * any metric missing from that module's `ARCHETYPE_METRICS` map. So the date it
 * serves at `:425` is "the newest stamp among the metrics this consumer maps",
 * and editing that map silently moves it. `priced_as_of` answers the question
 * actually being asked — when the build last wrote a priceable row for this
 * league-season — which is why a consumer switching to it will see a different
 * value in exactly the case where the old one was wrong.
 */
export const PRICED_SOURCES = Object.freeze(['draft', 'outcome']);

/**
 * WHY NOTHING SCHEDULES THESE TWO TABLES, written down so it stops being a
 * finding and starts being a decision.
 *
 * `buildManagerArchetypes()` replays every league-season in
 * `league_draft_picks` — 1,738 picks over 12 league-seasons today — and the
 * pass beside it, `storeJevAnswers()`, sends each manager's draft state to a
 * paid gateway and stores the answers. The first is expensive and idempotent;
 * the second costs money per run and produces a number that does not change
 * between drafts. A timer on either would spend on both every tick to refresh
 * a table whose inputs move once a year, on draft day.
 *
 * So the build stays on the run sheet. What was wrong was not the absence of a
 * scheduler, it was that no served surface said how old the result was — fixed
 * by `archetypeEvidenceBuilt` above, which is the honest version of a timer: the card
 * tells you when to run it.
 */
export const WHY_UNSCHEDULED =
  'The archetype build replays every league-season and the Jev pass calls a paid gateway per manager, '
  + 'for inputs that change once a year on draft day. A timer would spend on every tick for nothing; '
  + 'the as-of block says when it was last run instead.';

/**
 * Draft metrics this file computes that NO NAMED CONSUMER reads.
 *
 * They are not dead: `metricRepeatability()` and `splitHalfReliability()` read
 * every `source='draft'` metric generically, and both are called only from
 * `scripts/build-manager-archetypes.mjs`. So these appear in the run sheet's
 * repeatability table and nowhere a person makes a decision — not in
 * `manager-signals.js`'s `ARCHETYPE_METRICS`, not in `jevStateFor`'s summary,
 * not in the client.
 *
 * The list exists so that stays a statement rather than something the next
 * reader has to re-derive by grep, and so a metric added later cannot quietly
 * join them: the test on this list fails if an entry has no reason.
 */
export const RUN_SHEET_ONLY_METRICS = Object.freeze(['capital_hhi']);

export const RUN_SHEET_ONLY_REASON = Object.freeze({
  capital_hhi:
    'Herfindahl concentration of draft capital across skill positions. Kept because the repeatability '
    + 'report needs candidate metrics to test, and a metric is dropped on evidence rather than on '
    + 'nobody having wired it yet. It is not centred on its league-season, so it is not comparable '
    + 'across leagues and must not be served until it is.',
});

/**
 * WHEN THE EVIDENCE UNDER ONE MANAGER CARD WAS BUILT.
 *
 * The card served at `routes/trades.js:501` carries three things with three
 * different provenances, and one date for all of them would be wrong for at
 * least two:
 *
 *   - `this_season` — `manager_archetypes` rows keyed (member, league, season).
 *   - `career` — the same table, but keyed (member, 0, 0). A build only writes
 *     career rows for members it found draft picks for, so a league-season can
 *     be freshly built while the career roll-up beside it on the same card is
 *     older, and the reverse.
 *   - `jev` — `manager_archetype_jev`, written by a SEPARATE pass after a
 *     gateway call, with its own `evaluated_at`. Dating those answers by the
 *     archetype build would report a stamp that pass never wrote.
 *
 * THE TABLE'S OWN STAMPS, NEVER `sync_log`. There is no job row to borrow here
 * anyway, but the rule is the same one the signals payload follows: a job-level
 * stamp says when a build RAN, not which league-seasons it produced rows for.
 * A league missing its draft picks is skipped silently by
 * `buildManagerArchetypes` (`leagueSeasons` comes from `league_draft_picks`),
 * so the job can succeed while this league-season stays exactly as old as it
 * was. `MAX(computed_at)` for this league-season is the only value that means
 * "the build reached this league-season".
 *
 * MAX and not MIN: every row of one build shares a single `now`, so on a clean
 * database the two are equal — but the build `DELETE`s only its own version, so
 * rows can survive from an earlier run. The question the card is answering is
 * when this evidence was last refreshed.
 *
 * `null` with a reason, never a borrowed stamp: "built this morning" and "never
 * built" must not look alike. There is no `table_missing` reason because this
 * module `CREATE TABLE IF NOT EXISTS`es both at import, so the table cannot be
 * absent wherever this function can be called.
 *
 * `priced_as_of` / `priced_rows` are the same league-season restricted to
 * `PRICED_SOURCES`, which is what the trade path reads. They are here rather
 * than in a second accessor so `manager-signals.js` can switch to this one
 * without a second query over the same table. See `PRICED_SOURCES` for why the
 * two values differ and when.
 *
 * @param {number} leagueId
 * @param {number} season
 * @param {string|null} memberId when given, the block also dates that member's
 *   stored Jev answers; omitted, the Jev fields are left off rather than
 *   answered league-wide, which would hand a manager a date for answers that
 *   are not his.
 */
export function archetypeEvidenceBuilt(leagueId, season, memberId = null) {
  const { ls, career, priced, stale } = builtStamps(leagueId, season);
  const jev = memberId == null ? null
    : rows(`SELECT COUNT(*) AS n, MAX(evaluated_at) AS as_of FROM manager_archetype_jev
            WHERE member_id = ?`, memberId)[0];
  return builtBlock(leagueId, season, ls, career, priced, stale, jev);
}

/** The two stamp reads, written once. The first mutation run caught this file
 * with the pair copied into both callers: an injection into one left the other
 * answering correctly, which is the same drift `builtBlock` exists to prevent,
 * one level up. */
function builtStamps(leagueId, season) {
  const [ls] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of FROM manager_archetypes
                     WHERE league_id = ? AND season = ? AND version = ?`,
  leagueId, season, MANAGER_ARCHETYPE_VERSION);
  const [career] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of FROM manager_archetypes
                         WHERE league_id = ? AND season = ? AND version = ?`,
  CAREER_LEAGUE, CAREER_SEASON, MANAGER_ARCHETYPE_VERSION);
  const [priced] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of FROM manager_archetypes
                         WHERE league_id = ? AND season = ? AND version = ? AND source IN (${PRICED_SOURCES.map(() => '?').join(', ')})`,
  leagueId, season, MANAGER_ARCHETYPE_VERSION, ...PRICED_SOURCES);
  // Rows on this key from a PREVIOUS build version. The version filter above is
  // right — a price should stand on the current build, not on whatever a
  // superseded one left behind — but without this count the filter turns stale
  // data into `rows: 0`, indistinguishable from a league-season nothing has
  // ever written. Those two states lead to opposite actions: re-run the build,
  // or find out why this league has no draft picks on file.
  const [stale] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of,
                               GROUP_CONCAT(DISTINCT version) AS versions FROM manager_archetypes
                        WHERE league_id = ? AND season = ? AND version <> ?`,
  leagueId, season, MANAGER_ARCHETYPE_VERSION);
  return { ls, career, priced, stale };
}

/** The one place the block's shape is written, so a per-card build and a direct
 * call cannot drift apart. `ls`, `career` and `jev` are {n, as_of} rows. */
function builtBlock(leagueId, season, ls, career, priced, stale, jev) {
  const gaps = [];
  // NEVER COLLECTED IS NOT ZERO. Without this clause a league-season whose
  // `league_season_teams` is absent reports `rows: 0` in exactly the words a
  // league-season the build simply never covered does, and an archetype over
  // no rows is a real-looking answer about a real person. It is the same
  // distinction as the confident-zero bucket still open on the run sheet; until
  // that contract is settled the state is served through `reason`, the field
  // this block already uses for not-built data, rather than through a new one.
  const history = leagueHistoryState();
  if (!history.present) {
    gaps.push(`${LEAGUE_HISTORY_TABLE} is not on this database, so this league-season was never `
      + 'collected — this is not a zero, and nothing here should be read as a measurement. '
      + `It is created by ${LEAGUE_HISTORY_SOURCE}`);
  }
  if (!ls.n && stale.n) {
    // Stale, not absent. Named versions on both sides: "which build wrote what
    // is here" and "which build is being asked for" are the two facts needed to
    // decide whether re-running fixes it.
    gaps.push(`no row for league ${leagueId} season ${season} at version ${MANAGER_ARCHETYPE_VERSION}, but `
      + `${stale.n} row${stale.n === 1 ? '' : 's'} from ${stale.versions ?? 'an earlier version'} `
      + `(last written ${stale.as_of}) — this is stale, not missing; re-run the build`);
  } else if (!ls.n) {
    gaps.push(`no archetype row for league ${leagueId} season ${season} — the build has never covered it`);
  }
  if (!career.n) gaps.push('no career roll-up on this database — the build has never run here');
  if (ls.n && !priced.n) {
    gaps.push(`league ${leagueId} season ${season} has archetype rows but none from ${PRICED_SOURCES.join(' or ')}`
      + ' — nothing here is priceable');
  }
  const out = {
    as_of: ls.as_of ?? null,
    rows: ls.n,
    career_as_of: career.as_of ?? null,
    career_rows: career.n,
    priced_as_of: priced.as_of ?? null,
    priced_rows: priced.n,
    stale_version_rows: stale.n,
    built_by: ARCHETYPE_BUILDER,
    reason: gaps.length ? gaps.join('; ') : null,
  };
  if (jev) { out.jev_as_of = jev.as_of ?? null; out.jev_answers = jev.n; }
  return Object.freeze(out);
}

/**
 * One league's managers keyed by roster_id, which is what the trade finder
 * addresses people by. The career profile travels with them: a manager's draft
 * behaviour in his 2023 league is evidence about the same person in 2026.
 *
 * Every card carries `built`, the block above. It is on the card rather than
 * beside the collection because the card is where the claim is made: someone
 * reading "reaches for a QB early, 16 picks" is reading an assertion about
 * evidence, and its age belongs with it. The league-season and career halves
 * are read once for the whole map; only the Jev stamp is per member, and that
 * is one grouped query rather than one per card.
 */
export function archetypesFor(leagueId, season) {
  const out = new Map();
  // roster_ids present in league_season_teams with no ESPN member attributed
  // to them -- saveTeams() (league-history.js) writes espn_member_id null
  // whenever ESPN's own `owners` array is empty for that team, a real state
  // and not a fault. Counted here so a caller can tell that from a roster
  // that silently failed to get a card.
  out.unownedSlots = [];
  const { ls, career, priced, stale } = builtStamps(leagueId, season);
  const jevBy = new Map(rows(`SELECT member_id, COUNT(*) AS n, MAX(evaluated_at) AS as_of
                              FROM manager_archetype_jev GROUP BY member_id`)
    .map(r => [r.member_id, r]));
  // No table is no cards, and it must not be an exception: routes/trades.js
  // wraps this call in a bare catch, so a throw here and an empty result there
  // are the same thing to every surface downstream. Returning empty says the
  // same thing without pretending a fault did not happen — `leagueHistoryState()`
  // is what a caller reads to tell the two apart.
  if (!leagueHistoryState().present) return out;
  for (const t of rows(`SELECT roster_id, espn_member_id, owner_name FROM league_season_teams
                        WHERE league_id = ? AND season = ?`, leagueId, season)) {
    if (!t.espn_member_id) { out.unownedSlots.push(String(t.roster_id)); continue; }
    const profile = managerProfile(t.espn_member_id);
    out.set(String(t.roster_id), {
      owner: t.owner_name,
      member_id: t.espn_member_id,
      career: profile.seasons.career ?? null,
      this_season: profile.seasons[`${leagueId}|${season}`] ?? null,
      jev: profile.jev,
      built: builtBlock(leagueId, season, ls, career, priced, stale,
        jevBy.get(t.espn_member_id) ?? { n: 0, as_of: null }),
    });
  }
  return out;
}

const ROUND = v => (v == null ? '?' : (Math.round(v * 100) / 100));

/**
 * The state handed to Jev for one manager.
 *
 * NO NAMES. Jev is asked about behaviour, and the manager's real name adds
 * nothing to a judgment about draft behaviour while sending a real person's name
 * to a third-party gateway costs something. The pseudonym maps back locally.
 *
 * The pick list is handed over in order with its consensus delta, because that
 * is the evidence; the summary lines are there so Jev does not have to
 * re-derive arithmetic we already did.
 */
export function jevStateFor(memberId, alias, draftRows) {
  const profile = managerProfile(memberId);
  // Picks come from the build's own detail rather than a fresh query: the
  // detail already resolved the ~20% of picks ESPN returns without a memberId,
  // and it carries each pick's consensus delta, which is the evidence.
  const mineRows = (draftRows ?? []).filter(r => r.member_id === memberId)
    .sort((a, b) => a.season - b.season || a.league_id - b.league_id);

  const lines = [`MANAGER ${alias}. Redraft fantasy football (ESPN, PPR).`];
  const totalPicks = mineRows.reduce((a, r) => a + r.picks.length, 0);
  lines.push(`Observed: ${mineRows.length} league-seasons, ${totalPicks} draft picks. `
    + `NOTE: this record contains DRAFTS and SEASON OUTCOMES only. It contains no trades, `
    + `no waiver moves, no lineup changes and no chat.`);

  for (const row of mineRows) {
    const { league_id: leagueId, season } = row;
    const key = `${leagueId}|${season}`;
    const mine = row.picks;
    const s = profile.seasons[key] ?? { metrics: {}, labels: {} };
    const m = s.metrics;
    lines.push(`\nSEASON ${season} (league ${leagueId}):`);
    lines.push(`  auto-picked ${mine.filter(p => p.is_auto).length}/${mine.length} picks`
      + (m.pick_minus_consensus_mean != null
        ? `; on average he took players ${ROUND(m.pick_minus_consensus_mean)} ROUNDS later than `
          + `the preseason consensus ranked them (positive = waited and took value, negative = reached), `
          + `spread ${ROUND(m.pick_minus_consensus_sd)} rounds`
        : '; no consensus available for this season'));
    const shape = ['rb', 'wr', 'qb', 'te'].map(p => `${p.toUpperCase()} ${m[`${p}_through_6`] ?? 0}`).join(', ');
    lines.push(`  through round 6: ${shape}; first QB round ${m.first_qb_round ?? '-'}, `
      + `first TE round ${m.first_te_round ?? '-'}`);
    if (m.risk_prior_fp_cv_excess != null) {
      lines.push(`  drafted players' week-to-week scoring volatility in the PRIOR season, `
        + `relative to this league's average draft: ${ROUND(m.risk_prior_fp_cv_excess)} `
        + `(positive = he took the more erratic players)`);
    }
    if (m.name_brand_premium_excess != null) {
      lines.push(`  the players he took had slipped ${ROUND(m.name_brand_premium_excess)} rounds `
        + `further in consensus since LAST season than the league's average pick had `
        + `(positive = he bought names the market had already faded)`);
    }
    if (m.homer_top_team_share != null) {
      lines.push(`  most-drafted NFL team ${s.labels.homer_top_team_share ?? '?'}: `
        + `${Math.round(m.homer_top_team_share * 100)}% of his picks`);
    }
    if (m.all_play != null) {
      lines.push(`  outcome: ${ROUND(m.ppg)} points/week, all-play win rate ${ROUND(m.all_play)}, `
        + `actual H2H ${ROUND(m.h2h_pct)}, luck ${ROUND(m.luck_wins)} wins `
        + `(positive = his record flattered his scoring), final rank ${m.final_rank ?? '-'}`);
    }
    // Every pick in order with its own delta. The summary lines above are
    // arithmetic over exactly these rows; both are given so Jev can check one
    // against the other rather than take either on trust.
    lines.push('  picks in order (delta = rounds later than consensus; negative = reach):');
    for (const p of mine) {
      const delta = p.delta == null ? 'no consensus rank'
        : `consensus rank ${p.consensus_rank}, ${p.delta >= 0 ? '+' : ''}${ROUND(p.delta)} rounds`;
      lines.push(`    R${p.round} pick ${p.overall_pick}: ${p.position} ${p.name} (${delta})`
        + `${p.is_auto ? ' [AUTO-PICKED BY ESPN, the manager was not there]' : ''}`);
    }
  }
  const c = profile.seasons.career?.metrics ?? {};
  lines.push(`\nCAREER: auto-pick rate ${ROUND(c.auto_draft_rate)}, `
    + `average board-slot-minus-consensus ${ROUND(c.pick_minus_consensus_mean)} `
    + `(season-to-season spread of that number: ${ROUND(c.pick_minus_consensus_mean_season_sd)}), `
    + `all-play ${ROUND(c.all_play)}, luck ${ROUND(c.luck_wins)} wins per season.`);
  return { state: lines.join('\n'), n_seasons: mineRows.length, n_picks: totalPicks };
}

/**
 * The typed questions. Two groups, and the split is the point:
 *
 *   basis 'draft'          - the state contains evidence that bears on the answer.
 *   basis 'inference_only' - it does not. Trade style, waiver speed and
 *                            sell-low behaviour live in transaction history
 *                            ESPN does not serve retroactively. The questions
 *                            are asked because they are what the trade engine
 *                            wants, and every one of them tells Jev to stay near
 *                            the prior when the evidence is silent - a flat
 *                            answer here is the correct answer, and the basis
 *                            column stops a consumer reading it as measurement.
 */
export const JEV_QUESTIONS = {
  risk_appetite: {
    basis: 'draft',
    type: 'score',
    instructions: 'From the draft record only: how much week-to-week variance does this manager accept? '
      + 'Weigh the volatility line, how early he takes positions the market ranks lower, and the spread of his consensus deltas.',
    criteria: [
      'Very risk-averse - takes the consensus board, favours steady producers.',
      'Cautious - small deviations from the board.',
      'Middling.',
      'Risk-seeking - reaches for upside, tolerates erratic players.',
      'Very risk-seeking - repeatedly pays up for boom-or-bust profiles.',
    ],
  },
  recency_bias: {
    basis: 'draft',
    type: 'score',
    instructions: 'From the draft record only: how much does this manager appear to draft off LAST season\'s results '
      + 'rather than this season\'s consensus? The "names the market had already faded" line is the direct evidence.',
    criteria: [
      'None - his picks track the current consensus.',
      'Slight.', 'Moderate.', 'Strong.',
      'Very strong - repeatedly pays for last year\'s production at this year\'s discount to consensus.',
    ],
  },
  endowment_effect: {
    basis: 'inference_only',
    type: 'score',
    instructions: 'How likely is this manager to overvalue players he already owns? '
      + 'The record contains NO trades or drops, so unless drafting behaviour speaks to attachment '
      + '(e.g. heavy concentration on one NFL team, repeatedly drafting the same profile), spread probability evenly.',
    criteria: ['Not attached.', 'Slightly.', 'Moderately.', 'Strongly.', 'Very strongly attached to his own roster.'],
  },
  information_speed: {
    basis: 'inference_only',
    type: 'choice',
    instructions: 'How does this manager most likely consume fantasy information? '
      + 'The record contains NO waiver claims, lineup changes or timestamps. '
      + 'Auto-picked draft slots are the ONLY engagement evidence present; if that is thin, spread probability evenly.',
    criteria: {
      news_first: 'Follows NFL news closely and acts on it early.',
      box_score: 'Reacts to last week\'s results rather than to news.',
      set_and_forget: 'Low engagement - drafts, sets a lineup, rarely intervenes.',
    },
  },
  position_bias: {
    basis: 'draft',
    type: 'choice',
    instructions: 'From the roster-construction and first-round-by-position lines, which positional habit best describes his drafts?',
    criteria: {
      rb_heavy: 'Loads up on running backs early.',
      wr_heavy: 'Loads up on wide receivers early.',
      qb_early: 'Takes a quarterback earlier than the market does.',
      te_early: 'Takes a tight end earlier than the market does.',
      balanced: 'No consistent positional lean.',
    },
  },
  trade_style: {
    basis: 'inference_only',
    type: 'choice',
    instructions: 'How does this manager most likely behave in a trade negotiation? '
      + 'The record contains NO trade history whatsoever. Unless something in the draft record bears on it, spread probability evenly.',
    criteria: {
      counters: 'Engages and sends counter-offers.',
      binary: 'Accepts or declines outright, rarely counters.',
      never: 'Does not trade.',
    },
  },
  sells_low_after_bad_week: {
    basis: 'inference_only',
    type: 'boolean',
    instructions: 'Would this manager move a player cheaply after one bad week? '
      + 'The record contains NO transactions; answer near 0.5 unless the draft record genuinely bears on it.',
  },
  buys_high: {
    basis: 'inference_only',
    type: 'boolean',
    instructions: 'Would this manager pay a premium for a player coming off a big week? '
      + 'The draft record\'s evidence for this is how much he pays for last season\'s production; use that and nothing else.',
  },
};

/** Persist one manager's Jev answers. Called by the build script, which owns the
 *  gateway call and its budget. */
export function storeJevAnswers(memberId, answers, { nSeasons, nPicks, stateChars, model }) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    run(`DELETE FROM manager_archetype_jev WHERE member_id = ?`, memberId);
    for (const [question, a] of Object.entries(answers)) {
      if (!a) continue;
      const basis = JEV_QUESTIONS[question]?.basis ?? 'unknown';
      const write = (outcome, probability) =>
        run(`INSERT OR REPLACE INTO manager_archetype_jev
               (member_id,question,outcome,probability,basis,n_seasons,n_picks,model,state_chars,evaluated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
        memberId, question, outcome, probability, basis, nSeasons, nPicks, model, stateChars, now);
      if (a.type === 'boolean') { write('true', a.probability ?? null); continue; }
      if (a.type === 'score' && a.score != null) write('mean', a.score);
      for (const [k, p] of Object.entries(a.probabilities ?? {})) write(String(k), p);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
