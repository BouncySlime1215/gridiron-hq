#!/usr/bin/env node
/**
 * SCREENSHOT-OFFERS, ledger half: confident offers read off chat screenshots become
 * trade_outcomes rows (source 'observed_screenshot') through the ledger's own writer,
 * server/services/trade-outcomes.js#recordScreenshotOffer. Nothing else writes them.
 *
 * A finalize screen (a draft before Send) is recorded only if ESPN has a trace of the deal; else it
 * is left 'unconfirmed_draft' and looked at again on the next run.
 *
 * Input: `screenshot_trades` in the local chat DB (scripts/chat/screenshot_offers.py): rows
 * with source 'ocr', kind offer|finalize|accepted|declined, needs_review = 0. Hypothetical
 * (analyzer/calculator) and trade-block screens are never offers and are never read here.
 * Each row carries ids only; this script adds each player's ESPN id and his FantasyCalc
 * value AS OF the offer's date (dynasty_value_history, the league's format), or null when
 * no price that old is on file. It writes back ledger_state / ledger_id / matched_tx_id.
 *
 *   GRIDIRON_DB_PATH=<app db> node scripts/chat/feed_screenshot_offers.mjs [--chat-db <path>]
 *       [--migrate]   run the app's migrations first (preflight repair + 108), with the
 *                     runner's own pre-migration backup
 *       [--dry-run]   read and match only; write nothing to either DB
 *
 * Also writes chat_trade_interest (people/chat-trade-interest.js): a league-mate's own finalize/draft or
 * analyzer screen as wants / would-give ids, a shadow signal for the his-side lens. Nick's own are skipped.
 *
 * PRIVACY: local only. No network, no model call. Prints counts only (no names, no text).
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const LEDGER_KINDS = ['offer', 'finalize', 'accepted', 'declined'];
const STATUS_OF = { offer: 'proposed', finalize: 'proposed', accepted: 'accepted', declined: 'declined' };

export async function feed({ chatDbPath, migrate = false, dryRun = false } = {}) {
  const dbmod = await import('../../server/db/index.js');
  if (migrate && !dryRun) await (await import('../../server/db/migrate.js')).runMigrations();
  const ledger = await import('../../server/services/trade-outcomes.js');
  const { loadDecidedOffers } = await import('../../server/services/eval/decided-offers.js');
  const { deriveFormat } = await import('../../server/services/format.js');
  const { recordChatTradeInterest } = await import('../../server/services/people/chat-trade-interest.js');
  const { rows, row } = dbmod;
  const appDb = dbmod.db;

  const decided = () => {
    const r = loadDecidedOffers(appDb);
    const bySource = {};
    for (const o of r.offers) bySource[o.source] = (bySource[o.source] ?? 0) + 1;
    return { offers: r.offers.length, by_source: bySource, orphans: r.orphans.length };
  };
  const before = decided();

  const chat = new DatabaseSync(chatDbPath, dryRun ? { readOnly: true } : {});
  const shots = chat.prepare(`SELECT id, attachment_guid, kind, league_id, season, from_roster, to_roster, give_ids, get_ids,
      proposed_at, proposed_at_basis, posted_at, confidence, ledger_state FROM screenshot_trades
    WHERE source = 'ocr' AND needs_review = 0 AND kind IN (${LEDGER_KINDS.map(() => '?').join(',')})
      AND league_id IS NOT NULL
      AND (ledger_state IS NULL OR ledger_state IN ('ledger_not_widened', 'refused', 'unconfirmed_draft'))
    ORDER BY COALESCE(proposed_at, posted_at), id`).all(...LEDGER_KINDS);

  const hasHistory = !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'dynasty_value_history'`);
  const formatOf = new Map();
  const fmt = lid => {
    if (!formatOf.has(lid)) {
      const lg = row('SELECT * FROM leagues WHERE id = ?', lid);
      formatOf.set(lid, lg ? deriveFormat(lg).formatKey : null);
    }
    return formatOf.get(lid);
  };
  const item = (pid, from, to, formatKey, asOf) => {
    const p = row('SELECT id, espn_id FROM players WHERE id = ?', pid);
    const v = hasHistory && formatKey && asOf ? row(`SELECT redraft_value, captured_on FROM dynasty_value_history
      WHERE format_key = ? AND player_id = ? AND captured_on <= ? ORDER BY captured_on DESC LIMIT 1`,
    formatKey, pid, asOf.slice(0, 10)) : null;
    return { playerId: p?.espn_id ?? null, player_id: pid, fromTeamId: from, toTeamId: to,
      fc_value: v?.redraft_value ?? null, fc_captured_on: v?.captured_on ?? null, fc_format: formatKey };
  };

  const counts = { candidates: shots.length, recorded: 0, espn_duplicate: 0, espn_near_duplicate: 0, app_duplicate: 0, same_offer: 0,
    already_recorded: 0, unconfirmed_draft: 0, refused: 0, ledger_not_widened: 0, with_fc_values: 0, by_league: {}, by_status: {} };
  const touched = new Set();
  const writeBack = dryRun ? null : chat.prepare(
    `UPDATE screenshot_trades SET ledger_state = ?, ledger_id = ?, matched_tx_id = COALESCE(?, matched_tx_id) WHERE id = ?`);
  for (const s of shots) {
    const asOf = s.proposed_at ?? s.posted_at;
    const formatKey = fmt(s.league_id);
    const give = JSON.parse(s.give_ids ?? '[]').map(pid => item(pid, s.from_roster, s.to_roster, formatKey, asOf));
    const get = JSON.parse(s.get_ids ?? '[]').map(pid => item(pid, s.to_roster, s.from_roster, formatKey, asOf));
    const o = { league_id: s.league_id, season: s.season, attachment_guid: s.attachment_guid, kind: s.kind,
      status: STATUS_OF[s.kind], proposer_team_id: s.from_roster, counterparty_team_id: s.to_roster, give, get,
      proposed_at: s.proposed_at, proposed_at_basis: s.proposed_at_basis, seen_at: s.posted_at, confidence: s.confidence };
    let res;
    if (dryRun) res = { state: 'dry_run' };
    else {
      res = ledger.recordScreenshotOffer(o);
      writeBack.run(res.state, res.id ?? null, res.matched_tx_id ?? null, s.id);
    }
    counts[res.state] = (counts[res.state] ?? 0) + 1;
    if (res.state === 'recorded') {
      const k = String(s.league_id);
      counts.by_league[k] = (counts.by_league[k] ?? 0) + 1;
      if ([...give, ...get].every(i => i.fc_value != null)) counts.with_fc_values++;
      const st = row('SELECT status FROM trade_outcomes WHERE id = ?', res.id)?.status;
      counts.by_status[st] = (counts.by_status[st] ?? 0) + 1;
    }
    touched.add(`${s.league_id}:${s.season}`);
  }
  // Rows written on earlier runs are settled too, from ESPN rows collected since.
  const settle = { settled: 0, duplicates: 0, pending: 0 };
  if (!dryRun) {
    for (const r of rows(`SELECT DISTINCT league_id, season FROM trade_outcomes WHERE source = 'observed_screenshot'`)) {
      touched.add(`${r.league_id}:${r.season}`);
    }
    for (const k of touched) {
      const [lid, season] = k.split(':').map(Number);
      const r = ledger.settleScreenshotOffers(lid, season);
      for (const f of Object.keys(settle)) settle[f] += r[f] ?? 0;
    }
  }
  // CHAT-TRADE-INTEREST: a league-mate's own finalize draft or analyzer screen says whom he would give
  // (give_ids: his side) and whom he wants (get_ids). Nick's own screens are not a signal about a partner.
  const interest = { candidates: 0, recorded: 0, already_recorded: 0, nicks_own: 0, refused: 0, table_absent: 0 };
  const mine = new Map(rows('SELECT id, my_team_id FROM leagues').map(r => [Number(r.id), r.my_team_id == null ? null : Number(r.my_team_id)]));
  for (const s of chat.prepare(`SELECT attachment_guid, kind, league_id, season, from_roster, give_ids, get_ids, posted_at, confidence
      FROM screenshot_trades WHERE source = 'ocr' AND needs_review = 0 AND kind IN ('finalize', 'hypothetical')
        AND league_id IS NOT NULL AND from_roster IS NOT NULL`).all()) {
    interest.candidates++;
    if (mine.get(Number(s.league_id)) === Number(s.from_roster)) { interest.nicks_own++; continue; }
    if (dryRun) continue;
    const r = recordChatTradeInterest({ league_id: s.league_id, season: s.season, roster_id: s.from_roster,
      would_give_ids: JSON.parse(s.give_ids ?? '[]'), wants_ids: JSON.parse(s.get_ids ?? '[]'), kind: s.kind,
      seen_at: s.posted_at, confidence: s.confidence, source_key: s.attachment_guid });
    interest[r.state] = (interest[r.state] ?? 0) + 1;
  }
  chat.close();
  const after = decided();
  const ledgerRows = rows(`SELECT status, COUNT(*) AS n FROM trade_outcomes WHERE source = 'observed_screenshot' GROUP BY status`)
    .reduce((m, r) => ({ ...m, [r.status]: r.n }), {});
  return { counts, settle, screenshot_rows_in_ledger: ledgerRows, decided_offers: { before, after }, chat_trade_interest: interest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chatDbPath = opt('--chat-db') || process.env.LEAGUE_CHAT_OUT || path.join(ROOT, 'data', 'derived', 'league_chat.sqlite');
  if (!process.env.GRIDIRON_DB_PATH) {
    console.error('feed_screenshot_offers: set GRIDIRON_DB_PATH to the app DB (a copy first)');
    process.exit(2);
  }
  const out = await feed({ chatDbPath: chatDbPath.replace(/^~/, os.homedir()), migrate: flag('--migrate'), dryRun: flag('--dry-run') });
  console.log('screenshot_offers_ledger ' + JSON.stringify(out));
}
