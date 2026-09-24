/**
 * TELLS-01b: producer 'tells', the one writer of `tells.card`, `tells.prior_trades` and
 * `tells.checkout_risk` in engine_state (ENGINE-SPECS TELLS-01b).
 *
 * Runs off the request thread: scripts/engine-tells.mjs (role engine) calls
 * `runTellsProducer`, spawned by the refresh loop after each sync until the engine daemon
 * (#242) registers it; the web route only READS the stored card with its as_of.
 *
 *   tells.card           (league)       per manager: the TELLS-01a screen tells (refitTells,
 *                                       shrunk) and the E1-graded clone features, each with
 *                                       n, outcome, q and as_of. A tell the screen does not
 *                                       hold is `unproven`, never a neutral. The clone's E1
 *                                       grade is computed here, once per run.
 *   tells.prior_trades   (league_team)  trades in the PREVIOUS season: ESPN's
 *                                       transactionCounter.trades (league.team_counter) when
 *                                       captured, else completed trades in league.transaction
 *                                       events. TELLS-01a arm B (`PREV|any_trade`) is a
 *                                       `lead`, so the counterparty factor reading this is
 *                                       default-off (counterparty-pricing.js).
 *   tells.checkout_risk  (league_team)  the confirmed `checkout` tells, shrunk. Descriptive:
 *                                       adds and checkout tells never enter receptiveness or
 *                                       P(accept) (the TELLS-01 trade KILL).
 *
 * Every read is as of `asOf`: events stamped later are not read, so a card written as of T
 * never changes when a later event arrives; the next run writes a new row.
 */
import { registerProducer } from '../engine/registry.js';
import { writeState } from '../engine/state.js';
import { recordRun } from '../engine/fields.js';
import { getEvents, normalizeAsOf } from '../engine/events.js';
import { refitTells, loadScreen, tellsEnabled } from './refit.js';
import { TELL_EVENT_TYPES } from './library.js';
import { loadCloneContext, gradeClone, tellsCard } from './clone-features.js';

export const TELLS_PRODUCER = 'tells';
export const TELLS_PRODUCER_VERSION = '1';
const PRIOR_TRADES_TELL = 'PREV|any_trade';
const EVENT_LIMIT = 50000;

const WRITERS = registerProducer({ name: 'tells', active: '1', versions: { 1: { params: { prior_tell: 'PREV|any_trade' } } },
  inputs: { events: ['league.transaction', 'league.team_week', 'league.team_counter'],
    tables: ['trade_outcomes', 'league_transactions_raw', 'trade_proposal_snapshots'] },
  fields: [
    { field: 'tells.card', entityTypes: ['league'], valueType: 'object',
      description: 'Per manager: screen tells (shrunk) and E1-graded clone features, each with n, outcome, q, as_of' },
    { field: 'tells.prior_trades', entityTypes: ['league_team'], valueType: 'object',
      description: 'Trades in the previous season (ESPN transactionCounter, else league.transaction); arm B lead' },
    { field: 'tells.checkout_risk', entityTypes: ['league_team'], valueType: 'object',
      description: 'Confirmed checkout tells, shrunk; descriptive only, never a P(accept) input' },
  ],
});

const t = s => Date.parse(s);
const round = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/* ------------------------------------------------------------ card entries */

/**
 * One screen tell as a card entry. A tell id the screen does not hold is `unproven` with
 * its reason, never a neutral 0.
 */
export function screenEntry(row, screenById, asOf) {
  const s = screenById.get(row.tell_id) ?? null;
  // label/predicts/unit/graded/status/weight: the fields TellsCard.tsx renders for every tell.
  const base = { id: row.tell_id, kind: 'screen', label: row.tell_id, unit: 'shrunk tell value', graded: false,
    weight: null, n: row.n_weeks ?? null, as_of: asOf, value: round(row.shrunk), raw_value: round(row.value),
    prior_mean: row.prior_mean ?? null };
  if (!s) {
    return { ...base, verdict: 'unproven', status: 'unproven', outcome: row.outcome ?? null, predicts: row.outcome ?? 'unknown',
      q: null, direction: 'unproven', reason: 'not in the TELLS-01a screen, so nothing says it predicts anything' };
  }
  const effect = s.effect_confirm ?? s.effect_fit ?? null;
  const above = row.shrunk != null && s.prior?.mean != null ? Math.sign(row.shrunk - s.prior.mean) : 0;
  const lean = effect == null || above === 0 ? 0 : above * Math.sign(effect);
  const status = row.shrunk == null ? 'unknown' : s.verdict === 'confirmed' ? 'measured' : 'unproven';
  return { ...base, verdict: s.verdict, status, outcome: s.outcome, predicts: `${s.outcome} (TELLS-01a screen, ${s.verdict})`,
    q: s.q_confirm ?? s.q_fit ?? null, effect,
    direction: row.shrunk == null ? 'unknown' : lean > 0 ? `more ${s.outcome}` : lean < 0 ? `less ${s.outcome}` : 'at the population',
    reason: row.shrunk == null ? 'no events in its window as of this card'
      : s.verdict === 'confirmed' ? null : `screen verdict ${s.verdict}: its CI did not clear 0` };
}

/** A clone feature (clone-features.js tellsCard) in the card's shape: E1, not the screen, grades it. */
function cloneEntry(e, e1Status) {
  const confirmed = e.graded && e1Status === 'passing';
  return { ...e, kind: 'clone', outcome: 'accepts the offer', q: null,
    verdict: confirmed ? 'confirmed' : 'unproven',
    reason: e.reason ?? (confirmed ? null : `not in the TELLS-01a screen; its E1 grade is ${e1Status ?? 'not run'}`) };
}

/** The whole card for one league. `refit` is refitTells' result, `clone` tellsCard's. */
export function buildCard({ leagueId, asOf, refit, clone, grade, screen }) {
  const screenById = new Map(screen.tells.map(s => [s.id, s]));
  const e1Status = grade?.clone?.status ?? null;
  const teams = new Map();
  const teamOf = id => teams.get(String(id)) ?? teams.set(String(id), { team_id: String(id), tells: [] }).get(String(id));
  for (const m of clone?.managers ?? []) teamOf(m.team_id).tells.push(...m.tells.map(e => cloneEntry(e, e1Status)));
  for (const r of refit?.rows ?? []) teamOf(r.roster_id).tells.push(screenEntry(r, screenById, asOf));
  const managers = [...teams.values()].sort((a, b) => Number(a.team_id) - Number(b.team_id));
  return {
    league_id: Number(leagueId), as_of: asOf, producer_version: TELLS_PRODUCER_VERSION,
    screen: { version: screen.version, enabled: !!refit?.enabled,
      reason: refit?.enabled ? null : 'TELLS-01a refit is off (GRIDIRON_TELLS_ENABLED): screen tells are not computed' },
    weights: clone?.weights ?? null, fit_n: clone?.fit_n ?? null, fit_reason: clone?.fit_reason ?? null,
    missing_sources: clone?.missing_sources ?? [], terms_sources: clone?.terms_sources ?? {}, grade, managers,
  };
}

/* ------------------------------------------------------------ prior trades */

/**
 * Previous-season trades per team as of `asOf`. The ESPN counter wins where captured;
 * completed-trade events are the fallback; a team with neither is unknown.
 */
export function priorTrades(events, { season, teams }) {
  const prev = Number(season) - 1;
  const counter = new Map();
  for (const e of events) {
    if (e.event_type === 'league.team_counter' && Number(e.payload?.season) === prev && e.payload?.trades != null) {
      counter.set(String(e.team_id), { trades: Number(e.payload.trades), event_id: e.id });
    }
  }
  const txPrev = events.filter(e => e.event_type === TELL_EVENT_TYPES.transaction && Number(e.payload?.season) === prev);
  const traded = new Map();
  for (const e of txPrev) {
    if (e.payload?.type !== 'trade' || e.payload?.status !== 'complete') continue;
    for (const r of e.payload.roster_ids ?? []) traded.set(String(r), (traded.get(String(r)) ?? 0) + 1);
  }
  const out = new Map();
  for (const team of teams) {
    const c = counter.get(team);
    if (c) {
      out.set(team, { season: prev, trades: c.trades, any_trade: c.trades > 0 ? 1 : 0,
        source: 'espn_transaction_counter', tell: PRIOR_TRADES_TELL, verdict: 'lead', event_id: c.event_id });
    } else if (txPrev.length) {
      const n = traded.get(team) ?? 0;
      out.set(team, { season: prev, trades: n, any_trade: n > 0 ? 1 : 0,
        source: 'league_transactions', tell: PRIOR_TRADES_TELL, verdict: 'lead', event_id: null });
    } else {
      out.set(team, null);
    }
  }
  return { byTeam: out, prev, txEvents: txPrev.length, counters: counter.size };
}

/* ------------------------------------------------------------ the run */

/** Events of one league-season, re-keyed so the tell library sees a season as a league. */
function seasonLoader(events) {
  return async ({ leagueId }) => {
    const [, season] = String(leagueId).split('@');
    return events.filter(e => Number(e.payload?.season) === Number(season)).map(e => ({ ...e, league_id: leagueId }));
  };
}

/**
 * Compute and store the three fields for each league, as of `asOf`.
 * @param opts.leagues [{ leagueId, season }] (app league id, current season)
 * @param opts.refitEnabled overrides GRIDIRON_TELLS_ENABLED for the screen tells
 */
export async function runTellsProducer({ database, asOf = new Date(), leagues = [], screen = null, refitEnabled = null,
  env = process.env } = {}) {
  const at = normalizeAsOf(asOf);
  const scr = screen ?? loadScreen();
  const screenById = new Map(scr.tells.map(s => [s.id, s]));
  const ctx = loadCloneContext(database);
  // As of the card: an offer answered after `at` was not an outcome yet, so neither the
  // fit nor the E1 grade may see it (an unanswered time falls back to the proposal).
  const seen = { ...ctx, offers: ctx.offers.filter(o => t(o.resolved_at ?? o.proposed_at) <= t(at)) };
  const out = [];
  for (const { leagueId, season } of leagues) {
    const startedAt = new Date().toISOString();
    const cut = database.prepare('SELECT (SELECT MAX(id) FROM engine_events) AS e, (SELECT MAX(id) FROM engine_state) AS s').get();
    const events = getEvents({ asOf: at, leagueId, limit: EVENT_LIMIT,
      types: [TELL_EVENT_TYPES.transaction, TELL_EVENT_TYPES.teamWeek, 'league.team_counter'] }, database);
    const refit = await refitTells({ asOf: at, env, screen: scr, enabled: refitEnabled ?? tellsEnabled(env),
      leagues: [{ leagueId: `${leagueId}@${season}`, previous: { leagueId: `${leagueId}@${season - 1}`, playoffWeekStart: null } }],
      loadEvents: seasonLoader(events) });
    const rows = refit.rows.map(r => ({ ...r, league_id: leagueId }));
    const grade = gradeClone(seen.offers, seen, { leagueId, excluded: ctx.excluded, sources: ctx.sources, reason: ctx.reason });
    const clone = tellsCard(seen, { leagueId, asOf: at, grade });
    const card = buildCard({ leagueId, asOf: at, refit: { ...refit, rows }, clone, grade, screen: scr });

    const teams = new Set(card.managers.map(m => m.team_id));
    for (const e of events) {
      if (Number(e.payload?.season) !== Number(season)) continue;
      if (e.event_type === TELL_EVENT_TYPES.teamWeek && e.team_id != null) teams.add(String(e.team_id));
      for (const r of e.payload?.roster_ids ?? []) teams.add(String(r));
    }
    const prior = priorTrades(events, { season, teams });

    let written = 0; let unchanged = 0;
    const tally = r => { if (r.written) written += 1; else if (r.unchanged) unchanged += 1; };
    const common = { asOf: at, producerVersion: TELLS_PRODUCER_VERSION, leagueId };
    tally(writeState({ ...common, entityType: 'league', entityId: String(leagueId), field: 'tells.card',
      writer: WRITERS['tells.card'], value: card,
      reasonChain: { contributions: [
        { source: 'tells.screen', event_ids: [], text: card.screen.enabled ? `${rows.length} screen tell values` : card.screen.reason },
        { source: 'tells.clone', event_ids: [], text: `clone fit on ${card.fit_n} offers; E1 ${grade.clone?.status ?? 'not run'}` },
      ] } }, database));
    for (const team of [...teams].sort((a, b) => Number(a) - Number(b))) {
      const entity = `${leagueId}:${team}`;
      const p = prior.byTeam.get(team);
      tally(writeState({ ...common, entityType: 'league_team', entityId: entity, field: 'tells.prior_trades',
        writer: WRITERS['tells.prior_trades'], value: p,
        absence: p ? null : { status: 'unknown', reason: `no ${prior.prev} ESPN counter and no ${prior.prev} transactions in the event log` },
        reasonChain: { contributions: p ? [{ source: p.source, event_ids: [], text: `${p.trades} trades in ${p.season}` }] : [] } }, database));
      const checkout = rows.filter(r => String(r.roster_id) === team && r.outcome === 'checkout' && r.verdict === 'confirmed')
        .map(r => screenEntry(r, screenById, at));
      tally(writeState({ ...common, entityType: 'league_team', entityId: entity, field: 'tells.checkout_risk',
        writer: WRITERS['tells.checkout_risk'], value: checkout.length ? { tells: checkout, n_tells: checkout.length } : null,
        absence: checkout.length ? null : { status: 'not_measured',
          reason: refit.enabled ? 'no confirmed checkout tell has a value for this team as of this run' : card.screen.reason },
        reasonChain: { contributions: checkout.map(c => ({ source: `tells.${c.id}`, event_ids: [], text: `${c.id}: ${c.direction}` })) } }, database));
    }
    const runId = recordRun({ producer: TELLS_PRODUCER, version: TELLS_PRODUCER_VERSION, scopeKey: `league:${leagueId}`, startedAt,
      inputCutEventId: cut.e == null ? null : Number(cut.e), inputCutStateId: cut.s == null ? null : Number(cut.s),
      rowsWritten: written, rowsUnchanged: unchanged, dirtyReason: 'post-sync' }, database);
    out.push({ league_id: leagueId, season, as_of: at, teams: teams.size, rows_written: written, rows_unchanged: unchanged,
      screen_values: rows.length, prior_trades_source: { counters: prior.counters, transaction_events: prior.txEvents },
      e1_clone: grade.clone?.status ?? null, run_id: runId });
  }
  return out;
}
