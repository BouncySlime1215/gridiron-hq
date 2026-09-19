/**
 * Trade engine API.
 *
 * Every route here answers without an API key — the analysis is deterministic. The
 * one exception is /explain, which hands a fully-scored deal to Claude purely to
 * write the negotiation copy; the numbers are already decided before it is called.
 */
import { Router } from 'express';
import { row, rows } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import {
  findTrades, findTradeSequences, offerFor, offerForMany, selfScout, playerOutlook, evaluate,
  assetUniverse, loadRosters, lineupSlots, bestLineup, resolvePlayer, lineupDiff, playerEvidence
} from '../services/trade-engine.js';
// The same season-by-season prompt lines and "argue from the numbers" rules the
// draft advisor runs on (server/routes/drafts.js) — one voice for both rooms.
import { evidenceLines, evidenceHeadline, STAT_ROOTED_INSTRUCTIONS } from '../services/draft-assist.js';
import { dvpTable, relevantSplits, matchupModel, matchupSignalActive, MATCHUP_SIGNAL_REASON } from '../services/matchups.js';
import { leagueCurrentWeek, leagueLastCompletedWeek } from '../services/league-week.js';
import { waiverBoard } from '../services/waiver-wire.js';
import { lineupPosture } from '../services/lineup-posture.js';
import { deriveFormat } from '../services/format.js';
import { newsOpportunities } from '../services/news-lag-trader.js';
import { brainState, managerProfiles, setManagerProfile } from '../services/league-brain.js';
// The measured manager layer: what has been observed about each counterparty, as
// opposed to `manager_profiles`, which is the tier Nick set by hand.
import { SIGNAL_SOURCES, refreshManagerData } from '../services/manager-signals.js';
import { identityMap, identityRows, identityWarnings } from '../services/manager-identity.js';
import { counterpartyLayer, RECEPTIVENESS_RANGE } from '../services/counterparty-pricing.js';
// Every other route in this file is a read behind a bearer session; the one that
// triggers work needs the administrator grant on top (server/platform/legacy-access.js).
import { requirePlatformAdmin } from '../platform/legacy-access.js';
import { proposalsFor, liveCaller, dbCache, PROPOSAL_SLATE_SIZE } from '../services/trade-proposals.js';
import { waiverUpgrades, freeAgents } from '../services/waiver-brain.js';
import { byeOutlook, byePatches, fragility } from '../services/roster-risk.js';
import { positionLiquidity } from '../services/position-liquidity.js';
import { trendExploits } from '../services/trend-exploits.js';
import { lineupCall } from '../services/lineup-brain.js';
import { teamTrends, playerTrends } from '../services/weekly-trends.js';
import { scanTrends, conflicts, trendHistory } from '../services/trend-watch.js';
import { regressionCandidates, regressionForLeague, touchdownRates } from '../services/td-regression.js';
import { ceilingLineup } from '../services/ceiling-lineup.js';
import { titleOddsTrades } from '../services/title-odds-trades.js';
import { weekPostmortem } from '../services/week-postmortem.js';
import { tradeImpact } from '../services/season-sim.js';
import {
  proposeVerifyRetryTrade, judgeTradeVerdict, tradeChallengeText, SENSE_CHECK_SIM_RUNS
} from '../services/trade-verify.js';

const r = Router();

/**
 * `?ids=1,2,3` -> a numeric array, empty when the param is absent.
 *
 * The obvious version — `String(x ?? '').split(',').map(Number).filter(Number.isFinite)`
 * — is wrong, because ''.split(',') is [''] and Number('') is 0, not NaN. An
 * absent parameter therefore parsed as the id list [0], which silently became
 * "player 0 was started" in the post-mortem (attributing a 0-point lineup) and
 * "one pick has been made" in the draft simulator (shifting every pick by one).
 */
const idList = raw => String(raw ?? '').split(',')
  .map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);

/** `?exclude=id1,id2` -> a Set of numeric player ids, or null when empty. */
function excludeSet(req) {
  const raw = String(req.query.exclude ?? '').trim();
  if (!raw) return null;
  const ids = idList(raw);
  return ids.length ? new Set(ids) : null;
}

/** Shared preamble: every route needs a synced league. */
function league(req, res) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
  if (!lg) { res.status(404).json({ error: 'league not found' }); return null; }
  if (!lg.payload) { res.status(400).json({ error: 'league not synced yet — sync it on the My Leagues page' }); return null; }
  return lg;
}

/* ------------------------------------------------------------ self scouting */
r.get('/:leagueId/scout', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(selfScout(lg, req.query.team_id));
  } catch (e) { next(e); }
});

/* --------------------------------------------------- post-draft action plan */
/**
 * "Draft's done, now what" — assembles the three things My Team already
 * computes separately (selfScout's roster read, findTrades' real deals,
 * bestLineup's optimal starters) into one response for a single new card.
 * No new modeling: this is composition, not analysis.
 */
r.get('/:leagueId/post-draft-plan', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (lg.platform !== 'espn') return res.status(400).json({ error: 'Post-draft plan is ESPN-only for now.' });

    const { formatKey } = deriveFormat(lg);
    const assets = assetUniverse(lg, formatKey);
    const teams = loadRosters(lg, assets);
    // Same signal leagues.js/analysis and tradelab.js already use: an ESPN league
    // with no matched roster players hasn't drafted this season yet.
    const rosteredCount = teams.reduce((s, t) => s + t.players.length, 0);
    if (rosteredCount === 0) {
      return res.json({
        drafted: false,
        message: 'This league hasn’t drafted yet for this season — the post-draft plan will populate once the draft completes.'
      });
    }

    const teamId = req.query.team_id ?? lg.my_team_id;
    const scout = selfScout(lg, teamId);
    if (scout.error) return res.status(400).json(scout);

    const trades = findTrades(lg, {
      myTeamId: teamId, maxPerSide: 2, requireMutual: true, limit: 5
    });

    res.json({
      drafted: true,
      team: scout.team,
      self_scout: scout,
      // selfScout already runs bestLineup() under the SCORED (K/DEF-excluded) slot
      // set — reuse its lineup rather than recomputing it.
      lineup: scout.lineup,
      trades
    });
  } catch (e) { next(e); }
});

/**
 * A route that existed and was deliberately removed. 410 (Gone), never 404, and
 * always with a pointer: a caller that finds a missing path deserves to be told
 * where the capability went, and a silent 404 reads like a bug.
 */
const retired = (use, why) => (_req, res) => res.status(410).json({
  error: `This endpoint was retired on 2026-09-18. ${why}`, use,
});

/* ----------------------------------------------------------------- the brain */

/** Where you stand: rank, holes, and which hole is worth paying to fix. */
r.get('/:leagueId/brain/state', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(brainState(lg.id, req.query.team_id ?? null));
  } catch (e) { next(e); }
});

/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * `brainPlan` ranked its own enumerated deals by its own tier-based acceptance
 * curve, neither of which read the counterparty layer or the horizon — a second,
 * quietly different answer to "what trade should I send". Both are retired with
 * it (see league-brain.js). The ranked weekly plan across lineup, waivers and
 * trades is being rebuilt as a deterministic service on the Decision Inbox
 * (master plan 00, D5), fed by waiverBoard and the one trade-idea entry point.
 */
r.get('/:leagueId/brain/plan', retired('/api/trades/:leagueId/find',
  'The plan\'s trade half was a second enumerator with its own acceptance curve. Trade ideas now come from one place, which prices how each manager reads a deal; the weekly plan service is being rebuilt on top of it.'));

/**
 * Free agents who would crack your lineup.
 *
 * Separate from the plan because it answers on its own: a waiver claim needs no
 * counterparty, so it is the one move available every week regardless of who is
 * talking to you.
 */
r.get('/:leagueId/brain/waivers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(waiverUpgrades(lg.id, {
      myTeamId: req.query.team_id ?? null,
      limit: Math.min(25, Number(req.query.limit) || 10)
    }));
  } catch (e) { next(e); }
});

/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * `sellHigh` itself is NOT retired — it is the price-curve half of the Trade
 * Brain's "hype window" tactic, and it stays as an input to that (it is still
 * exported from waiver-brain.js). What is retired is serving it as its own page:
 * a list of players priced above their production curve, with no buyer attached
 * and no read on who overvalues them, is half an idea. The whole idea — who to
 * sell him to, what to ask, and whether that manager has talked him up — is a
 * trade idea, and trade ideas have one source.
 */
r.get('/:leagueId/brain/sell-high', retired('/api/trades/:leagueId/find',
  'Selling high on a player is a trade idea, not a list: the finder names the buyer, the package and how he reads it. sellHigh() remains an input to the hype-window tactic.'));

/** The unrostered pool, ranked on the horizon that matters this week. */
r.get('/:leagueId/brain/free-agents', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const list = freeAgents(lg, { limit: Math.min(200, Number(req.query.limit) || 60) });
    res.json({ count: list.length, players: list });
  } catch (e) { next(e); }
});

/** Which future weeks already cost you points, and who on the wire fixes them. */
r.get('/:leagueId/brain/bye-risk', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(byePatches(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/** Where one injury ends the season, weighted by how often each player misses time. */
r.get('/:leagueId/brain/fragility', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(fragility(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/** What the other rosters can actually spare, position by position. */
r.get('/:leagueId/brain/liquidity', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(positionLiquidity(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ weekly trends */

/**
 * What has changed lately, crossed against what you can do about it.
 *
 * The statistics live in weekly-trends.js and refuse to say anything that does
 * not clear a corrected significance bar; this is the join onto your roster,
 * the wire, and the schedule.
 */
r.get('/:leagueId/trends', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(trendExploits(lg.id, {
      myTeamId: req.query.team_id ?? null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** One team's trajectory across its recent games. */
r.get('/trends/team/:team', (req, res, next) => {
  try {
    const season = Number(req.query.season) || null;
    const latest = season ?? row('SELECT MAX(season) AS s FROM nfl_team_week_features')?.s;
    res.json(teamTrends(String(req.params.team).toUpperCase(), latest, {
      throughWeek: Number(req.query.week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** One player's usage trajectory — share rather than points, on purpose. */
r.get('/trends/player/:playerId', (req, res, next) => {
  try {
    const latest = Number(req.query.season) || row('SELECT MAX(season) AS s FROM player_week_usage')?.s;
    res.json(playerTrends(Number(req.params.playerId), latest, {
      throughWeek: Number(req.query.week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/**
 * Sweep every offence and report the DIFFERENCE against the last sweep.
 *
 * The diff is the product: a trend reported every week forever is wallpaper.
 * New ones are the alert, faded ones are the signal to stop acting on an old
 * read, and ongoing ones are context the league has already priced.
 */
r.post('/trends/scan', (req, res, next) => {
  try {
    res.json(scanTrends({
      season: Number(req.body?.season) || null,
      throughWeek: Number(req.body?.through_week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.body?.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** The stored picture, without running a sweep. */
r.get('/trends/watch', (req, res, next) => {
  try {
    const lookback = Math.max(2, Math.min(6, Number(req.query.lookback) || 3));
    const history = trendHistory({ season: Number(req.query.season) || null, lookback });
    res.json({
      ...history,
      conflicts: history.season ? conflicts(history.season, null, lookback).conflicts : []
    });
  } catch (e) { next(e); }
});

/**
 * Touchdown luck, and who it is about to stop favouring.
 *
 * Touchdown rate is the least stable number in football while target share is
 * among the most stable, so the gap between a player's touchdowns and his
 * opportunities is the most reliable inefficiency in the sport.
 */
r.get('/:leagueId/regression', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(regressionForLeague(lg.id, {
      myTeamId: req.query.team_id ?? null,
      season: Number(req.query.season) || null,
      throughWeek: Number(req.query.week) || null
    }));
  } catch (e) { next(e); }
});

/** The league-wide board, without a roster join. */
r.get('/regression/board', (req, res, next) => {
  try {
    res.json(regressionCandidates({
      season: Number(req.query.season) || null,
      throughWeek: Number(req.query.week) || null,
      minOpportunities: Math.max(5, Math.min(200, Number(req.query.min_opportunities) || 20))
    }));
  } catch (e) { next(e); }
});

/** The fitted conversion rates themselves, per position group. */
r.get('/regression/rates', (_req, res, next) => {
  try { res.json(touchdownRates()); } catch (e) { next(e); }
});

/**
 * Who to start this week, with every call graded by how close it was.
 *
 * `objective` chooses what to maximise: the average, the ceiling when you are an
 * underdog and need a tail, or the floor when you are favoured and variance can
 * only cost you.
 */
r.get('/:leagueId/lineup', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const objective = ['mean', 'ceiling', 'floor'].includes(req.query.objective)
      ? req.query.objective : 'mean';
    res.json(lineupCall(lg.id, { myTeamId: req.query.team_id ?? null, objective }));
  } catch (e) { next(e); }
});

/** Who will actually trade with you. Read, and write. */
r.get('/:leagueId/brain/managers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(managerProfiles(lg.id));
  } catch (e) { next(e); }
});

r.post('/:leagueId/brain/managers/:rosterId', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const out = setManagerProfile(lg.id, req.params.rosterId, {
      tradeability: req.body?.tradeability,
      notes: req.body?.notes ?? null,
      owner: req.body?.owner ?? null
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------- the measured manager layer */

/**
 * THE READ SIDE OF THE SIGNAL LAYER.
 *
 * `/brain/managers` above serves `manager_profiles`: the tier Nick typed in. This
 * serves what has actually been MEASURED about each manager — manager_signals
 * (roster, standings, transactions, draft, outcome, chat, Nick's priors), the
 * identity joins those rest on, and the receptiveness the trade finder prices
 * with. Until now none of it was readable anywhere: it reached the client only
 * embedded inside each deal's `counterparty` block, so a page could not show a
 * manager read at all, let alone say what it rests on.
 *
 * DEGRADES HONESTLY, BY CONSTRUCTION. Four of the five leagues have no chat
 * corpus and none of them has signals until the build has run, so `available`
 * and `reason` carry that in the same words counterparty-pricing.js already uses
 * rather than shipping an empty page that looks like a finding. Nothing is
 * synthesised here: every number in `signals` is a stored row, with the sample it
 * rests on and whether its source may price anything. A metric withheld at build
 * time for sample size (`tx_accept_rate` below five decided offers) is simply not
 * in the table, so it cannot appear here as if it had been measured.
 */
const NO_MANAGER_SIGNALS_REASON =
  'no manager signals for this league yet — scripts/build-manager-signals.mjs has not built it';

/**
 * `res.json()` turns a Map or a Set into `{}` — silently, with a 200. That bug
 * has already happened in this codebase (valuationMap and counterpartyLayer both
 * hand back Maps of Maps, and `owned` is a Set), and this payload is assembled
 * out of exactly those objects. So everything served below goes through here:
 * a Map becomes an object, a Set an array, and nothing reaches the client as an
 * empty object that was really data.
 */
function jsonSafe(value) {
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), jsonSafe(v)]));
  if (value instanceof Set) return [...value].map(jsonSafe);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/**
 * One stored signal, with what its source is allowed to be used for and why.
 *
 * `priceable` is LOAD-BEARING, not decoration. The `manager_signals` table has no
 * such column — SIGNAL_SOURCES carries it per source — so the join has to happen
 * here, and a consumer left to guess from the sample size alone would print a
 * draft-sourced metric with a big `n` as a measured fact. `draft` is the one
 * declared source with `priceable: false`, because no draft metric survived the
 * year-over-year repeatability test, and that is exactly the number this layer
 * exists to stop anyone pricing on.
 *
 * `why` is derived from the same registry (its label and its refresh cadence),
 * never written per metric: there is no per-metric explanation in the data, and
 * inventing one would be the first thing here to quietly stop being true.
 */
function signalOf(r) {
  const spec = SIGNAL_SOURCES[r.source] ?? null;
  const priceable = spec?.priceable ?? false;
  return {
    metric: r.metric, value: r.value, n: r.n, source: r.source, priceable,
    why: spec
      ? `${spec.label}; refreshed ${spec.refreshed}${priceable ? '' : ' — context only, never priced'}`
      : `source '${r.source}' is not declared in SIGNAL_SOURCES, so nothing may price on it`,
  };
}

async function managerSignalsPayload(lg, { week = null } = {}) {
  const leagueId = lg.id;
  const season = lg.season ?? null;
  const signalRows = rows(`SELECT roster_id, metric, value, n, source, computed_at FROM manager_signals
                           WHERE league_id = ? ORDER BY roster_id, source, metric`, leagueId);
  const computedAt = signalRows.reduce((max, r) => (max == null || r.computed_at > max ? r.computed_at : max), null);
  const byRoster = new Map();
  for (const r of signalRows) {
    if (!byRoster.has(r.roster_id)) byRoster.set(r.roster_id, []);
    byRoster.get(r.roster_id).push(signalOf(r));
  }

  // The synced payload is the roster set of record — a manager with no signals
  // yet still belongs in the list, saying so. A league whose payload cannot be
  // read falls back to whatever rows exist rather than answering with nothing.
  let payload = null;
  try { payload = JSON.parse(lg.payload); } catch { payload = null; }
  const teams = payload?.teams ?? [];
  const memberName = new Map((payload?.members ?? []).map(m => [m.id,
    `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.displayName || null]));
  const teamById = new Map(teams.map(t => [String(t.id), t]));
  const idents = new Map(identityRows(leagueId).map(r => [String(r.roster_id), r]));
  const profiles = new Map(rows('SELECT roster_id, tradeability, owner FROM manager_profiles WHERE league_id = ?',
    leagueId).map(r => [String(r.roster_id), r]));
  // Trusted chat identities only — a `likely` name match is not a corpus, it is
  // a warning (identityWarnings), and attributing chat to it is the one failure
  // manager-identity.js exists to prevent.
  const chatIdentities = identityMap(leagueId);

  // Receptiveness and the negotiation profile come from the layer the trade
  // finder itself prices with, so this page and a trade card cannot disagree.
  // `rosterContext: new Map()` deliberately skips deriveRosterNeeds, which runs
  // the whole league analysis (assetUniverse and a lineup solve per team) for
  // positional needs this contract does not carry.
  let layer = null;
  let layerError = null;
  if (signalRows.length) {
    try { layer = counterpartyLayer(leagueId, { season, week, rosterContext: new Map() }); }
    catch (e) { layerError = String(e?.message ?? e); }
  }
  // The archetype store is the weekly feature warehouse; it is imported here,
  // lazily, rather than at the top of the trade path (the same line
  // counterparty-pricing.js draws) and an absent store is simply no archetype.
  let archetypes = new Map();
  try {
    const { archetypesFor } = await import('../services/manager-archetypes.js');
    archetypes = archetypesFor(leagueId, season);
  } catch { archetypes = new Map(); }

  const rosterIds = teams.length
    ? teams.map(t => String(t.id))
    : [...new Set([...idents.keys(), ...byRoster.keys()])].sort((a, b) => Number(a) - Number(b));

  const managers = rosterIds.map(id => {
    const team = teamById.get(id) ?? null;
    const ident = idents.get(id) ?? null;
    const mp = layer?.get(id) ?? null;
    return {
      roster_id: id,
      owner: memberName.get((team?.owners ?? [])[0]) ?? ident?.espn_name ?? profiles.get(id)?.owner
        ?? team?.name ?? null,
      corpus: chatIdentities.has(id),
      // null, not 'fair': "nobody has said" and "he was judged tradeable" are
      // different facts, and league-brain.js's default hides the difference.
      tradeability_set: profiles.get(id)?.tradeability ?? null,
      archetype: archetypes.get(id) ?? null,
      receptiveness: mp ? {
        value: mp.receptiveness, range: RECEPTIVENESS_RANGE,
        chat_msgs: mp.chat_msgs, chat_weight: mp.chat_weight,
        open_to_trade_pct: mp.open_to_trade_pct, trade_talk_pct: mp.trade_talk_pct,
        accept_rate: mp.accept_rate, accept_rate_n: mp.accept_rate_n,
        untouchable_rate: mp.untouchable_rate ?? null,
        word_stance: mp.stance?.stance ?? null, word_note: mp.stance?.note ?? null,
        priors: mp.priors ?? {},
        factors: mp.receptiveness_factors ?? [],
      } : null,
      negotiation: mp?.negotiation ? { messages_read: mp.negotiation_n ?? 0, profile: mp.negotiation } : null,
      signals: byRoster.get(id) ?? [],
    };
  });

  return jsonSafe({
    league: { id: leagueId, name: lg.name ?? null, season, week: week ?? null },
    available: signalRows.length > 0,
    reason: signalRows.length
      // A layer that could not be built is reported rather than left as a silent
      // null receptiveness; the stored signals below it are still measured.
      ? (layerError ? `the signals are built, but the receptiveness layer failed: ${layerError}` : null)
      : NO_MANAGER_SIGNALS_REASON,
    computed_at: computedAt,
    sources: SIGNAL_SOURCES,
    identity_warnings: identityWarnings(leagueId),
    managers,
  });
}

/** What has been measured about every manager in one league, and what it rests on. */
r.get('/:leagueId/managers/signals', async (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    let week = null;
    try { week = leagueCurrentWeek(lg); } catch { week = null; }
    res.json(await managerSignalsPayload(lg, { week }));
  } catch (e) { next(e); }
});

/**
 * REBUILD THE LAYER — the only route in this file that makes work happen, so the
 * only one behind the administrator grant (`/api/trades` mounts
 * legacyAuthenticated, which is a valid session and nothing more).
 *
 * `{ "league_ids": [4] }` narrows it; omitted, every ESPN league is rebuilt.
 * Safe to call repeatedly: the service rewrites a league only when its result
 * differs from what is stored, so an idle re-run leaves every timestamp alone
 * (`unchanged: true`). One failing league never fails the call — the service
 * isolates each league in its own try/catch and this reports what it said.
 */
r.post('/managers/rebuild', requirePlatformAdmin, (req, res, next) => {
  try {
    const raw = req.body?.league_ids;
    if (raw != null && !Array.isArray(raw)) {
      return res.status(400).json({ error: 'league_ids must be an array of league ids' });
    }
    const ids = raw == null ? null : raw.map(Number).filter(Number.isFinite);
    if (ids && !ids.length) {
      return res.status(400).json({ error: 'league_ids was given but holds no usable league id' });
    }
    const out = refreshManagerData(ids ? { leagueIds: ids } : {});
    res.json({
      status: out.status, chat_db: out.chat_db, ms: out.ms, requested: ids,
      leagues: (out.leagues ?? []).map(l => ({
        league_id: l.league_id, name: l.name ?? null,
        // Exactly one of these three is the story for a league: it was not
        // eligible, it failed, or it built.
        skipped: l.skipped ?? null,
        error: l.error ?? null,
        chat_corpus: l.chat_corpus ?? false,
        unchanged: l.unchanged ?? null,
        signals: l.signals ?? 0,
        player_views: l.player_views ?? 0,
        rosters: l.rosters ?? 0,
        rosters_with_signals: l.rosters_with_signals ?? 0,
        rosters_with_chat: l.rosters_with_chat ?? 0,
        by_source: l.by_source ?? null,
        identities: l.identities ?? null,
        archetypes: l.archetypes ?? null,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * News the league has not reacted to yet, turned into actions.
 *
 * The only surface in this app where we hold a structural advantage over our
 * opponents rather than a hoped-for one — this pipeline runs on a timer and
 * your leaguemates do not.
 */
r.get('/:leagueId/news-edge', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(newsOpportunities(lg.id, {
      myTeamId: req.query.team_id,
      hours: Math.min(24 * 21, Number(req.query.hours) || 72)
    }));
  } catch (e) { next(e); }
});

/**
 * The lineup built for the outcome you need rather than the highest average.
 *
 * `objective=mean` reproduces the classic optimiser so the two can be compared
 * on identical draws — which is the entire point of the feature.
 */
r.get('/:leagueId/ceiling-lineup', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(ceilingLineup(lg.id, {
      teamId: req.query.team_id,
      week: Math.min(18, Math.max(1, Number(req.query.week) || leagueCurrentWeek(lg))),
      objective: req.query.objective === 'mean' ? 'mean' : 'ceiling',
      target: req.query.target ? Number(req.query.target) : null,
      trials: Math.min(8000, Number(req.query.trials) || 3000)
    }));
  } catch (e) { next(e); }
});

/**
 * Trades ranked by championship odds instead of points. Cached and slow on a
 * cold call — each shortlisted deal is a paired season simulation.
 */
r.get('/:leagueId/title-trades', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(titleOddsTrades(lg.id, {
      teamId: req.query.team_id,
      shortlist: Math.min(12, Math.max(3, Number(req.query.shortlist) || 6)),
      runs: Math.min(2000, Number(req.query.runs) || 800)
    }));
  } catch (e) { next(e); }
});

/**
 * Was I wrong, or unlucky? Separates decision cost from projection error from
 * variance for a completed week.
 */
r.get('/:leagueId/postmortem', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const lineup = idList(req.query.lineup);
    res.json(weekPostmortem(lg.id, {
      teamId: req.query.team_id,
      season: Number(req.query.season) || undefined,
      week: Math.min(18, Math.max(1, Number(req.query.week) || leagueLastCompletedWeek(lg))),
      lineup: lineup.length ? lineup : null
    }));
  } catch (e) { next(e); }
});

/**
 * The waiver wire, ranked by points added to the starting lineup.
 *
 * Measured worth: a team that works the wire gains about 3.4 percentage points
 * of all-play win rate against teams in the same league that do not, positive
 * in all five replayed seasons. That is roughly half the best draft-structure
 * edge and it is available every week rather than once a year.
 */
r.get('/:leagueId/waivers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(waiverBoard(lg, {
      myTeamId: req.query.team_id,
      limit: Math.min(50, Math.max(5, Number(req.query.limit) || 20)),
      minProjected: Number(req.query.min_projected) || 4,
    }));
  } catch (e) { next(e); }
});

/**
 * Floor or ceiling, against THIS week's opponent.
 *
 * Maximising expected points is the wrong objective in a head-to-head week. As
 * a heavy underdog the safe lineup loses slowly; as a heavy favourite variance
 * is the only way you lose. The effect is small and conditional — below
 * lineup-posture.js MATERIAL_EDGE (23 points) one typical swap moves win
 * probability by under 0.3pp — so this deliberately says nothing in close
 * matchups rather than inventing advice.
 */
r.get('/:leagueId/posture', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(lineupPosture(lg, { myTeamId: req.query.team_id, week: req.query.week }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ decision inbox */
/**
 * "What should I actually do today" — the Dashboard's Phase 1 flagship item
 * from the platform audit. Deliberately not a new analysis engine: every
 * signal here is something the app already computes (selfScout's prioritized
 * fixes, findTrades' real mutual-win deals, news_items' importance flag) —
 * this just merges them into one ranked queue instead of leaving them
 * scattered across three separate pages the user has to remember to check.
 */
r.get('/:leagueId/inbox', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const teamId = req.query.team_id;
    const items = [];

    const scout = selfScout(lg, teamId);
    if (!scout.error) {
      for (const f of scout.fixes.slice(0, 3)) {
        items.push({
          type: 'roster', priority: f.priority, title: f.issue, action: f.action,
          link: '/my-team'
        });
      }

      // MAJOR news about a team any of my rostered players actually plays for —
      // not a global news skim, scoped to what could move my own lineup.
      const myTeamAbbrs = [...new Set(scout.lineup.slots.map(s => s.player?.team_abbr).filter(Boolean)
        .concat(scout.lineup.bench.map(p => p.team_abbr).filter(Boolean)))];
      if (myTeamAbbrs.length) {
        const placeholders = myTeamAbbrs.map(() => '?').join(',');
        const news = rows(`SELECT n.headline, n.fantasy_impact, n.date, t.abbr AS team_abbr
                           FROM news_items n JOIN nfl_teams t ON t.id = n.team_id
                           WHERE n.importance = 3 AND t.abbr IN (${placeholders})
                             AND n.date >= date('now', '-7 days')
                           ORDER BY n.date DESC LIMIT 3`, ...myTeamAbbrs);
        for (const n of news) {
          items.push({
            type: 'news', priority: 'high',
            title: n.headline, action: n.fantasy_impact || `Major ${n.team_abbr} news this week — check the impact.`,
            link: `/teams/${n.team_abbr}`
          });
        }
      }
    }

    // One real, mutual-win trade if one exists — not the whole board, just
    // "here's a deal actually worth looking at today."
    if (teamId) {
      const trades = findTrades(lg, { myTeamId: teamId, requireMutual: true, limit: 5 });
      const best = (trades.deals ?? []).find(d => d.mutual);
      if (best) {
        items.push({
          type: 'trade', priority: 'medium',
          title: `${best.partner} would plausibly take a deal that helps both lineups`,
          action: `${best.i_give.map(p => p.name).join(' + ')} for ${best.i_get.map(p => p.name).join(' + ')}`,
          link: '/trade-lab'
        });
      }
    }

    const rank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2));
    res.json({ items: items.slice(0, 6) });
  } catch (e) { next(e); }
});

/* --------------------------------------------------- submitted vs. recommended */
r.get('/:leagueId/lineup-diff', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const diff = lineupDiff(lg, req.query.team_id);
    if (diff.not_found) return res.status(404).json({ error: diff.error });
    res.json(diff);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ trade finder */
r.get('/:leagueId/find', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(findTrades(lg, {
      myTeamId: req.query.team_id,
      maxPerSide: Math.min(3, Number(req.query.max_per_side) || 2),
      // Off by default in the UI's "aggressive" mode: deals that only help me are
      // still worth seeing, they just need a better sales pitch.
      requireMutual: req.query.mutual !== '0',
      // The search itself already evaluates every combination regardless of this
      // number — it only controls how much of the already-fully-computed, sorted,
      // deduplicated result gets returned. Raised well past the old 50 so the
      // trade-finder's reload has real distinct ideas to page through across many
      // clicks before it has to honestly say the well is dry, rather than
      // silently re-serving (or worse, being unable to serve) the same top 50.
      limit: Math.min(300, Number(req.query.limit) || 20),
      targetId: req.query.target_id || null,
      excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/**
 * The AI pass: the top numeric ideas, written up as messages Nick can send.
 *
 * Budgeted per league ($0.50/day, enforced inside callClaude) and cached on the
 * slate's content, so re-opening the page costs nothing and an unchanged slate
 * never re-spends. A refusal — budget gone, no key, the model inventing things
 * — comes back as `refused` with its reason rather than an empty list that
 * would read like "no good trades today".
 */
r.get('/:leagueId/proposals', async (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    // The model only ever sees ideas that already passed the edge test, because
    // that filter lives inside findTrades and runs before this point.
    const found = findTrades(lg, {
      myTeamId: req.query.team_id,
      requireMutual: req.query.mutual !== '0',
      // Fixed at D4's "top ~12", deliberately NOT caller-controlled. The cache
      // key is a hash of the slate, so a caller free to vary the limit could
      // mint a fresh key per value — 12 distinct keys, 12 paid Sonnet calls for
      // the same league on the same day, against a budget that is not per-league.
      limit: PROPOSAL_SLATE_SIZE,
    });
    const ideas = found?.deals ?? [];
    // Every player on a roster in this league, not merely the ones in the
    // returned deals. The failure mode this guards against is a proposal
    // offering someone who exists in the league but is in no idea here — and a
    // universe built from the deals themselves is blind to exactly that.
    const universe = found?.league_player_names ?? [];
    res.json(await proposalsFor(lg.id, {
      ideas, universe, call: liveCaller(callClaude), cache: dbCache(lg.id),
    }));
  } catch (e) { next(e); }
});

/** "Do this trade, then this one opens up" — see findTradeSequences(). */
r.get('/:leagueId/find/sequences', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(findTradeSequences(lg, {
      myTeamId: req.query.team_id,
      maxPerSide: Math.min(3, Number(req.query.max_per_side) || 2),
      requireMutual: req.query.mutual !== '0',
      excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------------- "what do I offer for X" */
r.get('/:leagueId/offer', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!req.query.player_id) return res.status(400).json({ error: 'player_id required' });
    res.json(offerFor(lg, {
      myTeamId: req.query.team_id, targetId: req.query.player_id, excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------- "what do I offer for THEM" */
r.get('/:leagueId/offer-many', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const raw = String(req.query.player_ids ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'player_ids required (comma-separated)' });
    res.json(offerForMany(lg, {
      myTeamId: req.query.team_id, targetIds: raw.split(',').map(Number).filter(Number.isFinite),
      excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- manual mock trade builder */
/**
 * Score an arbitrary two-sided package. This is the "build your own trade and see
 * who wins" path — the same evaluator the finder uses, driven by hand.
 */
r.post('/:leagueId/evaluate', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const { formatKey } = deriveFormat(lg);
    const assets = assetUniverse(lg, formatKey);
    const teams = loadRosters(lg, assets);
    const slots = lineupSlots(lg);

    const meId = String(req.body?.my_team_id ?? lg.my_team_id ?? teams[0]?.roster_id);
    const me = teams.find(t => t.roster_id === meId);
    const pick = ids => (ids ?? []).map(id => resolvePlayer(id, assets, teams)).filter(Boolean);
    const gives = pick(req.body?.give);
    const gets = pick(req.body?.get);
    if (!me) return res.status(400).json({ error: 'your team not found' });
    if (!gives.length && !gets.length) return res.status(400).json({ error: 'pick at least one player on each side' });

    // Infer the counterparty from whoever owns the incoming players, unless told.
    const them = req.body?.their_team_id
      ? teams.find(t => t.roster_id === String(req.body.their_team_id))
      : teams.find(t => t.roster_id !== meId && gets.some(g => t.players.some(p => p.id === g.id)));
    if (!them) return res.status(400).json({ error: 'could not work out who you are trading with — pass their_team_id' });

    res.json({ ...evaluate({ team: me, gives }, { team: them, gives: gets }, slots), slots });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------- rosters for the UI */
r.get('/:leagueId/rosters', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const { formatKey } = deriveFormat(lg);
    const assets = assetUniverse(lg, formatKey);
    const teams = loadRosters(lg, assets);
    const slots = lineupSlots(lg);
    res.json({
      my_team_id: lg.my_team_id,
      model_context: assets.context,
      slots,
      teams: teams.map(t => {
        const line = bestLineup(t.players, slots);
        const starters = new Set(line.slots.map(s => s.player?.id).filter(Boolean));
        return {
          roster_id: t.roster_id, owner: t.owner, lineup_ppg: line.points,
          players: t.players
            .map(p => ({
              id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
              espn_id: p.espn_id, sleeper_id: p.sleeper_id,
              value: p.value, proj: p.proj, ppg: p.ppg, adj_ppg: p.adj_ppg,
              // No sos/playoff_sos: both are 1 with no validated signal (matchups.js).
              age: p.age, bye: p.bye, injury: p.injury,
              starter: starters.has(p.id)
            }))
            .sort((a, b) => Number(b.starter) - Number(a.starter) || b.adj_ppg - a.adj_ppg)
        };
      })
    });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- player deep dive */
r.get('/:leagueId/player/:id', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(playerOutlook(lg, req.params.id));
  } catch (e) { next(e); }
});

/* -------------------------------------------------- defense-vs-position table */
r.get('/dvp', (req, res, next) => {
  try {
    const pos = String(req.query.position ?? 'WR').toUpperCase();
    if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) return res.status(400).json({ error: 'position must be QB/RB/WR/TE' });
    // Points allowed is history, not a forecast: the DvP multiplier failed the
    // weekly walk-forward test, so the table says so alongside the numbers.
    res.json({ position: pos, seasons: matchupModel().seasons, signal: matchupSignalActive(),
      reason: matchupSignalActive() ? null : MATCHUP_SIGNAL_REASON, table: dvpTable(pos) });
  } catch (e) { next(e); }
});

/** Opponent-history splits for one player: "when he plays X he usually does Y". */
r.get('/splits/:playerId', (req, res, next) => {
  try {
    const p = row(`SELECT p.id, p.name, p.position, t.abbr FROM players p
                   LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, req.params.playerId);
    if (!p) return res.status(404).json({ error: 'player not found' });
    res.json({ ...p, ...relevantSplits(p.id, p.abbr, 5) });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- AI sense check */
/**
 * An independent read on a deal the deterministic engine already scored — not a
 * pitch, a second opinion. The lineup/value math is real, but it can't see things
 * like "three of these five guys are all hurt" or "the reason their VOR is thin at
 * this spot is he's on a bye the same week two of my other guys are" — the kind of
 * thing a person actually trading would notice on sight. Claude is told the full
 * deal (every field the engine computed, not just a summary) and instructed to
 * work only from that data, so this can disagree with the engine's own verdict
 * when the numbers miss something real, but can't invent a fact that isn't there.
 *
 * SIMULATION-CHECKED SINCE 2026-09-07. The verdict is no longer the last word.
 * `season-sim.js#tradeImpact()` plays the rest of the season out hundreds of
 * times with the deal and without it — the same simulated football on both sides
 * of the diff — and reports what it does to BOTH teams' championship odds. If
 * those numbers clearly contradict the verdict Claude proposed, Claude gets the
 * numbers and exactly ONE re-think; never a loop. The response carries a
 * `verification` block saying whether the first read held or was corrected.
 * See docs/TRADE_LAB_VERIFY_LOOP.md.
 */
r.post('/:leagueId/sense-check', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const lg = league(req, res); if (!lg) return;
    const d = req.body?.deal;
    if (!d?.me || !d?.them) return res.status(400).json({ error: 'deal required' });

    // Evidence is recomputed server-side from the player id (the deal body is
    // client-supplied); what the client sent is only the fallback.
    const withEvidence = p => ({ ...p, ...(p?.id != null ? playerEvidence(p.id) : {}) });
    const fmtPlayer = raw => {
      const p = withEvidence(raw);
      const head = `${p.name} (${p.position}${p.team_abbr ? ` ${p.team_abbr}` : ''}) — ` +
        `proj ${p.proj ?? '?'} pts, ${p.adj_ppg ?? '?'} adj ppg, market value ${p.value ?? '?'}` +
        `${p.age != null ? `, age ${p.age}` : ''}${p.bye ? `, bye week ${p.bye}` : ''}` +
        `${p.injury ? ', INJURY FLAG' : ''}${p.floor != null ? `, floor/ceiling ${p.floor}/${p.ceiling}` : ''}` +
        `${p.consistency != null ? `, consistency ${p.consistency}` : ''}`;
      // No playoff-schedule line: no schedule-strength signal has passed testing
      // (matchups.js), so the prompt must not hand Claude one to reason from.
      // Season-by-season record, streaks, our preseason band and drivers, the
      // offseason read — the evidence the second opinion has to argue from.
      const lines = evidenceLines(p);
      return [head, ...lines.map(l => `  ${l}`)].join('\n    ');
    };

    const fmtRisk = risk => risk?.out && risk?.in
      ? `  Floor read: ${risk.read ? `${risk.read}; ` : ''}sends ${risk.out.top24_seasons}/${risk.out.seasons} top-24 seasons` +
        `${risk.out.swing_pct != null ? `, ±${risk.out.swing_pct}% swing` : ''}; receives ${risk.in.top24_seasons}/${risk.in.seasons} top-24 seasons` +
        `${risk.in.swing_pct != null ? `, ±${risk.in.swing_pct}% swing` : ''}`
      : '';

    const fmtSide = (label, s) => `${label} (${s.owner}):
  Sends: ${s.gives.length ? s.gives.map(fmtPlayer).join('\n    ') : 'nothing'}
  Receives: ${s.gets.length ? s.gets.map(fmtPlayer).join('\n    ') : 'nothing'}
  Starting lineup: ${s.lineup_before} -> ${s.lineup_after} ppg (${s.ppg_delta > 0 ? '+' : ''}${s.ppg_delta}/wk, ${s.season_delta > 0 ? '+' : ''}${s.season_delta} over the season)
  Market value: ${s.value_delta > 0 ? '+' : ''}${s.value_delta}
  Starting lineup's weekly total, change in its bad week (10th percentile) / good week (90th percentile): ${s.floor_delta ?? '?'}/${s.ceiling_delta ?? '?'}
${fmtRisk(s.risk)}
  ${s.new_holes?.length ? `Leaves an unfilled starting slot at: ${s.new_holes.join(', ')}` : 'Fills every starting slot'}`;

    const proposePrompt = `You are an experienced fantasy football manager giving a second opinion on a trade someone is
considering. A deterministic engine already scored it on lineup points and market value — your job is
to sanity-check that math against things a person would actually notice, not to re-derive the numbers.

THE DEAL

${fmtSide('MY SIDE', d.me)}

${fmtSide('THEIR SIDE', d.them)}

Engine's read: fairness "${d.fairness}", both lineups improve: ${d.mutual ? 'yes' : 'no'}, deal considered plausible: ${d.plausible ? 'yes' : 'no'}.
${d.red_flags?.length ? `Engine already flagged: ${d.red_flags.join('; ')}.` : 'Engine raised no roster-fit flags.'}
${d.their_window ? `Their team's situation: ${d.their_window.label} — ${d.their_window.stance}` : ''}

Look specifically for things the lineup/value math cannot see on its own:
- Bye-week collisions between the players changing hands and each other (not the rest of either
  roster — you don't have that).
- Injury-flagged players stacked on one side, or an injury flag on the single biggest piece of a deal.
- Age or workload concerns severe enough to matter beyond what "market value" already prices in.
- Whether this trade actually matches the "their team's situation" framing above, or contradicts it
  (e.g. a supposed rebuilder taking on an older proven vet instead of youth).
- Anything about the engine's own verdict that doesn't hold up once you look at who's actually moving.
- Whether one side is giving up a multi-season floor for a single-season spike: compare the
  season-by-season records above (seasons top-24, games played, year-to-year swing), not reputations.
${d.verdict_evidence ? `Engine's evidence line (my side): ${d.verdict_evidence}` : ''}

${STAT_ROOTED_INSTRUCTIONS}

Work ONLY from the data given above — never invent a stat, injury, or fact not listed. If you have
nothing real to flag in a category, say so plainly rather than manufacturing a concern.

Respond with ONLY JSON:
{"verdict":"one of: sound / worth a second look / risky / lopsided",
 "headline":"one sentence — your overall take, independent of the engine's verdict, and its FIRST clause is a concrete multi-season number from a record above (e.g. '1,000+ rec yds in 4 straight seasons for a 1-year spike')",
 "evidence":"one line: the 2-3 numbers from the records above that decide this deal, comma-separated, no adjectives",
 "concerns":["0-4 short, specific, concrete concerns grounded in the data above — omit entirely if none"],
 "agrees_with_engine": true or false,
 "why": "2-3 sentences on why you agree or disagree with the engine's plausibility call"}`;

    /* ------------------------------------------- propose → verify → retry once
     * The trade is fully specified by the request body, so the season simulation
     * has no dependency on Claude's answer and is started while the propose call
     * is still in flight. What is new here is only that the verdict now has to
     * survive a simulated season; the proposal itself is the call this route has
     * always made, with the same prompt. */
    const { args: simArgs, reason: notSimulatable } = simulationArgsFor(lg, d);
    const runs = Math.min(2000, Math.max(200, Number(req.body?.sim_runs) || SENSE_CHECK_SIM_RUNS));

    const payload = await proposeVerifyRetryTrade({
      propose: async () => parseJson(await callClaude({
        feature: 'trade-sense-check', maxTokens: 1100, prompt: proposePrompt
      })),

      /**
       * `tradeImpact()` runs the league twice under common random numbers — the
       * same simulated seasons with the deal and without it — so the delta is
       * the trade and not the gap between two noisy runs. It returns BOTH sides
       * from that one paired run, which is why checking both teams costs nothing
       * extra.
       *
       * A fixed seed keeps a given deal's answer reproducible: re-opening the
       * same card must not quietly produce a different verdict.
       *
       * Returns null rather than throwing when the deal cannot be resolved
       * against the real rosters — the second opinion is an optional layer and
       * must never fail the request; the payload comes back `unverified`.
       */
      simulate: () => {
        if (!simArgs) return null;
        try {
          const started = Date.now();
          const impact = tradeImpact(lg, { ...simArgs, runs, seed: 1 });
          return impact?.error ? impact : { ...impact, compute_ms: Date.now() - started };
        } catch (e) {
          console.warn(`[trade-sense-check] season simulation unavailable: ${e.message}`);
          return null;
        }
      },

      verify: (verdict, impact) => ({
        ...judgeTradeVerdict(impact ?? (notSimulatable ? { error: notSimulatable } : null), verdict),
        sim_compute_ms: impact?.compute_ms ?? null
      }),

      // The one bounded re-think: the full original context as the first turn,
      // the model's own verdict as the second, the simulation's numbers as the
      // third — so it is reconsidering its own reasoning rather than answering a
      // fresh, thinner question.
      retry: async (judgement) => parseJson(await callClaude({
        feature: 'trade-sense-check-retry', maxTokens: 700,
        messages: [
          { role: 'user', content: proposePrompt },
          { role: 'assistant', content: JSON.stringify({ verdict: judgement.proposed_verdict }) },
          { role: 'user', content: tradeChallengeText(judgement) }
        ]
      }))
    });

    res.json(payload);
  } catch (e) { next(e); }
});

/**
 * Turn the client-supplied deal into `tradeImpact()` arguments.
 *
 * Returns `{ args }` when the deal is simulatable and `{ reason }` when it is
 * not — the reason is surfaced verbatim in the `unverified` note, because "no
 * check happened" is only useful if it says which check and why.
 *
 * The deal body comes from the browser, so every id in it is re-resolved against
 * the rosters as the server has them — the same discipline the evidence lines
 * above already follow. Both roster ids must be real teams in this league, every
 * player I am sending must actually be on my roster, and every player I am
 * receiving must actually be on theirs. A deal that fails any of those is not
 * simulated at all rather than simulated wrongly: `tradeImpact` would happily
 * accept an id nobody owns and silently report the impact of a trade that gives
 * away nothing, which is a confident wrong answer dressed as a check.
 */
function simulationArgsFor(lg, d) {
  try {
    const { formatKey } = deriveFormat(lg);
    const teams = loadRosters(lg, assetUniverse(lg, formatKey));
    const myTeamId = String(d.me?.roster_id ?? lg.my_team_id ?? '');
    const theirTeamId = String(d.partner_id ?? d.them?.roster_id ?? '');
    const me = teams.find(t => t.roster_id === myTeamId);
    const them = teams.find(t => t.roster_id === theirTeamId);
    if (!me || !them) return { reason: 'the two teams in this deal could not be matched to live rosters' };

    const ids = list => (list ?? []).map(p => Number(p?.id)).filter(Number.isFinite);
    const iGive = ids(d.i_give ?? d.me?.gives);
    const iGet = ids(d.i_get ?? d.me?.gets);
    if (!iGive.length && !iGet.length) return { reason: 'the deal names no players on either side' };

    const owns = (team, id) => team.players.some(p => p.id === id);
    if (!iGive.every(id => owns(me, id)) || !iGet.every(id => owns(them, id))) {
      return { reason: 'a player in this deal is not on the roster the deal says he is on — '
        + 'the league may have changed since the deal was built' };
    }
    return { args: { myTeamId, theirTeamId, iGive, iGet } };
  } catch (e) {
    return { reason: `the rosters could not be loaded: ${e.message}` };
  }
}

/* --------------------------------------------------------- AI negotiation copy */
/**
 * Turn a scored deal into something you can actually send. The maths is done and
 * passed in — Claude only writes the pitch, the counter-read, and the walk-away line.
 */
r.post('/:leagueId/explain', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const lg = league(req, res); if (!lg) return;
    const d = req.body?.deal;
    if (!d?.me || !d?.them) return res.status(400).json({ error: 'deal required' });

    const fmtSide = s => `${s.owner}: sends ${s.gives.map(p => p.name).join(' + ') || 'nothing'}; ` +
      `lineup ${s.lineup_before} -> ${s.lineup_after} ppg (${s.ppg_delta > 0 ? '+' : ''}${s.ppg_delta}), ` +
      `market value ${s.value_delta > 0 ? '+' : ''}${s.value_delta}`;
    // One stat-rooted line per player changing hands, so the pitch can say
    // "1,000+ rec yds in 3 straight seasons" instead of "a solid WR2".
    const records = [...(d.me.gives ?? []), ...(d.me.gets ?? [])]
      .map(p => ({ name: p.name, headline: evidenceHeadline({ ...p, ...(p?.id != null ? playerEvidence(p.id) : {}) }) }))
      .filter(x => x.headline)
      .map(x => `- ${x.name}: ${x.headline}`);

    // Untouchables never enter the search that produced this deal, but the pitch is
    // free-text — without telling the model who is off-limits, a "sweeten it with one
    // more piece" suggestion in the counter-read could name exactly the player you
    // marked protected.
    const untouchables = Array.isArray(req.body?.untouchables) ? req.body.untouchables.filter(Boolean) : [];

    const msg = await callClaude({
      feature: 'trade-explain',
      maxTokens: 900,
      prompt: `You are helping a manager send a fantasy football trade in a ${lg.team_count ?? 12}-team league.

The analysis is already done — do not re-argue the numbers, just use them.
${fmtSide(d.me)}
${fmtSide(d.them)}
Fairness on market price: ${d.fairness}. Both sides improve: ${d.mutual ? 'yes' : 'no'}.
${untouchables.length ? `Untouchable — never suggest offering these, not even as a sweetener: ${untouchables.join(', ')}.` : ''}
${records.length ? `Records (real, multi-season — cite these numbers in the pitch, never an adjective in their place):\n${records.join('\n')}` : ''}

Write the negotiation. Frame it around what THEY get, never mention that you ran an analysis, no fake urgency, no flattery. If the deal is lopsided in my favour, the pitch still has to sound reasonable to them.
${records.length ? `\n${STAT_ROOTED_INSTRUCTIONS}\n` : ''}
Respond with ONLY JSON:
{"pitch":"3-4 sentence message I can paste to them${records.length ? ' — cite at least one real multi-season number from the records above' : ''}",
 "evidence":"one line: the numbers from the records above the pitch rests on, comma-separated, no adjectives${records.length ? '' : ' (empty string if no records were given)'}",
 "their_counter":"the counter they are most likely to send, and how I should respond, 2 sentences",
 "walk_away":"one sentence — the point at which I decline",
 "risk":"one sentence — the single way this deal goes badly for me"}`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

export default r;
