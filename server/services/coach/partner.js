/**
 * COACH-PARTNER: "gimme a trade to send to <manager>".
 *
 * Nick names a league-mate the way he talks about him (first name, full name,
 * team name, "team 7"); this resolves that to a roster id from the identity
 * rows (manager-identity.js#identityRows: ESPN name, team name, chat name) and
 * the plans entry's own `teams` map. No name is written in code. A name that
 * matches nobody, or more than one roster equally well, resolves to nobody:
 * Coach never guesses who Nick meant.
 *
 * The answer itself is brief-claims.js#partnerClaims: served plans only, so
 * Nick's rules (no overpay, blue chips) hold because Coach reads what the
 * planner already cleared and never builds a trade of its own.
 */
import { partnerClaims } from './brief-claims.js';

/** A question about a trade aimed at someone (resolution still has to find him). */
const TRADE_WORDS = /\b(trades?|offers?|deals?|packages?|send|sends|pitch|propose|swap|flip|take|want|wants|price|ask for|move for|get from)\b/;
export const partnerShaped = question => TRADE_WORDS.test(norm(question));

/** Tokens of a name that are too common to stand for a person on their own. */
const COMMON = new Set(['the', 'team', 'and', 'for', 'with', 'from', 'trade', 'send', 'what', 'best', 'next', 'good', 'will',
  'can', 'you', 'him', 'his', 'her', 'mine', 'not', 'any', 'all', 'one', 'new', 'big', 'little', 'first', 'last', 'more']);

function norm(s) {
  return ` ${String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/'s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
}
const generic = name => /^team \d+$/i.test(String(name ?? '').trim());
const clean = s => (typeof s === 'string' && s.trim() ? s.trim() : null);

/**
 * The plans entry with its `teams` map filled from the identity rows where the
 * plan has no manager or only a "Team N" name, so every label Coach writes
 * ("Manager (Team name)") comes from the same place the resolution did.
 */
export function withIdentityTeams(entry, identities = []) {
  const map = entry?.teams?.status === 'ok' && entry.teams.value && typeof entry.teams.value === 'object'
    ? structuredClone(entry.teams.value) : {};
  for (const r of identities ?? []) {
    const id = String(r.roster_id);
    const t = map[id] ?? {};
    const manager = clean(t.manager) ?? clean(r.espn_name) ?? clean(r.chat_name);
    const name = (clean(t.name) && !generic(t.name) ? clean(t.name) : null) ?? clean(r.team_name) ?? clean(t.name);
    map[id] = { ...t, ...(manager ? { manager } : {}), ...(name ? { name } : {}) };
  }
  return { ...entry, teams: { status: 'ok', value: map, source: entry?.teams?.source ?? 'league_member_identity' } };
}

/**
 * Player names in the plan by token. A manager's first or last name that is
 * also part of a player's name ("trade for <Firstname Lastname>") counts only
 * when the question does not name that player in full.
 */
function playerNames(entry) {
  const out = new Map();
  for (const n of Object.values(entry?.names ?? {})) {
    const full = norm(String(n).replace(/\([^)]*\)/g, '').replace(/\b[a-z]\.\s*/gi, ''));
    for (const w of full.trim().split(' ')) if (w.length >= 3) out.set(w, [...(out.get(w) ?? []), full]);
  }
  return out;
}

/**
 * Who in this league the question names, or null.
 *
 * @param {string} question
 * @param {{entry: object, identities?: object[]}} args identities: league_member_identity rows
 * @returns {{roster: string, label: string, matched: string}|{roster: null, ambiguous: string[]}|null}
 */
export function resolvePartner(question, { entry, identities = [] } = {}) {
  const q = norm(question);
  const me = entry?.me == null ? null : String(entry.me);
  const named = withIdentityTeams(entry, identities);
  const players = playerNames(entry);
  const rosters = new Set([...Object.keys(named.teams.value), ...((entry?.partners?.value ?? []).map(p => String(p.team)))]);
  const best = new Map();
  const hit = (roster, phrase, score) => {
    const p = norm(phrase);
    if (p.trim().length < 3 || !q.includes(p)) return;
    if ((best.get(roster)?.score ?? 0) < score) best.set(roster, { score, matched: p.trim() });
  };
  for (const roster of rosters) {
    if (roster === me) continue;
    const t = named.teams.value[roster] ?? {};
    const ident = (identities ?? []).find(r => String(r.roster_id) === roster) ?? {};
    const people = [t.manager, ident.espn_name, ident.chat_name].map(clean).filter(Boolean);
    const teams = [t.name, ident.team_name].map(clean).filter(x => x && !generic(x));
    for (const full of [...people, ...teams]) hit(roster, full, 100 + norm(full).length);
    for (const person of people) {
      const words = norm(person).trim().split(' ');
      for (const w of new Set([words[0], words.at(-1)])) {
        if (w.length < 3 || COMMON.has(w) || (players.get(w) ?? []).some(full => full.trim().includes(' ') && q.includes(full))) continue;
        hit(roster, w, w.length);
      }
    }
    const byId = q.match(/ team (\d{1,2}) /);
    if (byId && byId[1] === roster) best.set(roster, { score: 1000, matched: `team ${roster}` });
  }
  if (!best.size) return null;
  const top = Math.max(...[...best.values()].map(b => b.score));
  const winners = [...best.entries()].filter(([, b]) => b.score === top);
  const teamOfNamed = id => {
    const t = named.teams.value[id] ?? {};
    return t.manager && t.name ? `${t.manager} (${t.name})` : (t.manager || t.name || `Team ${id}`);
  };
  if (winners.length > 1) return { roster: null, ambiguous: winners.map(([id]) => teamOfNamed(id)) };
  const [roster, b] = winners[0];
  return { roster, label: teamOfNamed(roster), matched: b.matched };
}

/**
 * The partner answer's draft claims for one roster, labels filled from the
 * identity rows. `source` says which rung answered (plan_first_step,
 * plan_any_step, flip_leg, partner_read).
 */
export function partnerClaimsFor({ entry, roster, ledger, identities = [] }) {
  return partnerClaims(withIdentityTeams(entry, identities), ledger, roster);
}
