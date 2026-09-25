/**
 * E-DATA (Batch D item 2): every ESPN trade offer captured the moment it appears, with every
 * model's P(yes) as it stood at that moment. Migration 106 explains the tables.
 *
 * WRITERS (called by scripts/collect-league-transactions.mjs in the same pass as the raw rows):
 *   captureOffers      the offers in one ESPN response -> trade_proposal_snapshots, first write
 *                      wins, before the raw upsert can overwrite a proposal's items.
 *   backfillSnapshots  raw proposal rows written before 106 -> snapshots ('raw_backfill').
 *   recordFirstSight   each offer first seen live -> offer_first_sight: baseline, clone, blend
 *                      and served p, from the same modules the served number comes from
 *                      (p-yes.js#pYesTableFrom, p-yes-blend.js, eval/e1-league.js#replayAsOf).
 *
 * PAIRING is not done here. eval/decided-offers.js#rawOfferGroups (#409, E1's one producer)
 * pairs answers with proposals and already reads trade_proposal_snapshots to fill a proposal
 * the raw table lacks. offerCaptureReport only counts what it returns.
 *
 * CADENCE. The refresh loop reads ESPN once per tick, and a tick can run for many minutes; a
 * decline arrives ~0.4 h after its offer, so an offer made and answered inside one tick was
 * never seen. scripts/watch-trade-offers.mjs polls every pollSeconds(), started by the loop
 * only with GRIDIRON_OFFER_WATCH=1.
 */
import { loadDecidedOffers } from './eval/decided-offers.js';
import { replayAsOf } from './eval/e1-league.js';
import { blendP } from './p-yes-blend.js';
import { BLEND_BASIS, PYES_BASIS, fallbackReason, pYesFlag, pYesTableFrom } from './p-yes.js';

export const OFFER_WATCH_ENV = 'GRIDIRON_OFFER_WATCH';
export const ORPHAN_BAR = 0.1;
/** A league needs this many answers before its own rate is held to the bar. */
export const ORPHAN_MIN_ANSWERS = 10;
export const POLL_DEFAULTS = Object.freeze({ active: 120, idle: 600, hours: [7, 24], tz: 'America/New_York' });

const PROPOSAL = 'TRADE_PROPOSAL';
const TABLES = ['trade_proposal_snapshots', 'offer_first_sight'];
const ABSENT = 'trade_proposal_snapshots / offer_first_sight are not on this database: migration 106 has not run '
  + '(the web server runs migrations at start)';

const iso = ms => (ms ? new Date(ms).toISOString() : null);
const hasTables = database => TABLES.every(t =>
  database.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));

/** An offer, not the close record ESPN writes under the proposer when an offer ends (PROPOSAL / CANCEL). */
const isOffer = (type, executionType) => type === PROPOSAL && executionType !== 'CANCEL';

/** The one other team on an offer's items, or null when there is none or more than one. */
export function counterpartyOf(items, proposer) {
  const teams = new Set((items ?? []).flatMap(i => [i?.fromTeamId, i?.toTeamId])
    .filter(x => x != null && Number(x) > 0 && String(x) !== String(proposer)).map(Number));
  return teams.size === 1 ? [...teams][0] : null;
}

/** A non-empty items list, null for none, 'bad_json' for text that is not JSON (counted, not dropped). */
function parseItems(json) {
  if (json == null || json === '') return null;
  let v;
  try { v = JSON.parse(json); } catch { return 'bad_json'; }
  return Array.isArray(v) && v.length ? v : null;
}

const INSERT = `INSERT INTO trade_proposal_snapshots
    (league_id, season, proposal_tx_id, proposer_team_id, counterparty_team_id, proposed_at, scoring_period,
     items_json, captured_from, captured_at, last_seen_at, last_status)
  VALUES (@league_id, @season, @proposal_tx_id, @proposer_team_id, @counterparty_team_id, @proposed_at, @scoring_period,
     @items_json, @captured_from, @captured_at, @last_seen_at, @last_status)
  ON CONFLICT(league_id, season, proposal_tx_id) DO NOTHING`;

/**
 * Snapshot every offer in one ESPN response (transactions + pendingTransactions). First write
 * wins; a later sighting moves only last_seen_at and last_status. An offer with no items cannot
 * be stored (CHECK) and is counted. Returns the snapshots first captured live in this call as
 * `new_live`, which recordFirstSight takes.
 */
export function captureOffers(database, { leagueId, season, transactions = [], now = new Date().toISOString() } = {}) {
  const out = { state: 'ok', seen: 0, captured: 0, no_items: 0, new_live: [] };
  if (!hasTables(database)) return { ...out, state: 'table_absent', reason: ABSENT };
  const insert = database.prepare(INSERT);
  const touch = database.prepare(`UPDATE trade_proposal_snapshots SET last_seen_at = ?, last_status = ?
    WHERE league_id = ? AND season = ? AND proposal_tx_id = ?`);
  for (const t of transactions ?? []) {
    if (!t?.id || !isOffer(t.type, t.executionType ?? null)) continue;
    out.seen += 1;
    const id = String(t.id);
    const items = Array.isArray(t.items) && t.items.length ? t.items : null;
    if (items) {
      const snap = {
        league_id: leagueId, season, proposal_tx_id: id, proposer_team_id: t.teamId ?? null,
        counterparty_team_id: counterpartyOf(items, t.teamId), proposed_at: iso(t.proposedDate),
        scoring_period: t.scoringPeriodId ?? null, items_json: JSON.stringify(items),
        captured_from: t.isPending ? 'pending' : 'resolved', captured_at: now, last_seen_at: now, last_status: t.status ?? null,
      };
      if (Number(insert.run(snap).changes)) {
        out.captured += 1;
        out.new_live.push(snap);
        continue;
      }
    } else {
      out.no_items += 1;
    }
    touch.run(now, t.status ?? null, leagueId, season, id);
  }
  return out;
}

/** Raw proposal rows that still carry items and have no snapshot -> 'raw_backfill'. Idempotent. */
export function backfillSnapshots(database, { leagueId, season, now = new Date().toISOString() } = {}) {
  if (!hasTables(database)) return { state: 'table_absent', reason: ABSENT, backfilled: 0 };
  const raw = database.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'league_transactions_raw'`).get();
  if (!raw) return { state: 'raw_table_absent', backfilled: 0 };
  const insert = database.prepare(INSERT);
  let backfilled = 0;
  let badJson = 0;
  const offers = database.prepare(`SELECT tx_id, team_id, proposed_at, scoring_period, items_json, status, execution_type
    FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type = ?`).all(leagueId, season, PROPOSAL);
  for (const r of offers) {
    if (!isOffer(PROPOSAL, r.execution_type)) continue;
    const items = parseItems(r.items_json);
    if (items === 'bad_json') { badJson += 1; continue; }
    if (!items) continue;
    backfilled += Number(insert.run({
      league_id: leagueId, season, proposal_tx_id: String(r.tx_id), proposer_team_id: r.team_id ?? null,
      counterparty_team_id: counterpartyOf(items, r.team_id), proposed_at: r.proposed_at ?? null,
      scoring_period: r.scoring_period ?? null, items_json: JSON.stringify(items),
      captured_from: 'raw_backfill', captured_at: now, last_seen_at: now, last_status: r.status ?? null,
    }).changes);
  }
  return { state: 'ok', backfilled, ...(badJson ? { bad_json: badJson } : {}) };
}

/**
 * Every model's P(yes) for each offer first seen live, as of `now` (its first sight). The
 * offer's own row is taken out of the decided set, so an offer first seen already answered
 * never predicts itself; answers collected later never reach a row, which is never rewritten.
 * served = what p-yes.js serves under `env`: the blend, the baseline (GRIDIRON_PYES_BLEND=0),
 * or the clone with the fallback reason when no decided offer exists.
 */
export function recordFirstSight(database, { leagueId, season, snapshots = [], now = new Date().toISOString(), env = process.env } = {}) {
  const out = { state: 'ok', recorded: 0, reasons: {} };
  if (!snapshots.length) return out;
  if (!hasTables(database)) return { ...out, state: 'table_absent', reason: ABSENT };
  const { offers } = loadDecidedOffers(database);
  const mode = pYesFlag(env).mode;
  const at = Date.parse(now);
  const insert = database.prepare(`INSERT INTO offer_first_sight
      (league_id, season, proposal_tx_id, proposer_team_id, counterparty_team_id, proposed_at, recorded_at, seen_state,
       p_baseline, p_clone, p_blend, p_served, served_basis, served_mode, w_baseline, w_clone, n_graded, baseline_n, reason)
    VALUES (@league_id, @season, @proposal_tx_id, @proposer_team_id, @counterparty_team_id, @proposed_at, @recorded_at, @seen_state,
       @p_baseline, @p_clone, @p_blend, @p_served, @served_basis, @served_mode, @w_baseline, @w_clone, @n_graded, @baseline_n, @reason)
    ON CONFLICT(league_id, season, proposal_tx_id) DO NOTHING`);
  for (const s of snapshots) {
    if (s.captured_from === 'raw_backfill') continue;
    const base = { league_id: s.league_id, season: s.season, proposal_tx_id: s.proposal_tx_id,
      proposer_team_id: s.proposer_team_id, counterparty_team_id: s.counterparty_team_id, proposed_at: s.proposed_at,
      recorded_at: now, seen_state: s.captured_from === 'pending' ? 'pending' : 'resolved', served_mode: mode,
      p_baseline: null, p_clone: null, p_blend: null, p_served: null, served_basis: null,
      w_baseline: null, w_clone: null, n_graded: null, baseline_n: null, reason: null };
    const row = s.counterparty_team_id == null ? { ...base, reason: 'no_single_counterparty' } : predict(base);
    const wrote = Number(insert.run(row).changes);
    out.recorded += wrote;
    if (wrote && row.reason) out.reasons[row.reason] = (out.reasons[row.reason] ?? 0) + 1;
  }
  return out;

  function predict(base) {
    const others = offers.filter(o => !(String(o.league_id) === String(base.league_id)
      && String(o.season) === String(base.season) && String(o.espn_tx_id) === String(base.proposal_tx_id)));
    const team = String(base.counterparty_team_id);
    const table = pYesTableFrom(others, base.league_id, [team], { now: at, mode: 'blend' });
    const r = table.byTeam.get(team) ?? table.unseen;
    const pClone = replayAsOf({ acc: r.acc ?? 0, n: r.n ?? 0 });
    const w = table.blend.weights;
    const pBlend = pClone == null ? null : blendP(w, { baseline: r.p, clone: pClone });
    const why = fallbackReason({ ...table, reason: null });
    const served = why
      ? { p_served: pClone, served_basis: 'clone.accept', reason: why }
      : mode === 'blend' ? { p_served: pBlend, served_basis: BLEND_BASIS } : { p_served: r.p, served_basis: PYES_BASIS };
    return { ...base, p_baseline: r.p, p_clone: pClone, p_blend: pBlend, ...served,
      ...(served.p_served == null && !served.reason ? { reason: 'clone_band_absent' } : {}),
      w_baseline: w.baseline, w_clone: w.clone, n_graded: table.blend.pooled.n, baseline_n: r.n ?? 0 };
  }
}

/**
 * The pre-registered metric: orphans / (decided + orphans), per league and pooled, over answers
 * first collected at or after `since` (the watcher's start). decided-offers.js decides both.
 */
export function offerCaptureReport(database, { since = null } = {}) {
  const built = loadDecidedOffers(database);
  const from = since == null ? -Infinity : Date.parse(since);
  const seenAt = o => Date.parse(o.decision_seen_at ?? o.decided_at ?? o.resolved_at ?? '');
  const inWindow = o => Number.isFinite(seenAt(o)) ? seenAt(o) >= from : since == null;
  const by = {};
  const bump = (lid, k) => { by[lid] ??= { decided: 0, orphans: 0 }; by[lid][k] += 1; };
  for (const o of built.offers) if (inWindow(o)) bump(String(o.league_id), 'decided');
  for (const o of built.orphans) if (inWindow(o)) bump(String(o.league_id), 'orphans');
  const rate = c => (c.decided + c.orphans ? c.orphans / (c.decided + c.orphans) : null);
  const pooled = Object.values(by).reduce((a, c) => ({ decided: a.decided + c.decided, orphans: a.orphans + c.orphans }), { decided: 0, orphans: 0 });
  const by_league = Object.fromEntries(Object.entries(by).map(([k, c]) => [k, { ...c, orphan_rate: rate(c) }]));
  const pooledRate = rate(pooled);
  const leaguesOk = Object.values(by_league).every(c => c.decided + c.orphans < ORPHAN_MIN_ANSWERS || c.orphan_rate < ORPHAN_BAR);
  return { since, bar: ORPHAN_BAR, pooled: { ...pooled, orphan_rate: pooledRate }, by_league,
    pass: pooledRate == null ? null : pooledRate < ORPHAN_BAR && leaguesOk, sources: built.sources, reason: built.reason };
}

/** The watcher is its own flag: on only when the env says exactly '1' (never preview mode). */
export function offerWatchOn(env = process.env) {
  return env[OFFER_WATCH_ENV] === '1';
}

const posInt = (v, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

/** Hour of day (0-23) at `date` in `tz`. A zone Intl does not know throws (RangeError): loud, not guessed. */
function hourIn(date, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date)) % 24;
}

/**
 * Seconds until the next poll: GRIDIRON_OFFER_WATCH_ACTIVE_SECONDS (120) inside the active hours
 * GRIDIRON_OFFER_WATCH_ACTIVE_HOURS ("7-24", start inclusive, end exclusive) in
 * GRIDIRON_OFFER_WATCH_TZ (America/New_York), GRIDIRON_OFFER_WATCH_IDLE_SECONDS (600) otherwise.
 * A value that is not a positive integer falls back to its default, never to 0.
 */
export function pollSeconds(date = new Date(), env = process.env) {
  const active = posInt(env.GRIDIRON_OFFER_WATCH_ACTIVE_SECONDS, POLL_DEFAULTS.active);
  const idle = posInt(env.GRIDIRON_OFFER_WATCH_IDLE_SECONDS, POLL_DEFAULTS.idle);
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(env.GRIDIRON_OFFER_WATCH_ACTIVE_HOURS ?? '');
  const [start, end] = m && Number(m[1]) < Number(m[2]) && Number(m[2]) <= 24 ? [Number(m[1]), Number(m[2])] : POLL_DEFAULTS.hours;
  const h = hourIn(date, env.GRIDIRON_OFFER_WATCH_TZ || POLL_DEFAULTS.tz);
  return h >= start && h < end ? active : idle;
}
