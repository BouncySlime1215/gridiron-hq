/**
 * ESPN league transactions, with the timestamps — proposals, accepts,
 * declines, vetoes, waivers, drops.
 *
 * Why this exists as a service and not only as a script (2026-09-20):
 *
 * The work itself is old. `scripts/collect-league-transactions.mjs` has done it
 * since 2026-09-17 and does it correctly. What it has never had is a way to
 * happen on its own. It was reachable only through
 * `scripts/refresh-live-data.mjs`, which spawns it as a child process, and that
 * refresh loop runs on Nick's machine. Nothing on the deployed app ever called
 * it. Meanwhile six server modules read `league_transactions_raw` and none of
 * them writes it, so on Fly every manager read, archetype and counterparty
 * price has been priced off whatever a hand-run last left behind.
 *
 * That is not a staleness bug of the ordinary kind, because of this, from
 * `refresh-live-data.mjs` (the author's own comment on the same call):
 *
 *     ESPN only answers with the last ~3 days, so this must run every tick
 *     or the proposals are lost.
 *
 * A window that closes after three days does not leave data to catch up on
 * later. Anything not captured inside it is gone from the source, permanently.
 * So the gap is not "the numbers are old", it is "the evidence was never
 * collected", and no later run can repair it.
 *
 * Which is why the body lives here: a module the scheduler can register as an
 * ordinary job, so it gets a cadence, a `sync_log` row, a staleness check and
 * backoff, none of which a spawned script has. Today a failed collection is
 * invisible unless somebody happens to read the terminal it was typed into.
 *
 * The script is kept, as a thin wrapper over this same function, so a hand-run
 * and the scheduled run cannot drift apart — there is one body, called two
 * ways.
 */
import { db, rows } from '../db/index.js';
import { BROWSER_HEADERS } from './espn-draft.js';

/** ESPN's transaction window, per its own API. Quoted, not assumed. */
export const ESPN_TRANSACTION_WINDOW_DAYS = 3;

/**
 * Whose cookies this league's request carries — the league's own pair, or none.
 *
 * THIS IS A SEAM, AND IT IS DELIBERATELY THE NARROW RULE.
 *
 * The right answer lives in `server/platform/espn-credentials.js`
 * (`credentialsForLeague`), which resolves a league's own stored pair, then a
 * member of that league with commissioner priority, then nothing. That module
 * is PR #48 and is not on this branch, so it cannot be imported here yet
 * without stacking this work on that PR.
 *
 * What is implemented below is rule 1 of that resolver and nothing else: the
 * league's own stored pair. That is also exactly what the script did, so this
 * move changes no behaviour in the direction that would matter — it has never
 * reached for another league's cookies and it does not start now.
 *
 * The part that is NOT rule 1 is the failure. The script's query filtered
 * `espn_s2 IS NOT NULL AND swid IS NOT NULL`, so a league with no credential
 * was not skipped, it was never in the list — invisible, indistinguishable
 * from a league that had nothing to collect. Here it is a named reason on the
 * result, because an uncollectable league inside a three-day window is a thing
 * somebody has to be told about while there is still time to connect it.
 *
 * When #48 lands, replace this default with `credentialsForLeague` and rules 2
 * and 3 arrive with it. Nothing else in this file has to change: the contract
 * is already `{ s2, swid, source }` with nulls for "none", which is that
 * function's own shape.
 */
export function leagueOwnCredentials(lg) {
  if (!lg?.espn_s2 || !lg?.swid) return { s2: null, swid: null, source: null };
  return { s2: lg.espn_s2, swid: lg.swid, source: 'league' };
}

const iso = ms => (ms ? new Date(ms).toISOString() : null);

const UPSERT = `INSERT INTO league_transactions_raw VALUES
  (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,@team_id,@member_id,
   @related_tx_id,@scoring_period,@bid_amount,@is_pending,@items_json,@raw_json,@first_seen_at,@last_seen_at)
  ON CONFLICT(league_id, season, tx_id) DO UPDATE SET
    status=excluded.status, processed_at=COALESCE(excluded.processed_at, processed_at),
    is_pending=excluded.is_pending, items_json=excluded.items_json, raw_json=excluded.raw_json,
    last_seen_at=excluded.last_seen_at`;

/**
 * Collect every connected ESPN league's transaction window into
 * `league_transactions_raw`.
 *
 * Returns the detail the scheduler stores on the `sync_log` row. `failed` and
 * `skipped` are separate counts on purpose: a failure is a league we tried and
 * could not read, a skip is a league we deliberately did not ask about, and
 * only the first is a reason to call the job unhealthy.
 *
 * Every parameter is an injection point for the tests, and each has a real
 * default, so the scheduler's call site stays `collectLeagueTransactions()`.
 */
export async function collectLeagueTransactions({
  skipEspn = false,
  credentialsFor = leagueOwnCredentials,
  fetchImpl = fetch,
  nowIso = new Date().toISOString(),
  timeoutMs = 20_000,
} = {}) {
  // No `CREATE TABLE` here. It is migration 066's, because a service that
  // creates schema breaks scripts/schema-snapshot.mjs's baseline/full equality
  // — see the note in db/index.js.
  const leagues = rows(
    `SELECT id, league_id, season, name, espn_s2, swid FROM leagues WHERE platform = 'espn'`);

  const upsert = db.prepare(UPSERT);
  const reasons = [];
  let seen = 0, added = 0, failed = 0, skipped = 0, collected = 0;

  for (const lg of leagues) {
    // A draft being polled on ESPN itself is the one case where OUR request is
    // the problem rather than the fix: this carries the same espn_s2/SWID the
    // browser is drafting with, and concurrent use of one ESPN session is what
    // kicked Nick out mid-draft on 2026-09-06 (see liveDraftActive's note in
    // scheduler.js). Three days of window means waiting hours costs nothing.
    if (skipEspn) {
      skipped++;
      reasons.push({ league_id: lg.id, reason: 'a draft is live on ESPN; not competing for the session' });
      continue;
    }
    const { s2, swid, source } = credentialsFor(lg);
    if (!s2 || !swid) {
      skipped++;
      reasons.push({ league_id: lg.id, reason: 'no credential for this league' });
      continue;
    }
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${lg.season}`
      + `/segments/0/leagues/${lg.league_id}?view=mTransactions2&view=mPendingTransactions`;
    try {
      const r = await fetchImpl(url, {
        headers: { ...BROWSER_HEADERS, Cookie: `espn_s2=${s2}; SWID=${swid}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`ESPN ${r.status}`);
      const j = await r.json();
      const all = [...(j.transactions ?? []), ...(j.pendingTransactions ?? [])];
      const before = rows(
        `SELECT COUNT(*) AS n FROM league_transactions_raw WHERE league_id = ? AND season = ?`,
        lg.id, lg.season)[0].n;
      // node:sqlite has no .transaction(); BEGIN/COMMIT by hand.
      db.exec('BEGIN');
      try {
        for (const t of all) {
          if (!t?.id) continue;
          upsert.run({
            league_id: lg.id, season: lg.season, tx_id: String(t.id), type: t.type ?? null,
            status: t.status ?? null, execution_type: t.executionType ?? null,
            proposed_at: iso(t.proposedDate), processed_at: iso(t.processDate),
            team_id: t.teamId ?? null, member_id: t.memberId ?? null,
            related_tx_id: t.relatedTransactionId ?? null, scoring_period: t.scoringPeriodId ?? null,
            bid_amount: t.bidAmount ?? null, is_pending: t.isPending ? 1 : 0,
            items_json: JSON.stringify(t.items ?? []), raw_json: JSON.stringify(t),
            first_seen_at: nowIso, last_seen_at: nowIso,
          });
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const after = rows(
        `SELECT COUNT(*) AS n FROM league_transactions_raw WHERE league_id = ? AND season = ?`,
        lg.id, lg.season)[0].n;
      seen += all.length;
      added += after - before;
      collected++;
      // `source` is recorded, never branched on — it is how a reader finds out
      // whose connection answered for a league without this code making a
      // decision from it. Same rule espn-credentials.js states for its own field.
      if (source && source !== 'league') {
        reasons.push({ league_id: lg.id, reason: `collected with a ${source} credential` });
      }
    } catch (e) {
      failed++;
      reasons.push({ league_id: lg.id, reason: String(e?.message ?? e).slice(0, 160) });
    }
  }

  return {
    leagues: leagues.length, collected, seen, new: added, failed, skipped,
    window_days: ESPN_TRANSACTION_WINDOW_DAYS, reasons,
  };
}
