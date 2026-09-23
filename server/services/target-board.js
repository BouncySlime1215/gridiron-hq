/**
 * TM-03 — THE TARGET BOARD: one card per league-mate, for picking who to trade with.
 *
 * Served on GET /api/trades/:leagueId/brain/managers (routes/trades.js) beside the
 * hand-set tier, rendered by the Trade Brain's ManagerBoard row.
 *
 * NOTHING HERE IS A NEW NUMBER. Every read is an existing producer, shaped per
 * manager, with its sample size and source beside it:
 *
 *   openness, untouchables,   manager_signals chat_* rows (n = his messages), written by
 *   loss reaction, night        manager-signals.js#buildManagerSignals from league_chat.sqlite
 *   share                       manager_chat_profile through the trusted identity join
 *   down on / rates yours     manager_player_view (sentiment 0-4, 2 = neutral), same writer,
 *                               from league_chat.sqlite manager_player_sentiment
 *   last result, streak       manager_signals last_week_margin / standing_streak (standings)
 *   observed accept rate      manager_signals tx_accept_rate (withheld at build under 5 decided)
 *   busiest hour              trade-tactics.js#timingRead (league_transactions_raw)
 *   roster hole               trade-engine.js#lineupDiff, the Start/Sit week number, per roster
 *   lineup signals (LS-01)    `lineup_signals` when that table exists; LS-01 is not on main yet,
 *                               so it is read only behind column detection
 *
 * Reading the chat DB again here would be a second producer of the same numbers
 * with its own name-to-roster join; the stored copy is the joined one.
 *
 * HAND-SET RULES, stated as such (no fit behind them): a read under
 * TARGET_BOARD_THIN_N observations is THIN; "down on" is a sentiment mean strictly
 * below neutral (2.0) about a player on HIS roster, "rates yours" strictly above
 * neutral about a player on Nick's; the roster hole is the starting slot furthest
 * below the league median starter at that slot.
 *
 * No chat text and no chat-side name is ever served: the player name is the
 * roster's, and the manager is identified by roster id.
 */
import { rows } from '../db/index.js';
import { signalRowsFor } from './manager-signals.js';
import { identityMap } from './manager-identity.js';
import { rosterOwnership } from './talk-vs-model.js';
import { timingRead, TACTIC_THRESHOLDS } from './trade-tactics.js';
import { lineupDiff, assetUniverse } from './trade-engine.js';
import { deriveFormat } from './format.js';

export const TARGET_BOARD_THIN_N = 5;
const NEUTRAL_SENTIMENT = 2.0;
const LS_TABLES = ['lineup_signals', 'lineup_signal'];

const thin = n => !(Number(n) >= TARGET_BOARD_THIN_N);

/** One stored signal as a read, or the named absence of one. */
function read(sig, source, { chat = false, corpus = true } = {}) {
  if (chat && !corpus) return { value: null, n: 0, thin: true, source, state: 'no_corpus' };
  if (!sig || sig.value == null) return { value: null, n: 0, thin: true, source, state: 'not_measured' };
  const n = sig.n ?? 0;
  return { value: sig.value, n, thin: thin(n), source: sig.source ?? source, state: thin(n) ? 'thin' : 'measured' };
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The weakest starting slot of every roster, against the league, on the
 * Start/Sit week number. `lineupDiff` is the canonical per-roster optimum (the
 * League Hub card and Start/Sit agree on it, test/lineup-surfaces-agree.test.js),
 * so the hole is read off it rather than solved a second way.
 */
function rosterHoles(lg, rosterIds, assets) {
  const optimal = new Map();
  const failed = new Map();
  for (const rid of rosterIds) {
    const d = lineupDiff(lg, rid, { assets });
    if (d.error) failed.set(rid, d.error);
    else optimal.set(rid, d.optimal);
  }
  const bySlot = new Map();
  for (const slots of optimal.values()) {
    slots.forEach((s, i) => {
      const key = `${i}:${s.slot}`;
      if (!bySlot.has(key)) bySlot.set(key, []);
      bySlot.get(key).push(s.player?.week_points ?? 0);
    });
  }
  const source = 'trade-engine.js#lineupDiff (Start/Sit week_points), league median starter per slot';
  const out = new Map();
  for (const rid of rosterIds) {
    const slots = optimal.get(rid);
    if (!slots) {
      out.set(rid, { slot: null, player: null, week_points: null, league_median: null, gap: null,
        n: 0, thin: true, source, read_state: 'not_priced', reason: failed.get(rid) ?? 'not priced' });
      continue;
    }
    let hole = null;
    slots.forEach((s, i) => {
      const peers = bySlot.get(`${i}:${s.slot}`) ?? [];
      const wp = s.player?.week_points ?? 0;
      const med = median(peers);
      const gap = +(wp - med).toFixed(2);
      if (!hole || gap < hole.gap) {
        hole = { slot: s.slot, player: s.player?.name ?? null, week_points: wp, league_median: +med.toFixed(2),
          gap, n: peers.length, thin: thin(peers.length), source, read_state: 'present', reason: null,
          below_median: gap < 0 };
      }
    });
    out.set(rid, hole ?? { slot: null, player: null, week_points: null, league_median: null, gap: null,
      n: 0, thin: true, source, read_state: 'not_priced', reason: 'no starting slots in this league' });
  }
  return out;
}

/**
 * LS-01's table, only if it is there with the columns this reads. LS-01 is not
 * on main; its planned shape is (league, roster, player, week, signal, evidence, n).
 * The table name comes from the fixed list above, never from a request.
 */
function lineupSignalReader() {
  for (const table of LS_TABLES) {
    const present = rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length > 0;
    if (!present) continue;
    const cols = new Set(rows(`SELECT name FROM pragma_table_info(?)`, table).map(c => c.name));
    const player = cols.has('player_name') ? 'player_name' : cols.has('player') ? 'player' : null;
    const missing = ['league_id', 'roster_id', 'signal', 'n'].filter(c => !cols.has(c));
    if (missing.length || !player) {
      return { state: 'columns_absent', table, reason: `${table} lacks ${[...missing, ...(player ? [] : ['player'])].join(', ')}` };
    }
    const week = cols.has('week') ? 'week' : 'NULL';
    return {
      state: 'present', table,
      forRoster: (leagueId, rid) => rows(
        `SELECT ${player} AS player, signal, ${week} AS week, n FROM ${table}
         WHERE league_id = ? AND roster_id = ? ORDER BY week DESC, n DESC LIMIT 20`, leagueId, String(rid))
        .map(r => ({ player: r.player, signal: r.signal, week: r.week, n: r.n, thin: thin(r.n), source: table })),
    };
  }
  return { state: 'table_absent', table: null, reason: 'LS-01 lineup signals are not built on this database' };
}

/**
 * The board for every roster in one league.
 *
 * @param lg the leagues row (payload, platform, my_team_id).
 * @param opts.assets a priced asset map, as lineupDiff takes it (tests); omitted,
 *   the league's asset universe.
 * @returns {{ managers: Map<string, object>, meta: object }}
 */
export function targetBoard(lg, { assets = null } = {}) {
  const leagueId = lg.id;
  const me = lg.my_team_id == null ? null : String(lg.my_team_id);
  const payload = JSON.parse(lg.payload);
  const rosterIds = (payload.teams ?? []).map(t => String(t.id));

  const sigs = new Map();
  for (const r of signalRowsFor(leagueId)) {
    const rid = String(r.roster_id);
    if (!sigs.has(rid)) sigs.set(rid, new Map());
    sigs.get(rid).set(r.metric, r);
  }
  const corpus = identityMap(leagueId);
  const owned = rosterOwnership(leagueId) ?? new Map();
  const views = new Map();
  for (const v of rows(`SELECT roster_id, player_name, sentiment, n, last_mention FROM manager_player_view
                        WHERE league_id = ?`, leagueId)) {
    const rid = String(v.roster_id);
    if (!views.has(rid)) views.set(rid, []);
    views.get(rid).push(v);
  }
  const timing = timingRead(leagueId, { season: lg.season ?? null });
  const priced = assets ?? assetUniverse(lg, deriveFormat(lg).formatKey);
  const holes = rosterHoles(lg, rosterIds, priced);
  const ls = lineupSignalReader();

  const managers = new Map();
  for (const rid of rosterIds) {
    const s = sigs.get(rid) ?? new Map();
    const hasCorpus = corpus.has(rid);
    const chat = metric => read(s.get(metric), 'chat', { chat: true, corpus: hasCorpus });

    const playerRead = v => ({ player: v.player_name, sentiment: v.sentiment, n: v.n, thin: thin(v.n),
      source: 'chat', last_mention: v.last_mention ?? null });
    const mine = hasCorpus ? (views.get(rid) ?? []) : [];
    const byN = (a, b) => (b.n ?? 0) - (a.n ?? 0);
    const downOn = mine.filter(v => v.sentiment < NEUTRAL_SENTIMENT
      && owned.get(String(v.player_name).toLowerCase()) === rid).sort(byN).map(playerRead);
    const ratesYours = rid === me ? [] : mine.filter(v => v.sentiment > NEUTRAL_SENTIMENT
      && me != null && owned.get(String(v.player_name).toLowerCase()) === me).sort(byN).map(playerRead);

    const margin = read(s.get('last_week_margin'), 'standings');
    const decided = s.get('tx_decisions_made');
    const accept = s.get('tx_accept_rate')
      ? read(s.get('tx_accept_rate'), 'tx')
      : decided && Number(decided.n) > 0
        ? { value: null, n: decided.n, thin: true, source: 'tx', state: 'withheld_under_5' }
        : read(null, 'tx');

    const t = timing.get(rid) ?? null;
    managers.set(rid, {
      roster_hole: holes.get(rid),
      down_on: downOn,
      rates_yours: ratesYours,
      player_reads_state: hasCorpus ? 'present' : 'no_corpus',
      openness: chat('chat_open_to_trade'),
      untouchable: chat('chat_own_untouchable'),
      tilt: {
        // A single result is a fact, not a sample: it carries n=1 and is not
        // labelled thin. Unknown when no game has been decided.
        last_week_margin: { ...margin, thin: margin.value == null, state: margin.value == null ? 'not_measured' : 'fact' },
        just_lost: margin.value == null ? null : margin.value < 0,
        streak: read(s.get('standing_streak'), 'standings'),
        reacting_to_loss: chat('chat_reacting_to_loss'),
      },
      active_hours: {
        night_share: chat('chat_night_share'),
        busiest_hour_utc: t?.busiest_hour ?? null,
        actions_n: t?.actions_n ?? 0,
        min_actions: TACTIC_THRESHOLDS.timing_min_actions,
        thin: t?.busiest_hour == null,
        source: 'league_transactions_raw',
        read_state: t?.read_state ?? 'not_measured',
        reason: t?.active_hours_reason ?? null,
      },
      accept_rate: accept,
      lineup_signals: ls.state === 'present'
        ? { read_state: 'present', source: ls.table, signals: ls.forRoster(leagueId, rid) }
        : { read_state: ls.state, source: ls.table, reason: ls.reason, signals: [] },
    });
  }

  return {
    managers,
    meta: {
      thin_below: TARGET_BOARD_THIN_N,
      neutral_sentiment: NEUTRAL_SENTIMENT,
      lineup_signals: ls.state,
      rules: 'hand-set: thin under 5 observations; down on = below neutral about his own player; '
        + 'rates yours = above neutral about one of yours; hole = slot furthest below the league median starter',
    },
  };
}
