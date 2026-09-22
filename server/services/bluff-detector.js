/**
 * Reading a bluff: does this person mean what he says about his own players?
 *
 * Nick, 2026-09-17: "we need to be able to read past bluffs and recognize this
 * accurately." This matters more than it first appears, because the trade
 * finder had just started REMOVING declared untouchables from the search
 * entirely. That is the right treatment for someone whose word holds and
 * exactly the wrong one for someone who says "not moving him" as an opening
 * price — for a bluffer it deletes his best players from consideration, which
 * is the most expensive possible way to be polite.
 *
 * A bluff here is a REVERSAL, not a lie: a manager declares a player
 * untouchable (or otherwise closes the door) and later opens it — by saying so,
 * or by trading the player. Both sides of that are things we can observe:
 *
 *   declarations  chat messages labeled `own_roster.untouchable` that name a
 *                 player, or a high `player_sentiment` on his own guy paired
 *                 with a refusal
 *   reversals     a later message about that same player labeled
 *                 `open_to_trade`, or the player actually leaving his roster
 *                 in league_transactions_raw
 *
 * WHAT THIS CANNOT DO, stated plainly: it cannot tell a bluff from an honest
 * change of mind. A manager whose RB1 gets hurt and who then shops him has not
 * bluffed. So the window matters — a reversal inside a few days is evidence
 * about how he negotiates; a reversal six weeks later is evidence about
 * football. Only the short window counts, and the number is always reported
 * with its sample size because these counts are small by nature.
 */
import { rows } from '../db/index.js';
import { fingerprint } from './compute-cache.js';
import { servedTableState } from './data-freshness.js';
import { openChatDb, chatDbPath, chatDataKey } from './manager-signals.js';
import { TRUSTED_CONFIDENCE } from './manager-identity.js';
import { normalizePlayerName } from './player-identity.js';
import { currentNflWeek } from './weekly-learning.js';

/** A reversal inside this many days is about negotiating, not about football. */
export const BLUFF_WINDOW_DAYS = 10;
/** League-average bluff rate to shrink toward, and the strength of that pull. */
export const PRIOR_BLUFF_RATE = 0.35;
export const PRIOR_WEIGHT = 4;

/**
 * Which absence the ownership check is working from, as data-freshness.js reads
 * `league_roster_snapshots` (one entry per table: servedTableEntry). Its one writer is
 * `writePeriod` in scripts/collect-roster-snapshots.mjs, run only by the local refresh
 * loop (scripts/refresh-live-data.mjs); no server job writes it. The rule binds the
 * season being played, taken from the producer the Data Health route uses.
 *
 * Anything but `fresh` means ownedPlayersByChatName below leans on the CURRENT roster
 * fallback for someone, and with the table empty it leans on it for everyone: a player
 * he declared untouchable and has since traded away is no longer "his", so that
 * declaration, the bluff this file exists to catch, drops out without a trace.
 */
function rosterHistoryState() {
  return servedTableState('league_roster_snapshots', { currentSeason: currentNflWeek().season });
}

/**
 * What the ownership check read, for the credibility cache key: every snapshot write
 * moves it, including the collector's in-place UPDATEs (changed_at is bumped on every
 * change, collect-roster-snapshots.mjs writePeriod). The state rides along because a
 * season rollover makes the same rows stale with no write at all.
 */
const rosterHistoryKey = state =>
  `${state.state}|${fingerprint([{ table: 'league_roster_snapshots', stamp: 'changed_at' }])}`;

/**
 * Every "this guy is not available" moment we can find, per (manager, player).
 *
 * Two shapes count as a declaration. The explicit one is a message Jev labeled
 * `own_roster.untouchable`. The implicit one is a message about his own player
 * that is simultaneously high-praise and NOT open to trading — the "he's a
 * league winner, I'm good" move, which is the same message with better manners.
 */
/**
 * Every player name a chat name has EVER owned, from the app's own roster history —
 * `league_roster_snapshots` (weekly-captured, migration 058) first, and the current
 * `leagues.payload` roster as a fallback for a manager whose snapshot history has not
 * accumulated yet. Not point-in-time: a manager who traded a player away in July still
 * shows him here. That is deliberate — "ever owned" is enough to rule out the bug this
 * exists to fix (a manager declaring a player he has NEVER owned, i.e. someone else's
 * roster), and requiring exact point-in-time ownership would starve every declaration
 * older than the roster-snapshot history, which started 2026-09-18.
 *
 * Found in the 2026-09-18 structural relook: `declarations()`/`openings()` matched a
 * chat message to `mentioned_player` with no check that the SPEAKER owned that player at
 * all. Live example: Raj's "5 of 5 hard reversals" included Achane and Chase Brown —
 * Nick's players, not Raj's — because Raj talking about someone else's roster looked
 * identical to Raj declaring his own.
 *
 * Returns Map<chat_name lowercased, Set<normalized player name>>. A chat name with no
 * roster data anywhere (no trusted identity, no snapshot, no payload) is simply absent,
 * which is the honest state: "we cannot verify this" is not the same as "false," and a
 * declaration about a name absent from the map is dropped rather than trusted at face value.
 */
function ownedPlayersByChatName() {
  const out = new Map();
  const identities = rows(`SELECT DISTINCT league_id, roster_id, chat_name FROM league_member_identity
                           WHERE chat_name IS NOT NULL AND confidence IN (${TRUSTED_CONFIDENCE.map(() => '?').join(',')})`,
    ...TRUSTED_CONFIDENCE);
  if (!identities.length) return out;
  const add = (chatName, playerName) => {
    if (!playerName) return;
    const key = String(chatName).toLowerCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(normalizePlayerName(playerName));
  };
  for (const id of identities) {
    for (const r of rows(`SELECT player_name FROM league_roster_snapshots
                          WHERE league_id = ? AND team_id = ? AND on_roster = 1`, id.league_id, id.roster_id)) {
      add(id.chat_name, r.player_name);
    }
  }
  // Fallback: current live roster, for a league whose snapshot history has not built up.
  for (const id of identities) {
    if (out.has(String(id.chat_name).toLowerCase())) continue; // already has real snapshot history
    const lg = rows('SELECT payload FROM leagues WHERE id = ?', id.league_id)[0];
    if (!lg?.payload) continue;
    let payload; try { payload = JSON.parse(lg.payload); } catch { continue; }
    const team = (payload.teams ?? []).find(t => String(t.id) === String(id.roster_id));
    for (const e of team?.roster?.entries ?? []) add(id.chat_name, e.playerPoolEntry?.player?.fullName);
  }
  return out;
}

function declarations(chat, minProb = 0.5, owned = ownedPlayersByChatName()) {
  const all = chat.prepare(`
    SELECT s.name, s.mentioned_player AS player, m.ts_utc, s.probability AS prob,
           (SELECT probability FROM jev_chat_signals o
             WHERE o.msg_id = s.msg_id AND o.question = 'open_to_trade') AS open_prob
    FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
    WHERE s.question = 'own_roster.untouchable' AND s.probability >= ?
      AND s.mentioned_player IS NOT NULL AND s.name <> 'ME'
    ORDER BY s.name, s.mentioned_player, m.ts_utc`).all(minProb);
  // A declaration only means something as a claim about the speaker's OWN roster.
  return all.filter(d => owned.get(String(d.name).toLowerCase())?.has(normalizePlayerName(d.player)));
}

/** Later moments where the same manager opened the door on the same player. */
function openings(chat, minProb = 0.6, owned = ownedPlayersByChatName()) {
  const all = chat.prepare(`
    SELECT s.name, s.mentioned_player AS player, m.ts_utc, s.probability AS prob
    FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
    WHERE s.question = 'open_to_trade' AND s.probability >= ?
      AND s.mentioned_player IS NOT NULL AND s.name <> 'ME'`).all(minProb);
  // An "open to trade" reversal is only a REVERSAL if it is about a player he owns.
  // "I would take Rival Star" from someone who never had him is an offer, not a bluff.
  return all.filter(o => owned.get(String(o.name).toLowerCase())?.has(normalizePlayerName(o.player)));
}

const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

/**
 * Per-manager credibility on his own declarations.
 *
 * `credibility` is the shrunk probability that a declaration holds. With no
 * declarations at all it is the league prior, NOT 1 — "we have never heard him
 * refuse" is not evidence that his refusals are honest.
 *
 * Cached per window against chatDataKey: the two queries join the 500k-row
 * classifier table (~90 ms) and used to run on every uncached findTrades call.
 * A new message or classifier row changes the key; the 15-minute rollup
 * rewriting the same aggregates does not. The cached object is shared —
 * callers read it, never mutate it.
 *
 * Read with a corpus: `{ byManager, events, available: true, roster_history }`, where
 * `roster_history` is rosterHistoryState(), which absence (if any) the ownership filter
 * worked from; untouchableStance reads it into the note. With no chat DB:
 * `{ byManager, events, available: false, reason }`, both collections empty and no
 * roster_history, because no ownership check ran and nothing would read it. The roster
 * history is part of the cache key (rosterHistoryKey), because a snapshot write changes
 * who owns whom and so which declarations count — the chat key alone never saw that.
 */
/** Why there is no corpus here, naming the path so the state is checkable. */
const NO_CORPUS_REASON = () =>
  `No chat corpus at ${chatDbPath()}. It is extracted from Apple Messages on Nick's Mac and cannot be `
  + 'produced on this machine, so this is "not on this machine", not "nobody has said anything".';

const credibilityCache = new Map();
export function declarationCredibility({ windowDays = BLUFF_WINDOW_DAYS } = {}) {
  const chat = openChatDb();
  // Not "no data". On any box but Nick's Mac the corpus CANNOT exist: it is
  // extracted from ~/Library/Messages/chat.db by a Python script needing Full
  // Disk Access, so Fly will never have one. An empty result with no reason
  // reads downstream as "he has never called a player untouchable", which is
  // the opposite conclusion and moves a trade price.
  if (!chat) {
    return { byManager: new Map(), events: [], available: false, reason: NO_CORPUS_REASON() };
  }
  try {
    const rosterHistory = rosterHistoryState();
    const key = `${chatDbPath()}|${chatDataKey(chat)}|${rosterHistoryKey(rosterHistory)}`;
    const hit = credibilityCache.get(windowDays);
    if (hit?.key === key) return hit.value;
    const value = credibilityFrom(declarations(chat), openings(chat), windowDays, rosterHistory);
    credibilityCache.set(windowDays, { key, value });
    return value;
  } finally { chat.close(); }
}

function credibilityFrom(decls, opens, windowDays, rosterHistory) {
  const openIndex = new Map();
  for (const o of opens) {
    const k = `${o.name}|${String(o.player).toLowerCase()}`;
    (openIndex.get(k) ?? openIndex.set(k, []).get(k)).push(o.ts_utc);
  }

  const per = new Map();
  const events = [];
  for (const d of decls) {
    const k = `${d.name}|${String(d.player).toLowerCase()}`;
    // A message can be labeled untouchable AND open-to-trade at once ("he's not
    // going anywhere unless someone blows me away"). That is itself a soft
    // declaration, so it is counted as an immediate reversal rather than thrown
    // away — it is precisely the hedged refusal a bluffer makes.
    const selfHedge = Number(d.open_prob) >= 0.5;
    const later = (openIndex.get(k) ?? []).filter(ts => {
      const gap = daysBetween(d.ts_utc, ts);
      return gap > 0 && gap <= windowDays;
    });
    // These are two different things and must not be summed as if they were one.
    // A HARD reversal is "not moving him" on Monday and shopping him on
    // Wednesday: he closed the door and reopened it. A HEDGE is a refusal that
    // was never closed ("he's not going anywhere unless someone blows me away"),
    // which says the door was always ajar. Both mean do not take the refusal
    // literally, but only the first is evidence that his stated positions MOVE,
    // so a hedge counts half. Conflating them would have reported Raj as 5-of-5
    // reversals when four of those were hedges he never walked back at all.
    const hard = later.length > 0;
    const hedge = !hard && selfHedge;
    const rec = per.get(d.name) ?? { declarations: 0, hard: 0, hedged: 0, players: new Map() };
    rec.declarations++; if (hard) rec.hard++; if (hedge) rec.hedged++;
    const pv = rec.players.get(d.player) ?? { declarations: 0, hard: 0, hedged: 0, last: null };
    pv.declarations++; if (hard) pv.hard++; if (hedge) pv.hedged++; pv.last = d.ts_utc;
    rec.players.set(d.player, pv);
    per.set(d.name, rec);
    events.push({ name: d.name, player: d.player, at: d.ts_utc,
      kind: hard ? 'hard_reversal' : hedge ? 'hedged' : 'held',
      how: hard ? `opened the door ${Math.round(daysBetween(d.ts_utc, later[0]))}d later`
        : hedge ? 'hedged in the same message' : 'stood' });
  }

  const out = new Map();
  for (const [name, r] of per) {
    // Shrink toward the league prior: two declarations cannot establish that
    // someone always bluffs, and presenting 2-of-2 as 100% would be the kind of
    // confident-and-wrong number that makes a whole feature untrustworthy.
    const soft = r.hard + 0.5 * r.hedged;
    const bluffRate = (soft + PRIOR_BLUFF_RATE * PRIOR_WEIGHT) / (r.declarations + PRIOR_WEIGHT);
    out.set(name, {
      name, declarations: r.declarations, hard_reversals: r.hard, hedged: r.hedged,
      held: r.declarations - r.hard - r.hedged,
      bluff_rate: +bluffRate.toFixed(3), credibility: +(1 - bluffRate).toFixed(3),
      // "measured" requires hard reversals, not a pile of hedges: hedging is a
      // speech habit, reversing is a revealed preference.
      confidence: r.declarations >= 5 && r.hard >= 2 ? 'measured'
        : r.declarations >= 3 ? 'thin' : 'prior-dominated',
      players: Object.fromEntries([...r.players].map(([p, v]) => [p, v])),
    });
  }
  return { byManager: out, events, available: true, roster_history: rosterHistory };
}

/**
 * Should we take this manager's untouchable list literally?
 *
 * Returns how to treat each declared-untouchable player: `respect` removes him
 * from the search, `probe` keeps him in but flags that it is a real ask, and
 * `ignore` treats the declaration as an opening price. The default for an
 * unknown manager is `respect`, because being wrong in that direction costs a
 * suggestion while being wrong the other way costs a relationship.
 */
export function untouchableStance(leagueId, rosterId, credibility) {
  // Trusted identities only: a "likely" name match borrowing someone else's
  // declaration record would decide whether his players are asked for at all.
  const ident = rows(`SELECT chat_name FROM league_member_identity
                      WHERE league_id = ? AND roster_id = ?
                        AND confidence IN (${TRUSTED_CONFIDENCE.map(() => '?').join(',')})`,
  leagueId, String(rosterId), ...TRUSTED_CONFIDENCE)[0];
  const cred = ident?.chat_name ? credibility?.byManager?.get(ident.chat_name) : null;
  // Which roster history his declarations were filtered against, for the note. Only
  // when the record was actually read: with no corpus there is no ownership check to
  // qualify. Not returned as a field: every consumer of the stance reads stance / note /
  // respect / probe / credibility, and routes/trades.js:485 serves the note as word_note.
  const history = credibility?.available === true ? credibility.roster_history ?? null : null;
  const declared = rows(`SELECT player_name, sentiment, n, last_mention FROM manager_player_view
                         WHERE league_id = ? AND roster_id = ? AND sentiment >= 2.9 AND n >= 3
                           AND last_mention >= date('now', '-30 days')`, leagueId, String(rosterId));
  if (!declared.length) {
    return { stance: 'none', respect: new Set(), probe: new Set(), note: null, credibility: cred ?? null };
  }

  const respect = new Set(), probe = new Set();
  const c = cred?.credibility ?? (1 - PRIOR_BLUFF_RATE);
  for (const d of declared) {
    // Above 0.7 his word has held often enough to take at face value; below 0.45
    // his refusals have flipped often enough that removing the player would just
    // be us folding to an opening price.
    if (c >= 0.7) respect.add(d.player_name.toLowerCase());
    else if (c >= 0.45) probe.add(d.player_name.toLowerCase());
    // below 0.45: neither set — treated as an ordinary target
  }
  const note = cred
    ? `${cred.name}: ${cred.declarations} declarations — ${cred.hard_reversals} reversed outright, `
      + `${cred.hedged} hedged in the same message, ${cred.held} held (${cred.confidence})`
    : 'no declaration history — treating his word as good by default';
  return {
    stance: c >= 0.7 ? 'respect' : c >= 0.45 ? 'probe' : 'ignore',
    respect, probe, credibility: cred ?? null,
    note: note + rosterHistoryCaveat(history),
  };
}

/**
 * The credibility's `roster_history` state, as a clause on the one surface that shows
 * the stance (routes/trades.js serves `note` as `word_note`). Nothing when fresh. With
 * it empty or absent, a player he declared and then traded away is not "his" any more,
 * so that declaration never counted — the count above leans toward "held". Stale means
 * the history exists but is behind its rule, so a player he picked up since the last
 * snapshot is missing instead.
 */
function rosterHistoryCaveat(history) {
  if (!history || history.state === 'fresh') return '';
  if (history.state === 'empty' || history.state === 'table_absent') {
    return `; ownership checked against current rosters only (league_roster_snapshots is `
      + `${history.state === 'empty' ? 'empty' : 'not in this database'}), so a declared player he has `
      + 'since traded away is not counted';
  }
  if (history.state === 'stale') {
    return '; roster history is behind (league_roster_snapshots is stale'
      + `${history.last_write ? `, last written ${history.last_write}` : ''}), `
      + 'so a player he picked up since the last snapshot is not in the ownership check';
  }
  return `; the roster history could not be checked (league_roster_snapshots is ${history.state})`;
}
