/**
 * Trade engine API.
 *
 * Every route here answers without an API key — the analysis is deterministic. The
 * one exception is /explain, which hands a fully-scored deal to Claude purely to
 * write the negotiation copy; the numbers are already decided before it is called.
 */
import { Router } from 'express';
import { row, rows } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import {
  findTrades, findTradeSequences, offerFor, offerForMany, selfScout, playerOutlook, evaluate, lineupValueContext,
  assetUniverse, loadRosters, lineupSlots, bestLineup, resolvePlayer, lineupDiff, playerEvidence,
  tradeWeekContext
} from '../services/trade-engine.js';
// The same season-by-season prompt lines and "argue from the numbers" rules the
// draft advisor runs on (server/routes/drafts.js) — one voice for both rooms.
import { evidenceLines, evidenceHeadline, STAT_ROOTED_INSTRUCTIONS } from '../services/draft-assist.js';
import { dvpTable, matchupModel, matchupSignalActive, MATCHUP_SIGNAL_REASON } from '../services/matchups.js';
import { leagueCurrentWeek } from '../services/league-week.js';
import { waiverBoard } from '../services/waiver-wire.js';
import { streamingBoard } from '../services/streaming-board.js';
import { lineupPosture } from '../services/lineup-posture.js';
import { deriveFormat } from '../services/format.js';
import { marketAsOf, marketHistory } from '../services/dynasty-value-history.js';
import { newsOpportunities } from '../services/news-lag-trader.js';
import { managerProfiles, setManagerProfile } from '../services/league-brain.js';
// The measured manager layer: what has been observed about each counterparty, as
// opposed to `manager_profiles`, which is the tier Nick set by hand.
import { SIGNAL_SOURCES, refreshManagerData, signalRowsFor, transactionsCollected, chatCorpusState,
  archetypesBuilt }
  from '../services/manager-signals.js';
import { identityMap, identityRows, identityWarnings } from '../services/manager-identity.js';
import { counterpartyLayer, valuationMap, playerValuation, RECEPTIVENESS_RANGE, managerModelReads }
  from '../services/counterparty-pricing.js';
// Every other route in this file is a read behind a bearer session; the one that
// triggers work needs the administrator grant on top (server/platform/legacy-access.js).
import { requirePlatformAdmin } from '../platform/legacy-access.js';
import { proposalsFor, liveCaller, dbCache, PROPOSAL_SLATE_SIZE, PROMPT_VERSION }
  from '../services/trade-proposals.js';
import { recordProposalSlate, recordSentOffer } from '../services/trade-outcomes.js';
import { recordRoute } from '../services/rec-ledger.js';
import { offerLoopFields } from '../services/offer-loop-flag.js';
import { lineupCall } from '../services/lineup-brain.js';
import { lineupSignals } from '../services/lineup-signals.js';
import { ceilingLineup } from '../services/ceiling-lineup.js';
import { titleOddsTrades } from '../services/title-odds-trades.js';
import { tradeImpact, TRADE_IMPACT_RUNS } from '../services/season-sim.js';
// IDEA-001: served trade-card and title-trade numbers, queued for served_numbers.
import { recordServed, readServed, serveLogState } from '../services/serve-log.js';
// TM-09: historical revealed trade prices (aggregate table), read-only, default-off.
import { marketForPlayer } from '../services/trade-market.js';
import { playerHype } from '../services/hype.js';
import { warRoomView, loadPlans } from '../services/war-room-view.js';
import { logWarRoomShown } from '../services/war-room-log.js';
import { warRoomFlag } from '../services/warroom-flag.js';
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

/**
 * Shared preamble: every route needs a synced league THE CALLER IS IN.
 *
 * The membership check is here rather than on each route because this helper
 * is the single door all 32 league-scoped routes in this file go through, and
 * a rule enforced in one place cannot be forgotten by route 33. Until now it
 * looked up the league by id alone, so any authenticated user could read — and
 * through POST /:leagueId/brain/managers/:rosterId, write — any league in the
 * database. That was invisible while there was exactly one account and is the
 * first thing that matters once there are two.
 *
 * `assertLeagueMember` throws AuthorizationError, which the error handler in
 * server/index.js turns into a 403; that is the same answer leagues.js,
 * model.js and drafts.js already give, so a caller sees one consistent story.
 */
function league(req, res) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
  if (!lg) { res.status(404).json({ error: 'league not found' }); return null; }
  assertLeagueMember(req.auth?.userId, lg.id);
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

/* ------------------------------------------------- the brain, what is left of it */
/**
 * A route that existed and was deliberately removed. 410 (Gone), never 404, and
 * always with a pointer: a caller that finds a missing path deserves to be told
 * where the capability went, and a silent 404 reads like a bug.
 *
 * A tombstone is not free — it is code that must keep working — so it is earned
 * by having somewhere to point. The routes cut on 2026-09-20 had nowhere: no
 * page, script or test dialled them, and the capability was not moved, it was
 * abandoned. They are simply gone, and a 404 is the honest answer for a path
 * that never had a successor. `/splits/:playerId` is the one exception below.
 */
const retired = (use, why) => (_req, res) => res.status(410).json({
  error: `This endpoint was retired on 2026-09-18. ${why}`, use,
});


/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * `brainPlan` ranked its own enumerated deals by its own tier-based acceptance
 * curve, neither of which read the counterparty layer or the horizon — a second,
 * quietly different answer to "what trade should I send". Both are retired with
 * it (see league-brain.js).
 *
 * This comment used to promise the ranked weekly plan was "being rebuilt as a
 * deterministic service on the Decision Inbox (master plan 00, D5)". The
 * Decision Inbox was itself retired on 2026-09-20, so that successor does not
 * exist and the served message no longer claims one. The trade half is at
 * /find; the weekly plan across lineup, waivers and trades has no successor
 * today, and saying so is the point of a tombstone.
 */
r.get('/:leagueId/brain/plan', retired('/api/trades/:leagueId/find',
  'The plan\'s trade half was a second enumerator with its own acceptance curve. Trade ideas now come from one place, which prices how each manager reads a deal. The weekly plan across lineup, waivers and trades has no replacement today.'));


/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * `sellHigh` is still exported from waiver-brain.js, but (S-19) it is not an
 * input to the "outscoring his usage" tactic, which reads usage gaps
 * (talk-vs-model.js#expectationGaps); it now reads the one hype producer,
 * services/hype.js#playerHype. What is retired is serving it as its own page:
 * a list of players priced above their production curve, with no buyer attached
 * and no read on who overvalues them, is half an idea. The whole idea — who to
 * sell him to, what to ask, and whether that manager has talked him up — is a
 * trade idea, and trade ideas have one source.
 */
r.get('/:leagueId/brain/sell-high', retired('/api/trades/:leagueId/find',
  'Selling high on a player is a trade idea, not a list: the finder names the buyer, the package and how he reads it. Hype has one producer, services/hype.js#playerHype.'));













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
    const out = lineupCall(lg.id, { myTeamId: req.query.team_id ?? null, objective });
    recordRoute('lineup', lg, out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Who will actually trade with you, and what their lineups say. Read, and write. */
r.get('/:leagueId/brain/managers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    // What each manager's weekly lineups say (LS-01): measured lineup facts, with the
    // trade reading of them labelled a guess until its pre-registered test passes.
    res.json({ ...managerProfiles(lg.id), lineup_signals: lineupSignals(lg.id) });
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
 * The one error this page's archetype read is allowed to continue past.
 *
 * `league_season_teams` is created only by `scripts/backfill-league-history.mjs`,
 * so on a database where that has never run the read cannot succeed however
 * correct the code is. That is an absence, and absences are reported and
 * survived. Everything else — a renamed column, a corrupt file, a TypeError in
 * the archetype code — is a fault and must reach the error handler.
 *
 * Matching on the message is what node:sqlite gives us; it carries no error
 * code for this. The match is deliberately narrow: `no such column` and
 * `no such function` are faults and must NOT match.
 */
const isMissingTable = e => /no such table/i.test(String(e?.message ?? ''));

/**
 * The archetype object without the store's raw `jev`.
 *
 * `archetypesFor` carries the stored probabilities straight through: no
 * evaluation date, and no statement of which of them have evidence under them
 * and which are priors the model was told to give. The manager payload serves
 * `model_read` instead, which is the same answers dated and shaped, so this
 * strips the undated copy rather than leaving two shapes of one answer on one
 * page.
 */
/**
 * WHAT THE SEASON NUMBER ACTUALLY COVERS, in the explain prompt's own words.
 *
 * `season_delta` is the weekly lineup gain multiplied out. This sentence used
 * to say "a full 17-week season" on every date, so in week 15 a gain worth
 * three more weeks was handed to the model as seventeen and it reasoned about a
 * number five times the real one — a made-up span stated to a reader as a fact,
 * which is the same defect as an undated stamp in a different place.
 *
 * The lineup diff serves what it actually multiplied by (`season_delta_weeks`)
 * and whether that is the weeks left or a season-length default
 * (`season_delta_basis`). A payload carrying neither keeps the old wording:
 * guessing a count would be worse than the sentence it replaced.
 */
// TEST SEAM: exported for test/trade-season-span.test.js, which pins all three
// branches; the only production caller is `fmtSide` in the explain route below.
export const fmtSeasonSpan = s => {
  const weeks = s?.season_delta_weeks;
  if (!Number.isFinite(weeks)) return 'if that weekly gain held for a full 17-week season';
  const plural = weeks === 1 ? 'week' : 'weeks';
  return s?.season_delta_basis === 'full_season_default'
    ? `over ${weeks} ${plural}, the season-length default used when the weeks left are not known`
    : `over the ${weeks} ${plural} left in the season`;
};

const withoutRawJev = archetype => {
  if (!archetype) return null;
  const { jev: _rawUndated, ...rest } = archetype;
  return rest;
};

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

async function managerSignalsPayload(lg, { week = null } = {}) {
  const leagueId = lg.id;
  const season = lg.season ?? null;
  // `signalRowsFor` does the join, not this route. `priceable` is LOAD-BEARING,
  // not decoration: a consumer left to guess from the sample size alone would
  // print a draft-sourced metric with a big `n` as a measured fact, and `draft`
  // is declared priceable: false precisely because no draft metric survived the
  // year-over-year repeatability test. That rule used to live in a helper here,
  // in the one layer that prices nothing, while the layer that does price read
  // through an accessor that could not see it. It now lives beside the registry.
  const signalRows = signalRowsFor(leagueId);
  const computedAt = signalRows.reduce((max, r) => (max == null || r.computed_at > max ? r.computed_at : max), null);
  const byRoster = new Map();
  for (const r of signalRows) {
    if (!byRoster.has(r.roster_id)) byRoster.set(r.roster_id, []);
    byRoster.get(r.roster_id).push({ metric: r.metric, value: r.value, n: r.n,
      source: r.source, priceable: r.priceable, why: r.why });
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
  // A read that THREW and a store that is empty are different facts with
  // different fixes, and the bare `catch {}` that used to sit here made them
  // identical. Not hypothetical: `archetypesFor` joins `league_season_teams`,
  // whose only CREATE TABLE is in `scripts/backfill-league-history.mjs`, so on
  // a database where that backfill has never run this throws and every manager
  // came back with no archetype under a page that said the build had not run.
  let archetypeError = null;
  let archetypeState = 'present';
  try {
    const { archetypesFor, leagueHistoryState } = await import('../services/manager-archetypes.js');
    // ASK, RATHER THAN WAIT TO BE THROWN AT. `manager-archetypes.js` exports the
    // state of the table this read depends on, and returns an empty Map rather
    // than raising when it is missing — deliberately, because a caller that can
    // ask should not need an exception to learn a fact about the schema.
    //
    // This route's reporting used to be keyed to that throw, and when the module
    // stopped throwing the two changes cancelled: the catch never fired, and the
    // page served `read_failed: ''` for a read that never happened. That is the
    // defect the catch below was narrowed to remove, arriving by the other door.
    // A report that only works when something raises is not a report; it is a
    // side effect of an exception, and it lasts exactly as long as the exception
    // does.
    const historyState = leagueHistoryState();
    if (!historyState.present) {
      archetypeState = 'table_absent';
      // The module's own sentence, not a second one written here. Two
      // vocabularies for one state is how two surfaces come to disagree.
      archetypeError = historyState.reason;
      archetypes = new Map();
    } else {
      archetypes = archetypesFor(leagueId, season);
    }
  } catch (e) {
    // STILL LOAD-BEARING, and now the SECOND line rather than the only one. The
    // ask above covers `league_season_teams`, the one table whose state the
    // module publishes; every other table this read touches can still vanish,
    // and a throw is all the warning there is for those.
    //
    // ONLY THE ABSENCE IS ABSORBED. A missing table is a fact about this
    // database — the backfill has never run here — and this page's own job,
    // serving the measured signals, does not depend on the archetypes, so it
    // continues and says which state it is in. Anything else is a fault: a
    // `no such column` means the query and the schema disagree, and a catch
    // wide enough to take that turns every future mistake in the archetype code
    // into a quietly empty panel. Reporting the sentence was not enough on its
    // own; a page that says "the archetype read failed: <TypeError>" still
    // serves a 200 that a caller will read as data.
    if (!isMissingTable(e)) throw e;
    archetypeState = 'table_absent';
    archetypeError = String(e?.message ?? e);
    archetypes = new Map();
  }
  const rosterIds = teams.length
    ? teams.map(t => String(t.id))
    : [...new Set([...idents.keys(), ...byRoster.keys()])].sort((a, b) => Number(a) - Number(b));
  // The model read of each person, from the same call the counterparty layer
  // makes — not through the layer, which exists only for rosters that have
  // signals. A manager with no signals still has a draft record somebody paid a
  // gateway call to read.
  const modelReads = managerModelReads(leagueId, rosterIds);

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
      // The store's own `jev` is stripped: it is the raw probabilities with no
      // evaluation date and no statement of what is under them, and `model_read`
      // below is the same answers dated and shaped. Two shapes of one answer on
      // one payload is how a page ends up rendering the undated one.
      archetype: withoutRawJev(archetypes.get(id)),
      model_read: modelReads.get(id) ?? null,
      receptiveness: mp ? {
        value: mp.receptiveness, range: RECEPTIVENESS_RANGE,
        // What priced him, and on how much. `tier` here is the value the layer
        // USED; `tradeability_set` above is still the raw stored value, null when
        // nobody has judged him. Both are served because they answer different
        // questions and a page that has only the first cannot tell an assumed
        // "fair" from a stated one.
        tier: mp.tier, tier_source: mp.tier_source, tier_is_assumption: mp.tier_is_assumption,
        accept_rate_weight: mp.accept_rate_weight, priced_by: mp.priced_by,
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
    // WHEN THE BUILD RAN vs WHEN ITS EVIDENCE WAS COLLECTED. `computed_at`
    // above is the first; this is the second, and they are not the same fact.
    // The transaction rows every tx signal, archetype and counterparty price
    // rests on are written only by an off-server collector run by hand, so on
    // the deployed app they age silently while everything above them keeps
    // recomputing. A page that shows a manager read can now say how old the
    // evidence is instead of implying it is live.
    transactions: transactionsCollected(leagueId, season),
    // The chat half, same shape. Its absence is the normal case on the deployed
    // app rather than the exception — the corpus never ships in the image — so a
    // page that cannot say "the corpus is not here" will say "he never talks".
    chat: chatCorpusState(),
    // THE ARCHETYPE STORE, on the same footing as the two above, and the place
    // a failed read is reported instead of vanishing.
    archetypes: { ...archetypesBuilt(leagueId, season),
      // `read_state` is the machine-readable fact and `read_failed` the sentence
      // under it. The word is `manager-archetypes.js`'s own for this state, not
      // a second vocabulary for one thing.
      read_state: archetypeState, read_failed: archetypeError },
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
    // Which league owns the chat corpus is read from confirmed identities, and
    // nothing but this route and the build script ever writes one. On a box
    // where neither has run, an uploaded corpus attaches to no league at all,
    // so the first run needs to be told who is who: a roster id to the name
    // that person posts under. matchIdentities stores those as 'confirmed',
    // so it only has to be said once.
    const confirmations = req.body?.confirmations;
    if (confirmations != null && (typeof confirmations !== 'object' || Array.isArray(confirmations))) {
      return res.status(400).json({ error: 'confirmations must be an object of league id -> { roster_id: chat name }' });
    }
    for (const [leagueId, map] of Object.entries(confirmations ?? {})) {
      if (!Number.isFinite(Number(leagueId)) || typeof map !== 'object' || map == null || Array.isArray(map)) {
        return res.status(400).json({ error: `confirmations["${leagueId}"] must be an object of roster_id -> chat name` });
      }
      for (const [rosterId, chatName] of Object.entries(map)) {
        if (typeof chatName !== 'string' || !chatName.trim()) {
          return res.status(400).json({
            error: `confirmations["${leagueId}"]["${rosterId}"] must be the name that person posts under`,
          });
        }
      }
    }
    const out = refreshManagerData({
      ...(ids ? { leagueIds: ids } : {}),
      ...(confirmations ? { confirmations } : {}),
    });
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
 * WR-1: the War Room (a tab inside Trade Brain). Read-only and precomputed: it
 * reshapes a plans JSON written ahead of time by the study/campaign producer and
 * computes nothing here. Flag off (warroom-flag.js: own switch unset, preview mode off)
 * answers { enabled: false } and the client does not draw the tab.
 */
r.get('/:leagueId/war-room', async (req, res, next) => {
  try {
    // Membership first: even the "off" answer is only for a member of this league.
    const lg = league(req, res); if (!lg) return;
    if (!warRoomFlag().enabled) { res.json({ enabled: false }); return; }
    const view = await warRoomView(lg.id);
    // FIX-07: the shown next move goes to follow_ledger and the numbers to the serve log
    // (both off the plans file loadPlans already cached for the view).
    const logged = logWarRoomShown(res, lg, await loadPlans());
    res.json({ ...view, logged });
  } catch (e) { next(e); }
});

/**
 * Trades ranked by championship odds instead of points. Cached and slow on a
 * cold call — each shortlisted deal is a paired season simulation.
 */
r.get('/:leagueId/title-trades', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const out = titleOddsTrades(lg.id, {
      teamId: req.query.team_id,
      shortlist: Math.min(12, Math.max(3, Number(req.query.shortlist) || 6)),
      runs: Math.min(2000, Number(req.query.runs) || TRADE_IMPACT_RUNS)
    });
    recordServed(res, 'title_trades', lg, out, { myTeamId: req.query.team_id ?? lg.my_team_id });
    res.json(out);
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
    const out = waiverBoard(lg, {
      myTeamId: req.query.team_id,
      limit: Math.min(50, Math.max(5, Number(req.query.limit) || 20)),
      minProjected: Number(req.query.min_projected) || 4,
    });
    recordRoute('waivers', lg, out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * The defense streaming board (WV-01): free-agent defenses ranked by the implied
 * points of the offense they face, the edge over the defense you hold, and one
 * add suggestion that fits the roster. Same week as the waiver board.
 */
r.get('/:leagueId/streams', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const { season, week } = tradeWeekContext();
    res.json(streamingBoard(lg, { myTeamId: req.query.team_id, season, week }));
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
    const out = findTrades(lg, {
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
    });
    recordRoute('find', lg, out);
    // Queued before res.json, extracted at flush — after serialisation has already
    // settled the lazy floor_delta/ceiling_delta, so logging them costs nothing extra.
    recordServed(res, 'trade_find', lg, out);
    res.json(out);
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
    const result = await proposalsFor(lg.id, {
      ideas, universe, call: liveCaller(callClaude), cache: dbCache(lg.id),
    });
    // THE LEDGER WRITE, HERE AND NOWHERE DOWNSTREAM. This is the only layer that
    // holds both the whole slate that passed the edge test and the model's answer,
    // so it is the only layer that can see which candidates were considered and
    // NOT sent. Those are the control group for any later calibration, and past
    // this point they are gone. `recordProposalSlate` no-ops on a cache hit, so a
    // page refresh does not turn one decision into many rows.
    //
    // Wrapped, because the proposals are the product and the ledger is the
    // measurement: a measurement must never be able to fail the thing it measures.
    // NOT a bare catch — the reason is attached to the response, so a ledger that
    // has gone inert says so on the surface instead of going quiet.
    //
    // The proposer is the team the engine priced the slate for, as it reports it
    // (`found.me.roster_id`), NOT `req.query.team_id`. The app's own call sends no
    // team_id, and the engine then falls back to the league's own team (or to its
    // first roster when the id is not found), so the query string is null or wrong
    // on exactly the rows that matter.
    let ledger = null;
    try {
      ledger = recordProposalSlate(lg.id, lg.season ?? null, {
        ideas, result, modelVersion: PROMPT_VERSION, proposerTeamId: found?.me?.roster_id ?? null,
      });
    } catch (e) {
      ledger = { state: 'write_failed', reason: String(e?.message ?? e) };
    }
    res.json({ ...result, outcome_ledger: ledger });
  } catch (e) { next(e); }
});

/**
 * "I sent this" (CLONE-01b b1). Nick proposed this deal on ESPN himself; this
 * records that it was sent, with the P(accept) band the card showed him, so the
 * post-sync settle job can grade it against ESPN's reply. It never sends
 * anything to ESPN.
 *
 * The band is the one on the deal as served. It is not recomputed here: a
 * re-run now would score a different model against a decision already made.
 *
 * FIX-10: behind GRIDIRON_OFFER_LOOP (offer-loop-flag.js). Off, it answers
 * `{enabled:false, reason}` and records nothing.
 */
r.post('/:leagueId/offers/sent', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const flag = offerLoopFields();
    if (!flag.enabled) return res.json(flag);
    const deal = req.body?.deal;
    if (!deal || deal.partner_id == null || !Array.isArray(deal.i_give) || !Array.isArray(deal.i_get)) {
      return res.status(400).json({ error: 'deal with partner_id, i_give and i_get required' });
    }
    let out;
    try {
      out = recordSentOffer({
        league_id: lg.id, season: lg.season ?? null,
        proposer_team_id: String(req.body?.team_id ?? lg.my_team_id ?? '') || null,
        deal, model_version: 'acceptanceBand/served-deal',
      });
    } catch (e) {
      // The writer refuses a deal it cannot grade (no band, no season). That is
      // the caller's input, said as such, not a server fault.
      return res.status(400).json({ error: String(e?.message ?? e) });
    }
    res.json({ ...out, ...flag });
  } catch (e) { next(e); }
});

/** FIX-10: whether the "I sent this" button shows, and with the preview label. */
r.get('/:leagueId/offers/sent', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(offerLoopFields());
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
    const out = offerFor(lg, {
      myTeamId: req.query.team_id, targetId: req.query.player_id, excludeIds: excludeSet(req)
    });
    recordRoute('offer', lg, out);
    res.json(out);
  } catch (e) { next(e); }
});

/* --------------------------------------------- "what do I offer for THEM" */
r.get('/:leagueId/offer-many', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const raw = String(req.query.player_ids ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'player_ids required (comma-separated)' });
    const out = offerForMany(lg, {
      myTeamId: req.query.team_id, targetIds: raw.split(',').map(Number).filter(Number.isFinite),
      excludeIds: excludeSet(req)
    });
    recordRoute('offer-many', lg, out);
    res.json(out);
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

    res.json({ ...evaluate({ team: me, gives }, { team: them, gives: gets }, slots,
      { lineupValue: lineupValueContext(lg, assets, teams) }), slots });
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
      // How old the FantasyCalc price behind every value on this page is (FC-SNAP).
      market_as_of: marketAsOf(formatKey),
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

/* ------------------------------------------------------- served numbers */
/**
 * IDEA-001: what this league was actually served (served_numbers), newest first,
 * plus the serve-log queue's own state — a queue that is dropping or failing to
 * write says so here rather than going quiet. `?request_id=` is the
 * `X-Served-Request-Id` header of the response in question.
 */
r.get('/:leagueId/served-numbers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json({ league_id: lg.id, queue: serveLogState(),
      rows: readServed(lg.id, { requestId: req.query.request_id, entity: req.query.entity, limit: req.query.limit }) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- market price history */
/**
 * One player's FantasyCalc price in this league's format, one row per day it was
 * fetched (dynasty_value_history, written by syncDynastyValues), plus how old the
 * current price is. The history starts the day FC-SNAP shipped: FantasyCalc forbids
 * its own history endpoint, so there is nothing earlier to show.
 */
r.get('/:leagueId/market-history/:playerId', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const playerId = Number(req.params.playerId);
    if (!Number.isInteger(playerId) || playerId <= 0) return res.status(400).json({ error: 'playerId must be a positive integer' });
    const { formatKey } = deriveFormat(lg);
    const history = marketHistory(formatKey, playerId, { limit: req.query.limit });
    res.json({ format_key: formatKey, player_id: playerId, market_as_of: marketAsOf(formatKey), history });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- player deep dive */

/**
 * WHERE THIS PRICE COMES FROM — the valuation map, on the surface that shows it.
 *
 * `valuationMap` has priced every player for every manager, with a named source
 * and a sample size on each factor, since 2026-09-18, and until now nothing in
 * the running app imported it: the layer that measured the thing had no reader.
 * It is wired here rather than rebuilt, onto the detail Trade Lab already fetches
 * (client/src/pages/TradeLab.tsx), so there is no second answer to "what is he
 * worth to them".
 *
 * IT IS A READ, NOT A PRICE. Nothing on this panel feeds the deal score. The
 * clamp reported per player is `PLAYER_VALUATION_CAP` (0.20); the deal score's
 * own clamp is the separate +/-10% at `perceptionFactorFor` in trade-engine.js
 * and is untouched by anything here.
 *
 * The ablation is a RE-RUN, not arithmetic on each factor's effect: the source is
 * suppressed entirely and the price recomputed. Once a cap binds, the two stop
 * agreeing, and the re-run is the one that answers "does this source do anything".
 *
 * It reports the MULTIPLIER as well as the value, and that is not redundancy.
 * `their_value` is `our_value` times the multiplier, so for a player our own
 * model has not priced (`our_value` 0 — a rookie, or anyone with no projection
 * yet) every value delta is exactly 0 however hard the sources are pulling. The
 * multiplier is the only place the ablation is visible there, and a panel that
 * carried the value alone would report "this source does nothing" about a source
 * doing plenty.
 */
function valuationPanel(lg, playerId) {
  const season = lg.season ?? null;
  let week = null;
  try { week = leagueCurrentWeek(lg); } catch { week = null; }
  const blank = reason => ({
    league_id: lg.id, season, week, available: false, reason,
    my_roster_id: null, sources_used: [], sources_absent: [], managers: [],
  });

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const player = resolvePlayer(playerId, assets, teams);
  if (!player) {
    return blank('he is not in this league\'s priced universe, so no manager has a price for him');
  }

  // Built ONCE and handed to both calls below. A layer rebuilt per manager would
  // let the panel and the ablation disagree about the same league.
  const layer = counterpartyLayer(lg.id, { season, week });
  const map = valuationMap(lg.id, { season, week, players: [player], layer });
  if (!map.available) return blank(map.reason);

  const owner = new Map(teams.map(t => [String(t.roster_id), t.owner ?? null]));
  const key = String(player.name ?? '').toLowerCase();
  const managers = [];
  for (const [rid, m] of map.managers) {
    const valuation = m.players?.get(key) ?? null;
    const mp = layer.get(rid) ?? layer.get(String(rid)) ?? null;
    const ablation = [];
    for (const f of valuation?.factors ?? []) {
      if (!mp) continue;
      const without = playerValuation(mp, player, { zero: [f.source] });
      ablation.push({
        source: f.source,
        their_value_without: without.their_value,
        delta: +(valuation.their_value - without.their_value).toFixed(4),
        multiplier_without: without.multiplier,
        multiplier_delta: +(valuation.multiplier - without.multiplier).toFixed(4),
      });
    }
    managers.push({
      roster_id: String(rid), owner: owner.get(String(rid)) ?? null,
      receptiveness: m.receptiveness ?? null, tier: m.tier ?? null,
      valuation: jsonSafe(valuation), ablation,
    });
  }

  return {
    league_id: lg.id, season: map.season, week: map.week,
    available: true, reason: null, my_roster_id: map.my_roster_id,
    sources_used: map.sources_used, sources_absent: map.sources_absent, managers,
  };
}

r.get('/:leagueId/player/:id', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    // The panel is an extra read on a page that already works without it, so a
    // fault in it must not take the deep dive down with it -- but it is never
    // swallowed either: the surface says the panel went inert and why, which is
    // the whole point of a panel about provenance.
    let panel;
    try { panel = valuationPanel(lg, req.params.id); }
    catch (e) {
      panel = {
        league_id: lg.id, season: lg.season ?? null, week: null,
        available: false,
        reason: `the valuation layer failed to build for this league: ${String(e?.message ?? e)}`,
        my_roster_id: null, sources_used: [], sources_absent: [], managers: [],
      };
    }
    res.json({ ...playerOutlook(lg, req.params.id), valuation_map: panel });
  } catch (e) { next(e); }
});

/* ------------------------------------------ market prices from real trades (TM-09) */
// What this player fetched in real Sleeper trades (2021-2024 aggregates), the
// position x week x league-size price-to-value ratio, and the hype-decay reading.
// Historical and labelled "unconfirmed forward"; no trade card reads it yet.
r.get('/:leagueId/market/:playerId', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const player = row('SELECT id, name, position, sleeper_id FROM players WHERE id = ?', req.params.playerId);
    if (!player) { res.status(404).json({ error: 'player not found' }); return; }
    res.json({ league_id: lg.id,
      ...marketForPlayer({ player, week: leagueCurrentWeek(lg), teams: lg.team_count ?? null }),
      // S-19: the one hype producer, passed through unchanged.
      hype: playerHype({ sleeperId: player.sleeper_id }) });
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

/**
 * RETIRED 2026-09-20. Nothing dialled this route — no page, no script, no test.
 *
 * `relevantSplits()` is NOT retired with it, and this is the one cut of the
 * sixteen that earns a tombstone rather than a 404, because the data it served
 * is still served: `playerOutlook` calls the same function
 * (server/services/trade-engine.js) and Trade Lab renders the result as the
 * "his average against each" panel. A second route answering the same question
 * from the same function is a second answer waiting to drift.
 */
r.get('/splits/:playerId', retired('/api/trades/:leagueId/player/:id',
  'The opponent-history splits are on the player detail, computed by the same relevantSplits() this route called; Trade Lab already renders them there.'));

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
 * See docs/reference/fantasy/TRADE_LAB_VERIFY_LOOP.md.
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
  Starting lineup: ${s.lineup_before} -> ${s.lineup_after} ppg (${s.ppg_delta > 0 ? '+' : ''}${s.ppg_delta}/wk, ${s.season_delta > 0 ? '+' : ''}${s.season_delta} ${fmtSeasonSpan(s)})
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
 "why": "a short paragraph on why you agree or disagree with the engine's plausibility call"}`;

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
       * tradeImpact's default seed (one per league state) keeps a given deal's
       * answer reproducible AND equal to the Title-impact tab's and TradeCard's
       * delta for the same deal (RL-6-3: this used to hard-code seed 1).
       *
       * Returns null rather than throwing when the deal cannot be resolved
       * against the real rosters — the second opinion is an optional layer and
       * must never fail the request; the payload comes back `unverified`.
       */
      simulate: () => {
        if (!simArgs) return null;
        try {
          const started = Date.now();
          const impact = tradeImpact(lg, { ...simArgs, runs });
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
{"pitch":"a short message I can paste to them${records.length ? ' — cite at least one real multi-season number from the records above' : ''}",
 "evidence":"one line: the numbers from the records above the pitch rests on, comma-separated, no adjectives${records.length ? '' : ' (empty string if no records were given)'}",
 "their_counter":"the counter they are most likely to send, and how I should respond",
 "walk_away":"one sentence — the point at which I decline",
 "risk":"one sentence — the single way this deal goes badly for me"}`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

export default r;
