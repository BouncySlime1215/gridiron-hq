/**
 * Per-manager behavioural signals — the counterparty half of the trade engine.
 *
 * `manager_profiles` stays what it is: a hand-entered override (a tradeability
 * tier and a note). This is the measured layer beside it. Every row is one
 * metric for one manager with the sample size it rests on, because a metric
 * from three observations and a metric from three hundred must not look alike
 * to the model that consumes them, and the UI has to be able to say "based on
 * 4 trades" rather than implying certainty it does not have.
 *
 * Sources today (SIGNAL_SOURCES below is the contract; every row names one):
 *   chat      - the labeled iMessage corpus (private DB, ~15k messages) —
 *               only in a league that has a confirmed chat identity, and only
 *               for identities Nick confirmed or that matched on the exact
 *               full name. Which league that is comes from the data, not from
 *               a number written here: see refreshManagerData.
 *   tx        - league_transactions_raw, forward-captured since 2026-09-17
 *   roster    - the synced ESPN payload (lineup discipline, roster shape)
 *   standings - the synced ESPN record and the last decided matchup
 *   outcome   - all-play and luck from the archetype build (luck-panel)
 *   draft     - this season's draft, from the archetype build — descriptive
 *               only: no draft metric survived the repeatability test
 *   nick      - Nick's own read of the person, as an explicit PRIOR
 *
 * Four of Nick's five leagues have no chat corpus. They get every source
 * except chat and nick, which is the point of building all five: the trade
 * finder's counterparty layer used to be empty for them.
 *
 * `nick` rows are priors, not facts: they carry a small effective sample size
 * so that a handful of real observations outweighs them, and where the data
 * disagrees the disagreement is recorded rather than silently resolved. That
 * rule exists because the first read Nick gave us ("Haiden auto-drafts") was
 * contradicted by his lineups within the hour.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db, rows, run } from '../db/index.js';
import { identityMap, matchIdentities } from './manager-identity.js';
import { PROJECT_ROOT } from '../platform/paths.js';
import { espnDeadReason } from './dead-starters.js';

db.exec(`CREATE TABLE IF NOT EXISTS manager_signals (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  n INTEGER,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, roster_id, metric))`);
db.exec(`CREATE TABLE IF NOT EXISTS manager_player_view (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  sentiment REAL,          -- 0..4, 2 = neutral
  n INTEGER,
  last_mention TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (league_id, roster_id, player_name))`);

/**
 * Every source a signal row may carry, and what it may be used for. A consumer
 * that prices a trade reads `priceable`; a page that shows a manager read shows
 * `label` and `refreshed` so a number never looks fresher than it is.
 */
export const SIGNAL_SOURCES = Object.freeze({
  roster: { label: 'ESPN roster', refreshed: 'every league sync', priceable: true },
  standings: { label: 'ESPN record and last matchup', refreshed: 'every league sync', priceable: true },
  // NOT "every refresh tick". league_transactions_raw has one writer —
  // scripts/collect-league-transactions.mjs, spawned only from
  // scripts/refresh-live-data.mjs, an OFF-SERVER loop — and fly.toml declares no
  // `processes`, so nothing on the deployed app has ever written a row. This
  // string is not decoration: signalRowsFor interpolates it into the `why`
  // served on every tx signal, so a wrong cadence here is a wrong claim per
  // metric on the client. `transactionsCollected` below serves the real date.
  tx: { label: 'ESPN transactions',
    refreshed: 'only when scripts/collect-league-transactions.mjs is run (off-server; see transactions.as_of)',
    priceable: true },
  outcome: { label: 'All-play and luck (luck-panel, via the archetype build)',
    refreshed: 'when scripts/build-manager-archetypes.mjs runs', priceable: true },
  draft: { label: "This season's draft (archetype build)", refreshed: 'when scripts/build-manager-archetypes.mjs runs',
    // study/features/archetypes.md: no draft metric survived a year-over-year
    // repeatability test. Context for a human, never an input to a price.
    priceable: false },
  // NOT "every refresh tick". The corpus is a private SQLite file on Nick's Mac,
  // never in the deployed image, and its rollup is step 3 of
  // scripts/refresh-live-data.mjs — off-server by that script's own header. Like
  // `tx` above, this string is interpolated into the `why` served on every chat
  // signal row, so a wrong cadence here is a wrong claim per metric on the client.
  // `chatCorpusState` below serves the real date, and says when there is none.
  chat: { label: 'League chat (private)',
    refreshed: 'only when the league_chat step of scripts/refresh-live-data.mjs is run (off-server; see chat.as_of)',
    priceable: true },
  nick: { label: "Nick's own read (prior, n=3)", refreshed: 'edited in code', priceable: true },
});

/**
 * Where the private chat DB lives. GRIDIRON_CHAT_DB_PATH lets tests point at a
 * fixture instead of the real corpus; it is read on every call.
 */
export function chatDbPath() {
  return process.env.GRIDIRON_CHAT_DB_PATH || path.join(PROJECT_ROOT, 'data/derived/league_chat.sqlite');
}

/**
 * Open the private chat DB read-only. Absent is normal (another machine) and
 * returns null; any other failure throws rather than passing for "no chat".
 * The refresh loop rewrites the rollup tables every 15 minutes in rollback-
 * journal mode, so a reader that arrives mid-write waits instead of failing.
 */
export function openChatDb() {
  const file = chatDbPath();
  if (!existsSync(file)) return null;
  const chat = new DatabaseSync(file, { readOnly: true });
  chat.exec('PRAGMA busy_timeout = 5000');
  return chat;
}

/**
 * A cheap signature of the chat data that readers derive from: new messages
 * and new or re-labelled classifier rows change it; the rollup rewriting the
 * same aggregates every tick does not. MAX(rowid) rather than COUNT(*) on the
 * 500k-row signal table: 0.1 ms against 6-350 ms, and the classifier writes
 * with INSERT OR REPLACE, which always takes a new rowid. Not caught: an
 * in-place UPDATE that adds no row — no writer does that today.
 */
export function chatDataKey(chat) {
  const m = chat.prepare('SELECT MAX(msg_id) AS m, COUNT(*) AS n FROM messages').get();
  const j = chat.prepare('SELECT MAX(rowid) AS m FROM jev_chat_signals').get();
  return `msg:${m?.m ?? 0}:${m?.n ?? 0}|jev:${j?.m ?? 0}`;
}

const tableExists = name => rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

/**
 * Sentiment arrives on Jev's 0-4 score scale where 2 is neutral. Everything
 * downstream wants a multiplier on value, so map it once, here, and cap it:
 * a chat message is weak evidence and must never move a price more than 12%.
 * The cap is deliberate — an unbounded sentiment term would let one excited
 * text outweigh a season of usage data.
 */
export const SENTIMENT_CAP = 0.12;
export function sentimentMultiplier(score, n) {
  if (!Number.isFinite(score) || !n) return 1;
  const confidence = Math.min(1, n / 5);           // 5 mentions = full weight
  return 1 + SENTIMENT_CAP * confidence * Math.max(-1, Math.min(1, (score - 2) / 2));
}

function chatSignals(chat, chatName) {
  const p = chat.prepare('SELECT * FROM manager_chat_profile WHERE name = ?').get(chatName);
  if (!p) return [];
  const n = p.msgs ?? 0;
  return [
    ['chat_msgs', n, n], ['chat_group_share', n ? p.group_msgs / n : null, n],
    ['chat_tapback_ratio', n ? p.tapbacks / n : null, n],
    ['chat_night_share', p.night_share, n],
    ['chat_trade_talk', p.p_trade_talk, n], ['chat_trash_talk', p.p_trash_talk, n],
    ['chat_confidence', p.confidence_mean, n],
    ['chat_tone_competitive', p.p_competitive, n], ['chat_tone_friendly', p.p_friendly, n],
    ['chat_tone_defensive', p.p_defensive, n],
    ['chat_open_to_trade', p.p_open_to_trade, n],
    ['chat_reacting_to_loss', p.p_reacting_to_loss, n],
    ['chat_own_complaining', p.p_own_complaining, n],
    ['chat_own_untouchable', p.p_own_untouchable, n],
  ].filter(([, v]) => v != null).map(([metric, value, size]) => ({ metric, value, n: size, source: 'chat' }));
}

/**
 * One league-season's transactions, indexed once for every roster.
 *
 * ESPN writes more than one row per action, and reading them naively credits
 * the wrong person. Measured on league_transactions_raw, 2026-09-18:
 *   - an accepted trade leaves TWO TRADE_ACCEPT rows: `EXECUTE` under the
 *     manager who said yes, and `PROCESS` under the PROPOSER when the league
 *     processes it (`CANCEL` if it is then vetoed). Only EXECUTE is a decision;
 *     counting all three credited proposers with accepts they never made.
 *   - every proposal that closes (declined, withdrawn, expired) gets its own
 *     TRADE_PROPOSAL/CANCEL record under the proposer. Counting those as
 *     proposals turned league 4's 56 real offers into 128.
 *   - WAIVER rows include cancelled and failed claims; only EXECUTED moved a
 *     player.
 */
function txIndex(leagueId, season) {
  if (!tableExists('league_transactions_raw')) return { present: false, rows: [], related: new Map() };
  const all = rows(`SELECT tx_id, type, status, execution_type, team_id, related_tx_id, items_json
                    FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, season);
  const related = new Map();
  for (const t of all) {
    if (!t.related_tx_id) continue;
    (related.get(t.related_tx_id) ?? related.set(t.related_tx_id, []).get(t.related_tx_id)).push(t);
  }
  for (const t of all) {
    if (t.type !== 'TRADE_PROPOSAL' || t.execution_type !== 'EXECUTE') continue;
    let items = [];
    try { items = JSON.parse(t.items_json || '[]'); } catch { items = []; }
    t.parties = new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(x => x != null && x > 0).map(Number));
  }
  return { present: true, rows: all, related };
}

function txSignals(tx, rosterId) {
  // `team_id` is the team that ACTED. For a proposal that is the proposer; for
  // a decision it is the responder. "Offers a lot" and "gets offered a lot" are
  // opposite archetypes, so they stay separate metrics.
  const me = Number(rosterId);
  const mine = tx.rows.filter(t => Number(t.team_id) === me);
  const proposals = mine.filter(t => t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE');
  const received = tx.rows.filter(t => t.type === 'TRADE_PROPOSAL' && t.execution_type === 'EXECUTE'
    && Number(t.team_id) !== me && t.parties?.has(me)).length;
  const accepts = mine.filter(t => t.type === 'TRADE_ACCEPT' && t.execution_type === 'EXECUTE').length;
  const declines = mine.filter(t => t.type === 'TRADE_DECLINE' && t.execution_type === 'EXECUTE').length;
  const vetoes = mine.filter(t => t.type === 'TRADE_VETO').length;
  const moves = mine.filter(t => (t.type === 'WAIVER' || t.type === 'FREEAGENT') && t.status === 'EXECUTED').length;
  const decided = accepts + declines;
  if (!mine.length && !received) return [];
  const out = [
    { metric: 'tx_proposals_sent', value: proposals.length, n: proposals.length, source: 'tx' },
    { metric: 'tx_offers_received', value: received, n: received, source: 'tx' },
    { metric: 'tx_decisions_made', value: decided, n: decided, source: 'tx' },
    { metric: 'tx_veto_votes', value: vetoes, n: vetoes, source: 'tx' },
    { metric: 'tx_waiver_moves', value: moves, n: moves, source: 'tx' },
  ];
  // An acceptance rate from fewer than five decisions is noise dressed as a
  // number; withhold it rather than let the finder rank on it.
  if (decided >= 5) out.push({ metric: 'tx_accept_rate', value: accepts / decided, n: decided, source: 'tx' });
  if (proposals.length >= 5) {
    // Withdrawn (or expired): closed with no answer from the other side.
    const withdrawn = proposals.filter(p => {
      const after = tx.related.get(p.tx_id) ?? [];
      return after.some(a => a.type === 'TRADE_PROPOSAL' && a.execution_type === 'CANCEL')
        && !after.some(a => (a.type === 'TRADE_ACCEPT' || a.type === 'TRADE_DECLINE') && a.execution_type === 'EXECUTE');
    }).length;
    out.push({ metric: 'tx_proposal_withdrawn_rate', value: withdrawn / proposals.length, n: proposals.length, source: 'tx' });
  }
  return out;
}

/**
 * The record as ESPN has it, and how the last decided matchup went. The
 * margin is the "post-loss window" input: a manager who just lost by 40 reads
 * an offer differently from one who won by 40.
 */
function standingsSignals(payload, rosterId) {
  const id = Number(rosterId);
  const team = (payload.teams ?? []).find(t => Number(t.id) === id);
  const out = [];
  const rec = team?.record?.overall;
  const games = rec ? (rec.wins ?? 0) + (rec.losses ?? 0) + (rec.ties ?? 0) : 0;
  if (games > 0) {
    const len = rec.streakLength ?? 0;
    out.push(
      { metric: 'standing_wins', value: rec.wins ?? 0, n: games, source: 'standings' },
      { metric: 'standing_losses', value: rec.losses ?? 0, n: games, source: 'standings' },
      { metric: 'standing_points_for', value: rec.pointsFor ?? 0, n: games, source: 'standings' },
      { metric: 'standing_streak', value: rec.streakType === 'WIN' ? len : rec.streakType === 'LOSS' ? -len : 0,
        n: len, source: 'standings' },
    );
  }
  const decided = (payload.schedule ?? [])
    .filter(m => m.winner && m.winner !== 'UNDECIDED' && m.home && m.away
      && (Number(m.home.teamId) === id || Number(m.away.teamId) === id))
    .sort((a, b) => (b.matchupPeriodId ?? 0) - (a.matchupPeriodId ?? 0));
  const last = decided[0];
  if (last) {
    const home = Number(last.home.teamId) === id;
    const mine = home ? last.home.totalPoints : last.away.totalPoints;
    const theirs = home ? last.away.totalPoints : last.home.totalPoints;
    if (Number.isFinite(mine) && Number.isFinite(theirs)) {
      out.push({ metric: 'last_week_margin', value: +(mine - theirs).toFixed(2), n: 1, source: 'standings' });
    }
  }
  return out;
}

/**
 * Draft and outcome metrics for THIS league-season, from the archetype store
 * (manager_archetypes, built by scripts/build-manager-archetypes.mjs). Read,
 * not recomputed — that module and luck-panel own the measurement. Career
 * roll-ups and other leagues are deliberately not copied: a manager's 2023
 * draft in another league says nothing reliable about this one.
 */
const ARCHETYPE_METRICS = {
  draft: { auto_draft_rate: 'draft_auto_rate', reach_rate: 'draft_reach_rate',
    pick_minus_consensus_mean: 'draft_pick_vs_consensus', name_brand_premium_excess: 'draft_name_brand_excess' },
  outcome: { all_play: 'outcome_all_play', luck_wins: 'outcome_luck_wins', h2h_pct: 'outcome_h2h_pct',
    ppg: 'outcome_ppg', beat_median_rate: 'outcome_beat_median_rate' },
};
function archetypeIndex(leagueId, season) {
  if (!tableExists('manager_archetypes')) return { present: false, byMember: new Map(), asOf: null };
  const byMember = new Map();
  for (const r of rows(`SELECT member_id, metric, value, n, source, computed_at FROM manager_archetypes
                        WHERE league_id = ? AND season = ? AND source IN ('draft', 'outcome')`, leagueId, season)) {
    const name = ARCHETYPE_METRICS[r.source]?.[r.metric];
    if (!name || !Number.isFinite(r.value)) continue;
    (byMember.get(r.member_id) ?? byMember.set(r.member_id, []).get(r.member_id))
      .push({ metric: name, value: r.value, n: r.n, source: r.source });
  }
  // The build date comes from the STORE, through the one accessor, not from this
  // loop. It used to be accumulated inside it, after the `continue` above — so the
  // date reported was "newest stamp among the metrics ARCHETYPE_METRICS maps", and
  // editing that allowlist silently moved what a reader was told about when the
  // data was built. Which metrics one consumer copies is not a fact about the age
  // of the store.
  return { present: true, byMember, asOf: archetypesBuilt(leagueId, season).as_of };
}

/** Exported for the one-producer contract (test/dead-starter-one-producer.test.js). */
export function rosterSignals(payload, rosterId) {
  const team = (payload.teams ?? []).find(t => String(t.id) === String(rosterId));
  if (!team?.roster?.entries) return [];
  const entries = team.roster.entries;
  const starters = entries.filter(e => e.lineupSlotId !== 20 && e.lineupSlotId !== 21);
  // The one dead-starter rule (dead-starters.js#deadReason) on ESPN's status alone: this job
  // has only the payload. SUSPENSION counts since SS-01-F1 (it did not before).
  const dead = starters.filter(e => espnDeadReason(e.playerPoolEntry?.player?.injuryStatus) != null);
  // How much of the roster arrived by trade vs waiver vs draft — the cleanest
  // available read on whether someone actually engages with the market.
  const byType = entries.reduce((acc, e) => {
    const k = String(e.acquisitionType ?? 'UNKNOWN').toUpperCase();
    acc[k] = (acc[k] ?? 0) + 1; return acc;
  }, {});
  const n = entries.length;
  return [
    { metric: 'roster_size', value: n, n, source: 'roster' },
    { metric: 'lineup_dead_starters', value: dead.length, n: starters.length, source: 'roster' },
    { metric: 'roster_share_traded', value: n ? (byType.TRADE ?? 0) / n : null, n, source: 'roster' },
    { metric: 'roster_share_waiver', value: n ? ((byType.WAIVER ?? 0) + (byType.ADD ?? 0)) / n : null, n, source: 'roster' },
    { metric: 'roster_share_drafted', value: n ? (byType.DRAFT ?? 0) / n : null, n, source: 'roster' },
    { metric: 'projected_rank_drift', value: (team.currentProjectedRank ?? 0) - (team.draftDayProjectedRank ?? 0),
      n: 1, source: 'roster' },
  ].filter(s => s.value != null);
}

/**
 * Nick's reads, as priors. `n: 3` is the whole point — three notional
 * observations, so five real ones outweigh them.
 */
const NICK_PRIORS = {
  Raj: { sharp: 0.85, adversarial: 0.9, talker: 0.8 },
  'Rami Fakih': { defers_to_others: 0.8, sharp: 0.35 },
  'Parth Bedi': { disengaged: 0.85, seller: 0.7 },
  'Haiden Bonczek': { sharp: 0.15, active: 0.7 },
  'Christian Etheridge': { rapport_with_nick: 0.6 },
  'Josh Smith': { sharp: 0.55, fantasy_experience: 0.2, cocky: 0.7 },
  'Lars Cramer': { sharp: 0.2, consensus_driven: 0.85, fast_replies: 0.9, previously_scammed: 1 },
  'Anthony Vasquez': { quiet: 0.9, sharp: 0.35 },
  'Zach Ruggiero': { quiet: 0.8 },
};

/** Stable text form of a league's rows, for "did anything change". */
const canonical = (signals, views) => JSON.stringify([
  signals.map(s => JSON.stringify([String(s.rosterId), s.metric, s.value, s.n ?? null, s.source])).sort(),
  views.map(v => JSON.stringify([String(v.rosterId), v.player, v.sentiment ?? null, v.n ?? null, v.last ?? null])).sort(),
]);

/**
 * Rebuild one league's manager_signals and manager_player_view.
 *
 * Writes only when the result differs from what is stored, so an idle re-run
 * leaves `computed_at` alone and a cache keyed on it stays warm. When either
 * table changes, both are rewritten together with one millisecond stamp, so
 * MAX(manager_signals.computed_at) moves whenever anything for the league did.
 *
 * @param opts.chat an open chat DB to use, or null for "no chat for this
 *   league"; omitted, the chat DB is opened (and closed) here.
 */
export function buildManagerSignals(leagueId, opts = {}) {
  const lg = rows('SELECT payload, season FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return { league_id: leagueId, error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const season = lg.season ?? payload.seasonId;
  const ids = identityMap(leagueId);
  const ownChat = !('chat' in opts);
  const chat = ownChat ? (ids.size ? openChatDb() : null) : opts.chat;
  // Trusted chat identities mean this league's reads come from the chat. With
  // the chat DB gone, a rebuild would silently strip every one of them, so
  // refuse and leave the stored rows as they are.
  if (ownChat && ids.size && !chat) {
    return { league_id: leagueId, error: `chat corpus expected (trusted chat identities) but no chat DB at ${chatDbPath()}` };
  }
  const tx = txIndex(leagueId, season);
  const arch = archetypeIndex(leagueId, season);
  const written = [];
  const views = new Map();

  try {
    for (const team of payload.teams ?? []) {
      const rosterId = String(team.id);
      const ident = ids.get(rosterId);
      const signals = [
        ...rosterSignals(payload, rosterId),
        ...standingsSignals(payload, rosterId),
        ...txSignals(tx, rosterId),
        ...(arch.byMember.get((team.owners ?? [])[0]) ?? []),
      ];
      if (chat && ident?.chat_name) {
        signals.push(...chatSignals(chat, ident.chat_name));
        for (const [k, v] of Object.entries(NICK_PRIORS[ident.chat_name] ?? {})) {
          signals.push({ metric: `prior_${k}`, value: v, n: 3, source: 'nick' });
        }
        for (const pv of chat.prepare(`SELECT player, sentiment_mean, n, last_mention
                                       FROM manager_player_sentiment WHERE name = ?`).all(ident.chat_name)) {
          // Same key as the table's primary key, last one wins — what INSERT OR
          // REPLACE did — so the change check compares like with like.
          views.set(`${rosterId}|${pv.player}`,
            { rosterId, player: pv.player, sentiment: pv.sentiment_mean, n: pv.n, last: pv.last_mention });
        }
      }
      for (const s of signals) written.push({ rosterId, ...s });
    }
  } finally { if (ownChat) chat?.close(); }

  const playerViews = [...views.values()];
  const stored = canonical(
    rows('SELECT roster_id AS rosterId, metric, value, n, source FROM manager_signals WHERE league_id = ?', leagueId),
    rows(`SELECT roster_id AS rosterId, player_name AS player, sentiment, n, last_mention AS last
          FROM manager_player_view WHERE league_id = ?`, leagueId));
  const unchanged = stored === canonical(written, playerViews);

  if (!unchanged) {
    db.exec('BEGIN');
    try {
      const stamp = rows(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS t`)[0].t;
      run('DELETE FROM manager_signals WHERE league_id = ?', leagueId);
      for (const s of written) {
        run(`INSERT INTO manager_signals (league_id,roster_id,metric,value,n,source,computed_at)
             VALUES (?,?,?,?,?,?,?)`, leagueId, s.rosterId, s.metric, s.value, s.n, s.source, stamp);
      }
      run('DELETE FROM manager_player_view WHERE league_id = ?', leagueId);
      for (const v of playerViews) {
        run(`INSERT OR REPLACE INTO manager_player_view
               (league_id,roster_id,player_name,sentiment,n,last_mention,source)
             VALUES (?,?,?,?,?,?,'chat')`, leagueId, v.rosterId, v.player, v.sentiment, v.n, v.last);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const bySource = {};
  for (const s of written) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  return {
    league_id: leagueId, unchanged, signals: written.length, player_views: playerViews.length,
    rosters: (payload.teams ?? []).length,
    rosters_with_signals: new Set(written.map(s => s.rosterId)).size,
    rosters_with_chat: new Set(written.filter(s => s.source === 'chat').map(s => s.rosterId)).size,
    by_source: bySource,
    tx_table: tx.present ? 'present' : 'absent', tx_rows: tx.rows.length,
    archetypes: arch.present ? 'present' : 'absent', archetypes_as_of: arch.asOf,
  };
}

/**
 * Identities, then signals, for every ESPN league — the one call the refresh
 * loop makes (scripts/build-manager-signals.mjs).
 *
 * A league has a chat corpus when Nick has confirmed at least one member's chat
 * name there. The iMessage extract carries no league id, so his confirmation
 * is the only statement of which league a chat belongs to (league 4 today).
 * Name-matching every league against the chat would attribute it to namesakes:
 * the same "Aiden Smith" who is Haiden in league 4 sits in league 3, and the
 * chat's "Josh Smith" is someone else.
 *
 * A chat league whose chat DB has gone missing is an error for that league and
 * its rows are left untouched: rebuilding it without chat would silently strip
 * every chat read the trade finder uses.
 */
export function refreshManagerData({ leagueIds = null, confirmations = {} } = {}) {
  const started = Date.now();
  const leagues = rows(`SELECT id, name, (payload IS NOT NULL) AS synced FROM leagues
                        WHERE platform = 'espn' ORDER BY id`)
    .filter(l => !leagueIds || leagueIds.includes(l.id));
  const chatLeagues = new Set(rows(`SELECT DISTINCT league_id FROM league_member_identity
                                    WHERE confidence = 'confirmed' AND chat_name IS NOT NULL`).map(r => r.league_id));
  // Which league owns the corpus is derived from confirmed identities, and
  // those rows are only ever written by this function — so on a machine where
  // it has never run, every league looks chat-free and a freshly uploaded
  // corpus attaches to nothing at all. `confirmations` is the way in: a league
  // named here is treated as a chat league for this run, and matchIdentities
  // stores its rows as 'confirmed', so every later run finds it by itself.
  const seeded = new Map(Object.entries(confirmations ?? {})
    .map(([id, map]) => [Number(id), map && typeof map === 'object' ? map : {}])
    .filter(([id, map]) => Number.isFinite(id) && Object.keys(map).length));
  const chat = openChatDb();
  try {
    // Read on first use, inside the chat league's own try: the rollup drops and
    // recreates manager_chat_profile outside a transaction, and a missing table
    // must fail that league alone, never the leagues that have no chat.
    let chatNames = null;
    const chatNamesNow = () => (chatNames ??= chat
      .prepare('SELECT name FROM manager_chat_profile WHERE name IS NOT NULL ORDER BY name').all().map(r => r.name));
    const out = [];
    for (const lg of leagues) {
      const name = String(lg.name ?? '').trim();
      if (!lg.synced) { out.push({ league_id: lg.id, name, skipped: 'league not synced' }); continue; }
      const corpus = chatLeagues.has(lg.id) || seeded.has(lg.id);
      try {
        if (corpus && !chat) {
          throw new Error(`${seeded.has(lg.id) ? 'chat identities were confirmed for this league'
            : 'this league has confirmed chat identities'}, but there is no chat DB at ${chatDbPath()} `
            + '— upload the corpus before naming who is who');
        }
        const ident = matchIdentities(lg.id, {
          chatNames: corpus ? chatNamesNow() : [],
          confirmations: seeded.get(lg.id) ?? {},
        });
        const sig = buildManagerSignals(lg.id, { chat: corpus ? chat : null });
        out.push({
          league_id: lg.id, name, chat_corpus: corpus,
          identities: { rosters: ident.rosters, changed: ident.changed, with_chat_name: ident.matched,
            trusted: ident.trusted },
          ...sig,
        });
      } catch (e) {
        out.push({ league_id: lg.id, name, chat_corpus: corpus, error: String(e?.message ?? e) });
      }
    }
    return {
      status: out.some(l => l.error) ? 'error' : 'ok',
      chat_db: chat ? 'present' : 'absent', ms: Date.now() - started, leagues: out,
    };
  } finally { chat?.close(); }
}

/**
 * Every stored signal for a league, each row carrying whether anything may price
 * on it and why. The read side: the page shows everything, labelled. The route
 * used to run this query itself and join the registry in a local helper, which
 * put the one rule that matters in the one layer that prices nothing.
 */
export function signalRowsFor(leagueId) {
  return rows(`SELECT roster_id, metric, value, n, source, computed_at FROM manager_signals
               WHERE league_id = ? ORDER BY roster_id, source, metric`, leagueId)
    .map(r => {
      const reason = unpriceableReason(r.source);
      const spec = SIGNAL_SOURCES[r.source] ?? null;
      return {
        roster_id: r.roster_id, metric: r.metric, value: r.value, n: r.n,
        source: r.source, computed_at: r.computed_at,
        priceable: reason == null,
        why: spec
          ? `${spec.label}; refreshed ${spec.refreshed}${reason ? ' — context only, never priced' : ''}`
          : reason,
      };
    });
}

/**
 * Why a source's rows may not be priced on, or null when they may.
 *
 * THE ONE PLACE THAT DECIDES. This used to be answered in the HTTP layer, at
 * routes/trades.js, which is the one layer that does not price anything; the
 * accessor the trade engine reads through returned every metric in one bag with
 * no flag. Nothing priced on an unpriceable metric — checked by name across
 * server/ and client/ — but nothing stopped it either, and a rule enforced only
 * in the consumer that happens to obey it is not a rule.
 *
 * An UNDECLARED source returns a reason rather than null: absent must mean not
 * priceable, never priceable by default, or a metric added without its registry
 * entry silently becomes an input to a price.
 */
/**
 * WHEN THE TRANSACTIONS UNDER THIS LEAGUE'S SIGNALS WERE LAST COLLECTED.
 *
 * `manager_signals.computed_at` is when the BUILD ran. It is not when the rows
 * the build read were collected, and the two can be arbitrarily far apart:
 * `scripts/collect-league-transactions.mjs` catches a per-league failure and
 * continues, so a league whose ESPN cookies expired keeps its old rows while
 * the build downstream recomputes happily. `computed_at` moves; the evidence
 * underneath does not. Nothing in the app read these stamps before this.
 *
 * `last_seen_at` is the collector's own upsert stamp — every row it saw in the
 * window gets today's value — so MAX(last_seen_at) is exactly "the collector
 * last ran and reached ESPN for this league". MIN(first_seen_at) is how far
 * back the forward capture reaches, which is a window and not a history: ESPN's
 * mTransactions2 answers with about three days, so anything older was never
 * captured at all.
 *
 * Absent table or no rows is `as_of: null` with a reason, never a borrowed
 * stamp: "collected this morning" and "never collected" must not look alike.
 */
export function transactionsCollected(leagueId, season) {
  const collector = 'scripts/collect-league-transactions.mjs (off-server; nothing on the deployed app writes this table)';
  const empty = { as_of: null, rows: 0, first_seen: null, collected_by: collector };
  if (!tableExists('league_transactions_raw')) {
    return { ...empty, reason: 'league_transactions_raw does not exist on this database — the collector has never run here' };
  }
  const [r] = rows(`SELECT COUNT(*) AS n, MAX(last_seen_at) AS as_of, MIN(first_seen_at) AS first_seen
                    FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)`,
  leagueId, season ?? null, season ?? null);
  if (!r || !r.n) {
    return { ...empty, reason: `no transactions collected for this league yet — run ${collector.split(' (')[0]}` };
  }
  return { as_of: r.as_of ?? null, rows: r.n, first_seen: r.first_seen ?? null,
    collected_by: collector, reason: null };
}

/**
 * WHEN THE ARCHETYPE STORE BEHIND THE OUTCOME AND DRAFT SIGNALS WAS BUILT.
 *
 * Same rule as `transactionsCollected`, same shape, for the same reason: the
 * `outcome` half of `manager_archetypes` becomes `luck_self_view`, which is a
 * TERM IN THE TRADE PRICE, and the store is written only by
 * `scripts/build-manager-archetypes.mjs` — by hand, off-server. A stale luck
 * read priced into a deal is worse than a stale card, because nothing on the
 * card says that number moved the money.
 *
 * Not `manager_signals.computed_at`, deliberately. That is when the signal build
 * COPIED the value across; the signal build can re-run without the archetype
 * build having run, so its stamp advances while the measurement underneath sits
 * still. That is precisely the substitution this accessor exists to prevent.
 */
export function archetypesBuilt(leagueId, season) {
  const builder = 'scripts/build-manager-archetypes.mjs (off-server; nothing on the deployed app writes this store)';
  const empty = { as_of: null, rows: 0, first_seen: null, collected_by: builder };
  if (!tableExists('manager_archetypes')) {
    return { ...empty, reason: 'manager_archetypes does not exist on this database — the build has never run here' };
  }
  const [r] = rows(`SELECT COUNT(*) AS n, MAX(computed_at) AS as_of, MIN(computed_at) AS first_seen
                    FROM manager_archetypes WHERE league_id = ? AND (? IS NULL OR season = ?)
                      AND source IN ('draft', 'outcome')`, leagueId, season ?? null, season ?? null);
  if (!r || !r.n) {
    return { ...empty, reason: `no archetype rows for this league yet — run ${builder.split(' (')[0]}` };
  }
  return { as_of: r.as_of ?? null, rows: r.n, first_seen: r.first_seen ?? null,
    collected_by: builder, reason: null };
}

/**
 * IS THE CHAT CORPUS EVEN ON THIS MACHINE, AND WHEN WAS IT LAST ROLLED UP.
 *
 * The third store, and the one whose absence is the normal case rather than the
 * exception: the corpus is a private SQLite file on Nick's Mac
 * (`chatDbPath()`), deliberately never in the deployed image, and its rollup is
 * step 3 of `scripts/refresh-live-data.mjs` — off-server. So on the live app
 * `openChatDb()` returns null, every chat read downstream produces nothing, and
 * a league with no corpus and a manager who never talks produced the same empty.
 *
 * Four states, four different sentences, because acting on them differs:
 *   - no path configured at all;
 *   - configured but the file is not here (the deployed app, every time);
 *   - here but the rollup has not written `manager_chat_profile`;
 *   - here and rolled up, with the date it was rolled up.
 *
 * Opens read-only and closes; never throws on absence, and never reports an
 * absence as a clean empty.
 */
export function chatCorpusState() {
  const roller = 'the league_chat step of scripts/refresh-live-data.mjs (off-server)';
  // `chatDbPath()` always returns a string — the env var or the in-repo default —
  // so "no path is configured" is not a reachable state and reporting it as one
  // was a branch no test could ever enter. What IS worth saying is WHICH path,
  // and where it came from: a mistyped GRIDIRON_CHAT_DB_PATH and a machine that
  // genuinely has no corpus are the same absence with very different fixes.
  const file = chatDbPath();
  const path_source = process.env.GRIDIRON_CHAT_DB_PATH ? 'GRIDIRON_CHAT_DB_PATH' : 'default';
  const empty = { as_of: null, computed_at: null, rows: 0, path: file, path_source, collected_by: roller };

  let chat = null;
  try { chat = openChatDb(); } catch (e) {
    return { ...empty, reason: `the chat corpus at ${file} could not be opened: ${String(e?.message ?? e)}` };
  }
  if (!chat) {
    // BOTH HALVES, because one of them alone sends the reader to the wrong fix.
    // It cannot be produced here: the corpus is extracted from Apple Messages on
    // Nick's Mac, and no amount of deploying will make it appear. It CAN be put
    // here: POST /api/league-chat/upload (server/routes/league-chat.js) exists
    // for exactly that, and scripts/chat-sync.mjs is what posts to it.
    return { ...empty,
      reason: `there is no chat corpus at ${file} — it cannot be produced on this machine `
        + '(it is extracted from Apple Messages on Nick\'s Mac) but it can be uploaded to this one '
        + 'with POST /api/league-chat/upload' };
  }
  try {
    // TWO STAMPS, TWO FACTS, and conflating them is how a stale corpus reads as
    // current. `as_of` is the newest message anyone in the corpus sent: the age
    // of the DATA. `computed_at` is when the rollup last ran over it: the age of
    // the AGGREGATE. The rollup runs every fifteen minutes whether or not a
    // single new message arrived, so computed_at is always young and says
    // nothing about whether the chat half of a manager read is current.
    //
    // No MIN() here. manager_chat_profile is built CREATE TABLE AS with one
    // `datetime('now') AS computed_at` for the whole table
    // (scripts/chat/extract_league_chat.py), so MIN and MAX of it are equal by
    // construction — a "first seen" that is really just the same stamp again.
    const r = chat.prepare(`SELECT COUNT(*) AS n, MAX(last_msg) AS as_of, MAX(computed_at) AS computed_at
                            FROM manager_chat_profile`).get();
    if (!r || !r.n) {
      return { ...empty,
        reason: `the chat corpus at ${file} is here but has no manager profiles yet — run ${roller}` };
    }
    return { as_of: r.as_of ?? null, computed_at: r.computed_at ?? null, rows: r.n,
      path: file, path_source, collected_by: roller, reason: null };
  } catch (e) {
    // A missing table is a real state: the rollup drops and recreates
    // manager_chat_profile outside a transaction, so a crash between the two
    // leaves it gone. Reported, never passed off as an empty corpus.
    return { ...empty, reason: `the chat corpus at ${file} is here but its rollup tables are not readable: ${String(e?.message ?? e)}` };
  } finally { try { chat.close(); } catch { /* already closed */ } }
}

/**
 * WHEN THE MODEL READ OF EACH MANAGER WAS EVALUATED.
 *
 * The fourth store, and the one whose stamp is least like its neighbour's.
 * `manager_archetype_jev` holds a model's answers to typed questions about one
 * manager's draft record — does he overvalue what he owns, does he counter or
 * decline outright, does he sell low after a bad week. They are written by
 * `scripts/build-manager-archetypes.mjs`, the same script that writes
 * `manager_archetypes`, but ONLY when it is passed `--jev`, which is opt-in and
 * needs a gateway key (`scheduler.js` reports the job as "not run — opt-in").
 *
 * So the archetype build's `computed_at` and this pass's `evaluated_at` are two
 * clocks that drift apart by design: the build can run nightly while the model
 * answers sit untouched for weeks. Serving `archetypesBuilt().as_of` beside a
 * Jev answer would date a measurement by a process that did not make it — the
 * substitution this whole family of accessors exists to prevent.
 *
 * The stamp is returned PER MANAGER, not per league. `storeJevAnswers` stamps
 * each member as he is evaluated and the pass can stop halfway through a league
 * (it costs money per manager), so a league-wide MAX() would print the newest
 * manager's date under everybody's name.
 *
 * Four absences, four sentences, because the fix differs in each:
 *   - the table is not on this database at all;
 *   - it is here and empty: the pass has never been run;
 *   - it has rows, but none for anyone in this league;
 *   - it covers this league, but not this manager.
 * The last one is answered by the consumer, from an empty `by_roster` entry.
 *
 * Nothing here prices. The trade path serves these answers as a read of the
 * person and never as a term: half of them carry `basis: 'inference_only'`,
 * which is the store saying in its own column that the number is a prior.
 */
export function jevEvaluated(leagueId) {
  const evaluator = 'scripts/build-manager-archetypes.mjs --jev (off-server; opt-in, needs a gateway key, '
    + 'and nothing on the deployed app writes this store)';
  const empty = { as_of: null, rows: 0, evaluated_by: evaluator, by_roster: new Map() };
  if (!tableExists('manager_archetype_jev')) {
    return { ...empty, reason: 'manager_archetype_jev does not exist on this database — the Jev pass has never run here' };
  }
  const [total] = rows('SELECT COUNT(*) AS n FROM manager_archetype_jev');
  if (!total?.n) {
    return { ...empty,
      reason: 'the Jev pass has never been run: it is opt-in, and `npm run build:manager-archetypes -- --jev` '
        + 'is what would answer these questions' };
  }
  // The store is keyed by member_id alone — on purpose, because how a person
  // negotiates is a fact about the person and not about one of his leagues —
  // so the roster mapping is the join and the answers travel across leagues.
  //
  // `league_member_identity`, not `league_season_teams`. The second is the
  // mapping `manager-archetypes.js` itself joins on, and it is created only by
  // `scripts/backfill-league-history.mjs`: on any database where that backfill
  // has never run the table is simply absent, and a read through it throws
  // rather than returning an absence. `league_member_identity` is written by
  // `matchIdentities` on every league sync, so it is present wherever a league
  // is. Its `confidence` column is not consulted here: that gate governs
  // attributing CHAT to a roster, and an ESPN member id is an ESPN fact — a
  // manager whose chat name was never confirmed still has one.
  const answered = rows(`SELECT i.roster_id AS roster_id, j.member_id AS member_id, j.question AS question,
                                j.outcome AS outcome, j.probability AS probability, j.basis AS basis,
                                j.n_seasons AS n_seasons, j.n_picks AS n_picks, j.model AS model,
                                j.evaluated_at AS evaluated_at
                         FROM manager_archetype_jev j
                         JOIN league_member_identity i ON i.espn_member_id = j.member_id
                         WHERE i.league_id = ?`, leagueId);
  if (!answered.length) {
    return { ...empty,
      reason: 'the Jev pass has run, but for no manager in this league — it is run one manager at a time '
        + 'and costs a gateway call each, so a partial store is the normal state' };
  }
  const byRoster = new Map();
  let newest = null;
  for (const r of answered) {
    const key = String(r.roster_id);
    if (!byRoster.has(key)) {
      byRoster.set(key, { roster_id: key, member_id: r.member_id, as_of: null, model: r.model ?? null,
        questions: {} });
    }
    const entry = byRoster.get(key);
    // HIS newest, and separately the league's, which are different facts.
    if (r.evaluated_at && (entry.as_of == null || r.evaluated_at > entry.as_of)) entry.as_of = r.evaluated_at;
    if (r.evaluated_at && (newest == null || r.evaluated_at > newest)) newest = r.evaluated_at;
    entry.questions[r.question] ??= { basis: r.basis, n_seasons: r.n_seasons, n_picks: r.n_picks, p: {} };
    entry.questions[r.question].p[r.outcome] = r.probability;
  }
  return { as_of: newest, rows: answered.length, evaluated_by: evaluator, by_roster: byRoster, reason: null };
}

export function unpriceableReason(source) {
  const spec = SIGNAL_SOURCES[source];
  if (!spec) {
    return `source '${source}' is not declared in SIGNAL_SOURCES, so nothing may price on it`;
  }
  if (spec.priceable) return null;
  return `${spec.label} is declared priceable: false — context only, never priced`;
}

/**
 * Everything the trade engine needs about one league's managers, in one read.
 *
 * `metrics` / `samples` / `sources` carry ONLY what may be priced on. Anything
 * that may not is in `context` / `context_samples` / `context_sources`, with the
 * reason in `context_reasons`. That is a property, not a convention: a caller on
 * the pricing path cannot reach a draft metric by name because it is not in the
 * bag it reads, so the guard survives the next person who has not read this
 * comment. Nothing is dropped — the page still shows every stored row, through
 * `signalRowsFor` below.
 */
export function managerSignalsFor(leagueId) {
  const out = new Map();
  const blank = () => ({ metrics: {}, samples: {}, sources: {},
    context: {}, context_samples: {}, context_sources: {}, context_reasons: {} });
  for (const r of rows('SELECT roster_id, metric, value, n, source FROM manager_signals WHERE league_id = ?', leagueId)) {
    if (!out.has(r.roster_id)) out.set(r.roster_id, blank());
    const m = out.get(r.roster_id);
    const reason = unpriceableReason(r.source);
    if (reason) {
      m.context[r.metric] = r.value; m.context_samples[r.metric] = r.n;
      m.context_sources[r.metric] = r.source; m.context_reasons[r.metric] = reason;
      continue;
    }
    m.metrics[r.metric] = r.value; m.samples[r.metric] = r.n; m.sources[r.metric] = r.source;
  }
  for (const r of rows(`SELECT roster_id, player_name, sentiment, n, last_mention
                        FROM manager_player_view WHERE league_id = ?`, leagueId)) {
    if (!out.has(r.roster_id)) out.set(r.roster_id, blank());
    const m = out.get(r.roster_id);
    (m.players ??= new Map()).set(r.player_name.toLowerCase(),
      { sentiment: r.sentiment, n: r.n, last: r.last_mention, multiplier: sentimentMultiplier(r.sentiment, r.n) });
  }
  return out;
}
