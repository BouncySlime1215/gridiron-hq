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
  tx: { label: 'ESPN transactions', refreshed: 'every refresh tick (league_transactions_raw)', priceable: true },
  outcome: { label: 'All-play and luck (luck-panel, via the archetype build)',
    refreshed: 'when scripts/build-manager-archetypes.mjs runs', priceable: true },
  draft: { label: "This season's draft (archetype build)", refreshed: 'when scripts/build-manager-archetypes.mjs runs',
    // study/features/archetypes.md: no draft metric survived a year-over-year
    // repeatability test. Context for a human, never an input to a price.
    priceable: false },
  chat: { label: 'League chat (private)', refreshed: 'every refresh tick', priceable: true },
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
  let asOf = null;
  for (const r of rows(`SELECT member_id, metric, value, n, source, computed_at FROM manager_archetypes
                        WHERE league_id = ? AND season = ? AND source IN ('draft', 'outcome')`, leagueId, season)) {
    const name = ARCHETYPE_METRICS[r.source]?.[r.metric];
    if (!name || !Number.isFinite(r.value)) continue;
    (byMember.get(r.member_id) ?? byMember.set(r.member_id, []).get(r.member_id))
      .push({ metric: name, value: r.value, n: r.n, source: r.source });
    if (!asOf || r.computed_at > asOf) asOf = r.computed_at;
  }
  return { present: true, byMember, asOf };
}

function rosterSignals(payload, rosterId) {
  const team = (payload.teams ?? []).find(t => String(t.id) === String(rosterId));
  if (!team?.roster?.entries) return [];
  const entries = team.roster.entries;
  const starters = entries.filter(e => e.lineupSlotId !== 20 && e.lineupSlotId !== 21);
  const dead = starters.filter(e => ['OUT', 'INJURY_RESERVE', 'DOUBTFUL']
    .includes(e.playerPoolEntry?.player?.injuryStatus));
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

/** Everything the trade engine needs about one league's managers, in one read. */
export function managerSignalsFor(leagueId) {
  const out = new Map();
  for (const r of rows('SELECT roster_id, metric, value, n, source FROM manager_signals WHERE league_id = ?', leagueId)) {
    if (!out.has(r.roster_id)) out.set(r.roster_id, { metrics: {}, samples: {}, sources: {} });
    const m = out.get(r.roster_id);
    m.metrics[r.metric] = r.value; m.samples[r.metric] = r.n; m.sources[r.metric] = r.source;
  }
  for (const r of rows(`SELECT roster_id, player_name, sentiment, n, last_mention
                        FROM manager_player_view WHERE league_id = ?`, leagueId)) {
    if (!out.has(r.roster_id)) out.set(r.roster_id, { metrics: {}, samples: {}, sources: {} });
    const m = out.get(r.roster_id);
    (m.players ??= new Map()).set(r.player_name.toLowerCase(),
      { sentiment: r.sentiment, n: r.n, last: r.last_mention, multiplier: sentimentMultiplier(r.sentiment, r.n) });
  }
  return out;
}
