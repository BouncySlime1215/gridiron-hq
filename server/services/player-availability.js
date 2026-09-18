/**
 * Season-ending / released detection, shared so every roster view agrees on who is
 * actually available. `server/routes/teams.js` first built this for the X's&O's
 * depth chart (a real season-ending torn triceps was still showing as the starting
 * LT there until that fix landed) — this module is the same detection, generalized
 * so the fantasy trade engine's lineup solver (which never had it at all) can use it
 * too, instead of drifting into its own copy of the same regex.
 */
import crypto from 'node:crypto';
import { rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

/**
 * Severe-news vocabulary. Injured reserve is deliberately NOT here: NFL IR is a
 * four-game minimum and most players come back ("placed on IR ... out at least 4
 * weeks"), and treating it as season-ending set available=false, which zeroes a
 * player's rest-of-season value. "season-ending IR" still matches via season-ending.
 */
export const SEASON_ENDING_RE = /(?:out for (?:the )?(?:rest of the |remainder of the )?season|season[- ]ending|done for the (?:year|season)|(?:will |to )?miss(?:es)? the (?:rest of the |remainder of the )?(?:season|year)|tor(?:n|e (?:his|an?)) (?:acl|achilles|triceps|pector\w*|pec|quad(?:riceps)?|bicep|patella|meniscus)|ruptured \w+)\b/i;
export const RELEASED_RE = /\b(?:waived|waives|waiving|released|releases|releasing|cut|cutting|terminated)\b/i;
/** A severe phrase about the PAST ("making his return from a torn ACL") is not news of one. */
const PAST_CONTEXT_RE = /\b(?:return(?:s|ed|ing)? from|recover(?:s|ed|ing|y)? from|coming (?:back )?off|back from|rehab(?:bing)? from|removed from|last (?:season|year)|a year after|previously)\b/i;
/** Words that end a release's reach: "cut Moody AFTER Loop won the job" does not cut Loop. */
const SUBORDINATOR_RE = /\b(?:after|following|because|as|while|when|since|with|once|whereas|replacing|over|for|in favor of|make room|signed|signs|signing|claimed|claims|promoted|promotes|added|adds|activated|named)\b/;
const ABBREVIATIONS = new Set(['jr', 'sr', 'st', 'mr', 'dr', 'vs', 'no', 'wk', 'lt', 'jan', 'feb', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec']);

/** Sentences of raw text. Initials ("A.J. Brown") and common abbreviations do not end one. */
function sentencesOf(text) {
  const out = [];
  const src = String(text ?? '');
  let start = 0;
  for (const m of src.matchAll(/[.!?]+\s+/g)) {
    const before = src.slice(start, m.index).split(/\s+/).pop() ?? '';
    const word = before.replace(/[^A-Za-z.]/g, '');
    if (/^(?:[A-Z]\.)*[A-Z]$/.test(word) || ABBREVIATIONS.has(word.replace(/\./g, '').toLowerCase())) continue;
    out.push(src.slice(start, m.index + 1));
    start = m.index + m[0].length;
  }
  if (start < src.length) out.push(src.slice(start));
  return out.map(x => x.trim()).filter(Boolean);
}

/** Clauses of one sentence, split where a second subject usually starts. */
function clausesOf(sentence) {
  return sentence.split(/;\s*|,\s*(?:while|but|whereas|although|though|and)\s+|\s+(?:while|whereas)\s+/i).filter(Boolean);
}

const norm = t => ` ${normalizePlayerName(t)} `;

/**
 * What a news text says about ONE player: 'season_ending', 'released', or null.
 *
 * The old test was story-level co-occurrence — the player's full name anywhere and
 * a severe phrase anywhere — which flagged Patrick Mahomes and Kenneth Walker III
 * from one sentence ("Patrick Mahomes, making his return from a torn ACL, and
 * Kenneth Walker III combined..."), De'Zhaun Stribling for a teammate "ruled out for
 * the season" in the same sentence, Zach Charbonnet for a release in the NEXT
 * sentence, and Tyler Loop for "cut kicker Jake Moody after rookie Tyler Loop won the
 * job". Now:
 *   - season-ending needs the name and the phrase in the same clause, with no
 *     past-tense context in that clause;
 *   - released needs the release verb BEFORE the name in the same sentence with no
 *     subordinating word between them ("Waived LBs A, B, and C" flags all three),
 *     or the passive "<name> was/has been released".
 */
export function newsSeverityFor(text, name) {
  const normName = normalizePlayerName(name);
  if (!normName || !normName.includes(' ')) return null;
  const needle = ` ${normName} `;
  let released = false;
  for (const sentence of sentencesOf(text)) {
    const ns = norm(sentence);
    const at = ns.indexOf(needle);
    if (at < 0) continue;
    for (const clause of clausesOf(sentence)) {
      if (!norm(clause).includes(needle)) continue;
      if (SEASON_ENDING_RE.test(clause) && !PAST_CONTEXT_RE.test(clause)) return 'season_ending';
    }
    if (!released) {
      const verb = ns.slice(0, at + 1).match(/ (?:waived|waives|waiving|released|releases|releasing|cut|cutting|terminated) (?!.* (?:waived|waives|waiving|released|releases|releasing|cut|cutting|terminated) )/);
      if (verb && !SUBORDINATOR_RE.test(ns.slice(verb.index + verb[0].length, at + 1))) released = true;
      const passive = new RegExp(`${needle.trim()} (?:\\w+ ){0,2}(?:was|were|has been|have been|got|is being|also) (?:\\w+ )?(?:waived|released|cut|terminated)\\b`);
      if (passive.test(ns)) released = true;
    }
  }
  return released ? 'released' : null;
}

/**
 * Whether `name` (a full player name, e.g. "A.J. Brown") appears as a whole-word
 * phrase inside `text`. Both sides go through normalizePlayerName so punctuation,
 * accents and suffixes ("A.J." vs "AJ", "Jr."/"Jr"/"") can't cause a miss — but,
 * critically, this is a FULL name match, not last-name-only. Roster-cut news is
 * dense with common surnames ("Released WR Noah Brown", "waived ... Corey
 * Robinson II", "Alex Johnson") that used to falsely flag A.J. Brown, Wan'Dale
 * Robinson and Juwan Johnson as released just because someone else who shares
 * their last name actually was.
 */
export function textMentionsFullName(text, name) {
  const normName = normalizePlayerName(name);
  if (!normName || !normName.includes(' ')) return false; // no last name to disambiguate on
  const normText = ` ${normalizePlayerName(text)} `;
  return normText.includes(` ${normName} `);
}

/**
 * Every rostered player's espn_id currently flagged season-ending/released, league-wide.
 * Cheap by construction: filters news down to the (usually small) set of severe-language
 * items first, then only checks roster names against that subset — not every player
 * against every news item.
 */
/** Statuses under which ESPN is saying "he plays, or is about to". */
const ESPN_AVAILABLE = new Set(['ACTIVE', 'NORMAL', 'QUESTIONABLE', 'DOUBTFUL', 'PROBABLE', 'DAY_TO_DAY']);
const toMs = t => (t ? Date.parse(String(t).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? '' : 'Z')) : NaN);

/** Latest ESPN injury status and NFL team per ESPN player id, from the synced league payloads. */
export function espnStatusById() {
  const out = new Map();
  for (const lg of rows(`SELECT payload, fetched_at FROM leagues WHERE payload IS NOT NULL`)) {
    let p; try { p = JSON.parse(lg.payload); } catch { continue; }
    const at = toMs(lg.fetched_at);
    for (const t of p.teams ?? []) {
      for (const e of t.roster?.entries ?? []) {
        const pl = e.playerPoolEntry?.player;
        if (!pl?.id) continue;
        const prev = out.get(String(pl.id));
        if (prev && !(at > prev.at)) continue;
        out.set(String(pl.id), { status: pl.injuryStatus ?? null, proTeamId: pl.proTeamId ?? null, at });
      }
    }
  }
  return out;
}

/*
 * Memoised on the exact inputs: the in-window severe stories (text and time), the
 * roster, and each league's fetched_at (espnStatusById reads the payloads). Keying on
 * content, not on row counts, means a story edited in place is never served stale.
 * Every league's asset build calls this and the answer does not depend on the league,
 * so on the 2026-W2 snapshot five builds paid ~0.93 s each for the same Set.
 */
const seasonEndingMemo = new Map();
const SEASON_ENDING_MEMO_MAX = 8;

export function seasonEndingEspnIds({ days = 45 } = {}) {
  const roster = rows(`SELECT DISTINCT espn_id, name FROM roster_players WHERE espn_id IS NOT NULL ORDER BY espn_id, name`);
  if (!roster.length) return new Set();
  const severe = rows(
    `SELECT headline, body, COALESCE(published_at, date) AS at FROM news_items WHERE COALESCE(published_at, date) >= datetime('now', ?)`,
    `-${days} days`
  ).map(n => ({ text: `${n.headline ?? ''}. ${n.body ?? ''}`, at: toMs(n.at) }))
    .filter(n => SEASON_ENDING_RE.test(n.text) || RELEASED_RE.test(n.text));
  if (!severe.length) return new Set();

  const syncs = rows(`SELECT id, fetched_at FROM leagues WHERE payload IS NOT NULL ORDER BY id`);
  const key = crypto.createHash('sha1').update(JSON.stringify([days, severe, roster, syncs])).digest('hex');
  const hit = seasonEndingMemo.get(key);
  if (hit) return new Set(hit);

  // Normalised once per story, not once per (player x story) pair: that inner call was
  // 268,164 normalisations of whole story texts per build on the 2026-W2 snapshot.
  for (const n of severe) n.normText = norm(n.text);

  // ESPN is fresher than most stories and is the league's own source of truth. A
  // player it lists as available on an NFL team, in a sync taken AFTER the story,
  // is not out for the season — the story is stale, or it was about someone else.
  const espn = espnStatusById();
  const flagged = new Set();
  for (const player of roster) {
    const normName = normalizePlayerName(player.name);
    if (!normName.includes(' ')) continue;
    for (const n of severe) {
      if (!n.normText.includes(` ${normName} `)) continue;
      if (!newsSeverityFor(n.text, player.name)) continue;
      const e = espn.get(String(player.espn_id));
      if (e && e.at > n.at && ESPN_AVAILABLE.has(e.status ?? 'ACTIVE') && e.proTeamId !== 0) continue;
      flagged.add(player.espn_id);
      break;
    }
  }
  if (seasonEndingMemo.size >= SEASON_ENDING_MEMO_MAX) seasonEndingMemo.delete(seasonEndingMemo.keys().next().value);
  seasonEndingMemo.set(key, new Set(flagged));
  return flagged;
}
