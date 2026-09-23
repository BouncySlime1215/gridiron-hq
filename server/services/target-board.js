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
 *   buy low / sell high       talk-vs-model.js#talkReads (readTalk verdicts over manager_player_view),
 *                               the SAME call the trade finder prices with
 *                               (counterparty-pricing.js#counterpartyLayer); nothing is re-thresholded here
 *   last result, streak       manager_signals last_week_margin / standing_streak (standings)
 *   observed accept rate      manager_signals tx_accept_rate (withheld at build under 5 decided)
 *   busiest hour              trade-tactics.js#timingRead (league_transactions_raw)
 *   roster hole               tradelab.js#analyzeLeague needs (VOR starter value / league average),
 *                               the one needs source the trade finder uses (trade-engine.js#rosterContext)
 *   lineup signals (LS-01)    `lineup_signals` when that table exists; LS-01 is not on main yet,
 *                               so it is read only behind column detection
 *
 * Reading the chat DB again here would be a second producer of the same numbers
 * with its own name-to-roster join; the stored copy is the joined one.
 *
 * The one HAND-SET rule here, stated as such (no fit behind it): a read under
 * TARGET_BOARD_THIN_N observations is THIN. Which players count as buy low / sell
 * high, and which position is a need, are decided by the canonical producers above.
 *
 * No chat text and no chat-side name is ever served: the player name is the
 * roster's, and the manager is identified by roster id.
 */
import { rows } from '../db/index.js';
import { signalRowsFor } from './manager-signals.js';
import { identityMap } from './manager-identity.js';
import { rosterOwnership, talkReads } from './talk-vs-model.js';
import { timingRead, TACTIC_THRESHOLDS } from './trade-tactics.js';
import { analyzeLeague } from '../routes/tradelab.js';
import { leagueCurrentWeek } from './league-week.js';

export const TARGET_BOARD_THIN_N = 5;
const LS_TABLES = ['lineup_signals', 'lineup_signal'];

/** Exported so the boundary (n=4 thin, n=5 not) is pinned by a test. */
export const thin = n => !(Number(n) >= TARGET_BOARD_THIN_N);

/** One stored signal as a read, or the named absence of one. */
function read(sig, source, { chat = false, corpus = true } = {}) {
  if (chat && !corpus) return { value: null, n: 0, thin: true, source, state: 'no_corpus' };
  if (!sig || sig.value == null) return { value: null, n: 0, thin: true, source, state: 'not_measured' };
  const n = sig.n ?? 0;
  return { value: sig.value, n, thin: thin(n), source: sig.source ?? source, state: thin(n) ? 'thin' : 'measured' };
}

const HOLE_SOURCE = "tradelab.js#analyzeLeague: VOR starter value / league average, the trade finder's needs";

/**
 * Each roster's weakest position, read straight off `analyzeLeague`, the one
 * needs/surplus source the trade finder uses (trade-engine.js#rosterContext and
 * counterparty-pricing.js#deriveRosterNeeds call exactly this). The hole is the
 * position with the lowest starter ratio; `is_need` and `gap` come from its
 * `needs` list, so the board and the finder's "he is short at X" cannot differ.
 */
function rosterHoles(lg, rosterIds, analysis) {
  const out = new Map();
  let teams;
  try {
    teams = (analysis ?? analyzeLeague(lg)).teams ?? [];
  } catch (e) {
    const reason = `needs could not be read: ${String(e?.message ?? e)}`;
    console.error(`[target-board] analyzeLeague failed for league ${lg.id}:`, e);
    for (const rid of rosterIds) out.set(rid, notPriced(reason));
    return out;
  }
  const n = teams.length;
  const byRoster = new Map(teams.map(t => [String(t.roster_id), t]));
  for (const rid of rosterIds) {
    const t = byRoster.get(rid);
    const positions = Object.entries(t?.positions ?? {}).filter(([, p]) => Number.isFinite(p?.ratio));
    if (!t || !positions.length) {
      out.set(rid, notPriced(t ? 'no priced starters on this roster' : 'roster not in the needs read'));
      continue;
    }
    const [position, p] = positions.reduce((lo, cur) => (cur[1].ratio < lo[1].ratio ? cur : lo));
    const need = (t.needs ?? []).find(x => x.position === position) ?? null;
    out.set(rid, {
      position, ratio: p.ratio, is_need: !!need, gap: need ? need.gap : null,
      needs: (t.needs ?? []).map(x => x.position),
      n, thin: thin(n), source: HOLE_SOURCE, read_state: 'present', reason: null,
    });
  }
  return out;
}

function notPriced(reason) {
  return { position: null, ratio: null, is_need: false, gap: null, needs: [], n: 0, thin: true,
    source: HOLE_SOURCE, read_state: 'not_priced', reason };
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
 * @param lg the leagues row (payload, platform, my_team_id, season).
 * @param opts.week the week talkReads reads expectation gaps before; omitted, the
 *   league's current week (the same week /managers/signals prices with).
 * @param opts.analysis an analyzeLeague result (tests); omitted, analyzeLeague(lg).
 * @returns {{ managers: Map<string, object>, meta: object }}
 */
export function targetBoard(lg, { week = undefined, analysis = null } = {}) {
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
  const season = lg.season ?? null;
  const asOfWeek = week === undefined ? leagueCurrentWeek(lg) : week;
  // The trade finder's own talk read: same call, same thresholds, same ownership.
  const talk = new Map();
  for (const [rid, byName] of talkReads(leagueId, season, asOfWeek, { ownedBy: owned })) {
    talk.set(String(rid), [...byName.values()]);
  }
  const timing = timingRead(leagueId, { season });
  const holes = rosterHoles(lg, rosterIds, analysis);
  const ls = lineupSignalReader();

  const managers = new Map();
  for (const rid of rosterIds) {
    const s = sigs.get(rid) ?? new Map();
    const hasCorpus = corpus.has(rid);
    const chat = metric => read(s.get(metric), 'chat', { chat: true, corpus: hasCorpus });

    const playerRead = r => ({ player: r.player, verdict: r.verdict, confidence: r.confidence, why: r.why,
      sentiment: r.sentiment, n: r.mentions, thin: thin(r.mentions), source: 'chat' });
    const reads = hasCorpus ? (talk.get(rid) ?? []) : [];
    const ownerOf = r => owned.get(String(r.player).toLowerCase());
    // buy_low (sour + usage cold) ranks above genuine_sour, then by mentions.
    const rank = { buy_low: 0, genuine_sour: 1, wants_him: 0 };
    const order = (a, b) => rank[a.verdict] - rank[b.verdict] || (b.mentions ?? 0) - (a.mentions ?? 0);
    const downOn = reads.filter(r => (r.verdict === 'buy_low' || r.verdict === 'genuine_sour') && ownerOf(r) === rid)
      .sort(order).map(playerRead);
    const ratesYours = rid === me || me == null ? []
      : reads.filter(r => r.verdict === 'wants_him' && ownerOf(r) === me).sort(order).map(playerRead);

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
      season, week: asOfWeek,
      lineup_signals: ls.state,
      rules: 'hand-set: thin under 5 observations. Buy low / sell high = talkReads verdicts '
        + '(buy_low, genuine_sour on his players; wants_him on yours), the trade finder\'s read. '
        + 'Hole = lowest starter ratio in analyzeLeague, a need when it is in his needs list.',
    },
  };
}
