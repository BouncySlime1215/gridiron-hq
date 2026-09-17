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
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from '../db/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAT_DB = path.join(ROOT, 'data/derived/league_chat.sqlite');

/** A reversal inside this many days is about negotiating, not about football. */
export const BLUFF_WINDOW_DAYS = 10;
/** League-average bluff rate to shrink toward, and the strength of that pull. */
export const PRIOR_BLUFF_RATE = 0.35;
export const PRIOR_WEIGHT = 4;

function openChat() {
  try { return new DatabaseSync(CHAT_DB, { readOnly: true }); } catch { return null; }
}

/**
 * Every "this guy is not available" moment we can find, per (manager, player).
 *
 * Two shapes count as a declaration. The explicit one is a message Jev labeled
 * `own_roster.untouchable`. The implicit one is a message about his own player
 * that is simultaneously high-praise and NOT open to trading — the "he's a
 * league winner, I'm good" move, which is the same message with better manners.
 */
function declarations(chat, minProb = 0.5) {
  return chat.prepare(`
    SELECT s.name, s.mentioned_player AS player, m.ts_utc, s.probability AS prob,
           (SELECT probability FROM jev_chat_signals o
             WHERE o.msg_id = s.msg_id AND o.question = 'open_to_trade') AS open_prob
    FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
    WHERE s.question = 'own_roster.untouchable' AND s.probability >= ?
      AND s.mentioned_player IS NOT NULL AND s.name <> 'ME'
    ORDER BY s.name, s.mentioned_player, m.ts_utc`).all(minProb);
}

/** Later moments where the same manager opened the door on the same player. */
function openings(chat, minProb = 0.6) {
  return chat.prepare(`
    SELECT s.name, s.mentioned_player AS player, m.ts_utc, s.probability AS prob
    FROM jev_chat_signals s JOIN messages m ON m.msg_id = s.msg_id
    WHERE s.question = 'open_to_trade' AND s.probability >= ?
      AND s.mentioned_player IS NOT NULL AND s.name <> 'ME'`).all(minProb);
}

const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

/**
 * Per-manager credibility on his own declarations.
 *
 * `credibility` is the shrunk probability that a declaration holds. With no
 * declarations at all it is the league prior, NOT 1 — "we have never heard him
 * refuse" is not evidence that his refusals are honest.
 */
export function declarationCredibility({ windowDays = BLUFF_WINDOW_DAYS } = {}) {
  const chat = openChat();
  if (!chat) return new Map();
  const decls = declarations(chat);
  const opens = openings(chat);
  chat.close();

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
  return { byManager: out, events };
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
  const ident = rows(`SELECT chat_name FROM league_member_identity
                      WHERE league_id = ? AND roster_id = ?`, leagueId, String(rosterId))[0];
  const cred = ident?.chat_name ? credibility?.byManager?.get(ident.chat_name) : null;
  const declared = rows(`SELECT player_name, sentiment, n, last_mention FROM manager_player_view
                         WHERE league_id = ? AND roster_id = ? AND sentiment >= 2.9 AND n >= 3
                           AND last_mention >= date('now', '-30 days')`, leagueId, String(rosterId));
  if (!declared.length) return { stance: 'none', respect: new Set(), probe: new Set(), note: null, credibility: cred ?? null };

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
  return {
    stance: c >= 0.7 ? 'respect' : c >= 0.45 ? 'probe' : 'ignore',
    respect, probe, credibility: cred ?? null,
    note: cred
      ? `${cred.name}: ${cred.declarations} declarations — ${cred.hard_reversals} reversed outright, `
        + `${cred.hedged} hedged in the same message, ${cred.held} held (${cred.confidence})`
      : 'no declaration history — treating his word as good by default',
  };
}
