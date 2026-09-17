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
 * Sources today, in order of how much they can carry:
 *   chat      - the labeled iMessage corpus (private DB, ~15k messages)
 *   tx        - league_transactions_raw, forward-captured since 2026-09-17
 *   roster    - the synced ESPN payload (lineup discipline, roster shape)
 *   nick      - Nick's own read of the person, as an explicit PRIOR
 *
 * `nick` rows are priors, not facts: they carry a small effective sample size
 * so that a handful of real observations outweighs them, and where the data
 * disagrees the disagreement is recorded rather than silently resolved. That
 * rule exists because the first read Nick gave us ("Haiden auto-drafts") was
 * contradicted by his lineups within the hour.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, rows, run } from '../db/index.js';
import { identityMap } from './manager-identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAT_DB = path.join(ROOT, 'data/derived/league_chat.sqlite');

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

/** Open the private chat DB read-only; absent is normal (another machine). */
function openChat() {
  try { return new DatabaseSync(CHAT_DB, { readOnly: true }); } catch { return null; }
}

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

function txSignals(leagueId, rosterId) {
  // `teamId` is the team that ACTED. For a proposal that is the proposer; for
  // an accept/decline it is the responder. Counting both under one manager
  // would conflate "offers a lot" with "gets offered a lot", which are opposite
  // archetypes, so they are kept as separate metrics.
  const r = rows(`SELECT type, status, COUNT(*) AS n FROM league_transactions_raw
                  WHERE league_id = ? AND team_id = ? GROUP BY type, status`, leagueId, Number(rosterId));
  if (!r.length) return [];
  const get = (t, s) => r.filter(x => x.type === t && (s == null || x.status === s))
    .reduce((a, x) => a + x.n, 0);
  const proposals = get('TRADE_PROPOSAL');
  const accepts = get('TRADE_ACCEPT');
  const declines = get('TRADE_DECLINE');
  const decided = accepts + declines;
  const waivers = get('WAIVER') + get('FREEAGENT');
  const out = [
    { metric: 'tx_proposals_sent', value: proposals, n: proposals, source: 'tx' },
    { metric: 'tx_decisions_made', value: decided, n: decided, source: 'tx' },
    { metric: 'tx_waiver_moves', value: waivers, n: waivers, source: 'tx' },
  ];
  // An acceptance rate from fewer than five decisions is noise dressed as a
  // number; withhold it rather than let the finder rank on it.
  if (decided >= 5) out.push({ metric: 'tx_accept_rate', value: accepts / decided, n: decided, source: 'tx' });
  if (proposals >= 5) {
    const cancelled = get('TRADE_PROPOSAL', 'CANCELED');
    out.push({ metric: 'tx_proposal_cancel_rate', value: cancelled / proposals, n: proposals, source: 'tx' });
  }
  return out;
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

export function buildManagerSignals(leagueId) {
  const lg = rows('SELECT payload FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return { league_id: leagueId, error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const ids = identityMap(leagueId);
  const chat = openChat();
  const written = [];
  const playerViews = [];

  for (const team of payload.teams ?? []) {
    const rosterId = String(team.id);
    const ident = ids.get(rosterId);
    const signals = [...rosterSignals(payload, rosterId), ...txSignals(leagueId, rosterId)];
    if (chat && ident?.chat_name) {
      signals.push(...chatSignals(chat, ident.chat_name));
      for (const [k, v] of Object.entries(NICK_PRIORS[ident.chat_name] ?? {})) {
        signals.push({ metric: `prior_${k}`, value: v, n: 3, source: 'nick' });
      }
      for (const pv of chat.prepare(`SELECT player, sentiment_mean, n, last_mention
                                     FROM manager_player_sentiment WHERE name = ?`).all(ident.chat_name)) {
        playerViews.push({ rosterId, player: pv.player, sentiment: pv.sentiment_mean, n: pv.n, last: pv.last_mention });
      }
    }
    for (const s of signals) written.push({ rosterId, ...s });
  }
  chat?.close();

  db.exec('BEGIN');
  try {
    run('DELETE FROM manager_signals WHERE league_id = ?', leagueId);
    for (const s of written) {
      run(`INSERT INTO manager_signals (league_id,roster_id,metric,value,n,source,computed_at)
           VALUES (?,?,?,?,?,?,datetime('now'))`, leagueId, s.rosterId, s.metric, s.value, s.n, s.source);
    }
    run('DELETE FROM manager_player_view WHERE league_id = ?', leagueId);
    for (const v of playerViews) {
      run(`INSERT OR REPLACE INTO manager_player_view
             (league_id,roster_id,player_name,sentiment,n,last_mention,source)
           VALUES (?,?,?,?,?,?,'chat')`, leagueId, v.rosterId, v.player, v.sentiment, v.n, v.last);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return {
    league_id: leagueId, signals: written.length, player_views: playerViews.length,
    rosters_with_chat: new Set(written.filter(s => s.source === 'chat').map(s => s.rosterId)).size,
  };
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
