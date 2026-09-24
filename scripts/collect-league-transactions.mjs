#!/usr/bin/env node
/**
 * Forward collector for ESPN league transactions — proposals, accepts, declines,
 * vetoes, waivers, drops — WITH their timestamps.
 *
 * Why it exists (Nick, 2026-09-17): "source data on when trades were proposed /
 * accepted vs when the text messages were sent — this gives us reactions to live
 * information." ESPN's `mTransactions2` view only answers with the last ~3 days
 * (verified: 132 rows, 2026-09-15 → 09-17, incl. 36 TRADE_PROPOSAL, 9 ACCEPT,
 * 6 DECLINE, 4 VETO, each with `proposedDate` in ms and `relatedTransactionId`
 * tying a decision back to its proposal). Anything not captured inside that
 * window is gone, so this runs every refresh tick and upserts by transaction id.
 *
 * Read-only against ESPN with Nick's own cookies (pull approved 2026-09-17).
 * Usage: node --env-file-if-exists=.env scripts/collect-league-transactions.mjs
 */
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
const { BROWSER_HEADERS } = await import('../server/services/espn-draft.js');
const { settleOfferLoop } = await import('../server/services/trade-outcomes.js');

db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
db.exec(`CREATE INDEX IF NOT EXISTS ltr_proposed ON league_transactions_raw(league_id, proposed_at)`);

const iso = ms => (ms ? new Date(ms).toISOString() : null);
const now = new Date().toISOString();
const leagues = rows(`SELECT id, league_id, season, name, espn_s2, swid FROM leagues
                      WHERE platform = 'espn' AND espn_s2 IS NOT NULL AND swid IS NOT NULL`);
const upsert = db.prepare(`INSERT INTO league_transactions_raw VALUES
  (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,@team_id,@member_id,
   @related_tx_id,@scoring_period,@bid_amount,@is_pending,@items_json,@raw_json,@first_seen_at,@last_seen_at)
  ON CONFLICT(league_id, season, tx_id) DO UPDATE SET
    status=excluded.status, processed_at=COALESCE(excluded.processed_at, processed_at),
    is_pending=excluded.is_pending, items_json=excluded.items_json, raw_json=excluded.raw_json,
    last_seen_at=excluded.last_seen_at`);

let totalNew = 0, totalSeen = 0, failed = 0;
for (const lg of leagues) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${lg.season}/segments/0/leagues/${lg.league_id}?view=mTransactions2&view=mPendingTransactions`;
  try {
    const r = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: `espn_s2=${lg.espn_s2}; SWID=${lg.swid}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    const j = await r.json();
    const all = [...(j.transactions ?? []), ...(j.pendingTransactions ?? [])];
    const before = rows(`SELECT COUNT(*) AS n FROM league_transactions_raw WHERE league_id = ? AND season = ?`, lg.id, lg.season)[0].n;
    // node:sqlite has no .transaction(); BEGIN/COMMIT by hand.
    db.exec('BEGIN');
    try {
      for (const t of all) {
        if (!t?.id) continue;
        upsert.run({
          league_id: lg.id, season: lg.season, tx_id: String(t.id), type: t.type ?? null, status: t.status ?? null,
          execution_type: t.executionType ?? null, proposed_at: iso(t.proposedDate), processed_at: iso(t.processDate),
          team_id: t.teamId ?? null, member_id: t.memberId ?? null, related_tx_id: t.relatedTransactionId ?? null,
          scoring_period: t.scoringPeriodId ?? null, bid_amount: t.bidAmount ?? null, is_pending: t.isPending ? 1 : 0,
          items_json: JSON.stringify(t.items ?? []), raw_json: JSON.stringify(t), first_seen_at: now, last_seen_at: now,
        });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const after = rows(`SELECT COUNT(*) AS n FROM league_transactions_raw WHERE league_id = ? AND season = ?`, lg.id, lg.season)[0].n;
    totalNew += after - before; totalSeen += all.length;
    console.log(`league ${lg.id} ${String(lg.name).trim()}: ${all.length} in window, ${after - before} new, ${after} stored`);
    // Post-sync (CLONE-01b b1): grade every offer Nick logged as sent against the
    // rows just collected. Read-only toward ESPN; writes trade_outcomes only.
    try {
      const s = settleOfferLoop(lg.id, lg.season);
      console.log(`league ${lg.id}: offers observed ${s.observed.written} new (${s.observed.state}), `
        + `sent ${s.sent.settled} settled / ${s.sent.matched} matched / ${s.sent.pending} pending (${s.sent.state})`);
    } catch (e) {
      failed++; console.log(`league ${lg.id}: offer settle ERROR ${String(e?.message ?? e).slice(0, 160)}`);
    }
  } catch (e) {
    failed++; console.log(`league ${lg.id}: ERROR ${String(e?.message ?? e).slice(0, 120)}`);
  }
}
console.log(`transactions: seen ${totalSeen}, new ${totalNew}, failed ${failed}`);
run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs) VALUES ('league_transactions', ?, ?, ?, 1)
     ON CONFLICT(job) DO UPDATE SET last_run_at=excluded.last_run_at, last_status=excluded.last_status,
     last_detail=excluded.last_detail, runs=runs+1`, now, failed ? 'error' : 'ok', JSON.stringify({ seen: totalSeen, new: totalNew, failed }));
process.exit(0);
