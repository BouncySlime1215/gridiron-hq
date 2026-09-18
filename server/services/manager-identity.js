/**
 * Who is who: ESPN member -> roster -> the name their messages arrive under.
 *
 * Everything in the counterparty model joins on this. A wrong row does not fail
 * loudly; it quietly attributes one manager's sentiment, timing and trade
 * history to another, which is worse than having no profile at all. So each row
 * carries HOW it was matched and a confidence, and anything below `confirmed`
 * is surfaced in the UI rather than used silently.
 *
 * ESPN gives real first/last names in `payload.members[]` and ties each member
 * GUID to a team through `teams[].owners[]`. That is the spine. The chat name
 * comes from Contacts via the iMessage extract, so the join between the two is
 * a name match plus, where it exists, Nick's own confirmation.
 */
import { db, rows, run } from '../db/index.js';

db.exec(`CREATE TABLE IF NOT EXISTS league_member_identity (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL,
  espn_member_id TEXT,
  espn_name TEXT,
  team_name TEXT,
  chat_name TEXT,
  match_method TEXT,
  confidence TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (confidence IN ('confirmed','exact','likely','uncertain','unmatched')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, roster_id))`);

/**
 * The confidences that may attribute chat data to a roster without a human
 * looking first. `likely` (surname + first-name prefix) and `uncertain`
 * (surname prefix only) are exactly the matches that go wrong — league 4's
 * ESPN "Aiden Smith" surname-matches the chat's "Josh Smith", a different
 * person — so they are surfaced by identityWarnings and never used silently.
 */
export const TRUSTED_CONFIDENCE = Object.freeze(['confirmed', 'exact']);
/**
 * match_method for a league whose members have no chat corpus. Nothing to
 * match is the normal state for four of Nick's five leagues, not a failure,
 * so these rows are not warnings.
 */
export const NO_CHAT_METHOD = 'no chat corpus';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const firstOf = s => norm(s).split(' ')[0] ?? '';
const lastOf = s => norm(s).split(' ').at(-1) ?? '';

/**
 * Match ESPN members to chat names.
 *
 * Deliberately conservative: an exact full-name match is `exact`, same last
 * name plus a first name that is a prefix/variant of the other is `likely`, and
 * everything else stays `unmatched` rather than guessing. Nick's explicit
 * confirmations are applied last and always win, but they are recorded as
 * `confirmed` with the disagreement in `note` so a bad confirmation is visible.
 *
 * Confirmations already stored are carried forward. Nick gave them once, by
 * hand, and they exist nowhere but this table; a scheduled re-run that did
 * not pass them back in would demote each one to whatever the name match
 * says — for league 4 that hands Haiden's chat to "Josh Smith". `confirmations`
 * passed explicitly still override the stored ones.
 *
 * `chatNames` empty means the league has no chat corpus: every row is written
 * with method NO_CHAT_METHOD and no chat name. Rows are only rewritten when a
 * field actually changed, so `updated_at` moves only with real news and can
 * sit in a cache fingerprint.
 */
export function matchIdentities(leagueId, { chatNames = [], confirmations = {} } = {}) {
  const lg = rows('SELECT payload FROM leagues WHERE id = ?', leagueId)[0];
  if (!lg?.payload) return { league_id: leagueId, error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const stored = Object.fromEntries(rows(`SELECT roster_id, chat_name FROM league_member_identity
                                          WHERE league_id = ? AND confidence = 'confirmed'
                                            AND chat_name IS NOT NULL`, leagueId)
    .map(r => [r.roster_id, r.chat_name]));
  const allConfirmations = { ...stored, ...confirmations };
  const memberById = new Map((payload.members ?? []).map(m => [
    m.id, { id: m.id, name: `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.displayName },
  ]));

  const out = [];
  for (const team of payload.teams ?? []) {
    const ownerId = (team.owners ?? [])[0] ?? null;
    const member = ownerId ? memberById.get(ownerId) : null;
    const espnName = member?.name ?? null;
    let chatName = null, method = chatNames.length ? null : NO_CHAT_METHOD, confidence = 'unmatched', note = null;

    if (espnName && chatNames.length) {
      const exact = chatNames.find(c => norm(c) === norm(espnName));
      if (exact) { chatName = exact; method = 'exact full name'; confidence = 'exact'; }
      else {
        // Same last name, and one first name is a prefix of the other
        // ("Josh"/"Joshua", "Zach"/"Zachary"). Nicknames that share no prefix
        // ("Vass"/"Vasquez" is a shared prefix; "Bob"/"Robert" is not) stay out.
        const cand = chatNames.filter(c => lastOf(c) === lastOf(espnName)
          && (firstOf(c).startsWith(firstOf(espnName)) || firstOf(espnName).startsWith(firstOf(c))));
        if (cand.length === 1) { chatName = cand[0]; method = 'last name + first-name prefix'; confidence = 'likely'; }
        else {
          const byLast = chatNames.filter(c => lastOf(c).startsWith(lastOf(espnName)) || lastOf(espnName).startsWith(lastOf(c)));
          if (byLast.length === 1) { chatName = byLast[0]; method = 'last-name prefix only'; confidence = 'uncertain'; }
        }
      }
    }

    const confirmed = allConfirmations[String(team.id)];
    if (confirmed) {
      if (chatName && norm(chatName) !== norm(confirmed)) {
        note = `name match said "${chatName}" (${method}); Nick confirmed "${confirmed}"`;
      } else if (!chatName && espnName && chatNames.length) {
        note = `no name match to ESPN's "${espnName}"; confirmed by Nick`;
      }
      chatName = confirmed; method = 'confirmed by Nick'; confidence = 'confirmed';
    }

    out.push({
      league_id: leagueId, roster_id: String(team.id), espn_member_id: ownerId,
      espn_name: espnName, team_name: team.name ?? null, chat_name: chatName,
      match_method: method, confidence, note,
    });
  }

  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of out) {
      // The WHERE makes an identical row a no-op, so updated_at only moves
      // when something about the person or the match really changed.
      changed += run(`INSERT INTO league_member_identity
             (league_id,roster_id,espn_member_id,espn_name,team_name,chat_name,match_method,confidence,note,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(league_id,roster_id) DO UPDATE SET
             espn_member_id=excluded.espn_member_id, espn_name=excluded.espn_name,
             team_name=excluded.team_name, chat_name=excluded.chat_name,
             match_method=excluded.match_method, confidence=excluded.confidence,
             note=excluded.note, updated_at=datetime('now')
           WHERE espn_member_id IS NOT excluded.espn_member_id OR espn_name IS NOT excluded.espn_name
              OR team_name IS NOT excluded.team_name OR chat_name IS NOT excluded.chat_name
              OR match_method IS NOT excluded.match_method OR confidence IS NOT excluded.confidence
              OR note IS NOT excluded.note`,
        r.league_id, r.roster_id, r.espn_member_id, r.espn_name, r.team_name,
        r.chat_name, r.match_method, r.confidence, r.note).changes;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return {
    league_id: leagueId, rosters: out.length, changed,
    matched: out.filter(r => r.chat_name).length,
    trusted: out.filter(r => r.chat_name && TRUSTED_CONFIDENCE.includes(r.confidence)).length,
    rows: out,
  };
}

/**
 * roster_id -> chat name, for joining chat-derived signals onto a league.
 * Trusted matches only (TRUSTED_CONFIDENCE); the rest wait in identityWarnings.
 */
export function identityMap(leagueId) {
  return new Map(rows(`SELECT roster_id, chat_name, confidence, espn_name FROM league_member_identity
                       WHERE league_id = ? AND chat_name IS NOT NULL
                         AND confidence IN (${TRUSTED_CONFIDENCE.map(() => '?').join(',')})`,
  leagueId, ...TRUSTED_CONFIDENCE).map(r => [r.roster_id, r]));
}

/**
 * Rows a human should look at before the profile is trusted. A league with no
 * chat corpus has nothing to match, so its rows are not warnings.
 */
export function identityWarnings(leagueId) {
  return rows(`SELECT roster_id, espn_name, chat_name, confidence, note FROM league_member_identity
               WHERE league_id = ? AND match_method IS NOT ?
                 AND (confidence IN ('likely','uncertain','unmatched') OR note IS NOT NULL)`,
  leagueId, NO_CHAT_METHOD);
}
