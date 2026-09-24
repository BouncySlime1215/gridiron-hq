/**
 * The trade engine.
 *
 * Everything here is deterministic — no API key required. The one currency that
 * decides a trade is **starting lineup points**: a roster is only as good as the
 * nine players it can start, so a deal is a win when your optimal lineup projects
 * higher afterwards, regardless of how the raw player values add up. Market price
 * is tracked alongside it as a separate axis, because "did I improve" and "did I
 * get fleeced" are different questions and a good deal answers both.
 *
 * Layers, bottom up:
 *   assets      — every rostered player enriched with projection, market price,
 *                 weekly floor/ceiling, and this week's game (no schedule-strength
 *                 or DvP tilt: none has passed the weekly walk-forward test, see
 *                 matchups.js)
 *   bestLineup  — optimal-lineup solver over a league's real slot config
 *   evaluate    — score any give/get package for both sides
 *   findTrades  — enumerate and rank realistic deals across the league
 *   offerFor    — "I want this player, what do I give up"
 *   selfScout   — my roster's strengths, holes and fix list
 *   evidence    — career record, preseason band and offseason read on every
 *                 player object, plus a floor/ceiling risk read per side —
 *                 explanation only, never an input to any number above
 *
 * ---------------------------------------------------------------------------
 * THE ONE ENTRY POINT FOR TRADE IDEAS: `tradeIdeas(lg, opts)`
 * ---------------------------------------------------------------------------
 * Trade Lab, the Coach, the dashboard and the weekly plan all ask the SAME
 * function for ideas. Before 2026-09-18 there were five answers to "what trade
 * should I make" — `findTrades`, `offerFor`/`offerForMany`, league-brain's own
 * `enumerateDeals` + `acceptProbability`, Trade Lab `/partners` and edge
 * `POST /trade` — and they disagreed, because only the first read the
 * counterparty layer and only the first was horizon-weighted. The other four are
 * retired (410 with a pointer). These are the only three shapes left, and they
 * share every input:
 *
 *   tradeIdeas(lg, { myTeamId, ... })              -> { mode:'league',  context, deals }
 *   tradeIdeas(lg, { myTeamId, targets:[id],
 *                    shape:'single' })             -> { mode:'target',  context, offers, ... }
 *   tradeIdeas(lg, { myTeamId, targets:[id, ...] })-> { mode:'targets', context, ladders }
 *
 * `context` is the same block in all three, and it is what makes them agree:
 * league and roster, season/week, this roster's real P(make playoffs) and where
 * that number came from, the horizon split those odds produce, whether a
 * counterparty layer was available, and how the chance to play is priced. Every
 * number a consumer shows should be traceable to it.
 *
 * `findTrades`, `offerFor` and `offerForMany` are kept as named wrappers so the
 * existing routes and tests keep working; they call straight through, so no
 * caller can be served a different answer than the entry point gives. New
 * consumers call `tradeIdeas`.
 */
import crypto from 'node:crypto';
import { rows } from '../db/index.js';
import { fantasyWeek } from './week.js';
import { vorBoard, volatility } from '../routes/edge.js';
import { deriveFormat } from './format.js';
import { pickInventory } from './picks.js';
import { analyzeLeague } from '../routes/tradelab.js';
import { publishRecommendation } from '../routes/decision-inbox.js';
import { scheduleOutlook, relevantSplits, matchupSignalActive, MATCHUP_SIGNAL_REASON } from './matchups.js';
import { SLOT_NAME } from './espn-draft.js';
import { rosterLocks, lockPins } from './lineup-lock.js';
import { seasonEndingEspnIds } from './player-availability.js';
import { buildPlayerWeekEngine, playerWeekDistribution } from './player-week-engine.js';
import { weeklyAvailability, availabilityBasis } from './contingency.js';
import { activeInjuryFlagIds } from './injury-flags.js';
import { cached, fingerprint } from './compute-cache.js';
import { activeWeeklyWeightSet } from './weekly-weight-store.js';
import { scoringFor } from './scoring.js';
import { activeFantasyCoordinatorFit, weeklyExpertValues, coordinateFantasy } from './fantasy-coordinator.js';
import { dynastyAgeAdjustment } from './dynasty-age-curve.js';
// lineupDiff() only: the Start/Sit tab's own game-script lift (so both pages price
// this week identically), the normal CDF behind a swap's probability, and the
// write that retires a lineup recommendation lineupDiff() itself published.
import { vegasLift } from './waiver-brain.js';
// The league's wire, for lineupValue()'s replacement level (one producer with the
// Waivers page's waiverBoard()).
import { leagueWire } from './league-wire.js';
import { normalCdf, withRandomSeed } from './stats-util.js';
// lineupSpread() only: each starter's played-week draws and the fitted archetype
// correlations, for the lineup-total floor/ceiling.
import { sampleWeeks } from './projections.js';
import { correlationMatrix, correlationBasis } from './correlation.js';
import { servedTableState } from './data-freshness.js';
import { currentMarket } from './dynasty-value-history.js';
import { run as dbRun } from '../db/index.js';
// Evidence layers (see the "evidence" section below). Read-only sources: the
// engine never re-prices on them, it explains with them.
import { careerLine } from './player-career.js';
import { playerNews } from '../news/player-news.js';
import { preseasonProjection } from './preseason-model.js';
import { offseasonAdjustment } from './offseason-model.js';
import { counterpartyLayer, readDeal, counterpartyDataKey, playerValuation, selfRead }
  from './counterparty-pricing.js';
// The nine tactics and THE EDGE TEST (trade-tactics.js). The edge test is the
// only thing in this file that removes an idea on the strength of the
// counterparty read rather than describing one: a deal that is not positive for
// Nick on our own numbers never reaches the list, whatever the other manager
// thinks of it (master plan 00 D4, "a gift, not a trade").
import { edgeTest, tacticsForDeal, timingRead, vetoClimate } from './trade-tactics.js';
import { LOST_IDEAS } from './rec-ledger.js';
import { acceptanceBand } from './trade-acceptance.js';
// tradeIdeas() only: this roster's real P(make playoffs), which is what turns the
// horizon from a 0.5 prior into a number. season-sim.js imports assetUniverse /
// loadRosters / lineupSlots from THIS file, so the two modules form a cycle.
// Neither touches the other's bindings while its module body evaluates (both uses
// are inside functions), and test/trade-engine-correctness.test.js loads them in
// both orders to keep it that way.
//
// TESTS: importing this file now also loads season-sim, so a later
// mock.module('trade-engine.js') does NOT reach season-sim — it already holds the
// real bindings. A test that mocks this module for season-sim's benefit must
// import season-sim under an unused URL afterwards; see the comment in
// test/decision-leftovers-home-away.test.js.
//
// This inverts the layering on purpose and temporarily: the odds belong to the
// Team Outlook service (master plan 00, D3 — "the trade horizon reads its real
// playoff odds"), which does not exist yet. When it ships, myPlayoffOdds() should
// read it and this import goes away. Until then the alternative was leaving the
// live /find route on the 0.5 prior, which is the bug this item exists to fix.
import { simulateSeason, simStartWeek, tradeImpact, tradeImpactWorld } from './season-sim.js';
import { titleMutualMode, titleCandidate, titleMutualDeals } from './title-mutual.js';
import { horizonWeights, horizonGain, horizonNote, leagueSchedule, leagueShape } from './trade-horizon.js';
// ros_ppg / playoff_ppg (and so adj_ppg): the gated rest-of-season model. This
// week's number stays the weekly blend.
import { buildRosProjections } from './ros-projection.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const GAMES = 17;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
export const FLEX_ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
                        SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };
// Positions we model. K and D/ST are near-random week to week and roughly
// interchangeable, so including them adds noise to every lineup comparison.
const SCORED = new Set(SKILL);
// Per-player weekly-model inputs for lineupSpread() (see there), attached to every
// asset under this symbol by buildAssetUniverse(). A symbol, not a field: object
// spread copies it, JSON.stringify and Object.keys skip it.
// Exported so a test can attach a weekly model to a fixture (test/lineup-spread.test.js).
export const WEEK_MARGINAL = Symbol('weekMarginal');
/**
 * What handing over market value costs, per 20% of the value you send.
 *
 * Unfitted and deliberately conservative — see the note at the call site. Fit
 * against decided proposals once `league_transactions_raw` holds enough of them
 * to estimate how much acceptance a point of value actually buys.
 */
export const VALUE_GIVEAWAY_LAMBDA = 0.9;

const norm = s => (s ?? '').toLowerCase().replace(/[.'’-]/g, '')
  .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();

/**
 * Real roster context per team: which positions are a genuine need (starter value
 * well below league average) vs. genuine surplus, and each team's contention window
 * (win-now/rebuild/etc). Without this, the finder only knows "does the lineup-points
 * math improve" — it has no idea whether a package would actually gut a team at a
 * spot they can't afford to lose, which is exactly what makes an auto-suggested
 * trade read as fake to someone who knows the league.
 */
function rosterContext(lg) {
  const byRoster = new Map();
  try {
    for (const t of analyzeLeague(lg).teams) {
      byRoster.set(String(t.roster_id), {
        needs: new Set(t.needs.map(n => n.position)),
        surplus: new Set(t.surplus.map(s => s.position)),
        window: t.window
      });
    }
  } catch { /* analyzeLeague needs the same synced payload findTrades already checked for */ }
  return byRoster;
}

/* ------------------------------------------------------------------ assets */

/**
 * Build the enriched player universe for a league.
 *
 * @returns {Map<number, object>} player id -> asset
 */
export function tradeWeekContext() {
  return fantasyWeek(SEASON); // nfl.week, clamped 1..18 (week.js, BROKEN-D)
}

/**
 * The whole player universe, priced — memoised on the data it reads.
 *
 * This is the most expensive pure function in the fantasy half of the app: it
 * builds a weekly projection engine, a VOR board, a volatility table, schedule
 * outlooks and a 400-run distribution per player. One call is fine. The problem
 * is that the surrounding services make about a dozen — `brainState`,
 * `waiverUpgrades`, `sellHigh`, `positionLiquidity`, and one `selfScout` per
 * team — each rebuilding the identical universe from the identical tables, and
 * the page went from 1.3 to 5.0 seconds as those callers were added.
 * (`brainPlan` was another, until it was retired on 2026-09-18.)
 *
 * A fingerprint cache rather than a TTL, for the reason compute-cache.js
 * explains: keyed on the row counts and newest timestamps of the tables this
 * actually reads, a hit is not merely fresh enough, it is provably the same
 * answer. A sync changes the fingerprint and the work is redone on the next
 * call; nothing changes and the previous answer was already correct.
 */
/**
 * Every table buildAssetUniverse() reads, for the fingerprints of assetUniverse() and
 * findTrades(). A table missing here is an input whose change the cache never sees.
 */
export const ASSET_INPUT_TABLES = [
  { table: 'players', stamp: 'id' },
  { table: 'roster_players', stamp: 'id' },
  // fetched_at, not player_id: a re-sync updates prices in place (same count, same
  // max id), so the old stamp never saw a new price; retirement lands in the same run.
  { table: 'dynasty_values', stamp: 'fetched_at' },
  // Row counts only: MAX(week) was always 18 and carried nothing. In-place stat
  // corrections to the served season are caught by servedInputsDigest() below.
  'player_week_usage',
  // modified_at is the source's own clock (blank on 2026 rows); the served week's
  // report itself is digested in servedInputsDigest(). This used to stamp 'id', which
  // does not exist, and the error was swallowed into a row count.
  { table: 'nfl_injuries', stamp: 'modified_at' },
  // Both line writers stamp fetched_at on insert and the ESPN writer on every update;
  // MAX(week) was always 22.
  { table: 'game_lines', stamp: 'fetched_at' },
  // buildAssetUniverse() also calls seasonEndingEspnIds(), which reads
  // news_items directly — omitted here, a genuine new release/season-ending
  // report (or a fix to how that news is matched) would never invalidate this
  // cache until an unrelated table happened to change, silently continuing
  // to bench an actually-available player.
  { table: 'news_items', stamp: 'id' },
  // ...and espnStatusById(), which reads every league's payload ("ESPN wins when
  // fresher"); a sync writes payload and fetched_at and nothing else.
  { table: 'leagues', stamp: 'fetched_at' },
  // Chance to play: the fitted rates and the role layer's tiers (contingency.js).
  { table: 'nfl_availability_rates', stamp: 'fitted_at' },
  { table: 'nfl_availability_role_rates', stamp: 'fitted_at' },
  'player_week_snaps',
  // A trending re-sync upserts in place (ON CONFLICT DO UPDATE), so the row count
  // alone never saw it; fetched_at is rewritten on every sync.
  { table: 'trending_players', stamp: 'fetched_at' },
  // The Sleeper sync clears an injury flag with an UPDATE (RL-12-2), so the row count
  // never moves; every player_metrics writer re-stamps fetched_at.
  { table: 'player_metrics', stamp: 'fetched_at' }, 'schedule_games',
  // Not read by buildAssetUniverse, but by lineupSpread inside findTrades, whose cache
  // keys on this list. A refit rewrites fitted_at on the same 20-odd rows.
  { table: 'correlation_estimates', stamp: 'fitted_at' }
];

/**
 * The inputs above that only change when a person runs something (S-18), as named
 * states from data-freshness.js#servedTableState ('table_absent' | 'empty' | 'stale' |
 * 'fresh' | 'unknown'), each from that table's one entry (servedTableEntry). Served on
 * `context.hand_fed`, which routes carry as `model_context`:
 *   trending_players       every asset's trend_kind / trend_count; written only by
 *                          POST /api/tradelab/trending/sync. Empty, `trend_kind: null`
 *                          is "nothing fetched", not "not trending".
 *   correlation_estimates  lineupSpread's copula; written only by POST /api/model/sync.
 *                          Empty, every archetype is correlation.js's DEFAULTS.
 */
const handFedInputs = () => ({ trending_players: servedTableState('trending_players'),
  correlation_estimates: correlationBasis() });
// The states key the cache too: a table going stale with time moves no row and no stamp.
const handFedKey = inputs => Object.values(inputs).map(s => `${s.table}=${s.state}`).join(',');

/**
 * What the served week reads that is rewritten in place with no update time, so no
 * row count or newest stamp can see it (review-fixes-2, finding 5): the served week's
 * injury report (syncInjuries upserts a Friday Questionable -> Out onto the same row;
 * weeklyAvailability reads exactly these rows) and the served season's usage and snap
 * totals (nflverse stat corrections upsert in place). About 1 ms on production data.
 */
function servedInputsDigest(season, week) {
  const report = rows(`SELECT gsis_id, team, report_status, practice_status, injury
                       FROM nfl_injuries WHERE season = ? AND week = ? ORDER BY gsis_id`, season, week);
  const usage = rows(`SELECT COUNT(*) AS n, total(targets), total(carries), total(attempts), total(receptions),
                             total(receiving_yards), total(rushing_yards), total(passing_yards),
                             total(receiving_tds), total(rushing_tds), total(passing_tds),
                             total(interceptions), total(fumbles_lost)
                      FROM player_week_usage WHERE season = ?`, season);
  const snaps = rows(`SELECT COUNT(*) AS n, total(offense_snaps), total(offense_pct)
                      FROM player_week_snaps WHERE season = ?`, season);
  return crypto.createHash('sha1').update(JSON.stringify([report, usage, snaps])).digest('hex').slice(0, 16);
}

/**
 * The promoted weekly weight set that prices this week. A promotion adds a row, but a
 * rollback only clears a `promoted` flag, which no row count or max id sees, so the
 * served set's id itself is part of the key. Plus the in-place digest above.
 */
const assetInputsKey = (lg, formatKey, target) =>
  `${lg.id}:${formatKey}:${target.season}:${target.week}:` +
  `w${activeWeeklyWeightSet({ season: target.season, week: target.week }).id}:` +
  `d${servedInputsDigest(target.season, target.week)}:h${handFedKey(handFedInputs())}:` +
  `i${injuryFlagKey()}`;

// A flag goes stale by the clock alone (injury-flags.js), with no table write, so the
// active set itself is part of the key (RL-12-2).
const injuryFlagKey = () => crypto.createHash('sha1')
  .update([...activeInjuryFlagIds()].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 12);

export function assetUniverse(lg, formatKey, requested = null) {
  const target = requested ?? tradeWeekContext();
  return cached(
    `assets:${lg.id}:${formatKey}:${target.season}:${target.week}`,
    fingerprint(ASSET_INPUT_TABLES, assetInputsKey(lg, formatKey, target)),
    () => buildAssetUniverse(lg, formatKey, target));
}

function buildAssetUniverse(lg, formatKey, target) {
  // The universe is only rebuilt when the tables it reads changed (see the
  // fingerprint above) — the same "new data landed" signal the per-player
  // evidence cache should refresh on, so it is dropped here rather than on a TTL.
  evidenceCache.clear();
  const scoring = scoringFor(lg);
  // This league's own playoff weeks, so playoff_ppg is priced on the weeks that
  // actually decide ITS title (see trade-horizon.js#leagueSchedule).
  const { playoffWeeks } = leagueSchedule(lg);
  const playoffWeeksLeft = playoffWeeks.filter(w => w >= target.week).length;
  // formatKey is `dyn_...`/`rd_...` per deriveFormat (format.js) — the age
  // decay only makes sense for a dynasty/keeper valuation, never redraft.
  const isDynasty = formatKey.startsWith('dyn_');
  const weekly = buildPlayerWeekEngine({ season: target.season, week: target.week, scoring });
  // Rest-of-season rate per game played (ros-projection.js): preseason market prior
  // updated by this season's games at n/(n+4), half-weighted with the structural head.
  // It replaced the weekly blend as ros_ppg after a pre-registered gate (2024 and 2025,
  // weeks 1-4: MAE vs the rest-of-season actual 2.8-3.8 -> 2.3-2.5; weeks 6-10 pooled
  // not worse in either season).
  // Players it has no entry for (no game yet this season) keep the weekly number.
  // A failed build is logged and marked on every asset (ros_basis.failed) rather than
  // taking every page down or, as before, silently reading as "no games yet".
  let rosModel = new Map();
  let rosFailure = null;
  try {
    rosModel = buildRosProjections({ season: target.season, week: target.week, scoring, weekly });
  } catch (error) {
    rosFailure = `rest-of-season model failed (${error.message}); ros_ppg is the weekly number`;
    console.error(`[trade-engine] league ${lg.id}, ${target.season} W${target.week}: ${rosFailure}`);
  }
  // Read-only, no computation — the coordinator itself is refit on a schedule
  // (scheduler.js#fantasy_coordinator_refit) and persisted; walk-forward
  // verified (fantasy-coordinator.js's own doc-comment) to beat the plain
  // structural+ensemble number it corrects. `ready: false` before the first
  // background refit falls back to exactly today's prior behavior below.
  const fantasyFit = activeFantasyCoordinatorFit();
  const active = weeklyAvailability(target.season, target.week, { through: target.season - 1 });
  const board = new Map(vorBoard(lg.team_count || 12).map(p => [p.id, p]));
  const vol = volatility();
  // Live FantasyCalc prices only: a row FantasyCalc stopped returning is retired
  // (dynasty-value-history.js) and prices as unpriced here, not at its last value.
  const market = currentMarket(formatKey);
  const ageByPlayer = new Map(rows(`SELECT p.id, rp.age FROM players p
                                    JOIN roster_players rp ON rp.espn_id = p.espn_id
                                    WHERE rp.age IS NOT NULL`).map(x => [x.id, x.age]));
  const injured = activeInjuryFlagIds();
  // Same season-ending/released detection the X's&O's depth chart uses — without
  // this, a player out for the year keeps getting picked as the optimal starter
  // here even after the roster page correctly benches him.
  const seasonEnding = seasonEndingEspnIds();
  // Which absence trend_kind: null means on this build, served on context.hand_fed.
  const handFed = handFedInputs();
  const trending = new Map(rows('SELECT player_id, kind, count FROM trending_players')
    .map(t => [t.player_id, t]));

  const out = new Map();
  for (const p of rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, p.gsis_id, t.abbr AS team_abbr
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id`)) {
    const v = board.get(p.id), w = vol.get(p.id), m = market.get(p.id);
    const dynastyAge = isDynasty && m?.value != null
      ? dynastyAgeAdjustment({
          position: p.position, rawValue: m.value, gsisId: p.gsis_id,
          rosterSnapshotAge: ageByPlayer.get(p.id) ?? m.age ?? null
        })
      : null;
    const weekProjection = weekly.get(p.id);
    const proj = v?.proj ?? 0;
    const sched = p.team_abbr && SCORED.has(p.position)
      ? scheduleOutlook(p.team_abbr, p.position, target.week, playoffWeeks)
      : { sos: 1, playoff_sos: 1, signal: false, reason: 'no team', bye: null, best: [], worst: [],
          playoff_games: [], games: [] };
    // Schedule STRENGTH only enters a number when matchups.js says it is a validated
    // signal. Today it is not (every arm of the 2026-09-17 weekly walk-forward test
    // failed, see matchups.js MATCHUP_EVIDENCE), so sos and playoff_sos are 1 and no
    // rate below is tilted by them. The schedule's FACTS — whether his team plays a
    // given week — still count: that is a bye, not a forecast.
    const scheduleTilt = sched.signal === true;
    const tr = trending.get(p.id);
    const availability = active.get(p.id);
    const activeProbability = availability?.active_probability ?? 0.92;
    const weeklyPpg = weekProjection?.ppg ?? (proj / GAMES);
    const thisGame = sched.games?.find(game => game.week === target.week) ?? null;
    // The coordinator only corrects THIS week's number (ensemble_shift and
    // game-script are both week-specific signals) — weeklyPpg itself, used
    // below for ROS/season-long figures, is untouched: the coordinator was
    // only walk-forward validated against weekly outcomes, not season totals.
    const expertValues = weekProjection ? weeklyExpertValues(weekProjection, target.season, target.week, scoring) : null;
    const coordinated = expertValues ? coordinateFantasy(fantasyFit, expertValues, weeklyPpg) : null;
    const currentWeekBasePpg = coordinated?.ready ? coordinated.corrected_ppg : weeklyPpg;
    // thisGame.mult is exactly 1 while the matchup signal is off (matchups.js#
    // gameMultiplier); kept as a factor so this line needs no edit if a multiplier
    // ever passes the harness. thisGame itself is the bye detector: no game, 0.
    const currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult * activeProbability : 0;
    // Rest-of-season weekly rate. No schedule tilt (see scheduleTilt above), no
    // availability term — per game played, the same basis it has always had. It used
    // to BE weeklyPpg, which at week 2 is 80% the week-1 score (Coker 29.9 after a
    // 33.8-point week 1; Waddle 2.72 after 1.2).
    const ros = rosModel.get(p.id) ?? null;
    const rosBasePpg = ros?.ros_ppg ?? weeklyPpg;
    const rosPpg = scheduleTilt ? rosBasePpg * sched.sos : rosBasePpg;
    // The rate for THIS league's playoff weeks, on ros_ppg's basis: the ROS rate
    // times the share of those weeks his team actually plays. A playoff-week bye is a
    // real, known zero; opponent strength in those weeks is not something any tested
    // model forecasts, so it is not in here. For nearly everyone this equals ros_ppg
    // (2026: only week 14 has byes, and only league 3's playoffs include week 14).
    // Players with no NFL schedule on file (no team, K/DEF) keep the full rate —
    // unknown is not a bye.
    const hasSchedule = Boolean(p.team_abbr && SCORED.has(p.position));
    // Same bye detector as currentWeekPpg (:359): no game this week, known from the
    // schedule, not a forecast. Gates weekDist, WEEK_MARGINAL and the served
    // floor/ceiling/avg below so a bye-week starter's weekly range is 0, not a full
    // distribution he cannot play. Players with no schedule on file keep the
    // model's number — unknown is not a bye (see the comment above hasSchedule).
    const onBye = hasSchedule && !thisGame;
    const playoffGameShare = hasSchedule && playoffWeeksLeft > 0
      ? (sched.playoff_games?.length ?? 0) / playoffWeeksLeft : 1;
    const playoffPpg = (scheduleTilt ? rosBasePpg * sched.playoff_sos : rosBasePpg) * playoffGameShare;
    // Which of those weeks he sits out, so a trade's playoff leg can solve that week's
    // lineup without him (evaluate()) instead of charging his whole rate x share.
    const playoffByeWeek = hasSchedule && sched.bye != null && sched.bye >= target.week
      && playoffWeeks.includes(sched.bye) ? sched.bye : null;
    // A trade is a rest-of-season decision, not DFS. The live week matters, but
    // it cannot erase the remaining schedule or turn a bye into a player-value
    // collapse. The weekly engine itself refreshes from every completed week.
    const decisionPpg = 0.25 * currentWeekPpg + 0.75 * rosPpg;
    // 2,000 draws, playerWeekDistribution's own default. This used to override it
    // down to 400, and at 400 the percentiles are not stable enough to print, let
    // alone difference across the two sides of a trade: measured over 200 re-draws
    // of one WR1, p90 sd 1.84 at 400 vs 0.86 at 2,000 (p10 0.52 vs 0.23, mean 0.69 vs
    // 0.34). A ceiling_delta of a few points was inside the draw noise of the two
    // swapped players. Cost: ~0.7s -> ~3.6s of sampling per asset-universe build
    // (1,183 players), which is cached per league-week. Deterministic seeding from
    // the cache key makes the number reproducible, which is not the same as
    // accurate — and because the key includes activeProbability and mult, a small
    // availability change re-rolls the whole draw. These per-player numbers are for
    // display; a trade's floor_delta/ceiling_delta no longer adds them up — it comes
    // from lineupSpread()'s lineup-total percentiles.
    // No draw for a player who cannot play this week — a bye is a known 0, not a
    // distribution to sample (see onBye above).
    const weekDist = weekProjection && !onBye
      ? playerWeekDistribution(weekProjection, { runs: 2000, activeProbability, mult: thisGame?.mult ?? 1 })
      : null;

    out.set(p.id, {
      // What lineupSpread() needs to put this player's week into a lineup total: the
      // same week inputs as weekDist above. Symbol-keyed so it survives the
      // `{ ...p }` copies the trade search makes and never reaches a JSON response.
      // activeProbability 0 on a bye zeroes both the mean and the variance
      // spreadInput() derives from this (trade-engine.js#spreadInput), so a bye-week
      // starter contributes nothing to a lineup's weekly floor/ceiling/avg.
      [WEEK_MARGINAL]: weekProjection ? {
        params: weekProjection.params, shift: weekProjection.ensemble_shift ?? 0,
        activeProbability: onBye ? 0 : activeProbability, mult: thisGame?.mult ?? 1, scoring,
        seed: `${target.season}:${target.week}:${p.id}:${activeProbability}:${thisGame?.mult ?? 1}:${weekProjection.ensemble_shift ?? 0}`,
        meta: { id: p.id, position: p.position, team: p.team_abbr, opponent: thisGame?.opponent ?? null,
          target_share: weekProjection.volume?.target_share ?? null }
      } : null,
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      espn_id: p.espn_id, sleeper_id: p.sleeper_id,
      proj: +(weeklyPpg * Math.max(1, 18 - target.week)).toFixed(1),
      ppg: +weeklyPpg.toFixed(2),
      vor: v?.vor ?? 0,
      adp: v?.adp ?? null,
      value: m?.value ?? 0,
      trend30: m?.trend30 ?? null,
      pos_rank: m?.pos_rank ?? null,
      age: m?.age ?? ageByPlayer.get(p.id) ?? null,
      // Additive, inspectable age-curve decay on top of the raw FantasyCalc
      // dynasty price (4for4 2025 "Production Curves") — null for non-dynasty
      // formats or players FantasyCalc has no dynasty price for. `value` above
      // is left untouched (still the raw market pass-through every other
      // consumer of this universe already relies on); this is a separate,
      // explicit view onto the same player. See dynasty-age-curve.js.
      dynasty_value_raw: dynastyAge?.raw_value ?? null,
      dynasty_value_age_adjusted: dynastyAge?.adjusted_value ?? null,
      dynasty_age_decay: dynastyAge ? {
        multiplier: dynastyAge.multiplier, age: dynastyAge.age, age_source: dynastyAge.age_source,
        source: dynastyAge.source ?? null
      } : null,
      // Weekly shape from real boxscores — this is what separates two players who
      // project for the same total.
      // On a bye, `weekDist` above is already null — but without this branch these
      // three would still fall through to `w?.floor/ceiling/avg`, the multi-season
      // VOLATILITY table (routes/edge.js#volatility), which is not this week either
      // and is exactly how a bye-week starter kept a positive ceiling (RL-5-3).
      floor: onBye ? 0 : weekDist?.p10 ?? w?.floor ?? null,
      ceiling: onBye ? 0 : weekDist?.p90 ?? w?.ceiling ?? null,
      avg: onBye ? 0 : weekDist?.mean ?? w?.avg ?? null,
      boom: weekDist?.boom_rate ?? w?.boom_rate ?? null, bust: weekDist?.bust_rate ?? w?.bust_rate ?? null,
      consistency: w?.consistency ?? null, logged_games: w?.games ?? null,
      injury: injured.has(p.id) || !!(availability?.report_status && !/probable/i.test(availability.report_status)) ? 1 : 0,
      available: !(p.espn_id && seasonEnding.has(p.espn_id)),
      trend_kind: tr?.kind ?? null, trend_count: tr?.count ?? null,
      // Schedule strength: 1 and `schedule_signal: false` while matchups.js has no
      // validated signal. Kept on the asset (the player outlook shows them) but no
      // number in this file reads them unless schedule_signal is true.
      sos: sched.sos, playoff_sos: sched.playoff_sos, bye: sched.bye,
      schedule_signal: scheduleTilt, schedule_reason: scheduleTilt ? null : (sched.reason ?? MATCHUP_SIGNAL_REASON),
      adj_ppg: +decisionPpg.toFixed(2),
      current_week_ppg: +currentWeekPpg.toFixed(2),
      // His team has no game in the target week (onBye above, the same detector
      // current_week_ppg uses). weekLineup() reads it so selfScout and a trade card's
      // weekly floor/ceiling solve this week's lineup without him (RL-5-3).
      bye_this_week: onBye,
      // Transparency for the correction folded into current_week_ppg above —
      // null when no fit is persisted yet (fantasy_coordinator_refit hasn't
      // run) or this player has no weekly projection to correct.
      fantasy_coordinator: coordinated?.ready
        ? { corrected_ppg: coordinated.corrected_ppg, correction: coordinated.correction, contributions: coordinated.contributions }
        : null,
      ros_ppg: +rosPpg.toFixed(2),
      // What ros_ppg was built from; null = no ROS entry (no game yet), { failed } = the
      // ROS build failed; in both cases ros_ppg is the weekly number.
      ros_basis: ros ? {
        games: ros.games, season_to_date: +ros.season_to_date.toFixed(2),
        prior: ros.prior == null ? null : +ros.prior.toFixed(2), prior_source: ros.prior_source,
        weight_in_season: ros.weight_in_season == null ? null : +ros.weight_in_season.toFixed(3)
      } : rosFailure ? { failed: rosFailure } : null,
      active_probability: +activeProbability.toFixed(3),
      injury_status: availability?.report_status ?? null,
      practice_status: availability?.practice_status ?? null,
      model_cutoff: weekProjection?.player_week_engine?.cutoff ?? `${target.season}-W${Math.max(0, target.week - 1)}`,
      model_mode: weekProjection?.player_week_engine?.mode ?? 'season_projection_fallback',
      role_change: weekProjection?.player_week_engine?.role_change ?? null,
      matchup: thisGame,
      // Weekly rate in this league's playoff weeks: ros_ppg's basis, times the share
      // of those weeks his team plays (byes). No opponent adjustment — see above.
      playoff_ppg: +playoffPpg.toFixed(2),
      playoff_game_share: +playoffGameShare.toFixed(3),
      playoff_bye_week: playoffByeWeek,
      playoff_weeks_left: playoffWeeksLeft,
      // The playoff-week opponents themselves are fact and stay for display; each
      // game's mult is 1 and rank null while the matchup signal is off.
      playoff_games: sched.playoff_games
    });
  }
  out.context = {
    hand_fed: handFed,
    season: target.season, week: target.week,
    cutoff: `${target.season}-W${Math.max(0, target.week - 1)}`,
    engine: 'player-week-v2.1 + weekly availability + current/remaining schedule',
    decision_horizon: '25% current week, 75% rest-of-season rate; dynasty market value remains a separate price axis',
    // Byes count; opponent strength does not (no validated signal — matchups.js).
    schedule_signal: matchupSignalActive(),
    schedule_note: matchupSignalActive() ? null : MATCHUP_SIGNAL_REASON,
    // Which availability model priced active_probability: 'role' | 'pooled' | 'constants'
    // and the fit tables that are missing (contingency.js#availabilityBasis). The cache
    // fingerprint stamps both fit tables, so this matches the cached numbers.
    availability_basis: availabilityBasis()
  };
  return out;
}

/* ----------------------------------------------------------------- rosters */

/** ESPN defaultPositionId -> position, for the name + position fallback. */
const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

/**
 * Which asset an ESPN roster entry is. The one resolver behind loadRosters and the
 * waiver board (waiver-wire.js#waiverBoard), so the two cannot disagree on who is
 * rostered.
 *
 * Returns `pl => { asset, match }`, `pl` being `playerPoolEntry.player`:
 *   - match 'espn_id': an asset carries the entry's ESPN id. Always tried first.
 *   - match 'name_position': no asset carries that id (or the entry has none), and
 *     exactly one asset with the same normalised name and position has NO ESPN id of
 *     its own. An asset carrying a different ESPN id is a different person — the
 *     retired "Marvin Harrison" (ESPN 939) is not Marvin Harrison Jr. (4432708) —
 *     so it is never a fallback target; neither is a tie between two id-less rows.
 *     The identity is unconfirmed, and callers say so.
 *   - { asset: null, match: null }: unresolved.
 * The waiver board used to join by normalised name only (last row wins, "Jr."
 * stripped) and priced a retired or junk namesake at 0.0 / 0.0 as the suggested cut
 * in all 5 synced leagues on 2026-W3 (RL-6-4, docs/tdd/2026-09-23-rl-6-4-waiver-drop-identity.tdd.md).
 */
export function espnPlayerResolver(assets) {
  const byEspn = new Map(), byKey = new Map();
  for (const a of assets.values()) {
    if (a.espn_id) { byEspn.set(String(a.espn_id), a); continue; }
    const k = `${norm(a.name)}|${a.position}`;
    byKey.set(k, byKey.has(k) ? null : a);   // null marks a tie: ambiguous, not resolvable
  }
  return pl => {
    const hit = pl?.id != null ? byEspn.get(String(pl.id)) : undefined;
    if (hit) return { asset: hit, match: 'espn_id' };
    const fb = pl?.fullName ? byKey.get(`${norm(pl.fullName)}|${ESPN_POS[pl.defaultPositionId] ?? ''}`) : null;
    return fb ? { asset: fb, match: 'name_position' } : { asset: null, match: null };
  };
}

/** League rosters as arrays of enriched assets, keyed the same way for both platforms. */
export function loadRosters(lg, assets) {
  const payload = JSON.parse(lg.payload);
  const teams = [];
  if (lg.platform === 'sleeper') {
    const bySleeper = new Map();
    for (const a of assets.values()) if (a.sleeper_id) bySleeper.set(String(a.sleeper_id), a);
    const users = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
    for (const ro of payload.rosters ?? []) {
      const u = users[ro.owner_id];
      teams.push({
        roster_id: String(ro.roster_id),
        owner: u?.metadata?.team_name || u?.display_name || `Team ${ro.roster_id}`,
        players: (ro.players ?? []).map(sid => bySleeper.get(String(sid))).filter(Boolean)
      });
    }
  } else {
    const resolve = espnPlayerResolver(assets);
    for (const t of payload.teams ?? []) {
      teams.push({
        roster_id: String(t.id),
        owner: t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`,
        players: (t.roster?.entries ?? []).map(e => resolve(e.playerPoolEntry?.player).asset).filter(Boolean)
      });
    }
  }
  return teams;
}

/** Starting slots for this league, defaulted sanely when the sync didn't record them. */
export function lineupSlots(lg) {
  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions)
    : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
  return rp.filter(s => SCORED.has(s) || FLEX_ELIGIBLE[s]);
}

/* -------------------------------------------------------- lineup optimiser */

const warnedMissingKeys = new Set();

/**
 * Exact max-weight assignment of flex slots, for eligibility sets that are not
 * nested (see bestLineup). `pool` is already sorted by `key`, descending, and holds
 * only players no dedicated slot took. Enumerates injective slot->player maps over
 * the union of each slot's top-f eligible players; with f flex slots that is at
 * most f^2 candidates, so the search is tiny.
 */
function exactFlexAssignment(pool, flexSlots, key) {
  const f = flexSlots.length;
  const candidates = [...new Set(flexSlots.flatMap(slot =>
    pool.filter(p => FLEX_ELIGIBLE[slot].includes(p.position)).slice(0, f)))];
  let best = null, bestPts = -Infinity;
  const pick = new Array(f).fill(null);
  const taken = new Set();
  const walk = i => {
    if (i === f) {
      const pts = pick.reduce((sum, p) => sum + (p?.[key] ?? 0), 0);
      if (pts > bestPts) { bestPts = pts; best = [...pick]; }
      return;
    }
    const ok = FLEX_ELIGIBLE[flexSlots[i]];
    for (const p of candidates) {
      if (taken.has(p.id) || !ok.includes(p.position)) continue;
      taken.add(p.id); pick[i] = p; walk(i + 1); taken.delete(p.id);
    }
    pick[i] = null; walk(i + 1);
  };
  walk(0);
  return flexSlots.map((slot, i) => ({ slot, player: best?.[i] ?? null }));
}

/**
 * Best possible starting lineup from a set of players.
 *
 * Fills dedicated slots with the top players at each position, then flex slots from
 * whatever is left. The dedicated-before-flex order is optimal because every flex
 * set is a superset of the dedicated slot it competes with — no dedicated slot can
 * ever be better served by a player the flex already took.
 *
 * That argument covers dedicated vs flex ONLY. It says nothing about two flex slots
 * competing with each other, and the old code filled those in roster_positions order,
 * which is a platform artifact. Two cases:
 *
 *   NESTED flex sets (FLEX with SUPER_FLEX/OP, or several FLEX) — every pair is a
 *   subset of the other. Greedy is optimal provided the MOST RESTRICTIVE slot is
 *   filled first; in platform order a SUPER_FLEX could take the last RB/WR/TE and
 *   strand a FLEX that a spare QB could not fill. The pass now sorts by eligibility
 *   size, which is a no-op for every league synced today (all plain FLEX).
 *
 *   NON-NESTED sets (REC_FLEX {WR,TE} with WRRB_FLEX {RB,WR}) — no greedy order is
 *   optimal. Measured: RB3 = 14, WR3 = 15, TE2 = 2 left over, slot order [WRRB, REC]
 *   scored 125 and [REC, WRRB] 137 on the identical roster. For these the flex pass is
 *   solved exactly by enumeration, which is cheap: an optimal assignment only ever
 *   uses, for each slot, one of that slot's top-f eligible players (f = number of flex
 *   slots), so the candidate set is at most f^2 players.
 *
 * No synced league uses a non-nested pair, so this changes no number today. It
 * matters because every downstream decision is a DIFFERENCE of two of these calls.
 *
 * @param key which projection to optimise: 'adj_ppg' (season), 'current_week_ppg'
 *   (this week), 'ros_ppg', 'playoff_ppg', or a key the caller annotated.
 */
export function bestLineup(players, slots, key = 'adj_ppg') {
  // Season-ending/released players (see player-availability.js) never fill a
  // starting slot — but they still belong on the bench list, not vanished
  // entirely, so the roster view can show why that slot moved to someone else.
  const eligible = players.filter(p => SCORED.has(p.position));
  const pool = eligible.filter(p => p.available !== false).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  // A key that exists on NO player is almost always a programming error — a typo,
  // or a caller that forgot to annotate the field it asked for — and it used to
  // return points 0 beside a full, plausible-looking lineup with no signal at all.
  // Every consumer takes a difference of two such calls, so the failure read as "no
  // upgrade found" everywhere. It is now flagged on the result (`key_missing`) and
  // logged once per key. It does not throw: evaluate() is legitimately called on
  // partial player objects (the test fixtures carry adj_ppg and no playoff_ppg), and
  // a crash on a live page is a worse failure than a flagged zero. A key that is
  // present but null or 0 on some players is a legitimate data state and is not
  // flagged.
  const keyMissing = pool.length > 0 && !pool.some(p => Object.prototype.hasOwnProperty.call(p, key));
  if (keyMissing && !warnedMissingKeys.has(key)) {
    warnedMissingKeys.add(key);
    console.warn(`[trade-engine] bestLineup: no player in the pool carries '${key}' — every lineup on this key ` +
      'scores 0. Misspelled or unannotated key? (logged once per key; see key_missing on the result)');
  }
  const used = new Set();
  const filled = [];

  for (const slot of slots.filter(s => SCORED.has(s))) {
    const pick = pool.find(p => !used.has(p.id) && p.position === slot);
    if (pick) used.add(pick.id);
    filled.push({ slot, player: pick ?? null });
  }
  // Solve the flex slots most-restrictive first, then report them back in the
  // league's own roster order so no consumer sees a reshuffled slot list.
  const flexOrder = slots.filter(s => FLEX_ELIGIBLE[s])
    .map((slot, order) => ({ slot, order }))
    .sort((a, b) => FLEX_ELIGIBLE[a.slot].length - FLEX_ELIGIBLE[b.slot].length || a.order - b.order);
  const flexSlots = flexOrder.map(x => x.slot);
  const nested = flexSlots.every((a, i) => flexSlots.slice(i + 1).every(b =>
    FLEX_ELIGIBLE[a].every(pos => FLEX_ELIGIBLE[b].includes(pos))
    || FLEX_ELIGIBLE[b].every(pos => FLEX_ELIGIBLE[a].includes(pos))));
  let flexFilled;
  if (nested) {
    flexFilled = flexSlots.map(slot => {
      const ok = FLEX_ELIGIBLE[slot];
      const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
      if (pick) used.add(pick.id);
      return { slot, player: pick ?? null };
    });
  } else {
    flexFilled = exactFlexAssignment(pool.filter(p => !used.has(p.id)), flexSlots, key);
    for (const f of flexFilled) if (f.player) used.add(f.player.id);
  }
  const inRosterOrder = new Array(flexOrder.length);
  flexOrder.forEach((x, i) => { inRosterOrder[x.order] = flexFilled[i]; });
  filled.push(...inRosterOrder);

  const points = filled.reduce((s, f) => s + (f.player?.[key] ?? 0), 0);
  return {
    points: +points.toFixed(2),
    key_missing: keyMissing,
    slots: filled,
    bench: eligible.filter(p => !used.has(p.id)),
    holes: filled.filter(f => !f.player).map(f => f.slot)
  };
}

/**
 * THIS week's best lineup: bestLineup() over everyone whose team plays this week.
 * A player on bye (asset.bye_this_week, set in buildAssetUniverse from the same
 * schedule check as current_week_ppg) cannot start, so the next-best player fills
 * his slot — the same rule evaluate()'s solve() applies to a playoff-week bye
 * (playoff_bye_week). He stays on the bench list so the roster view still shows him.
 * With no one on bye this is exactly bestLineup(players, slots, key).
 */
export function weekLineup(players, slots, key = 'adj_ppg') {
  if (!players.some(p => p.bye_this_week)) return bestLineup(players, slots, key);
  const line = bestLineup(players.filter(p => !p.bye_this_week), slots, key);
  return { ...line, bench: line.bench.concat(players.filter(p => p.bye_this_week && SCORED.has(p.position))) };
}

/**
 * bestLineup with some players pinned where they are (RL-4-2: a player whose game
 * has kicked off cannot move — lineup-lock.js).
 *
 * `pins` maps player id -> the slot he is set in. A pinned starter keeps that slot
 * and it is taken out of the solve; a pinned player in BENCH, IR or a slot this
 * league does not have is out of the solve entirely. Everyone else is solved by
 * bestLineup over the slots left, which is the standard late-swap rule: lock the
 * started players, re-solve the open slots. With no pins it IS bestLineup.
 *
 * The result has bestLineup's shape and order (dedicated slots, then flex in roster
 * order). A pinned starter flagged unavailable counts 0, as bestLineup would count
 * him (it leaves him out). `pinned` lists the ids held in a slot.
 */
export function pinnedBestLineup(players, slots, key = 'adj_ppg', pins = new Map()) {
  if (!pins?.size) return bestLineup(players, slots, key);
  const remaining = [...slots];
  const held = [];
  for (const p of players) {
    if (!pins.has(p.id) || !SCORED.has(p.position)) continue;
    const i = remaining.indexOf(pins.get(p.id));
    if (i < 0) continue;
    remaining.splice(i, 1);
    held.push({ slot: pins.get(p.id), player: p });
  }
  const sub = bestLineup(players.filter(p => !pins.has(p.id)), remaining, key);
  const take = (list, slot) => {
    const i = list.findIndex(f => f.slot === slot);
    return i < 0 ? null : list.splice(i, 1)[0];
  };
  const heldLeft = [...held], subLeft = [...sub.slots];
  const filled = [...slots.filter(s => SCORED.has(s)), ...slots.filter(s => FLEX_ELIGIBLE[s])]
    .map(slot => take(heldLeft, slot) ?? take(subLeft, slot) ?? { slot, player: null });
  const heldPoints = held.reduce((s, f) => s + (f.player.available === false ? 0 : (f.player[key] ?? 0)), 0);
  const used = new Set(filled.map(f => f.player?.id).filter(id => id != null));
  return {
    points: +(sub.points + heldPoints).toFixed(2),
    key_missing: sub.key_missing,
    slots: filled,
    bench: players.filter(p => SCORED.has(p.position) && !used.has(p.id)),
    holes: filled.filter(f => !f.player).map(f => f.slot),
    pinned: held.map(f => f.player.id)
  };
}

/*
 * THE LINEUP'S WEEKLY FLOOR AND CEILING — percentiles of the lineup's TOTAL.
 *
 * Two rosters can project identically and have very different variance; a win-now
 * team wants floor, a longshot wants ceiling. The question is what the starting
 * lineup scores in a bad week and in a good one.
 *
 * This used to answer it with the SUM of each starter's own p10 as the lineup
 * "floor" and the sum of p90s as the "ceiling". A sum of quantiles is not the
 * quantile of a sum: nine starters do not all have their 1-in-10 week together.
 * Measured by the 2026-09-17 audit on a nine-starter lineup (40,000 joint draws):
 * sum of p10 5.2 against a true lineup p10 of 73.6; sum of p90 245.4 against a
 * true 159.5. The "floor" was the everyone-busts week, which never happens, and
 * floor_delta / ceiling_delta in every trade verdict were differences of those.
 *
 * Now the floor and ceiling are the 10th and 90th percentiles of the lineup total,
 * from each starter's weekly model:
 *
 *   One starter's week. With probability 1 - active_probability he does not play
 *   and scores exactly 0. Otherwise one played week from projections.js
 *   #sampleWeeks (this week's usage/efficiency params and the mean-preserving
 *   weekly shock) plus the ensemble shift, clamped at 0 — the same inputs, and the
 *   same 0 for a week he sits, as player-week-engine.js#playerWeekDistribution, so
 *   this lineup floor and the per-player floor on the asset agree. Each starter's
 *   mean and variance come from a fixed, seeded pool of 2,000 played weeks plus
 *   that 0 for the weeks he sits.
 *
 *   Together. The lineup total's mean is the sum of the means; its variance is the
 *   sum of the variances plus 2 rho sd sd for every pair in the same game (the
 *   fitted archetype correlations, correlation.js: QB-WR same team ~0.18, opposing
 *   QBs ~0.16; every other pair is independent, which is what most drafted
 *   lineups are). Floor and ceiling = mean -/+ 1.2816 sd.
 *
 * That last step is a normal approximation, and it was chosen by a pre-registered
 * check, not by taste (scratch step1/trade-consumers/GATE.md, 2026-09-18). Truth
 * was a brute-force joint simulation — 200,000 draws per player through the
 * library copula sampler (correlation.js#correlatedSampler) — on all 46 lineups in
 * the five synced leagues plus every post-trade lineup findTrades returned (150
 * lineups, 142 before/after pairs). Pass: level error <= 2.5 pts max and <= 1.0
 * mean, trade deltas within 1.0 pt for 95% of pairs and within 2.0 for all.
 *
 *                         p10 err max/mean   p90 err max/mean   deltas within 1.0 (floor / ceiling)
 *   old sum of quantiles    48.2 / 29.8        81.3 / 65.0        30% / 37%
 *   joint draws (10,000)     1.4 / 0.46         2.7 / 0.68        96.5% / 92.3%   FAILED
 *   normal approximation     1.2 / 0.46         2.0 / 0.59        100% / 99.3%    passed
 *
 * The joint simulation (10,000 draws of the same per-player pools) was the first
 * choice and failed narrowly: a lineup's 90th percentile wandered up to 2.7 pts
 * and ceiling deltas were within a point only 92% of the time. The normal
 * approximation, on the same pools, passed on every count; its own bias is small
 * and known — about 0.4 pts low at both ends, because a lineup total is slightly
 * skewed. Where the true change in floor or ceiling was a point or more, its sign
 * agreed with the brute force every time (206 of 206).
 *
 * Cost: ~3 ms per player the first time he enters any spread (his pool), then
 * microseconds per lineup. evaluate() computes floor_delta/ceiling_delta only when
 * they are read (see there), so the trade search does not pay for the thousands of
 * candidate deals nobody ever sees.
 */
const SPREAD_POOL = 2000;     // played weeks per player — the per-player distribution's own size
const Z90 = 1.2815516;        // standard-normal 90th percentile

const seedOf = text => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * One starter's weekly mean and variance: `model` from his weekly model (memoised
 * on the WEEK_MARGINAL object, which lives exactly as long as its asset universe),
 * `approx` from the floor/ceiling he carries when he has no weekly model (a normal
 * with that 10th-90th range, unclamped), or `constant` at his average.
 */
function spreadInput(p) {
  const m = p[WEEK_MARGINAL];
  if (m?.params) {
    if (!m.moments) {
      const played = withRandomSeed(seedOf(`${m.seed}:pool`), () =>
        sampleWeeks(m.params, SPREAD_POOL, m.scoring, m.mult, 1));
      const ap = Math.max(0, Math.min(1, Number(m.activeProbability) || 0));
      let s1 = 0, s2 = 0;
      for (const v of played) { const x = Math.max(0, v + m.shift); s1 += x; s2 += x * x; }
      const mean = ap * (s1 / played.length);
      m.moments = { mean, variance: Math.max(0, ap * (s2 / played.length) - mean * mean) };
    }
    return { kind: 'model', meta: m.meta, ...m.moments };
  }
  if (p.floor != null && p.ceiling != null) {
    const sd = Math.max(0, p.ceiling - p.floor) / (2 * Z90);
    return { kind: 'approx', mean: p.avg ?? (p.floor + p.ceiling) / 2, variance: sd * sd };
  }
  return { kind: 'constant', mean: Number(p.avg ?? p.adj_ppg ?? 0) || 0, variance: 0 };
}

/**
 * The starting lineup's weekly floor (p10) and ceiling (p90) TOTAL. See the note
 * above for the model and the check behind it.
 *
 * @returns {{ floor, ceiling, mean, sd, coverage, method, correlated_pairs }}
 */
export function lineupSpread(lineup) {
  const starters = (lineup?.slots ?? []).map(s => s.player).filter(Boolean);
  const inputs = starters.map(spreadInput);
  if (!inputs.some(x => x.kind !== 'constant')) return { floor: null, ceiling: null, coverage: 0 };
  let mean = 0, variance = 0;
  for (const x of inputs) { mean += x.mean; variance += x.variance; }
  // Same-game pairs among the starters with a weekly model: 2 rho sd_i sd_j each.
  const modeled = inputs.filter(x => x.kind === 'model');
  let correlatedPairs = 0;
  if (modeled.length > 1) {
    const R = correlationMatrix(modeled.map(x => x.meta));
    for (let i = 0; i < modeled.length; i++) {
      for (let j = i + 1; j < modeled.length; j++) {
        if (!R[i][j]) continue;
        correlatedPairs++;
        variance += 2 * R[i][j] * Math.sqrt(modeled[i].variance * modeled[j].variance);
      }
    }
  }
  const sd = Math.sqrt(Math.max(0, variance));
  return {
    floor: +Math.max(0, mean - Z90 * sd).toFixed(1),
    ceiling: +(mean + Z90 * sd).toFixed(1),
    mean: +mean.toFixed(1),
    sd: +sd.toFixed(1),
    coverage: +(modeled.length / inputs.length).toFixed(2),
    method: 'normal approximation of the lineup total',
    correlated_pairs: correlatedPairs
  };
}

/* --------------------------------------------------------------- evidence */

/**
 * Stat-rooted evidence per player: the multi-season record (player-career.js),
 * our validated preseason projection with its band (preseason-model.js) and the
 * offseason-changes read (offseason-model.js).
 *
 * This is explanation, not pricing. Nothing here touches `value`, `adj_ppg` or
 * any lineup number — the point is that a card can say "1,000+ rec yds in 5
 * straight seasons, top-12 every year" instead of "reliable". In particular the
 * offseason multiplier is NEVER applied: the weekly engine already knows the
 * depth chart, so multiplying it on would double-count (see offseason-model.js);
 * it is surfaced as a risk/upside flag with its drivers.
 *
 * Every layer is optional. A source that returns null or throws simply leaves
 * its field absent, so the engine behaves exactly as before on a database that
 * has no play-by-play history or no fitted model.
 *
 * `slim()` — the one place every outgoing player object is built (gives, gets,
 * i_give/i_get, targets, scout starters) — spreads this in, memoised per player
 * because `evaluate()` runs thousands of times inside findTrades().
 */
const evidenceDefaults = { careerLine, preseasonProjection, offseasonAdjustment };
let evidenceSources = { ...evidenceDefaults };
const evidenceCache = new Map();

/** Test hook: swap any evidence source (pass `null` to simulate a missing layer). */
export function _setEvidenceSources(overrides = {}) {
  evidenceSources = { ...evidenceDefaults, ...overrides };
  evidenceCache.clear();
}

const r1 = v => (v == null || !Number.isFinite(v) ? null : +Number(v).toFixed(1));
const CAREER_SEASONS_SHOWN = 3;

function compactCareer(c) {
  if (!c || !Array.isArray(c.seasons)) return null;
  return {
    headline: c.headline ?? null,
    window: c.window ?? null,
    // Newest first; three seasons is what fits on a card, the consistency read
    // below still covers the full window the source computed it over.
    seasons: c.seasons.slice(0, CAREER_SEASONS_SHOWN).map(s => ({
      season: s.season, games: s.games, ppr_points: r1(s.ppr_points), ppg: s.ppg, pos_rank: s.pos_rank,
      rush_att: s.rush_att, carries: s.rush_att, rush_yds: s.rush_yds, rush_td: s.rush_td,
      targets: s.targets, rec: s.rec, rec_yds: s.rec_yds, rec_td: s.rec_td,
      pass_att: s.pass_att, pass_yds: s.pass_yds, pass_td: s.pass_td, int: s.int
    })),
    seasons_on_record: c.seasons.length,
    consistency: c.consistency ?? null,
    streaks: (c.streaks ?? []).filter(s => (s.streak ?? 0) >= 2).slice(0, 4)
      .map(s => ({ stat: s.stat, threshold: s.threshold, seasons: s.seasons, streak: s.streak, values: s.values })),
    trend: c.trend ?? null
  };
}

function compactPreseason(p) {
  if (!p || p.points == null) return null;
  return {
    points: r1(p.points), ppg: p.ppg ?? null, expected_games: r1(p.expected_games),
    p20: r1(p.p20), p80: r1(p.p80),
    drivers: (p.drivers ?? []).slice(0, 2)
  };
}

function compactOffseason(o) {
  if (!o) return null;
  const mult = o.opportunity_multiplier ?? 1;
  const drivers = o.drivers ?? [];
  // A neutral read (x1.00, no drivers) is the model saying nothing — attaching
  // it would only be noise on every card.
  if (!drivers.length && Math.abs(mult - 1) < 0.005) return null;
  return {
    opportunity_multiplier: +mult.toFixed(2),
    ppg_multiplier: o.ppg_multiplier != null ? +o.ppg_multiplier.toFixed(2) : null,
    confidence: o.confidence ?? null,
    drivers: drivers.slice(0, 3),
    direction: mult > 1.005 ? 'upside' : mult < 0.995 ? 'risk' : 'neutral',
    applied_to_value: false
  };
}

/**
 * The compact evidence object for one player: `{ career?, preseason?, offseason? }`
 * with a key only when that layer had something to say.
 */
export function playerEvidence(playerId, season = SEASON) {
  if (playerId == null) return {};
  const key = `${playerId}:${season}`;
  const hit = evidenceCache.get(key);
  if (hit) return hit;
  const out = {};
  let career = null, preseason = null, offseason = null;
  // A source that THREW and a source that correctly reported nothing both leave
  // the field absent, and downstream that difference matters: "no career line
  // for this player" is a fact about the player, "the career query failed" is a
  // fact about us. Collapsing them let a broken layer describe a five-year
  // starter as having no NFL record (playerRiskProfile -> describeProfile).
  // Which layers failed is recorded; the fields stay absent either way, so
  // pricing degrades exactly as before.
  const unreadable = [];
  try { career = compactCareer(evidenceSources.careerLine?.(playerId, { season })); } catch { unreadable.push('career'); }
  try { preseason = compactPreseason(evidenceSources.preseasonProjection?.(playerId, season)); } catch { unreadable.push('preseason'); }
  try { offseason = compactOffseason(evidenceSources.offseasonAdjustment?.(playerId, season)); } catch { unreadable.push('offseason'); }
  if (career) out.career = career;
  if (preseason) out.preseason = preseason;
  if (offseason) out.offseason = offseason;
  if (unreadable.length) out.evidence_unreadable = unreadable;
  if (evidenceCache.size > 5000) evidenceCache.clear();
  evidenceCache.set(key, out);
  return out;
}

/* ---------------------------------------------------------- floor / risk */

/**
 * One player's volatility read, from the evidence already on him. Profiles:
 *   proven floor — 3+ top-24 seasons and a year-to-year swing of 25% or less
 *   steady       — 2+ top-24 seasons, swing under 35%
 *   spike        — exactly one season on record that landed top-24
 *   volatile     — swing over 35%, or a single sub-top-24 season
 *   unproven     — no NFL season on record (rookie, or unlinked)
 *   unknown      — the career layer could not be read, so none of the above can
 *                  be said; distinct from `unproven`, which is a finding
 * `band_pct` is this season's p20-p80 width as a share of the median.
 */
export function playerRiskProfile(p) {
  const c = p.career?.consistency;
  const seasons = c?.seasons_counted ?? p.career?.seasons_on_record ?? p.career?.seasons?.length ?? 0;
  const top24 = c?.seasons_top24 ?? 0, top12 = c?.seasons_top12 ?? 0;
  const cv = c?.cv_points ?? null;
  const pre = p.preseason;
  const bandPct = pre?.points && pre.p20 != null && pre.p80 != null
    ? Math.round(((pre.p80 - pre.p20) / pre.points) * 100) : null;
  let profile;
  // Unreadable outranks unproven: with no career line to read, "he has never
  // done it" is a claim we cannot make. See playerEvidence().
  if (p.evidence_unreadable?.includes('career')) profile = 'unknown';
  else if (!seasons) profile = 'unproven';
  else if (seasons === 1) profile = top24 >= 1 ? 'spike' : 'volatile';
  else if (top24 >= 3 && (cv == null || cv <= 0.25)) profile = 'proven floor';
  else if (top24 >= 2 && (cv == null || cv <= 0.35)) profile = 'steady';
  else profile = 'volatile';
  return {
    id: p.id, name: p.name, value: p.value ?? 0,
    seasons, top24, top12,
    min_games: c?.min_games ?? null,
    swing_pct: cv != null ? Math.round(cv * 100) : null,
    band_pct: bandPct,
    points: pre?.points ?? null, p20: pre?.p20 ?? null, p80: pre?.p80 ?? null,
    profile
  };
}

const describeProfile = r => {
  if (!r) return null;
  if (r.profile === 'unknown') return 'a player whose record could not be read';
  if (r.profile === 'unproven') return 'a player with no NFL record';
  if (r.profile === 'spike') return 'a 1-season spike';
  if (r.top12 === r.seasons && r.seasons >= 2) return `a ${r.seasons}-year top-12 floor`;
  if (r.profile === 'proven floor') return `a ${r.top24}-of-${r.seasons} top-24 floor`;
  if (r.profile === 'steady') return `a ${r.top24}-of-${r.seasons} top-24 record`;
  return `a ±${r.swing_pct ?? '?'}% swing over ${r.seasons} seasons`;
};

/**
 * The floor/ceiling/consistency read for one package of players.
 *
 * `unreadable` counts the players whose career layer could not be read. It
 * matters beyond the headline: the sums below are taken over `withRecord`
 * (`seasons > 0`), which drops an unknown player silently, so without this
 * count a two-player package with one unreadable record reports the readable
 * player's seasons as if they were the whole package. Every line built from
 * these sums states the shortfall instead (see packageNumbers).
 */
export function packageRisk(players) {
  const profiles = (players ?? []).map(playerRiskProfile);
  const withRecord = profiles.filter(x => x.seasons > 0);
  const withSwing = withRecord.filter(x => x.swing_pct != null);
  const withBand = profiles.filter(x => x.p20 != null && x.p80 != null);
  const avg = (list, key) => list.length ? Math.round(list.reduce((s, x) => s + x[key], 0) / list.length) : null;
  const sum = (list, key) => list.length ? +list.reduce((s, x) => s + x[key], 0).toFixed(1) : null;
  const headline = profiles.slice().sort((a, b) => b.value - a.value)[0] ?? null;
  return {
    players: profiles,
    seasons: withRecord.reduce((s, x) => s + x.seasons, 0),
    top24_seasons: withRecord.reduce((s, x) => s + x.top24, 0),
    top12_seasons: withRecord.reduce((s, x) => s + x.top12, 0),
    min_games: withRecord.some(x => x.min_games != null) ? Math.min(...withRecord.filter(x => x.min_games != null).map(x => x.min_games)) : null,
    swing_pct: avg(withSwing, 'swing_pct'),
    band_pct: avg(withBand, 'band_pct'),
    points: sum(withBand, 'points'), p20: sum(withBand, 'p20'), p80: sum(withBand, 'p80'),
    headline_profile: headline?.profile ?? null,
    headline_read: describeProfile(headline),
    unreadable: profiles.filter(x => x.profile === 'unknown').length
  };
}

/** Numbers only — the evidence line under a verdict. */
function packageNumbers(r) {
  if (!r) return null;
  const bits = [];
  // With an unreadable record in the package the season sums cover only part of
  // it, so the line says how many players it could not read rather than
  // presenting a partial count as the whole (packageRisk's `unreadable`).
  if (r.seasons && r.unreadable) {
    bits.push(`${r.top24_seasons}/${r.seasons} top-24 seasons for ${r.players.length - r.unreadable} of ${r.players.length}` +
      `, ${r.unreadable} record${r.unreadable === 1 ? '' : 's'} could not be read`);
  } else if (r.seasons) bits.push(`${r.top24_seasons}/${r.seasons} top-24 seasons`);
  else if (r.unreadable) bits.push(`${r.unreadable} record${r.unreadable === 1 ? '' : 's'} could not be read`);
  else bits.push('0 seasons on record');
  if (r.swing_pct != null) bits.push(`±${r.swing_pct}% swing`);
  if (r.min_games != null) bits.push(`${r.min_games} g min`);
  if (r.p20 != null) bits.push(`${SEASON} band ${Math.round(r.p20)}-${Math.round(r.p80)}`);
  return bits.join(', ');
}

/**
 * Both packages' risk reads for one side plus a one-line read — "you are
 * trading a 5-year top-12 floor for a 1-season spike".
 */
function sideRisk(gives, gets) {
  const out = packageRisk(gives), inn = packageRisk(gets);
  const read = out.headline_read && inn.headline_read
    ? `trading ${out.headline_read} for ${inn.headline_read}`
    : null;
  return { out, in: inn, read };
}

function verdictEvidence(risk) {
  if (!risk) return null;
  const give = risk.out.players.length ? `give: ${packageNumbers(risk.out)}` : null;
  const get = risk.in.players.length ? `get: ${packageNumbers(risk.in)}` : null;
  const line = [give, get].filter(Boolean).join(' · ');
  return line || null;
}

/* ------------------------------------------------------------- evaluation */

/**
 * Define `key` on `obj` as an enumerable field whose value is computed on first
 * read and then stored as a plain data property. JSON.stringify, object spread and
 * ordinary reads all see a normal field; assigning to it simply replaces it.
 */
function lazyField(obj, key, compute) {
  const settle = (target, value) => Object.defineProperty(target, key,
    { value, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(obj, key, {
    enumerable: true, configurable: true,
    get() { const value = compute(); settle(this, value); return value; },
    set(value) { settle(this, value); }
  });
}

const verdictFor = (ppgDelta, valueDelta) => {
  if (ppgDelta >= 2.5) return 'clear win';
  if (ppgDelta >= 0.8) return 'win';
  if (ppgDelta > -0.8) return valueDelta > 0 ? 'even (value edge)' : 'even';
  if (ppgDelta > -2.5) return 'loss';
  return 'clear loss';
};

/**
 * Score one concrete package from both sides.
 *
 * @param a {{team, gives: asset[]}}  @param b {{team, gives: asset[]}}
 * @param ctx {{theirNeeds?: Set<string>, theirWindow?: object}} real roster context
 *   for team b, from rosterContext() — lets the plausibility check see whether this
 *   package actually makes sense for them, not just whether the numbers pencil out.
 */
export function evaluate(a, b, slots, ctx = {}) {
  // A team's lineups BEFORE the deal do not depend on the deal, and the trade
  // search evaluates thousands of packages against the same two rosters. Callers
  // that loop (findTrades, offerFor, offerForMany) pass one `memo` per search so
  // each before-lineup is solved once; a one-off call just solves it.
  const solve = (players, key, byeWeek) => bestLineup(
    byeWeek == null ? players : players.filter(p => p.playoff_bye_week !== byeWeek), slots, key);
  const lineupOf = (players, key, byeWeek = null) => {
    if (!ctx.memo) return solve(players, key, byeWeek);
    let byKey = ctx.memo.get(players);
    if (!byKey) ctx.memo.set(players, byKey = new Map());
    const k = `${key}|${byeWeek}`;
    if (!byKey.has(k)) byKey.set(k, solve(players, key, byeWeek));
    return byKey.get(k);
  };
  // WHEN points land, for horizonGain(): the best lineup in each of this league's
  // remaining playoff weeks, averaged, on the weekly rate (ros_ppg). Anyone on bye in
  // a given playoff week is left out of THAT week's lineup, so a playoff-week bye
  // costs one week of his value minus whoever replaces him — not his whole rate
  // times the share of weeks he plays, which is what one lineup solved on
  // playoff_ppg charged. Weeks with no bye on the roster share one solve. No
  // opponent adjustment: none is validated (matchups.js). null when the players
  // carry no ros_ppg (partial fixtures), so horizonGain() falls back to "now".
  const playoffLeg = (players, memoize) => {
    if (!players.some(p => p.ros_ppg != null)) return null;
    const get = (byeWeek = null) => (memoize ? lineupOf(players, 'ros_ppg', byeWeek) : solve(players, 'ros_ppg', byeWeek)).points;
    const weeks = Math.max(0, ...players.map(p => p.playoff_weeks_left ?? 0));
    const byeWeeks = [...new Set(players.map(p => p.playoff_bye_week).filter(w => w != null))];
    if (!weeks || !byeWeeks.length) return get();
    return ((weeks - byeWeeks.length) * get() + byeWeeks.reduce((sum, w) => sum + get(w), 0)) / weeks;
  };
  const side = (team, gives, gets) => {
    const after = team.players.filter(p => !gives.some(g => g.id === p.id)).concat(gets);
    const before = lineupOf(team.players, 'adj_ppg');
    const post = bestLineup(after, slots);
    const bMonth = playoffLeg(team.players, true);
    const pMonth = playoffLeg(after, false);
    const valueOut = gives.reduce((s, p) => s + Math.max(0, p.value), 0);
    const valueIn = gets.reduce((s, p) => s + Math.max(0, p.value), 0);
    const givesOut = gives.map(slim), getsIn = gets.map(slim);

    const out = {
      roster_id: team.roster_id, owner: team.owner,
      gives: givesOut, gets: getsIn,
      // Floor/ceiling/consistency of what leaves vs what arrives, from each
      // player's multi-season record and this season's band — explanation
      // alongside the verdict, never an input to it.
      risk: sideRisk(givesOut, getsIn),
      lineup_before: before.points, lineup_after: post.points,
      ppg_delta: +(post.points - before.points).toFixed(2),
      // The lineup change in THIS league's playoff weeks (playoffLeg above: the
      // weekly-rate lineup of each playoff week, byes out, averaged). No opponent
      // adjustment, so this differs from ppg_delta only by WHEN points land: adj_ppg
      // carries 25% of this week (its injuries, its byes), this carries playoff-week
      // byes. It is horizonGain()'s playoff leg, not a display number: it is not on
      // adj_ppg's scale (adj_ppg's this-week share is discounted by availability, the
      // weekly rate is not), which is why the two baselines below travel with it and
      // horizonGain() compares each delta to its own baseline.
      playoff_ppg_delta: bMonth != null && pMonth != null ? +(pMonth - bMonth).toFixed(2) : null,
      playoff_lineup_before: bMonth != null ? +bMonth.toFixed(2) : null,
      playoff_lineup_after: pMonth != null ? +pMonth.toFixed(2) : null,
      value_out: valueOut, value_in: valueIn, value_delta: valueIn - valueOut,
      roster_spots: gets.length - gives.length,
      new_holes: post.holes,
      verdict: verdictFor(post.points - before.points, valueIn - valueOut)
    };
    // floor_delta / ceiling_delta: the change in the starting lineup's weekly p10 /
    // p90 TOTAL (lineupSpread). Computed the first time the field is read — a JSON
    // response, a prompt, a caller — and then fixed on the object. The trade search
    // builds thousands of these and returns a few dozen; only those are ever read,
    // so only those pay for the players' weekly draws.
    // The spread is THIS week's, so it is taken over this week's lineup: a starter on
    // bye is swapped for whoever would really play (weekLineup), not kept in the slot
    // at 0. The verdict above stays on the season lineups. No one on bye = same
    // lineups, no extra solve.
    let spreads = null;
    const weekOf = (line, players) => players.some(p => p.bye_this_week) ? weekLineup(players, slots) : line;
    const spreadDelta = which => {
      spreads ??= { before: lineupSpread(weekOf(before, team.players)), after: lineupSpread(weekOf(post, after)) };
      const x = spreads.before[which], y = spreads.after[which];
      return x != null && y != null ? +(y - x).toFixed(1) : null;
    };
    lazyField(out, 'floor_delta', () => spreadDelta('floor'));
    lazyField(out, 'ceiling_delta', () => spreadDelta('ceiling'));
    // Next to value_delta: the same deal in lineup points with the roster spot
    // charged (lineupValue below). Lazy like floor_delta, so the search pays for it
    // only on the deals it returns; null when the caller supplied no wire.
    lazyField(out, 'lineup_value', () => ctx.lineupValue
      ? lineupValue(team, gives, gets, slots, ctx.lineupValue) : null);
    // The lineup change over the season, from ONE producer (lineupSpan) shared with
    // lineup_value.total, so on a deal where no roster spot changes hands the two are
    // equal. With the league's weeks left (the caller passed lineupValueContext) it is
    // this week once plus the weekly rate for every week after; without them it stays
    // the old weekly gain x 17 and says so (season_delta_basis), which the explain
    // prompt's fmtSeasonSpan (routes/trades.js) reads.
    const weeksLeft = ctx.lineupValue?.weeksLeft;
    const known = Number.isFinite(weeksLeft);
    lazyField(out, 'season_delta', () => known
      ? lineupSpan(team.players, after, slots, weeksLeft)
      : +((post.points - before.points) * GAMES).toFixed(1));
    out.season_delta_weeks = known ? weeksLeft : GAMES;
    out.season_delta_basis = known ? 'weeks_remaining' : 'full_season_default';
    return out;
  };

  const A = side(a.team, a.gives, b.gives);
  const B = side(b.team, b.gives, a.gives);
  // A deal only gets sent if both sides can tell themselves they won. Joint gain is
  // what makes that possible — it comes from positional scarcity, not from one manager
  // being wrong.
  const joint = +(A.ppg_delta + B.ppg_delta).toFixed(2);
  const theirTotal = B.value_out + B.value_in;
  const theirValuePct = theirTotal ? (B.value_delta / theirTotal) * 100 : 0;
  const bothImprove = A.ppg_delta > 0.15 && B.ppg_delta > 0.15;
  // "Would a real GM take this" is a lower bar than "does the optimal-lineup solver
  // say their projection went up." A team whose tradeable capital is a couple of
  // starters (no scrub depth to sweeten with — exactly the shape of a roster that is
  // stacked at one position and thin at another) will never clear bothImprove, because
  // it has nothing spare to throw in. Real trades routinely go through on fairness
  // alone: a need-for-need swap that is roughly even by market value and doesn't
  // gut the other side's lineup, even if it doesn't strictly improve it. Demanding
  // bothImprove for every suggestion left exactly those teams with zero offers.
  const fairEnough = B.ppg_delta > -1.25 && theirValuePct >= -8;

  // Real roster-fit check: does this package actually make sense for THEM, not just
  // pencil out on lineup points? Pure value/ppg math has no idea a team has zero
  // bench at a position, or that the piece leaving is the one thing holding down a
  // spot they already can't fill — a real GM declines both instantly.
  const redFlags = [];
  const leavesHole = B.new_holes.length > 0;
  if (leavesHole) redFlags.push(`leaves them with no startable ${B.new_holes.join('/')}`);
  const bGivesPos = b.gives.map(p => p.position);
  const aGivesPos = new Set(a.gives.map(p => p.position));
  const hurtsNeed = ctx.theirNeeds
    ? [...new Set(bGivesPos.filter(pos => ctx.theirNeeds.has(pos) && !aGivesPos.has(pos)))]
    : [];
  if (hurtsNeed.length) redFlags.push(`digs into their already-thin ${hurtsNeed.join('/')}`);
  // A need-position piece can still move if it clearly helps their lineup overall
  // (real teams do sell from a weak spot for a bigger upgrade elsewhere) — it's only
  // disqualifying when it ALSO doesn't net them anything, which is exactly the
  // "why would they ever do this" shape a value-only optimizer can't see.
  const brokenForThem = leavesHole || (hurtsNeed.length > 0 && !bothImprove);

  return {
    me: A, them: B, joint_ppg: joint,
    mutual: bothImprove,
    plausible: !brokenForThem && (bothImprove || fairEnough),
    red_flags: redFlags,
    their_window: ctx.theirWindow ?? null,
    their_value_pct: +theirValuePct.toFixed(1),
    fairness: fairnessLabel(A.value_delta, A.value_out + A.value_in),
    // My side's numbers-only evidence line: "give: 5/5 top-24 seasons, ±9%
    // swing, 17 g min · get: 1/1 top-24 seasons, 2026 band 150-290".
    verdict_evidence: verdictEvidence(A.risk)
  };
}

/** Why lineup_value exists and what it may not be used for yet. */
export const LINEUP_VALUE_STATUS = 'not yet validated';
const LINEUP_VALUE_NOTE = 'per_week: the change in the best lineup on adj_ppg (the ppg_delta number) with the '
  + 'roster spot charged. total: lineup points over the weeks left, this week counted once on its own projection '
  + '(byes, injuries) and the weekly rate after. A freed spot '
  + 'is filled by the best free agent on this league\'s wire, a needed spot costs the least-missed player. '
  + 'Not yet validated (gate RL-8-2b pending); no recommendation reads it.';

/**
 * A deal's value to ONE team in lineup points, charging the roster spot.
 *
 * value_delta adds players up as if roster spots were free, so a 2-for-1 always
 * reads better for whoever gets more players. Here the roster size is held at what
 * the team carries today:
 *   - a side that FREES spots fills each one from this league's wire: of the best
 *     free agent at each position, the one that raises the starting lineup most
 *     (the highest-rated if none does);
 *   - a side that NEEDS spots drops, for each, the player whose loss costs the
 *     starting lineup least (ties: the lowest-rated).
 * Then per_week is the change in the best starting lineup (bestLineup, the one
 * solver), and total is lineupSpan() of the same rosters over the weeks left. Key: adj_ppg, the same number ppg_delta is solved
 * on, so with no roster spot changing hands per_week IS ppg_delta and the two
 * differ only by the spot's charge (one producer for the lineup number).
 *
 * @param opts.wire      unrostered priced assets for this league (lineupValueContext)
 * @param opts.weeksLeft regular + playoff weeks remaining, or null (per_week only)
 */
export function lineupValue(team, gives, gets, slots, { wire, weeksLeft = null } = {}) {
  const key = 'adj_ppg';
  const points = list => bestLineup(list, slots, key).points;
  const before = points(team.players);
  let roster = team.players.filter(p => !gives.some(g => g.id === p.id)).concat(gets);
  const spots = gets.length - gives.length;
  const replacement = [], dropped = [];
  const rate = p => p[key] ?? 0;
  const brief = p => ({ id: p.id, name: p.name, position: p.position, [key]: p[key] ?? null });
  for (let i = 0; i < -spots; i++) {
    const held = new Set(roster.map(p => p.id));
    const bestAt = new Map();
    for (const fa of wire ?? []) {
      if (held.has(fa.id) || !SCORED.has(fa.position) || fa.available === false) continue;
      const cur = bestAt.get(fa.position);
      if (!cur || rate(fa) > rate(cur)) bestAt.set(fa.position, fa);
    }
    let pick = null, pickPts = -Infinity;
    for (const fa of bestAt.values()) {
      const pts = points([...roster, fa]);
      if (pts > pickPts || (pts === pickPts && rate(fa) > rate(pick))) { pick = fa; pickPts = pts; }
    }
    if (!pick) break;   // an empty wire: the spot stays empty, and says so below
    roster = [...roster, pick];
    replacement.push(brief(pick));
  }
  for (let i = 0; i < spots; i++) {
    let cut = null, cutPts = -Infinity;
    for (const p of roster) {
      const pts = points(roster.filter(q => q.id !== p.id));
      if (pts > cutPts || (pts === cutPts && rate(p) < rate(cut))) { cut = p; cutPts = pts; }
    }
    if (!cut) break;
    roster = roster.filter(p => p.id !== cut.id);
    dropped.push(brief(cut));
  }
  const perWeek = +(points(roster) - before).toFixed(2);
  const weeks = Number.isFinite(weeksLeft) ? weeksLeft : null;
  return {
    per_week: perWeek,
    weeks,
    // Not per_week x weeks: per_week is on adj_ppg, a blend that is 25% THIS week, so
    // multiplying it would count this week's byes and injuries in every week left.
    total: weeks == null ? null : lineupSpan(team.players, roster, slots, weeks),
    key,
    roster_spots: spots,
    replacement,
    // Spots the wire could not fill (no priced free agent): charged at zero points.
    unfilled_spots: Math.max(0, -spots - replacement.length),
    dropped,
    status: LINEUP_VALUE_STATUS,
    note: LINEUP_VALUE_NOTE,
  };
}

/**
 * The change in a team's best lineup summed over the weeks left, the one producer
 * of "lineup points over the rest of the season" (season_delta and
 * lineup_value.total both come from here).
 *
 * This week is counted ONCE, on current_week_ppg (this Sunday's projection: 0 on a
 * bye, discounted for injury), and each later week on the weekly rate, ros_ppg, the
 * same two legs horizonGain() weighs. A player without either field falls back to
 * adj_ppg (partial fixtures). weeksLeft counts this week (horizonWeights'
 * regular_weeks_left + playoff_weeks_left); 0 or less is a season over: 0 points.
 */
export function lineupSpan(beforePlayers, afterPlayers, slots, weeksLeft) {
  if (!Number.isFinite(weeksLeft)) return null;
  if (weeksLeft <= 0) return 0;
  const leg = (players, field) => bestLineup(players.map(p =>
    ({ ...p, span_leg: p[field] ?? p.adj_ppg ?? 0 })), slots, 'span_leg').points;
  const now = leg(afterPlayers, 'current_week_ppg') - leg(beforePlayers, 'current_week_ppg');
  const rate = weeksLeft > 1 ? leg(afterPlayers, 'ros_ppg') - leg(beforePlayers, 'ros_ppg') : 0;
  return +(now + (weeksLeft - 1) * rate).toFixed(1);
}

/**
 * What lineupValue() needs from a league: its wire (league-wire.js#leagueWire, the
 * Waivers page's producer, less anyone on a loaded roster by id so a Sleeper
 * league or a hypothetical post-trade roster never offers a rostered player) and
 * the weeks left on this league's calendar (trade-horizon.js#horizonWeights).
 */
export function lineupValueContext(lg, assets, teams) {
  const onRoster = new Set(teams.flatMap(t => t.players.map(p => p.id)));
  const wire = leagueWire(lg, assets, espnPlayerResolver(assets)).filter(a => !onRoster.has(a.id));
  const h = horizonWeights(tradeWeekContext().week, { ...leagueSchedule(lg), ...leagueShape(lg) });
  return { wire, weeksLeft: h.regular_weeks_left + h.playoff_weeks_left };
}

const slim = p => ({
  id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
  espn_id: p.espn_id, sleeper_id: p.sleeper_id,
  value: p.value, proj: p.proj, ppg: p.ppg, adj_ppg: p.adj_ppg,
  age: p.age, bye: p.bye, injury: p.injury, available: p.available !== false,
  floor: p.floor, ceiling: p.ceiling, consistency: p.consistency,
  // sos / playoff_sos are left off: 1 with no validated signal behind them
  // (matchups.js), and a card or prompt that shows them invites reading a schedule.
  current_week_ppg: p.current_week_ppg, bye_this_week: p.bye_this_week === true, ros_ppg: p.ros_ppg, fantasy_coordinator: p.fantasy_coordinator,
  active_probability: p.active_probability, injury_status: p.injury_status,
  practice_status: p.practice_status, model_cutoff: p.model_cutoff,
  role_change: p.role_change, matchup: p.matchup,
  // career / preseason / offseason — each present only when its layer has
  // something to say (see playerEvidence()).
  ...playerEvidence(p.id)
});

/**
 * Label the *shape* of a deal, not just its grade — "clears the bar" and "why
 * you'd actually make this one" are different questions, and a flat list of
 * fifteen lineup-gain numbers reads as one repetitive idea even when it isn't.
 * Every input here is already computed for the card; this just names the
 * pattern instead of making the manager infer it from raw numbers.
 */
export function tagDeal(give, get, ev) {
  const tags = [];
  const avg = (list, key, fallback) => list.length
    ? list.reduce((s, p) => s + (p[key] ?? fallback), 0) / list.length : fallback;
  const youngest = list => Math.min(...list.map(p => p.age ?? 99));
  const oldest = list => Math.max(...list.map(p => p.age ?? 0));

  if (give.length + get.length >= 4) tags.push('Blockbuster');
  // 'Playoff Push' claims the deal buys an easier weeks-15-17 schedule. No schedule-
  // strength signal has passed the weekly walk-forward test (matchups.js: home field
  // and DvP both failed on 2025), so while matchupSignalActive() is false the tag
  // cannot fire — playoff_sos is exactly 1 and any gap would be noise. If a signal
  // ever passes, playoff_sos is a points MULTIPLIER (higher = easier stretch; the
  // opposite polarity of edge.js's unrelated field of the same name), and the 0.05
  // threshold is unfitted and must be re-derived on that signal.
  if (matchupSignalActive() && avg(get, 'playoff_sos', 1) > avg(give, 'playoff_sos', 1) + 0.05) tags.push('Playoff Push');
  if (youngest(get) <= 24 && oldest(give) >= youngest(get) + 3) tags.push('Youth Play');
  // An age rule, not a hype reading: it says we send the older player. It was labelled
  // 'Sell High', which claimed a market-price read; the one hype producer is
  // services/hype.js#playerHype (S-19), so the tag now says only what it measures.
  if (oldest(give) >= 29 && youngest(get) < oldest(give)) tags.push('Sell the Veteran');
  // role_change is detectRoleChange()'s object (role-changepoint.js), set only on a
  // confirmed usage shift. Its status carries the DIRECTION: reading truthiness
  // labelled players losing usage 'Buy Low' (RL-15-3). A rising role is named for
  // what it measures (usage up, not a market-price read); a shrinking role is a
  // caution and goes first so the two-tag cap can never hide it.
  const roleStatus = status => get.some(p => p.role_change?.status === status);
  const shrinking = roleStatus('confirmed_role_decrease');
  if (roleStatus('confirmed_role_increase')) tags.push('Role Rising');
  if (give.some(p => p.injury) && !get.some(p => p.injury)) tags.push('Sell the Injury Risk');
  if (Math.abs(ev.their_value_pct) <= 4 && ev.me.ppg_delta > 0.4) tags.push('Fair & Clean');
  else if (ev.their_value_pct < -6 && ev.me.ppg_delta > 0.6) tags.push('Value Win');
  if (shrinking) tags.unshift('Role Shrinking');
  if (!tags.length) tags.push('Straight Upgrade');
  return tags.slice(0, 2);
}

function fairnessLabel(delta, total) {
  if (!total) return 'unpriced';
  const pct = (delta / total) * 100;
  if (pct > 12) return 'lopsided my way';
  if (pct > 4) return 'slightly my way';
  if (pct > -4) return 'even money';
  if (pct > -12) return 'slightly their way';
  return 'lopsided their way';
}

/* ------------------------------------------------------------ trade search */

/** All subsets of `list` with size 1..max, capped so the search stays bounded. */
function combos(list, max) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length) out.push(acc.slice());
    if (acc.length === max) return;
    for (let i = start; i < list.length; i++) { acc.push(list[i]); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);
  return out;
}

/**
 * Tradeable candidates from a roster: the players a manager would actually consider
 * moving. Anyone startable is included (that's most of a trade's substance), but
 * we cut the deep bench, which nobody trades for and which explodes the search space.
 */
function candidates(team, slots, limit = 11, excludeIds = null) {
  const line = bestLineup(team.players, slots);
  const startersById = new Set(line.slots.map(s => s.player?.id).filter(Boolean));
  return team.players
    .filter(p => SCORED.has(p.position) && (p.value > 0 || p.proj > 0))
    // Untouchables never enter the search at all — not "ranked low," genuinely absent,
    // so they can never appear as a give in any suggestion.
    .filter(p => !excludeIds || !excludeIds.has(p.id))
    .map(p => ({ ...p, is_starter: startersById.has(p.id) }))
    .sort((a, b) => b.value - a.value || b.adj_ppg - a.adj_ppg)
    .slice(0, limit);
}

/* --------------------------------------------- shared inputs, one definition */

/**
 * GATE (scratchpad/wa/trade-engine-correctness/GATE.md, G1), written before this
 * code: the odds that enter the ranking must be the simulator's answer for THIS
 * roster, must be identical between calls and between processes (so they cannot
 * drift into the cache key), must fall back to the documented 0.5 prior with a
 * stated reason when the simulator cannot run, and must cost <= 6 s cold and
 * <= 50 ms warm.
 *
 * Why it matters: `horizonWeights` splits a deal's value between "now" and the
 * playoff weeks, and the split is driven by P(make playoffs). Nothing ever passed
 * it, so every deal in every league was weighted on the 0.5 prior. Measured on
 * production, 2026 week 2, the shipped numbers are 0.69 / 0.58 / 0.26 / 0.31 / 0.87 —
 * league 3 was being told its December roster matters about twice as much as it
 * does, and league 5 about half as much.
 *
 * Seeded on purpose. The sim is Monte Carlo; an unseeded run would hand the
 * cache a new key every time and turn a cached search into an uncached one.
 */
const HORIZON_SIM_SEED = 20260918;
const HORIZON_SIM_RUNS = 1000;

/** The asset universe's own fingerprint. ~24 ms on production, so it is computed
 *  once per entry-point call and handed to everything that keys on it. */
const assetPrint = (lg, formatKey, target) =>
  fingerprint(ASSET_INPUT_TABLES, assetInputsKey(lg, formatKey, target));

export function myPlayoffOdds(lg, myTeamId = null, print = null) {
  const rosterId = String(myTeamId ?? lg?.my_team_id ?? '');
  const prior = reason => ({ value: null, roster_id: rosterId, source: `0.5 prior — ${reason}` });
  if (!lg?.payload) return prior('this league is not synced yet');
  const target = tradeWeekContext();
  // The sim's start week comes from the one producer (simStartWeek: the league's
  // own week, week 1 for last season's payload) — the same week /simulate uses —
  // not the NFL game_lines week, which runs ahead of the league between Monday
  // night and the next sync (B-01 review). target stays for the asset print only.
  const start = simStartWeek(lg);
  const { formatKey } = deriveFormat(lg);
  return cached(
    `playoffOdds:${lg.id}:${rosterId}:${target.season}:${start}`,
    print ?? assetPrint(lg, formatKey, target),
    () => {
      // A returned `error` is a NAMED state (no fixtures left, an unsynced
      // schedule) and falls back. Anything thrown is a real defect and is left to
      // throw — a silent 0.5 would hide it, which is how this number got lost in
      // the first place.
      const sim = withRandomSeed(HORIZON_SIM_SEED, () => simulateSeason(lg, {
        runs: HORIZON_SIM_RUNS, scoring: scoringFor(lg) // start week: simStartWeek(lg) inside, same as `start`
      }));
      if (sim?.error) return prior(`the season simulation could not run (${sim.error})`);
      const mine = sim.teams?.find(t => String(t.roster_id) === rosterId);
      if (!Number.isFinite(mine?.playoff_odds)) return prior('your roster is not in this league\'s simulated standings');
      return {
        value: +mine.playoff_odds.toFixed(2),
        roster_id: rosterId,
        interval: mine.playoff_odds_95 ?? null,
        source: `season simulation, ${sim.runs} runs from week ${sim.from_week}`,
      };
    });
}

/** Resolve the odds the horizon is built on: caller's number, else the sim, else the prior. */
function horizonOdds(lg, myTeamId, supplied, print = null) {
  if (Number.isFinite(supplied)) return { value: supplied, source: 'supplied by the caller' };
  const measured = myPlayoffOdds(lg, myTeamId, print);
  return measured.value == null
    ? { value: 0.5, source: measured.source, measured: null }
    : { value: measured.value, source: measured.source, interval: measured.interval ?? null };
}

/**
 * The hand-set "hard to trade with" discount, applied in exactly ONE place.
 *
 * It used to be applied here AND inside counterparty-pricing's receptiveness,
 * which discounted a hard manager to 0.55 x 0.55 = 0.30 (inventory section C).
 * counterparty-pricing now only REPORTS the tier; this is the only multiplier.
 */
export const HARD_TIER_FACTOR = 0.55;
const tierFactor = tier => (tier === 'hard' ? HARD_TIER_FACTOR : 1);

/**
 * How the package lands with HIM, bounded to +-10% of the score.
 *
 * Driven by `perception_shift`, NOT `perception_delta`. The delta is how much
 * better the incoming package looks to him than the one he gives up — but most
 * of that is just our own value gap, which the capped fairness term and the
 * value cost already charge for. Multiplying by it as well paid a second time for
 * handing him value. The shift is the part his views add BEYOND our gap, which is
 * the tie-breaker this factor was written to be: a handful of texts breaks a tie
 * between comparable deals and never promotes a deal that is bad for us.
 */
export function perceptionFactorFor(counterparty) {
  const shift = counterparty?.perception_shift;
  if (!Number.isFinite(shift)) return 1;
  return 1 + Math.max(-0.10, Math.min(0.10, shift / 100));
}

/**
 * The block every trade-idea shape carries, so Trade Lab, the Coach, the
 * dashboard and the plan can never quote numbers built on different assumptions.
 * Cheap: everything in it was already computed by the caller.
 */
function ideaContext(lg, { me, assets, odds, horizon, counterparties, useCounterparty, week }) {
  return {
    league_id: lg.id,
    my_roster_id: me?.roster_id ?? String(lg.my_team_id ?? ''),
    season: week.season,
    week: week.week,
    playoff_odds: horizon.playoff_odds,
    playoff_odds_source: odds.source,
    playoff_odds_interval: odds.interval ?? null,
    horizon: { now: horizon.now, playoff: horizon.playoff,
      playoff_weeks: horizon.playoff_weeks_label, note: horizonNote(horizon, { playoff_tilt: 0 }) },
    counterparty_available: useCounterparty && counterparties.size > 0,
    counterparty_managers: counterparties.size,
    availability_basis: assets?.context?.availability_basis ?? null,
  };
}

/**
 * Search the league for deals worth sending.
 *
 * Cached the same way assetUniverse() already is — this combinatorial search
 * (every give/get combo against every other team) measured 5-24 real seconds
 * depending on package size, on real data, which is not "instant" by any
 * definition. A hypothetical post-trade roster (teamsOverride/assetsOverride,
 * used by findTradeSequences) is never cached: it exists to answer "what if,"
 * not to be looked up again.
 *
 * @param opts.max_per_side  package size cap (2 keeps it realistic and fast)
 * @param opts.require_mutual only surface deals that also improve their lineup
 */
/**
 * The week and format every key below is built on. Derived ONCE per entry-point
 * call: `deriveFormat` measured 13 ms on production data, and the warm path used
 * to pay it three times over.
 */
const ideaCtx = (lg, ctx = null) => (ctx?.target && ctx?.formatKey ? ctx
  : { target: tradeWeekContext(), formatKey: deriveFormat(lg).formatKey, print: ctx?.print ?? null });

function findTradesKey(lg, opts = {}, ctx = null) {
  const { myTeamId, maxPerSide = 2, requireMutual = true, limit = 25, targetId = null,
    excludeIds = null, counterparty: useCounterparty = true, playoffOdds, zero = [] } = opts;
  const { target, formatKey } = ideaCtx(lg, ctx);
  const excludeKey = excludeIds ? [...excludeIds].sort((a, b) => a - b).join(',') : '';
  // `zero` suppresses named valuation-map sources. It is in the KEY because the
  // ablation has to be a real re-run of this search: the previous step's
  // ablation re-scored an already-surfaced list, which cannot see an idea
  // appear or disappear and reported a "no set change" that was not true.
  const zeroKey = [...zero].sort().join(',');
  // RL-19-3: flipping the title-mutual flag (or preview mode) is a different answer.
  const tm = titleMutualMode();
  return `findTrades:${lg.id}:${formatKey}:${target.season}:${target.week}:` +
    `${myTeamId ?? lg.my_team_id}:${maxPerSide}:${requireMutual}:${limit}:${targetId ?? ''}:` +
    `${excludeKey}:cp${useCounterparty ? 1 : 0}:po${playoffOdds ?? 'd'}:z${zeroKey}:` +
    `tm${tm.on ? (tm.preview ? 'p' : 1) : 0}`;
}

/**
 * GATE (G2): every input the ranking reads must be in here, including the ones a
 * row count cannot see. The counterparty tables were not: rebuilding
 * `manager_signals`, confirming an identity, flipping a manager's tier in place
 * or rebuilding the negotiation profiles all left the cache serving the old
 * ranking (inventory section C, "stale cache after a signals rebuild"). They are
 * covered by `counterpartyDataKey`, which stamps signals, player views,
 * identities, hand-set tiers, the chat corpus and the negotiation profiles for
 * this league in one string.
 *
 * Exported so a test can assert the fingerprint moves without having to guess at
 * cache internals.
 */
export function tradeIdeasFingerprint(lg, opts = {}, ctx = null) {
  const resolved = ideaCtx(lg, ctx);
  // Everything the universe reads (the rosters come from leagues.payload, too)...
  const assets = resolved.print ?? assetPrint(lg, resolved.formatKey, resolved.target);
  // ...plus, not part of assetUniverse's own fingerprint: a manager marked "never
  // trade" or "hard" changes findTrades' own filtering directly. Stamped on
  // updated_at, because editing a tier in place changes no row count.
  const profiles = fingerprint([{ table: 'manager_profiles', stamp: 'updated_at' }]);
  return `${assets}|${profiles}|${findTradesKey(lg, opts, resolved)}|${counterpartyDataKey(lg.id)}`;
}

export function findTrades(lg, opts = {}) {
  if (opts.teamsOverride || opts.assetsOverride) return findTradesUncached(lg, opts);
  // Playoff odds for MY team, resolved BEFORE the key so two searches with
  // different odds can never share a cache entry. Without them the horizon used
  // an uninformative 0.5 prior, which is the right default and a poor answer for
  // a team plainly out of it — a seller's December roster does not matter, and
  // the objective should collapse back to "what helps me now".
  const ctx = ideaCtx(lg);
  ctx.print = assetPrint(lg, ctx.formatKey, ctx.target);
  const odds = horizonOdds(lg, opts.myTeamId, opts.playoffOdds, ctx.print);
  const resolved = { ...opts, playoffOdds: odds.value, playoffOddsSource: odds.source,
    playoffOddsInterval: odds.interval ?? null };
  const key = findTradesKey(lg, resolved, ctx);
  return cached(key, tradeIdeasFingerprint(lg, resolved, ctx), () => findTradesUncached(lg, resolved));
}

function findTradesUncached(lg, {
  myTeamId, maxPerSide = 2, requireMutual = true, limit = 25, targetId = null, excludeIds = null,
  // Lets findTradeSequences() re-run this exact search against a hypothetical
  // post-trade roster without duplicating any of the logic below.
  teamsOverride = null, assetsOverride = null, playoffOdds, playoffOddsSource = null,
  playoffOddsInterval = null,
  // Named valuation-map sources to suppress, for the per-source ablation. The
  // list is part of the cache key, so two arms can never share an answer.
  zero = [],
  // Off only so the harness can measure what the counterparty layer is worth.
  // Production always wants it on: ranking by what we think a deal is worth,
  // with no model of whether anyone would accept it, is how the engine spent
  // its life suggesting trades nobody took.
  counterparty: useCounterparty = true
} = {}) {
  const startedAt = Date.now();
  const { formatKey } = deriveFormat(lg);
  const assets = assetsOverride ?? assetUniverse(lg, formatKey);
  const teams = teamsOverride ?? loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found in this league' };
  const target = targetId ? resolvePlayer(targetId, assets, teams)?.id ?? null : null;
  const context = rosterContext(lg);
  const managerProfiles = new Map(rows(`SELECT roster_id,tradeability FROM manager_profiles WHERE league_id=?`, lg.id)
    .map(profile => [String(profile.roster_id), profile.tradeability]));
  const blockedManagers = new Set([...managerProfiles].filter(([, tier]) => tier === 'never').map(([id]) => id));
  // What we know about the ten people on the other side: how each one talks
  // about trades, what he has said about these specific players, and how he has
  // actually behaved. Loaded once for the whole search; empty maps are the
  // normal case for a league with no chat corpus and cost nothing.
  // NB: `target` in this function is the target PLAYER, not the week context.
  const weekNow = tradeWeekContext();
  // WHEN the points land, not just how many. evaluate()'s playoff_ppg_delta is
  // the lineup change on each player's rate in this league's playoff weeks —
  // byes counted, no opponent adjustment (no schedule-strength signal has passed
  // the weekly harness; matchups.js). It is weighted against the adj_ppg delta by
  // how much of the season remains, how much more a playoff week is worth, and how
  // likely this roster is to still be playing then (trade-horizon.js). What moves a
  // deal between the two legs is timing: this week's number (each player's modelled
  // chance to play — for healthy starters mostly the durability prior, contingency.js —
  // a bye, the game-line correction) against byes in the playoff weeks.
  // findTradeSequences() reaches this function directly (teamsOverride), so the
  // odds are resolved here too rather than only in the cached wrapper — a
  // sequence must be ranked on the same horizon as the deal that opens it.
  const odds = Number.isFinite(playoffOdds) && playoffOddsSource
    ? { value: playoffOdds, source: playoffOddsSource, interval: playoffOddsInterval }
    : horizonOdds(lg, myTeamId, playoffOdds);
  const horizon = horizonWeights(weekNow.week, { playoffOdds: odds.value, ...leagueSchedule(lg), ...leagueShape(lg) });
  // One memo for the whole search: the two rosters' before-lineups are the same for
  // every package against them (see evaluate()).
  const memo = new WeakMap();
  // `rosterContext` is handed through on purpose: without it the layer calls
  // analyzeLeague a second time for the same league, which measured +0.9 s of
  // cold cost per call on production (valuation-map handoff).
  const counterparties = useCounterparty
    ? counterpartyLayer(lg.id, { season: weekNow.season, week: weekNow.week,
      rosterContext: context, zero })
    : new Map();

  const myPool = candidates(me, slots, 11, excludeIds);
  const deals = [];
  // RL-19-3: 1-for-1s the points gates drop, kept aside for the title-odds stage.
  // Only beside the points-mutual class, and never on a hypothetical roster
  // (teamsOverride): the simulator plays the league's real rosters.
  const titleMode = titleMutualMode();
  const titlePool = titleMode.on && requireMutual && !teamsOverride ? [] : null;
  // lineup_value on every returned deal (display only; nothing below ranks on it).
  const lineupCtx = lineupValueContext(lg, assets, teams);

  for (const them of teams) {
    if (them.roster_id === me.roster_id) continue;
    if (blockedManagers.has(String(them.roster_id))) continue;
    const theirCtx = context.get(String(them.roster_id));
    const cp = counterparties.get(String(them.roster_id)) ?? null;
    // Whether "he's untouchable" is a fact or an opening price. For a manager
    // whose declarations have held, the player is removed from the search
    // entirely — asking is the cheapest way to look like you do not read the
    // chat. For one who has walked his refusals back (Raj: 5 of 5; Lars: 5 of 6)
    // removing the player would just be folding to an opening price, so he stays
    // in and the deal is flagged as a real ask instead.
    const offLimits = useCounterparty ? (cp?.stance?.respect ?? new Set()) : new Set();
    const mustProbe = useCounterparty ? (cp?.stance?.probe ?? new Set()) : new Set();
    let theirPool = candidates(them, slots)
      .filter(p => !offLimits.has(String(p.name ?? '').toLowerCase()));
    if (target) {
      // Target mode: every package must contain the player we're after.
      const t = theirPool.find(p => p.id === target);
      if (!t) continue;
      theirPool = [t, ...theirPool.filter(p => p.id !== t.id).slice(0, 5)];
    }

    const mine = combos(myPool, maxPerSide);
    const theirs = combos(theirPool, maxPerSide)
      .filter(c => !target || c.some(p => p.id === target));

    for (const get of theirs) {
      const getValue = get.reduce((s, p) => s + Math.max(0, p.value), 0);
      for (const give of mine) {
        const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
        // Nobody accepts a package worth half of what they send. Prune before the
        // expensive lineup solve — this is what keeps the search sub-second.
        const total = giveValue + getValue;
        if (!total) continue;
        const skew = (giveValue - getValue) / total;
        if (skew < -0.16 || skew > 0.30) continue;

        const ev = evaluate({ team: me, gives: give }, { team: them, gives: get }, slots,
          { theirNeeds: theirCtx?.needs, theirWindow: theirCtx?.window, memo, lineupValue: lineupCtx });
        if (ev.me.ppg_delta < 0.4) {
          // The points gate, unchanged. A 1-for-1 it drops goes to the title-odds
          // stage instead of nowhere (titleCandidate holds the other gates).
          if (titlePool && titleCandidate(give, get, ev)) {
            titlePool.push({ partner: them.owner, partner_id: them.roster_id,
              i_give: give.map(slim), i_get: get.map(slim), tags: tagDeal(give, get, ev), ...ev });
          }
          continue;
        }
        // Never even a "closest fit" fallback candidate — no real GM accepts leaving
        // a starting slot empty, whatever the value math says.
        if (ev.them.new_holes.length > 0) continue;
        if (ev.their_value_pct < -12 || ev.their_value_pct > 18) continue;

        // Remove combinatorial noise: if deleting any one player leaves both
        // lineup deltas effectively unchanged, that player is a decorative
        // throw-in and this is not the cleanest version of the deal.
        const redundant = [
          ...give.map(player => ({ side: 'give', player })),
          ...get.map(player => ({ side: 'get', player }))
        ].some(({ side, player }) => {
          if (target && side === 'get' && player.id === target) return false;
          const leanGive = side === 'give' ? give.filter(x => x.id !== player.id) : give;
          const leanGet = side === 'get' ? get.filter(x => x.id !== player.id) : get;
          if (!leanGive.length || !leanGet.length) return false;
          const lean = evaluate({ team: me, gives: leanGive }, { team: them, gives: leanGet }, slots,
            { theirNeeds: theirCtx?.needs, theirWindow: theirCtx?.window, memo });
          return lean.me.ppg_delta >= ev.me.ppg_delta - 0.05
            && lean.them.ppg_delta >= ev.them.ppg_delta - 0.05;
        });
        if (redundant) continue;
        // Read the deal from his side of the table: what he gives and gets, priced
        // with HIS opinion of those players rather than ours. `receptiveness` is
        // how tradeable this person is at all; `perception_delta` is whether this
        // particular package reads as a win to him.
        const tier = managerProfiles.get(String(them.roster_id)) ?? 'fair';
        const counterparty = cp
          ? { ...readDeal({ theirGive: get, theirGet: give, managerProfile: cp, zero }),
            counterparty_data: true }
          : { receptiveness: 1, perception_delta: null, perception_shift: null, perception_reasons: [],
            chat_msgs: 0, accept_rate: null, counterparty_data: false };
        // ONE place, ONE tier factor (see HARD_TIER_FACTOR). With no counterparty
        // data receptiveness is 1, so a league with no chat corpus ranks exactly as
        // it did before, and the reported receptiveness never silently carries the
        // hand-set tier — which is what made the double discount invisible.
        const managerFactor = counterparty.receptiveness * tierFactor(tier);
        // FAIRNESS, CAPPED — and then paid for.
        //
        // This sigmoid rises monotonically with how much value you hand over:
        // 0.17 when you win on value, 0.60 at even, 0.92 when they get 20% more.
        // It was the engine's ONLY acceptance proxy, so rewarding generosity was
        // the right shape for it. Now that receptiveness and perception model
        // acceptance directly, an uncapped fairness term double-counts it and
        // leaves nothing to stop the engine buying a yes with your assets. Every
        // top suggestion was handing over 1,000-1,800 of market value.
        //
        // Capped just past even: beyond that a deal is already attractive to
        // them and the rest is a donation.
        const fairnessFactor = Math.min(
          1 / (1 + Math.exp(-(Math.min(ev.their_value_pct, 4) + 4) / 10)), 0.60);
        // The lambda term the objective always specified and never had: what
        // surrendering market value costs YOU. Measured against the value you
        // send, so a lopsided swap of two big assets is penalised harder than
        // the same percentage on two bench players.
        //
        // NOT FITTED. It cannot be until enough proposals have been decided to
        // estimate how much acceptance a point of value actually buys; forward
        // capture began 2026-09-17. 0.9 makes giving away 20% of what you send
        // cost about as much as 1.0 point a week of lineup gain — deliberately
        // conservative, so the engine has to argue for a clear weekly win
        // before it parts with assets.
        const valueCost = VALUE_GIVEAWAY_LAMBDA * Math.max(0, ev.their_value_pct) / 20;
        // How the package lands with HIM, bounded to +-10% of the score — on the
        // part of his read that is NOT our own value gap (see perceptionFactorFor).
        const perceptionFactor = perceptionFactorFor(counterparty);
        // Horizon-weighted gain replaces the flat weekly delta.
        const gain = horizonGain({
          ppgDelta: ev.me.ppg_delta,
          playoffPpgDelta: ev.me.playoff_ppg_delta,
          nowBaseline: ev.me.lineup_before,
          playoffBaseline: ev.me.playoff_lineup_before,
          weights: horizon,
        });
        // THE EDGE TEST (trade-tactics.js#edgeTest). The signed objective is
        // computed twice: once as it ships, and once with the counterparty read
        // taken OUT. A deal that is only positive with it is an idea that wins
        // on his perception and loses on ours — a gift, not a trade — and it is
        // removed below rather than ranked. Measured on a copy of production
        // before this went in: league 3's "Tyler Warren for Patrick Mahomes"
        // was -0.046 without the read and +0.013 with it, and surfaced.
        const rawGain = gain.value + 0.2 * ev.joint_ppg;
        const scoreUnperceived = +(managerFactor * fairnessFactor * rawGain - valueCost).toFixed(3);
        const scoreSigned = +(managerFactor * fairnessFactor * perceptionFactor * rawGain
          - valueCost).toFixed(3);
        const edge = edgeTest({ ppgDelta: ev.me.ppg_delta, horizonGain: gain.value,
          scoreSigned, scoreUnperceived });
        deals.push({
          partner: them.owner, partner_id: them.roster_id,
          horizon: { ...horizon, ...gain, note: horizonNote(horizon, gain) },
          i_give: give.map(slim), i_get: get.map(slim),
          tags: tagDeal(give, get, ev),
          ...ev,
          // Lineup gain is the point, but among deals that land the same lineup the
          // one where I surrender less market value is strictly better — without this
          // term the ranking is indifferent to throwing in a free asset.
          manager_tradeability: tier,
          counterparty: {
            ...counterparty,
            // He has called one of these players untouchable, but his word has
            // not held often enough to take it literally. Worth asking, with the
            // expectation that the first answer is no.
            asking_for_declared: get.filter(p => mustProbe.has(String(p.name ?? '').toLowerCase()))
              .map(p => p.name),
            word_stance: cp?.stance?.stance ?? null,
          },
          // The trade-off, surfaced rather than buried in one number.
          value_cost: +valueCost.toFixed(2),
          value_note: ev.their_value_pct > 6
            ? `You send ${ev.their_value_pct.toFixed(0)}% more market value than you get back — justified only by the weekly gain.`
            : ev.their_value_pct < -6
              ? `You get ${Math.abs(ev.their_value_pct).toFixed(0)}% more market value than you send.`
              : 'Roughly even on market value.',
          // The signed objective is what ORDERS deals; `score` is its display form,
          // clamped at zero as before. Clamping before sorting made every net-
          // negative deal tie at exactly 0, so their order was roster-iteration
          // order presented as a ranking. Latent at today's gain magnitudes (min
          // score 8.9 on league 2), but it binds as soon as projections settle.
          score_signed: scoreSigned,
          score: +Math.max(0, scoreSigned).toFixed(3),
          // The same objective with the counterparty read removed, and the
          // four-check verdict built from it. `edge.passes` is what decides
          // whether this deal is allowed to be shown at all.
          score_unperceived: scoreUnperceived,
          edge: { ...edge,
            // Not a failure, but Nick should see it: a deal that is worth more
            // now than it costs in weeks 15-17 is a real win-now trade, and the
            // horizon weighting is the number the plan ranks on.
            playoff_leg: ev.me.playoff_ppg_delta,
            playoff_leg_note: ev.me.playoff_ppg_delta < 0
              ? `Costs ${Math.abs(ev.me.playoff_ppg_delta).toFixed(1)} a week in the playoff weeks; `
                + 'it clears the bar on the horizon-weighted number because this week is worth more.'
              : null },
        });
      }
    }
  }

  deals.sort((a, b) => b.score_signed - a.score_signed);

  // RL-19-3: the title-mutual class. Its pool is the 1-for-1s dropped at the week
  // gate plus the ones that cleared it but not the both-sides gate (not mutual);
  // both are simulated on the same paired-seed tradeImpact as every other
  // title-odds surface. Off: the block says so and nothing else changes.
  const titleMutual = titlePool
    ? titleMutualDeals(lg, [...titlePool, ...deals.filter(d => titleCandidate(d.i_give, d.i_get, d))], {
      myTeamId: me.roster_id, mode: titleMode, sim: { tradeImpact, tradeImpactWorld } })
    : { status: 'off', deals: [] };

  // Found live, on a real league (2026-09): requireMutual=true (both sides'
  // OPTIMAL LINEUP must improve) found 1 partner out of 9 real opponents.
  // Dropping to the deduplicated list unfiltered used to be the only
  // alternative, which included implausible and red-flagged packages nobody
  // would ever accept — not a real second option, just noise. There is a real
  // middle tier already computed by evaluate() and previously discarded here:
  // `plausible` (fair by market value, no red flags, a real GM could reasonably
  // say yes) without also requiring bothImprove. On that same real league, this
  // tier alone found 5 of 9 partners with a genuinely fair, no-red-flag trade —
  // still real, just not a lineup win for both sides specifically.
  //
  // FILTER FIRST, THEN COLLAPSE (GATE G5). It used to be the other way round,
  // and the ordering was a real bug: the dedupe spent an idea's one slot on the
  // highest-scoring VARIANT, which the mutual filter could then reject, hiding a
  // lower-scoring variant of the same idea that both lineups actually liked.
  // Measured case (manager-data-pipeline handoff, league 4): "Deebo Samuel for
  // Jalen Coker" disappeared from the mutual list because the variant that also
  // threw in Juwan Johnson scored higher and was not mutual.
  const passesShape = requireMutual
    ? d => d.mutual && d.plausible && d.red_flags.length === 0
    : d => d.plausible && d.red_flags.length === 0;
  const shaped = deals.filter(passesShape);
  // THE EDGE TEST, applied here and nowhere else. Everything below this line is
  // an idea that is positive for Nick on our own numbers: this week, the
  // horizon-weighted blend, after the market value it costs, and WITHOUT the
  // counterparty read. Before this filter existed the engine surfaced deals
  // with a negative horizon gain, a negative signed score, and one that was
  // positive only because the partner was short at a position.
  const eligible = shaped.filter(d => d.edge.passes);
  const removed = shaped.filter(d => !d.edge.passes);

  // Collapse to distinct *ideas*. Two offers are the same idea when the headline
  // pieces match — keying on the whole package instead just surfaces ten variants of
  // one swap padded with different throwaway bench players. `eligible` is already
  // sorted, so the survivor is the best variant that PASSED.
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const ideaKey = d => `${headline(d.i_give)}>${headline(d.i_get)}`;
  const seen = new Set();
  const result = eligible.filter(d => {
    const k = ideaKey(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // An idea is only LOST when no variant of it survived — a package whose
  // cleaner sibling is still on the list has not been taken away from Nick.
  const survived = new Set(result.map(ideaKey));
  const lostIdeas = [];
  const lostSeen = new Set();
  for (const d of removed) {
    const k = ideaKey(d);
    if (survived.has(k) || lostSeen.has(k)) continue;
    lostSeen.add(k);
    lostIdeas.push(d);
  }

  // Every deal above is computed independently against your CURRENT roster, so
  // two of them can both plan on trading away the same player — real, but only
  // one is actually executable. Rather than silently presenting both as if you
  // could do either, mark the lower-ranked one so the UI can say "pick one."
  const claimed = new Set();
  for (const d of result) {
    const overlap = d.i_give.filter(p => claimed.has(p.id)).map(p => p.name);
    d.conflicts_with_earlier = overlap.length ? overlap : null;
    if (!overlap.length) for (const p of d.i_give) claimed.add(p.id);
  }

  const shown = result.slice(0, limit);
  // The tactics run ONCE, on the list that is actually returned — not on every
  // candidate in the combinatorial search, which would multiply the cost of the
  // inner loop by the price of a valuation lookup for nothing.
  const tacticsStartedAt = Date.now();
  attachTactics(lg, shown, { deals, counterparties, weekNow, assets, teams, zero, ideaKey });
  const tacticsMs = Date.now() - tacticsStartedAt;

  const out = { mode: 'league', me: { roster_id: me.roster_id, owner: me.owner }, slots,
           model_context: assets.context, considered: deals.length,
           excluded_never_trade: [...blockedManagers], deals: shown,
           // RL-19-3: a class of its own, never merged into `deals` (see title-mutual.js).
           title_mutual: titleMutual,
           // Every player on a roster in this league. Exposed because anything
           // checking generated prose for an invented player needs the names
           // that EXIST but are not in the deal — a proposal offering a player
           // from another team in the league is the failure mode, and a universe
           // built from the returned deals alone cannot see it. Built here from
           // the rosters this run already loaded rather than re-derived by the
           // caller, so there is one source for it.
           league_player_names: [...new Set(teams.flatMap(t =>
             (t.players ?? []).map(p => p?.name).filter(Boolean)))],
           // What the edge test took away, and why — reported rather than
           // silently absent, because "the engine found nothing" and "the engine
           // found three things that were not good for you" are different answers.
           edge_removed: lostIdeas.length,
           edge_removed_variants: removed.length,
           // Which check did the removing, over every idea that was removed.
           // "We dropped nine and seven of them only won on his perception" is
           // a different sentence from "we dropped nine", and it is the one
           // that says whether the counterparty read is being used honestly.
           edge_removed_by_check: lostIdeas.reduce((acc, d) => {
             for (const name of d.edge.failed) acc[name] = (acc[name] ?? 0) + 1;
             return acc;
           }, {}),
           edge_removed_examples: lostIdeas.slice(0, 5).map(d => ({
             partner: d.partner, partner_id: d.partner_id,
             i_give: d.i_give.map(p => p.name), i_get: d.i_get.map(p => p.name),
             failed: d.edge.failed,
             numbers: Object.fromEntries(d.edge.checks.map(c => [c.name, c.value])),
           })),
           context: { ...ideaContext(lg, { me, assets, odds, horizon, counterparties, useCounterparty,
             week: weekNow }),
           // Runtime of THIS computation. A cache hit replays the number the
           // cold run measured, which is what it cost to produce this answer.
           runtime_ms: Date.now() - startedAt, tactics_ms: tacticsMs,
           zeroed_sources: [...zero] } };
  // The ideas the edge test took away, for the recommendation ledger's
  // considered-not-shown rows (C-08). Carried on a Symbol key, so the JSON the
  // routes send is byte-for-byte what it was, and a cache hit returns the same
  // object with them still attached. They are NOT written here: this search
  // also runs for /proposals, the post-draft plan, title odds, tradeIdeas and,
  // with teamsOverride, on the made-up post-trade roster of /sequences. Only
  // the /find route writes them (recordRoute('find'), rec-ledger.js), the same
  // route that writes the shown rows, so the control group comes from exactly
  // the searches the shown group comes from. An override search never carries
  // them at all.
  if (!teamsOverride && !assetsOverride) {
    Object.defineProperty(out, LOST_IDEAS, { value: lostIdeas, enumerable: false });
  }
  return out;
}

/**
 * Hang the nine tactics on the ideas that are going out, with the numbers.
 *
 * Every per-player number a tactic quotes comes from the SAME
 * `playerValuation` the valuation map and the trade card use — injected, not
 * re-derived — so a tactic and the card it sits on cannot disagree.
 */
function attachTactics(lg, shown, { deals, counterparties, weekNow, assets, teams, zero, ideaKey }) {
  if (!shown.length) return;
  const byEspn = new Map();
  for (const a of assets.values()) if (a.espn_id != null) byEspn.set(String(a.espn_id), a);
  const valueOfEspn = espnId => byEspn.get(String(espnId))?.value ?? null;

  let timing = new Map();
  let climate = null;
  let self = null;
  try { timing = timingRead(lg.id, { season: weekNow.season }); } catch { timing = new Map(); }
  try { climate = vetoClimate(lg, { season: weekNow.season, priceOfPlayer: valueOfEspn }); }
  catch { climate = null; }
  try { self = selfRead(lg.id, { season: weekNow.season }); }
  catch (err) {
    console.error(`[trade-engine] selfRead lookup failed for league ${lg.id}:`, err);
    // Typed absence, not a silent null: trade-tactics.js's how_nick_looks
    // note reads `self.available === false` and surfaces `self.reason`, so a
    // lookup FAULT is told apart from the genuine "he's never made an offer"
    // empty case instead of reading through as the same healthy sentence.
    self = { league_id: lg.id, available: false, reason: 'self-scout lookup failed' };
  }
  const ownerNames = teams.map(t => t.owner).filter(Boolean);
  // Median points-per-1,000-of-price BY POSITION, over every rostered player in
  // this league. The sneak-in rule needs a baseline that is not cross-position:
  // in a one-QB league a starting quarterback scores like a WR1 at a quarter of
  // the price, so measuring him against the running back he rides along with
  // made every QB in the league look like a steal.
  const rates = new Map();
  for (const t of teams) {
    for (const p of t.players ?? []) {
      const rate = Number(p.ros_ppg ?? p.adj_ppg ?? 0) || 0;
      const price = Math.max(0.25, (Number(p.value) || 0) / 1000);
      if (!p.position || rate <= 0) continue;
      rates.set(p.position, [...(rates.get(p.position) ?? []), rate / price]);
    }
  }
  const positionRate = new Map([...rates].map(([pos, xs]) => {
    const sorted = xs.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return [pos, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2];
  }));

  for (const d of shown) {
    const cp = counterparties.get(String(d.partner_id)) ?? null;
    // The rungs of the ladder are the packages that land EXACTLY THIS RETURN
    // from this partner and passed the edge test. Keyed on the headline piece
    // instead, the ladder's opening ask was a different deal — "open with
    // De'Von Achane" for a return that also included Cam Skattebo, against an
    // idea whose return was D'Andre Swift alone.
    const sameReturn = list => list.map(p => p.id).sort((a, b) => a - b).join(',');
    const returning = sameReturn(d.i_get);
    const variants = deals
      .filter(v => v.partner_id === d.partner_id && v.edge.passes && sameReturn(v.i_get) === returning)
      .map(v => ({ give_value: v.i_give.reduce((s, p) => s + (p.value ?? 0), 0),
        get_value: v.i_get.reduce((s, p) => s + (p.value ?? 0), 0),
        perception_delta: v.counterparty?.perception_delta ?? null,
        their_value_pct: v.their_value_pct, score_signed: v.score_signed,
        i_give: v.i_give.map(p => ({ name: p.name, value: p.value })),
        i_get: v.i_get.map(p => ({ name: p.name, value: p.value })) }));
    const postLoss = (cp?.receptiveness_factors ?? []).find(f => f.source === 'recency_post_loss') ?? null;
    const out = tacticsForDeal({
      give: d.i_give, get: d.i_get, manager: cp, partnerId: d.partner_id, partnerName: d.partner,
      valuationOf: p => playerValuation(cp, p, { zero }),
      self, climate, timing: timing.get(String(d.partner_id)) ?? null,
      theirValuePct: d.their_value_pct, variants, postLoss, positionRate,
      otherManagerNames: ownerNames.filter(n => n !== d.partner),
    });
    d.tactics = out.tactics;
    d.tactics_absent = out.tactics_absent;
    // A stable identity for this idea, so a consumer can cite one and be checked
    // against it. `ideaKey` is the same key the dedupe above already treats as
    // this idea's identity, so two names for one thing cannot drift apart.
    // Without it every idea arrived with `id: undefined` and anything verifying
    // a citation against it — the proposals pass does exactly that — rejected
    // every proposal as untraceable, after paying for it.
    d.id = ideaKey(d);
    // How likely he is to say yes, as a band. Attached HERE, on `shown`, and
    // nowhere earlier: everything in this list has already passed the edge
    // test, so an idea that is a gift never carries an acceptance number at
    // all. The band reads `d.counterparty` — it does not re-price anything,
    // because need fit and the profile roster read are already inside that
    // block's `perception_delta` (see trade-acceptance.js's header).
    //
    // `zero` is deliberately NOT forwarded. The band's own ablation vocabulary
    // (perception_delta / receptiveness / says_no_holds) and VALUATION_SOURCES
    // are disjoint sets, so passing the engine's valuation `zero` array in here
    // could never match anything — it read like a control and was a no-op, which
    // is worse than not offering one.
    //
    // The ablation still reaches this band, through its inputs rather than
    // through this call: `zero` is applied upstream in `counterpartyLayer`
    // (:1522, which is what receptiveness is built from, including the
    // `recency_post_loss` source) and in `readDeal` (:1596, which is what
    // `perception_delta` is built from). Suppress a chat source and both of this
    // band's real inputs move. What the engine cannot suppress is
    // `says_no_holds`, which is read straight off the negotiation profile and
    // has no valuation-source name — stated here rather than implied by a
    // parameter that cannot do it.
    d.acceptance = acceptanceBand({ counterparty: d.counterparty, edge: d.edge,
      profile: cp?.negotiation ?? null });
  }
}

/**
 * THE ONE ENTRY POINT FOR TRADE IDEAS (see the file header).
 *
 * Every consumer — Trade Lab, the Coach, the dashboard, the weekly plan — asks
 * this one function, so they cannot quote different numbers for the same league.
 * It dispatches on what was asked for, never on who is asking:
 *
 *   no targets            -> the ranked league-wide list  ({ mode: 'league' })
 *   targets + shape:'single' -> one full ladder for one player ({ mode: 'target' })
 *   targets               -> a ladder per owner            ({ mode: 'targets' })
 *
 * All three carry the same `context` block: season and week, this roster's real
 * P(make playoffs) and where it came from, the horizon split, whether a
 * counterparty layer was available, and how the chance to play is priced.
 *
 * @param opts.myTeamId      my roster id (defaults to the league's my_team_id)
 * @param opts.targets       player id(s) I want — omit for the league-wide search
 * @param opts.shape         'single' for one player's full ladder
 * @param opts.playoffOdds   override P(make playoffs); measured from the season
 *                           simulation when omitted (never the silent 0.5 prior)
 * @param opts.excludeIds    my untouchables — absent from every package
 */
export function tradeIdeas(lg, opts = {}) {
  const { targets = null, shape = null, ...rest } = opts;
  const list = targets == null ? [] : (Array.isArray(targets) ? targets : [targets]).filter(v => v != null);
  if (!list.length) return findTrades(lg, rest);
  if (shape === 'single') {
    return offerFor(lg, { myTeamId: rest.myTeamId, targetId: list[0],
      excludeIds: rest.excludeIds ?? null, playoffOdds: rest.playoffOdds });
  }
  return offerForMany(lg, { myTeamId: rest.myTeamId, targetIds: list,
    excludeIds: rest.excludeIds ?? null, playoffOdds: rest.playoffOdds });
}

/**
 * "Do this trade, then this one opens up." findTrades() prices every deal
 * against your roster as it is *right now* — it has no way to notice that
 * taking its own #1 suggestion changes what your #2 suggestion should even
 * be. This runs the search twice: once for real, then again against a
 * roster with the top deal already applied, so a genuinely sequential idea
 * (the throw-in you'd only have *after* the first trade, a hole the first
 * trade just opened that a second deal happens to fill) can surface instead
 * of being invisible because it didn't pencil out against the roster you
 * currently have.
 */
export function findTradeSequences(lg, opts = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const first = findTrades(lg, { ...opts, limit: 50, teamsOverride: teams, assetsOverride: assets });
  if (first.error) return first;

  const step1 = first.deals.find(d => d.mutual && d.plausible && !d.conflicts_with_earlier);
  if (!step1) return { ...first, sequences: [] };

  const me = teams.find(t => t.roster_id === first.me.roster_id);
  const partner = teams.find(t => String(t.roster_id) === String(step1.partner_id));
  if (!me || !partner) return { ...first, sequences: [] };

  // Apply step1 to a cloned roster set — everyone else's roster is untouched,
  // so any *new* idea below is attributable to this one trade, not noise.
  const giveIds = new Set(step1.i_give.map(p => p.id));
  const getIds = new Set(step1.i_get.map(p => p.id));
  const hypothetical = teams.map(t => {
    if (t.roster_id === me.roster_id) {
      return { ...t, players: [...t.players.filter(p => !giveIds.has(p.id)), ...partner.players.filter(p => getIds.has(p.id))] };
    }
    if (t.roster_id === partner.roster_id) {
      return { ...t, players: [...t.players.filter(p => !getIds.has(p.id)), ...me.players.filter(p => giveIds.has(p.id))] };
    }
    return t;
  });

  const second = findTrades(lg, { ...opts, limit: 50, teamsOverride: hypothetical, assetsOverride: assets });
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const step1Key = `${step1.partner_id}:${headline(step1.i_give)}>${headline(step1.i_get)}`;
  const firstKeys = new Set(first.deals.map(d => `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`));

  // Only surface a step 2 that (a) wasn't already a standalone idea today, so
  // this list is additive, not a repeat of the main board, and (b) doesn't
  // just re-trade the same two pieces back — that isn't a second move.
  const unlocked = (second.deals ?? [])
    .filter(d => {
      const key = `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`;
      if (key === step1Key || firstKeys.has(key)) return false;
      if (d.i_give.some(p => getIds.has(p.id)) && String(d.partner_id) === String(partner.roster_id)) return false;
      return d.mutual && d.plausible;
    })
    .slice(0, 5);

  return { ...first, step1, sequences: unlocked.map(d => ({ ...d, unlocked_by: step1Key })) };
}

/**
 * Resolve a player id to the row that is actually rostered.
 *
 * A handful of players exist twice: an old seed row with no external ids, plus the
 * row the ESPN sync created. Only the synced row ever matches a roster, so a lookup
 * that lands on the seed row would report a rostered star as a free agent.
 */
export function resolvePlayer(id, assets, teams) {
  const wanted = assets.get(Number(id));
  if (!wanted) return null;
  const owned = new Set(teams.flatMap(t => t.players.map(p => p.id)));
  if (owned.has(wanted.id)) return wanted;
  const twin = [...assets.values()].find(a =>
    a.id !== wanted.id && a.position === wanted.position
    && norm(a.name) === norm(wanted.name) && owned.has(a.id));
  return twin ?? wanted;
}

/* ------------------------------------------------- "what do I offer for X" */

/**
 * GATE (G6): a targeted ladder must read the SAME table as the league-wide
 * search. It did not. `offerFor`/`offerForMany` ranked on the flat weekly delta
 * with no horizon and never opened the counterparty layer, so Trade Lab's "go get
 * him" tab could recommend a package the league list had already priced as a bad
 * idea — two answers to one question (inventory section C, "ignores the chat
 * reads and timing weighting. Inconsistent with findTrades").
 */
function ladderInputs(lg, myTeamId, playoffOdds, useCounterparty = true) {
  const weekNow = tradeWeekContext();
  const odds = horizonOdds(lg, myTeamId, playoffOdds);
  const horizon = horizonWeights(weekNow.week, { playoffOdds: odds.value, ...leagueSchedule(lg), ...leagueShape(lg) });
  const counterparties = useCounterparty
    ? counterpartyLayer(lg.id, { season: weekNow.season, week: weekNow.week })
    : new Map();
  return { weekNow, odds, horizon, counterparties };
}

/** The same horizon-weighted gain findTrades ranks on, for one ladder rung. */
const ladderGain = (ev, horizon) => horizonGain({
  ppgDelta: ev.me.ppg_delta, playoffPpgDelta: ev.me.playoff_ppg_delta,
  nowBaseline: ev.me.lineup_before, playoffBaseline: ev.me.playoff_lineup_before, weights: horizon,
});

/**
 * The free-add ceiling: add the target(s) for nothing and re-solve. If even a
 * gift does not help, no package can, and the honest answer is to say so rather
 * than hunt for one that will never exist.
 *
 * It is measured on the SAME horizon-weighted basis every rung below it is
 * gated on. It used to be a `bestLineup` diff on this week alone while the rung
 * loop had already been moved to `ladderGain`, so the two disagreed: a player
 * who is a real upgrade across the rest of the season but not this Sunday was
 * refused outright with "he would not crack your starting lineup", and the
 * ladder that would have priced him never ran. Live case that found it
 * (verify:trade-engine-correctness): offering for Ja'Marr Chase, 0.00 ppg this
 * week and +0.17 horizon-weighted, came back as a flat refusal.
 *
 * Going through `evaluate()` with an empty give is what keeps them in step —
 * it is the same call the rungs make, so the gate and the ladder cannot drift
 * apart again.
 */
export function freeAddCeiling(me, owner, targets, slots, horizon, ctx = {}) {
  const ev = evaluate({ team: me, gives: [] }, { team: owner, gives: targets }, slots, ctx);
  const gain = ladderGain(ev, horizon);
  return {
    weekly: ev.me.ppg_delta,
    horizon_weighted: gain.value,
    playoff_leg: ev.me.playoff_ppg_delta,
    gain,
  };
}

/** What we know about this owner, independent of any one package. */
function ownerRead(counterparties, owner, tier) {
  const cp = counterparties.get(String(owner.roster_id)) ?? null;
  const receptiveness = cp?.receptiveness ?? 1;
  return {
    counterparty_data: !!cp,
    receptiveness, tier,
    manager_factor: +(receptiveness * tierFactor(tier)).toFixed(3),
    chat_msgs: cp?.chat_msgs ?? 0,
    accept_rate: cp?.accept_rate ?? null,
    accept_rate_n: cp?.accept_rate_n ?? 0,
    word_stance: cp?.stance?.stance ?? null,
    word_note: cp?.stance?.note ?? null,
    note: cp ? null : 'No counterparty read for this league — this ladder is priced on our numbers only.',
  };
}

/**
 * How this owner has talked about the player being asked for.
 *
 * findTrades removes a CREDIBLY declared untouchable from the search entirely; a
 * ladder cannot do that (the user named him), so it says so instead rather than
 * quietly pricing a player who is not for sale.
 */
function targetStance(counterparties, owner, targets) {
  const cp = counterparties.get(String(owner.roster_id)) ?? null;
  if (!cp?.stance) return null;
  const named = list => targets.filter(t => list?.has?.(String(t.name ?? '').toLowerCase())).map(t => t.name);
  const respected = named(cp.stance.respect);
  const probe = named(cp.stance.probe);
  if (!respected.length && !probe.length) return null;
  return {
    respected, probe,
    warning: respected.length
      ? `${owner.owner} has called ${respected.join(' and ')} untouchable and his word has held — the league search will not even ask. Price this as a long shot.`
      : `${owner.owner} has called ${probe.join(' and ')} untouchable, but his refusals have not held. Worth asking, expecting a first no.`,
  };
}

/** One rung's package-specific counterparty read. */
function rungCounterparty(counterparties, owner, tier, { theirGive, theirGet }) {
  const cp = counterparties.get(String(owner.roster_id)) ?? null;
  const read = cp
    ? { ...readDeal({ theirGive, theirGet, managerProfile: cp }), counterparty_data: true }
    : { receptiveness: 1, perception_delta: null, perception_shift: null, perception_reasons: [],
      chat_msgs: 0, accept_rate: null, counterparty_data: false };
  return { ...read, tier,
    manager_factor: +(read.receptiveness * tierFactor(tier)).toFixed(3),
    perception_factor: +perceptionFactorFor(read).toFixed(3) };
}

/**
 * Offer ladder for a specific target: the cheapest package that plausibly gets it
 * done, a fair-market version, and the point past which you are overpaying.
 */
export function offerFor(lg, { myTeamId, targetId, excludeIds = null, playoffOdds }) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  const target = resolvePlayer(targetId, assets, teams);
  if (!target) return { error: 'player not found' };
  const owner = teams.find(t => t.players.some(p => p.id === target.id));
  if (!owner) return { error: 'that player is not on a roster in this league' };
  if (owner.roster_id === me.roster_id) return { error: 'you already own him' };
  const tier = rows(`SELECT tradeability FROM manager_profiles WHERE league_id=? AND roster_id=?`,
    lg.id, String(owner.roster_id))[0]?.tradeability ?? 'fair';
  if (tier === 'never') return { error: `${owner.owner} is marked "Never trades," so the engine did not generate fake offers for this player.` };
  const ownerCtx = rosterContext(lg).get(String(owner.roster_id));
  const { weekNow, odds, horizon, counterparties } = ladderInputs(lg, myTeamId, playoffOdds);

  // How motivated is the seller? A team with surplus at his position and a hole
  // elsewhere is a much cheaper negotiation than one starting him with no cover.
  const theirLine = bestLineup(owner.players, slots);
  const withoutHim = bestLineup(owner.players.filter(p => p.id !== target.id), slots);
  const theirCost = +(theirLine.points - withoutHim.points).toFixed(2);
  const replaceable = theirCost < 1.0;

  // Ceiling on what he can possibly do for me — on the horizon-weighted number
  // the rungs below are gated on, not on this week alone (see freeAddCeiling).
  const memo = new WeakMap();   // both rosters are fixed for this whole ladder (see evaluate())
  const myLine = bestLineup(me.players, slots);
  const addCeiling = freeAddCeiling(me, owner, [target], slots, horizon,
    { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window, memo });
  const upside = addCeiling.weekly;
  const upsideHorizon = addCeiling.horizon_weighted;
  const blockedBy = myLine.slots
    .map(s => s.player)
    .filter(p => p && (p.position === target.position || FLEX_ELIGIBLE.FLEX?.includes(p.position)))
    .filter(p => p.adj_ppg >= target.adj_ppg)
    .sort((a, b) => a.adj_ppg - b.adj_ppg)[0];

  const context = {
    mode: 'target',
    context: ideaContext(lg, { me, assets, odds, horizon, counterparties, useCounterparty: true, week: weekNow }),
    model_context: assets.context,
    target: slim(target), owner: owner.owner, owner_id: owner.roster_id,
    their_cost: theirCost, replaceable,
    // Both legs travel together: `upside_ppg` is the this-week lineup change a
    // free add makes, `upside_ppg_horizon` is that blended with the playoff
    // weeks, and the second one is what the refusal below is decided on.
    upside_ppg: upside, upside_ppg_horizon: upsideHorizon,
    upside_playoff_leg: addCeiling.playoff_leg,
    counterparty: ownerRead(counterparties, owner, tier),
    target_stance: targetStance(counterparties, owner, [target]),
    leverage: replaceable
      ? `${owner.owner} can cover him — losing him only costs their lineup ${theirCost} ppg. Start low.`
      : `He is load-bearing for ${owner.owner} (${theirCost} ppg of their lineup). Expect to pay a premium or get refused.`
  };

  // Refuse only when he cannot help across the rest of the season either. A
  // player who does nothing for THIS Sunday but improves the playoff weeks is
  // exactly the trade a contender makes, and the rung loop below already ranks
  // on that number.
  if (upsideHorizon <= 0.05) {
    return {
      ...context,
      error: `He would not crack your starting lineup.`,
      reason: (blockedBy
        ? `${target.name} projects ${target.adj_ppg} ppg once his schedule is priced in; you already start ${blockedBy.name} at ${blockedBy.adj_ppg}. Buying him upgrades your bench, not your Sunday.`
        : `${target.name} projects ${target.adj_ppg} ppg, below what you already start at that spot.`)
        + ` Weighting the playoff weeks in does not rescue it either (${upsideHorizon} ppg).`,
      // The bar an acquisition has to clear to be worth anything at all.
      bar: blockedBy ? { name: blockedBy.name, position: blockedBy.position, adj_ppg: blockedBy.adj_ppg } : null
    };
  }

  const myPool = candidates(me, slots, 12, excludeIds);
  const packages = combos(myPool, 3).filter(c => c.length <= 3);

  const priced = [];
  for (const give of packages) {
    const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
    const ratio = target.value ? giveValue / target.value : 0;
    if (ratio < 0.70 || ratio > 1.65) continue;
    const ev = evaluate({ team: me, gives: give }, { team: owner, gives: [target] }, slots,
      { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window, memo });
    const gain = ladderGain(ev, horizon);
    // The horizon-weighted gain is the objective, so it is also the entry gate —
    // it used to be the flat weekly delta, which discarded a package that is worth
    // more in December than it is this week, the exact shape a contender buys.
    if (gain.value <= 0) continue;
    priced.push({
      i_give: give.map(slim), ratio: +ratio.toFixed(2), give_value: giveValue,
      ...ev,
      horizon: { ...horizon, ...gain, note: horizonNote(horizon, gain) },
      counterparty: rungCounterparty(counterparties, owner, tier, { theirGive: [target], theirGet: give }),
      // Best offer = most horizon-weighted lineup gain per unit of market value
      // surrendered. Same currency findTrades ranks on.
      efficiency: +(gain.value / Math.max(1, giveValue / 100)).toFixed(3)
    });
  }
  if (!priced.length) {
    return {
      ...context,
      error: 'He would help, but nothing on your roster prices out.',
      reason: `Adding him is worth ${upsideHorizon} ppg to your lineup horizon-weighted (${upside} this week), but every package in his price range (${Math.round(target.value * 0.7)}–${Math.round(target.value * 1.65)}) costs you more than he returns. You need a third team, or a cheaper player at the same position.`
        + (excludeIds?.size ? ` This search also left out the player(s) you've marked untouchable.` : '')
    };
  }

  // "He might say yes": his lineup improves, or he wins on market value, or —
  // the counterparty read findTrades has always had and this ladder did not —
  // the package reads as a win from HIS side of the table.
  const acceptable = priced.filter(p => p.them.ppg_delta > 0 || p.ratio >= 1.0
    || (p.counterparty.perception_delta ?? 0) > 0);
  const pool = acceptable.length ? acceptable : priced;
  // Cheapest first, but among packages that cost the same never open with the one
  // that helps me least — that offer is dominated and only wastes the first ask.
  const byRatio = [...pool].sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta);
  const byEfficiency = [...pool].sort((a, b) => b.efficiency - a.efficiency);
  const ceiling = [...priced].sort((a, b) => b.ratio - a.ratio)[0];

  /**
   * "Go get him": five distinct, playable packages that would land the target —
   * not five variants of the same core piece with a different throw-in. Collapsed
   * to one representative per headline give (the most valuable piece in the
   * package) before ranking, the same technique findTrades() uses to keep a deal
   * list from being ten copies of one idea.
   */
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  const seenHeadline = new Set();
  const distinctByCost = [...pool]
    .sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta)
    .filter(p => {
      const k = headline(p.i_give);
      if (seenHeadline.has(k)) return false;
      seenHeadline.add(k);
      return true;
    });
  const RUNG_LABEL = ['Opening offer', 'Good value', 'Fair price', 'Sweetened', 'Safest bet'];
  const offers = distinctByCost.slice(0, 5).map((p, i) => ({
    ...p, rank: i + 1, label: RUNG_LABEL[i] ?? `Offer ${i + 1}`
  }));

  return {
    ...context,
    offers,
    open_with: byRatio[0],
    fair: byEfficiency[0],
    max: { ...ceiling, note: `Past roughly ${Math.round(target.value * 1.35)} in market value you are paying a tax you will not recover.` },
    alternatives: byEfficiency.slice(1, 5)
  };
}

/* -------------------------------------- "go get them" — multiple targets */

/**
 * Same offer-ladder logic as offerFor(), generalized to a whole shopping list at
 * once. Targets are grouped by current owner — a real trade is with one team, so
 * two players on different rosters come back as two separate ladders, one per
 * owner, rather than pretending a single package could land both.
 */
export function offerForMany(lg, { myTeamId, targetIds, excludeIds = null, playoffOdds }) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found in this league' };
  // Same horizon and same counterparty layer as the league-wide search (G6).
  const { weekNow, odds, horizon, counterparties } = ladderInputs(lg, myTeamId, playoffOdds);

  const targets = [...new Set((targetIds ?? []).map(Number))]
    .map(id => resolvePlayer(id, assets, teams)).filter(Boolean);
  if (!targets.length) return { error: 'no valid players selected' };

  const byOwner = new Map();
  for (const t of targets) {
    const owner = teams.find(tm => tm.players.some(p => p.id === t.id));
    if (!owner || owner.roster_id === me.roster_id) continue;
    if (!byOwner.has(owner.roster_id)) byOwner.set(owner.roster_id, { team: owner, targets: [] });
    byOwner.get(owner.roster_id).targets.push(t);
  }
  if (!byOwner.size) {
    return { error: 'None of the selected players are on another roster in this league — check they are actually rostered, or that you do not already own them.' };
  }

  const context = rosterContext(lg);
  const myPool = candidates(me, slots, 12, excludeIds);

  const ladders = [];
  for (const { team: owner, targets: theirTargets } of byOwner.values()) {
    const tier = rows(`SELECT tradeability FROM manager_profiles WHERE league_id=? AND roster_id=?`,
      lg.id, String(owner.roster_id))[0]?.tradeability ?? 'fair';
    if (tier === 'never') {
      ladders.push({ targets: theirTargets.map(slim), owner: owner.owner, owner_id: owner.roster_id,
        counterparty: ownerRead(counterparties, owner, tier),
        error: `${owner.owner} is marked "Never trades," so no offers were generated.` });
      continue;
    }
    const ownerCtx = context.get(String(owner.roster_id));
    const targetsValue = theirTargets.reduce((s, p) => s + Math.max(0, p.value), 0);

    const withoutThem = bestLineup(owner.players.filter(p => !theirTargets.some(t => t.id === p.id)), slots);
    const theirLine = bestLineup(owner.players, slots);
    const theirCost = +(theirLine.points - withoutThem.points).toFixed(2);
    const replaceable = theirCost < 1.0 * theirTargets.length;

    // Same free-add ceiling as offerFor, on the horizon-weighted number the rungs
    // below are gated on rather than on this week alone (see freeAddCeiling).
    const memo = new WeakMap();   // both rosters are fixed for this owner's ladder (see evaluate())
    const addCeiling = freeAddCeiling(me, owner, theirTargets, slots, horizon,
      { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window, memo });
    const upside = addCeiling.weekly;
    const upsideHorizon = addCeiling.horizon_weighted;

    const base = {
      targets: theirTargets.map(slim), owner: owner.owner, owner_id: owner.roster_id,
      their_cost: theirCost, replaceable,
      upside_ppg: upside, upside_ppg_horizon: upsideHorizon,
      upside_playoff_leg: addCeiling.playoff_leg,
      counterparty: ownerRead(counterparties, owner, tier),
      target_stance: targetStance(counterparties, owner, theirTargets),
      leverage: replaceable
        ? `${owner.owner} can cover ${theirTargets.length > 1 ? 'both' : 'him'} — losing ${theirTargets.length > 1 ? 'them' : 'him'} only costs their lineup ${theirCost} ppg. Start low.`
        : `${theirTargets.length > 1 ? 'They are' : 'He is'} load-bearing for ${owner.owner} (${theirCost} ppg of their lineup). Expect to pay a premium or get refused.`
    };

    // Refuse only when the group cannot help across the rest of the season
    // either — the rung loop below ranks on the horizon-weighted number, so the
    // gate has to be measured on it too.
    if (upsideHorizon <= 0.05) {
      ladders.push({ ...base, error: `This package would not crack your starting lineup.`,
        reason: `Adding ${theirTargets.map(t => t.name).join(' + ')} is worth ${upsideHorizon} ppg to your lineup horizon-weighted `
          + `(${upside} this week) — not enough to change your best starting 9 now or in the playoff weeks.` });
      continue;
    }

    const maxGive = Math.min(4, theirTargets.length + 2);
    const packages = combos(myPool, maxGive);
    const priced = [];
    for (const give of packages) {
      const giveValue = give.reduce((s, p) => s + Math.max(0, p.value), 0);
      const ratio = targetsValue ? giveValue / targetsValue : 0;
      if (ratio < 0.70 || ratio > 1.65) continue;
      const ev = evaluate({ team: me, gives: give }, { team: owner, gives: theirTargets }, slots,
        { theirNeeds: ownerCtx?.needs, theirWindow: ownerCtx?.window, memo });
      const gain = ladderGain(ev, horizon);
      if (gain.value <= 0) continue;
      priced.push({
        i_give: give.map(slim), ratio: +ratio.toFixed(2), give_value: giveValue,
        ...ev,
        horizon: { ...horizon, ...gain, note: horizonNote(horizon, gain) },
        counterparty: rungCounterparty(counterparties, owner, tier, { theirGive: theirTargets, theirGet: give }),
        efficiency: +(gain.value / Math.max(1, giveValue / 100)).toFixed(3)
      });
    }
    if (!priced.length) {
      ladders.push({ ...base, error: 'Nothing on your roster prices out for this package.',
        reason: `Every combination in range (${Math.round(targetsValue * 0.7)}–${Math.round(targetsValue * 1.65)}) costs you more lineup value than it returns. Try fewer targets, or a third team.`
          + (excludeIds?.size ? ` This search also left out your untouchable player(s).` : '') });
      continue;
    }

    const acceptable = priced.filter(p => p.them.ppg_delta > 0 || p.ratio >= 1.0
      || (p.counterparty.perception_delta ?? 0) > 0);
    const pool = acceptable.length ? acceptable : priced;
    const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
    const seenHeadline = new Set();
    const distinctByCost = [...pool]
      .sort((a, b) => a.ratio - b.ratio || b.me.ppg_delta - a.me.ppg_delta)
      .filter(p => {
        const k = headline(p.i_give);
        if (seenHeadline.has(k)) return false;
        seenHeadline.add(k);
        return true;
      });
    const RUNG_LABEL = ['Opening offer', 'Good value', 'Fair price', 'Sweetened', 'Safest bet'];
    const offers = distinctByCost.slice(0, 5).map((p, i) => ({ ...p, rank: i + 1, label: RUNG_LABEL[i] ?? `Offer ${i + 1}` }));
    const byEfficiency = [...pool].sort((a, b) => b.efficiency - a.efficiency);

    ladders.push({ ...base, offers, fair: byEfficiency[0], alternatives: byEfficiency.slice(1, 5) });
  }

  return { mode: 'targets',
    context: ideaContext(lg, { me, assets, odds, horizon, counterparties, useCounterparty: true, week: weekNow }),
    me: { roster_id: me.roster_id, owner: me.owner }, model_context: assets.context, ladders };
}

/* --------------------------------------------------------------- self scout */

/**
 * Honest read on my own roster: where I'm strong, where I'm thin, what breaks if
 * someone gets hurt, and the specific moves that fix it.
 */
export function selfScout(lg, myTeamId) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'your team not found' };

  // This week's lineup (weekLineup): a starter on bye is benched and the next-best
  // player starts, so the weekly range, the rank beside it, the position strengths
  // and the depth test all describe the same eleven (RL-5-3).
  const lineup = weekLineup(me.players, slots);
  // The starting lineup's weekly total in a bad (p10) and a good (p90) week — see
  // lineupSpread().
  const spread = lineupSpread(lineup);

  // League context: every rival's optimal lineup, so "strong at RB" means strong
  // relative to the ten teams you actually play, not to a national average.
  const rivals = teams.filter(t => t.roster_id !== me.roster_id)
    .map(t => ({ owner: t.owner, roster_id: t.roster_id, line: weekLineup(t.players, slots) }));
  const allLineups = [lineup.points, ...rivals.map(r => r.line.points)].sort((a, b) => b - a);
  const myRank = allLineups.indexOf(lineup.points) + 1;

  // Per-position strength vs the league, measured on starters only.
  const startersAt = (team, pos, line) => line.slots
    .filter(s => s.player?.position === pos).map(s => s.player);
  const positions = {};
  for (const pos of SKILL) {
    const mineStarters = startersAt(me, pos, lineup);
    const myPts = mineStarters.reduce((s, p) => s + p.adj_ppg, 0);
    const rivalPts = rivals.map(r => startersAt(null, pos, r.line).reduce((s, p) => s + p.adj_ppg, 0));
    const avg = rivalPts.length ? rivalPts.reduce((a, b) => a + b, 0) / rivalPts.length : myPts;
    const better = rivalPts.filter(v => v > myPts).length;

    // Depth test: what the lineup loses if the best player here goes down.
    const best = mineStarters.slice().sort((a, b) => b.adj_ppg - a.adj_ppg)[0];
    const ifOut = best ? weekLineup(me.players.filter(p => p.id !== best.id), slots).points : lineup.points;
    const dropoff = +(lineup.points - ifOut).toFixed(2);

    positions[pos] = {
      starters: mineStarters.map(slim),
      depth: me.players.filter(p => p.position === pos && !mineStarters.some(s => s.id === p.id))
        .sort((a, b) => b.adj_ppg - a.adj_ppg).slice(0, 4).map(slim),
      ppg: +myPts.toFixed(2),
      league_avg: +avg.toFixed(2),
      ratio: avg ? +(myPts / avg).toFixed(2) : 1,
      rank: better + 1, of: rivalPts.length + 1,
      injury_dropoff: dropoff,
      status: myPts > avg * 1.12 ? 'strength' : myPts < avg * 0.88 ? 'weakness' : 'average'
    };
  }

  // Bye-week collisions among starters — the most common self-inflicted loss.
  // Checked on the season lineup: this week's lineup has already benched anyone on
  // bye now, which would hide exactly the collision this warns about.
  const seasonLineup = bestLineup(me.players, slots);
  const byes = {};
  for (const s of seasonLineup.slots) {
    if (s.player?.bye) (byes[s.player.bye] ??= []).push(slim(s.player));
  }
  const byeRisk = Object.entries(byes).filter(([, list]) => list.length >= 3)
    .map(([week, list]) => ({ week: Number(week), count: list.length, players: list }))
    .sort((a, b) => b.count - a.count);

  // The weeks that decide the title. This used to report a per-starter "playoff
  // swing", playoff_ppg - adj_ppg, as the schedule turning in weeks 15-17. It was a
  // units artifact (playoff_ppg had no availability term, adj_ppg does), positive
  // for every starter, and the schedule strength behind it has no validated signal
  // (matchups.js). What IS known about those weeks is who is on bye in them.
  const { playoffWeeks } = leagueSchedule(lg);
  const nowWeek = tradeWeekContext().week;
  const playoffByes = seasonLineup.slots.map(s => s.player)
    .filter(p => p?.bye && p.bye >= nowWeek && playoffWeeks.includes(p.bye))
    .map(p => ({ ...slim(p), week: p.bye }));

  const strengths = Object.entries(positions).filter(([, v]) => v.status === 'strength')
    .sort((a, b) => b[1].ratio - a[1].ratio);
  const weaknesses = Object.entries(positions).filter(([, v]) => v.status === 'weakness')
    .sort((a, b) => a[1].ratio - b[1].ratio);

  const fixes = [];
  for (const [pos, v] of weaknesses) {
    fixes.push({ priority: 'high', area: pos,
      issue: `${pos} starters project ${v.ppg} ppg vs a league average of ${v.league_avg} — ${v.rank}${ord(v.rank)} of ${v.of}.`,
      action: `Trade from surplus (${strengths.map(s => s[0]).join('/') || 'depth'}) for a starting ${pos}.` });
  }
  for (const [pos, v] of Object.entries(positions)) {
    if (v.injury_dropoff > 4 && v.depth.length < 2) {
      fixes.push({ priority: 'medium', area: `${pos} depth`,
        issue: `Losing your top ${pos} costs ${v.injury_dropoff} ppg and you have ${v.depth.length} real backup${v.depth.length === 1 ? '' : 's'}.`,
        action: `Add a startable ${pos} as insurance — cheap in trade because it costs the seller nothing.` });
    }
  }
  for (const b of byeRisk) {
    fixes.push({ priority: 'medium', area: `Week ${b.week} bye`,
      issue: `${b.count} of your starters are on bye in Week ${b.week} (${b.players.map(p => p.name).join(', ')}).`,
      action: 'Stagger byes when two trade targets are otherwise equal, or plan the waiver claim now.' });
  }
  const byeWeeks = [...new Set(playoffByes.map(p => p.week))].sort((a, b) => a - b);
  for (const w of byeWeeks) {
    const names = playoffByes.filter(p => p.week === w).map(p => p.name);
    fixes.push({ priority: 'medium', area: `Week ${w} playoff bye`,
      issue: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} on bye in week ${w}, one of this league's playoff weeks.`,
      action: 'Plan that week\'s replacement early — the bye is certain, unlike any read on playoff matchups.' });
  }
  // No "Roster shape" fix (RL-15-2). It told every team outside this week's projected
  // top 3 to "chase variance" and the top 3 to "trade ceiling for floor". In Sleeper
  // 2021-24 (21,946 team-seasons, R&D r15, pre-registered) the teams it called bubble
  // won fewer titles at higher weekly variance (-0.138 log-odds/SD [-0.214,-0.067]) and
  // the contender half had no support. Variance is a weekly, matchup-conditional call:
  // lineup-posture.js on Start/Sit is its one producer. The range and rank the fix
  // repeated are still returned (spread, rank) and shown on the Scout header.

  return {
    team: { roster_id: me.roster_id, owner: me.owner },
    // The live NFL week, so a caller (the My Team ceiling-lineup tab, in
    // particular) doesn't have to hardcode week 1 for the whole season.
    week: tradeWeekContext().week,
    rank: myRank, of: allLineups.length,
    lineup: { points: lineup.points, slots: lineup.slots.map(s => ({ slot: s.slot, player: s.player ? slim(s.player) : null })),
              bench: lineup.bench.map(slim), holes: lineup.holes },
    spread,
    positions,
    strengths: strengths.map(([pos, v]) => ({ position: pos, ...v })),
    weaknesses: weaknesses.map(([pos, v]) => ({ position: pos, ...v })),
    bye_risk: byeRisk,
    // Empty while no schedule-strength signal is validated (see above); the key stays
    // so the My Team card that renders it simply hides.
    playoff_swing: [],
    playoff_byes: playoffByes,
    fixes: fixes.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority]),
    league_lineups: [{ owner: me.owner, roster_id: me.roster_id, points: lineup.points, me: true },
                     ...rivals.map(r => ({ owner: r.owner, roster_id: r.roster_id, points: r.line.points, me: false }))]
      .sort((a, b) => b.points - a.points)
  };
}

const ord = n => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
  : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/* ------------------------------------------------------- player deep report */

/** Everything the engine knows about one player, for the card behind a trade. */
export function playerOutlook(lg, playerId) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const a = resolvePlayer(playerId, assets, teams);
  if (!a) return { error: 'player not found' };
  const owner = teams.find(t => t.players.some(p => p.id === a.id));
  // relevantSplits() carries `signal: false` and its reason (history, not a
  // forecast); the no-team fallback says the same.
  const splits = a.team_abbr ? relevantSplits(a.id, a.team_abbr)
    : { baseline: null, upcoming: [], notable: [], signal: false, reason: 'no NFL team on file' };
  // Same stories as the player card and the News page (one attribution producer).
  const news = playerNews(a.id, { limit: 5 }).map(n => ({
    id: n.id, date: n.date, headline: n.headline, fantasy_impact: n.fantasy_impact, importance: n.importance }));
  return { ...a, ...playerEvidence(a.id), owner: owner?.owner ?? 'free agent', owner_id: owner?.roster_id ?? null, splits, news };
}

/* ---------------------------------------------- submitted vs. recommended lineup */

// ESPN lineupSlotId -> our slot label, minus BENCH(20)/IR(21) — a "starter" is
// anything else. Sleeper's payload has a `starters` array instead of a per-player
// slot id; a real Sleeper version needs its own read of that shape, not this one.
const STARTER_SLOT_IDS = new Set(
  Object.entries(SLOT_NAME).filter(([, name]) => name !== 'BENCH' && name !== 'IR').map(([id]) => Number(id)));

const IR_SLOT_ID = Number(Object.entries(SLOT_NAME).find(([, name]) => name === 'IR')[0]);
// ESPN statuses under which a player is still expected to suit up.
const ESPN_PLAYING = new Set(['ACTIVE', 'QUESTIONABLE', 'DAY_TO_DAY', 'PROBABLE']);

/**
 * This week's number for one player, built exactly as lineup-brain.js#lineupCall
 * builds `week_points` for the Start/Sit tab: current_week_ppg (this Sunday's
 * projection times his chance to play, 0 on a bye; no opponent adjustment, none
 * is validated — matchups.js) times this week's
 * game-script multiplier from the betting line. Kept identical on purpose — if
 * the two drift, the League Hub card and the Start/Sit tab name different
 * lineups. The `?? adj_ppg ?? ppg` fallback only fires when the field is absent,
 * never on a real 0 (a bye), same as weekPpg() in lineup-posture.js and
 * waiver-wire.js (commit fe38e93).
 */
function lineupDiffWeekPoints(p, season, week) {
  const base = p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0;
  const lift = vegasLift(p, season, week);
  const v = base * (lift.applied ? lift.multiplier : 1);
  return Number.isFinite(v) ? +v.toFixed(2) : null;
}

/*
 * HOW SURE IS ONE SWAP — the probability on each swap, and the urgency it sets.
 *
 * Question: when two players are this many projected points apart, how often
 * does the higher projection actually score more? Measured with the walk-forward
 * weekly replay (weekly-backtest.js#replaySeasonWeekly, live ensemble weights,
 * weeks 5-17) on every pair of same-position players in the same week whose
 * projections were both >= 4 points — the players a start/sit is actually
 * between — keeping anyone who then sat out as 0, because on Tuesday you do not
 * know who will be inactive on Sunday. A tie in actual points counts half.
 *
 *   projected gap     <1    1-2   2-3   3-5   5-8   8+
 *   2023+24 (fit)    52.4  55.3  58.8  62.3  68.7  76.4   % right, 161,078 pairs
 *   2025 (check)     51.7  53.5  57.5  61.9  67.7  75.0   % right,  78,735 pairs
 *
 * One curve fits it: P(right) = Phi(gap / 14.5), the 14.5 by maximum likelihood
 * on 2023+2024 only. Checked once on 2025 against a pre-registered gate: every
 * bin within 4 points of what happened (worst: 8+ says 77.9, observed 75.0), and
 * no worse on log-loss than a six-bin lookup fit on the same seasons
 * (player-clustered paired bootstrap, 90% CI of the difference -0.0014..+0.0003).
 *
 * The audit's table (<1 48.6, 1-2 57.0, 2-3 63.0, 3-5 69.2, 5-8 78.6, 8+ 88.3)
 * reads higher because it also scores pairs nobody faces — a 15-point starter
 * against a 2-point backup — and, in its best-matching form, only players who
 * went on to play. Low projections miss by less, so the same gap looks more
 * decisive there. On the players a lineup call is really between, a 5-8 point
 * edge is right about two times in three, not four in five.
 *
 * Urgency is set on that probability, with cut points fixed before the fit:
 *   high    >= 75%   a gap of about 9.8 points or more (Phi^-1(0.75) x 14.5)
 *   medium  >= 60%   about 3.7 points or more
 *   low     <  60%   right barely more often than a coin
 * These replace the old hand-picked cut on the WHOLE swap set's gain (>= 4 high,
 * >= 2 medium), which also let two coin-flip swaps add up to "medium".
 *
 * A swap against a SURE zero — an empty slot, a starter with no game, one
 * flagged out or on IR — is not a two-player comparison: it is right whenever
 * the new man plays, so its probability is his own active_probability.
 */
const SWAP_GAP_SIGMA = 14.5;
const swapRightProbability = gap => normalCdf(gap / SWAP_GAP_SIGMA);
const SWAP_URGENCY = [['high', 0.75], ['medium', 0.60], ['low', -Infinity]];
const swapUrgency = p => SWAP_URGENCY.find(([, min]) => p >= min)[0];
const URGENCY_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Pair each player coming IN with the starter he replaces, so every swap
 * carries its own gap and its own probability.
 *
 * Pairs are exchanges FROM the optimum: (out y, in x) is legal when the optimal
 * lineup minus x plus y still fills every slot legally. The optimum cannot gain
 * from any single exchange, so every legal pair has pts(x) - pts(y) >= 0, and the
 * gaps of a full pairing add up to the total gain. A full legal pairing always
 * exists (lineups are bases of a transversal matroid — Brualdi's exchange
 * theorem); an empty slot on either side pads with null. Among full pairings,
 * prefer same-position pairs (the one a manager reads naturally), then the
 * largest smallest gap — the conservative choice for the headline, since the
 * gaps' sum is fixed. `points` is what each player counts for this week.
 */
function pairLineupSwaps(ins, outs, optimalPlayers, slots, points) {
  const n = Math.max(ins.length, outs.length);
  if (!n) return [];
  const I = [...ins, ...new Array(n - ins.length).fill(null)];
  const O = [...[...outs].sort((a, b) => points(b) - points(a)), ...new Array(n - outs.length).fill(null)];
  // Legality ignores availability on purpose: a flagged starter is being replaced,
  // and the question is only whether the slots still fill.
  // Legality is unpinned on purpose (RL-4-2): locked players are already held in
  // optimalPlayers and never in `ins`/`outs`, and a pinned check changed no pairing on
  // 400 random two-FLEX rosters with early-window locks (mutation M8, evidence file).
  const holds = set => bestLineup(set.map(p => ({ ...p, available: true })), slots, 'week_points')
    .slots.filter(s => s.player).length === set.length;
  const legal = O.map(y => I.map(x => !x || !y || holds([...optimalPlayers.filter(p => p.id !== x.id), y])));
  const gap = (y, x) => (x ? points(x) : 0) - (y ? points(y) : 0);

  let best = null;
  const used = new Array(n).fill(false), pick = new Array(n);
  const walk = j => {
    if (j === n) {
      let same = 0, min = Infinity;
      for (let k = 0; k < n; k++) {
        const x = I[pick[k]], y = O[k];
        if (x && y && x.position === y.position) same++;
        if (x) min = Math.min(min, gap(y, x));
      }
      if (!best || same > best.same || (same === best.same && min > best.min + 1e-9)) best = { same, min, pick: [...pick] };
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i] || !legal[j][i]) continue;
      used[i] = true; pick[j] = i; walk(j + 1); used[i] = false;
    }
  };
  if (n <= 7) walk(0);
  // Beyond 7 swaps (a whole lineup set wrong), or if no full legal pairing turned
  // up, fall back to pairing by rank: best newcomer for the weakest starter (O is
  // strongest-first, so it takes the newcomers weakest-first).
  const order = best?.pick ?? I.map((_, i) => i).sort((a, b) =>
    (I[a] ? points(I[a]) : -1) - (I[b] ? points(I[b]) : -1));
  return O.map((y, j) => ({ out: y, in: I[order[j]], gap: gap(y, I[order[j]]) })).filter(p => p.in || p.out);
}

/**
 * When a published lineup row stops being actionable: the earliest kickoff among the
 * players its swaps name (lineup-lock.js; a named player is never locked, since the
 * solve is pinned). Falls back to 72 hours from `now` only when none of them has a
 * kickoff on file.
 */
function swapExpiry(swaps, locks, now) {
  const kicks = swaps.flatMap(s => [s.in.id, s.out?.id])
    .map(id => (id == null ? null : locks.byId.get(id)?.kickoff))
    .filter(Boolean).map(k => Date.parse(k)).filter(Number.isFinite);
  return new Date(kicks.length ? Math.min(...kicks) : now + 72 * 3600 * 1000).toISOString();
}

/**
 * What's actually set on the platform right now vs. what the engine's own
 * optimal-lineup solver would start THIS WEEK — the "what should I change
 * before kickoff" question.
 *
 * ONE-WEEK QUESTION, ONE-WEEK NUMBER. This used to solve both lineups on
 * adj_ppg, the 25%-this-week / 75%-rest-of-season blend built for trades. For a
 * start/sit that is wrong twice over: it ranks players on a rest-of-season rate
 * this Sunday says little about, and it carries a player on bye (current_week_ppg
 * 0) at most of his season value. When the audit measured it (2026 week 2),
 * league 3's card read "107.44 vs optimal 112.48, +5.04, urgency high"; on this
 * week's number it was 87.47 vs 89.37, +1.90. League 4's swap set was worth 2.22
 * fewer week points than the right one and missed a swap; league 1 missed one.
 *
 * It now ranks on `week_points`, built the way lineup-brain.js#lineupCall builds
 * it (lineupDiffWeekPoints above), so the League Hub card and the Start/Sit tab
 * name the same optimal lineup at the same points — checked roster by roster
 * across every synced league when this changed. The one designed difference is
 * IR, below.
 *
 * Never recommended IN: a player with no game this week (bye), anyone the
 * availability layer flags out for the season or released (available === false;
 * bestLineup already drops them), and anyone on IR (ESPN's IR slot, or ESPN
 * status INJURY_RESERVE). A flagged or IR player the manager has STARTED counts 0
 * in the submitted lineup and is listed in `flagged_starters` beside ESPN's own
 * status, so a false positive in the news scan reads as "check this", not as a
 * silent bench. An IR-slot player ESPN lists as playing, who would start if
 * activated, is listed in `activate_from_ir` rather than recommended.
 */
export function lineupDiff(lg, myTeamId, { assets: pricedAssets = null, now = Date.now() } = {}) {
  if (lg.platform !== 'espn') return { error: 'Submitted-lineup comparison is ESPN-only for now — Sleeper stores starters in a different shape this doesn\'t read yet.' };
  const { formatKey } = deriveFormat(lg);
  // `assets` lets a test price every player exactly (test/lineup-diff-urgency.test.js).
  const assets = pricedAssets ?? assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  // A requested team that is not in the league is not found. It used to fall back to
  // teams[0] — a rival's roster in 3 of the 5 live leagues — and then publish that
  // rival's swaps into Nick's Decision Inbox. Only a league with no my_team_id at all
  // (never synced who is who) still shows the first roster, and never publishes.
  const requested = myTeamId ?? lg.my_team_id;
  const me = requested != null && requested !== '' ? teams.find(t => t.roster_id === String(requested)) : teams[0];
  if (!me) return { error: `team ${requested} is not in this league`, not_found: true };
  const isMine = lg.my_team_id != null && me.roster_id === String(lg.my_team_id);
  const { season, week } = tradeWeekContext();

  const payload = JSON.parse(lg.payload);
  const espnTeam = payload.teams?.find(t => String(t.id) === me.roster_id);
  const byEspnId = new Map([...assets.values()].filter(a => a.espn_id).map(a => [String(a.espn_id), a]));
  // Each of my players' ESPN entry — the slot he is set in and ESPN's own injury
  // status. Matched by ESPN id, then by name within this roster (the fallback
  // loadRosters() itself uses to put him on the roster).
  const entryOf = new Map();
  const submittedIds = new Set();
  for (const e of espnTeam?.roster?.entries ?? []) {
    const pl = e.playerPoolEntry?.player;
    const p = byEspnId.get(String(pl?.id)) ?? me.players.find(x => norm(x.name) === norm(pl?.fullName));
    if (!p) continue;
    entryOf.set(p.id, e);
    // K/DEF are outside SCORED — bestLineup()/lineupSlots() never touch them (see
    // this file's header: near-random week to week, deliberately unmodeled), so
    // comparing them here would flag every started K/DEF as a "should bench" false
    // positive purely because the optimizer was never going to consider them.
    if (STARTER_SLOT_IDS.has(e.lineupSlotId) && SCORED.has(p.position)) submittedIds.add(p.id);
  }
  if (!espnTeam || submittedIds.size === 0) return { error: 'could not read a submitted lineup for this team — try syncing the league again' };

  const espnStatus = p => entryOf.get(p.id)?.playerPoolEntry?.player?.injuryStatus ?? null;
  const mine = me.players.map(p => ({
    ...p,
    week_points: lineupDiffWeekPoints(p, season, week),
    espn_status: espnStatus(p),
    in_ir_slot: entryOf.get(p.id)?.lineupSlotId === IR_SLOT_ID,
    on_ir: entryOf.get(p.id)?.lineupSlotId === IR_SLOT_ID || espnStatus(p) === 'INJURY_RESERVE',
    no_game: p.bye === week || !p.matchup
  }));
  // RL-4-2: whose game has kicked off (or ESPN already locked). A locked starter
  // keeps his slot and a locked bench player stays benched: every solve below is
  // pinned (pinnedBestLineup), so neither can be either leg of a swap. Same lock
  // rule as the Start/Sit tab (lineup-lock.js).
  const locks = rosterLocks(lg, me.roster_id, mine, { season, week, now });
  const pins = lockPins(locks);
  const solve = (players, s, key) => pinnedBestLineup(players, s, key, pins);
  const dead = p => p.available === false || p.on_ir;          // counts 0 this week
  const sureZero = p => dead(p) || p.no_game;                  // scores 0 for certain
  const counts = p => (dead(p) ? 0 : (p.week_points ?? 0));

  // The optimum, on the Start/Sit tab's own basis, from everyone who can start.
  const optimal = solve(mine.filter(p => !p.on_ir), slots, 'week_points');
  const optimalPlayers = optimal.slots.map(s => s.player).filter(Boolean);
  const optimalIds = new Set(optimalPlayers.map(p => p.id));
  const slotOf = new Map(optimal.slots.filter(s => s.player).map(s => [s.player.id, s.slot]));

  // What is set on ESPN, with flagged and IR starters held at 0 (bestLineup
  // drops the flagged ones by itself; IR is dropped here).
  const submitted = mine.filter(p => submittedIds.has(p.id));
  const submittedLineup = bestLineup(submitted.filter(p => !p.on_ir), slots, 'week_points');
  const gain = +(optimal.points - submittedLineup.points).toFixed(2);

  const brief = p => ({ id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
    week_points: p.week_points, active_probability: p.active_probability ?? null,
    injury_status: p.injury_status ?? null, espn_status: p.espn_status });
  const outReason = p => (!p ? 'empty slot' : p.on_ir ? 'on IR'
    : p.available === false ? 'flagged out for the season or released'
      : p.no_game ? 'no game this week' : null);

  const pairs = pairLineupSwaps(optimalPlayers.filter(p => !submittedIds.has(p.id)),
    submitted.filter(p => !optimalIds.has(p.id)), optimalPlayers, slots, counts);
  const swaps = pairs
    .filter(x => x.in && !sureZero(x.in) && (x.in.week_points ?? 0) > 0 && x.gap > 0.005)
    .map(x => {
      const versusZero = !x.out || sureZero(x.out);
      const p = versusZero ? (x.in.active_probability ?? 0.92) : swapRightProbability(x.gap);
      return {
        slot: slotOf.get(x.in.id),
        in: brief(x.in),
        out: x.out ? { ...brief(x.out), counts_for: counts(x.out), reason: outReason(x.out) } : null,
        gap: +x.gap.toFixed(2),
        p_right: +p.toFixed(3),
        p_basis: versusZero ? 'active_probability' : 'projected_gap',
        urgency: swapUrgency(p)
      };
    })
    .sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || b.p_right - a.p_right);
  const headline = swaps[0] ?? null;

  const flaggedStarters = submitted.filter(dead).map(p => ({
    ...brief(p), reason: outReason(p),
    // The news scan says out, ESPN still says playing — worth a look before benching.
    espn_disagrees: p.available === false && !p.on_ir && ESPN_PLAYING.has(p.espn_status)
  }));
  const activatable = mine.filter(p => !p.on_ir || (p.in_ir_slot && ESPN_PLAYING.has(p.espn_status)));
  const ifActivated = solve(activatable, slots, 'week_points');
  const activateFromIr = ifActivated.slots.map(s => s.player).filter(p => p?.on_ir && !p.no_game && p.week_points > 0)
    .map(p => ({ ...brief(p), lineup_points_if_activated: ifActivated.points }));

  // Decision Inbox publish — a side effect; the return value below is what
  // every caller gets. Published only at medium urgency or above: a "low" swap
  // is right less than 60% of the time, and dressing that up as a decision is
  // what lineup-brain.js's header warns against. When nothing clears the bar,
  // an open lineup recommendation this function published earlier is retired
  // rather than left to say "high" for 72 hours. See server/routes/decision-inbox.js
  // for publishRecommendation() and migrations/020 for the schema.
  // Only Nick's own roster: the inbox is his, and the My Team page can point this
  // card at any team in the league.
  const dedupKey = `lineup:${lg.id}:${me.roster_id}`;
  if (isMine) {
    try {
      if (headline && URGENCY_RANK[headline.urgency] >= URGENCY_RANK.medium) {
        const single = swaps.length === 1 && swaps[0].out;
        publishRecommendation({
          dedupKey,
          leagueId: lg.id, sport: 'NFL', type: 'lineup',
          subjectIds: swaps.flatMap(s => [s.in.id, s.out?.id]).filter(id => id != null),
          title: single ? `Start ${swaps[0].in.name} over ${swaps[0].out.name}`
            : `${swaps.length} lineup swap${swaps.length > 1 ? 's' : ''} this week (+${gain} pts)`,
          rationale: `Week ${week} projection: submitted lineup ${submittedLineup.points} vs. optimal ${optimal.points}. ` +
            swaps.map(s => `${s.in.name} over ${s.out ? s.out.name : 'an empty slot'}: +${s.gap}, ` +
              `right about ${Math.round(s.p_right * 100)}% of the time`).join('; ') + '.',
          expectedValue: gain, confidence: headline.p_right, urgency: headline.urgency,
          // The earliest kickoff among the players the swaps name: at that
          // instant ESPN locks him and the advice can no longer be taken
          // (RL-4-2; it was a flat 72 h, which left two W2 rows open 17.2 h and
          // 32.0 h after a named player locked). 72 h only when no named player
          // has a kickoff on file (a schedule not loaded), and that is the
          // heuristic it always was.
          expiresAt: swapExpiry(swaps, locks, now),
          sourceModel: 'lineup-brain', sourceVersion: 'v2-week-points', link: '/lineup'
        });
      } else {
        dbRun(`UPDATE decision_recommendations SET status = 'expired', resolved_at = datetime('now'), outcome = ?
               WHERE dedup_key = ? AND status = 'open' AND type = 'lineup'`,
          pins.size
            ? `superseded: no lineup swap among players whose games have not kicked off clears a 60% chance of being right (${pins.size} locked)`
            : 'superseded: no lineup swap this week clears a 60% chance of being right', dedupKey);
      }
    } catch (error) {
      // A side effect: never break the card over it, but never lose it silently either.
      console.error(`[lineup-diff] Decision Inbox write failed for league ${lg.id} (${dedupKey}):`, error);
    }
  }

  return {
    // A one-week decision: every number below is THIS week's projection.
    basis: 'week_points', season, week,
    matches: swaps.length === 0,
    submitted_points: submittedLineup.points,
    optimal_points: optimal.points,
    gain,
    urgency: headline?.urgency ?? null,
    p_right: headline?.p_right ?? null,
    swaps,
    // The recommended swaps in the original shape, for existing callers.
    swap_in: swaps.map(s => ({ slot: s.slot, player: slim(mine.find(p => p.id === s.in.id)) })),
    swap_out: swaps.filter(s => s.out).map(s => slim(mine.find(p => p.id === s.out.id))),
    optimal: optimal.slots.map(s => ({ slot: s.slot, player: s.player ? brief(s.player) : null })),
    empty_slots: optimal.holes,
    flagged_starters: flaggedStarters,
    activate_from_ir: activateFromIr,
    // Players whose game has kicked off (or ESPN already locked): held where they
    // are, never either side of a swap. `lock_coverage` false means the platform
    // gives no lock data here, not that nobody is locked.
    locked: mine.filter(p => pins.has(p.id)).map(p => ({ ...brief(p),
      slot: locks.byId.get(p.id).slot, reason: locks.byId.get(p.id).reason, kickoff: locks.byId.get(p.id).kickoff })),
    lock_coverage: locks.covered,
    note: `Week ${week} projection: this Sunday's game (0 on a bye) and injury odds, with the betting line's game script — ` +
      'the same numbers as the Start/Sit tab. p_right is how often the higher projection actually outscored the ' +
      'other at that gap in the 2023-2025 weekly replay.'
  };
}
