/**
 * JEV-SINK-FIX: what Jev reads names no league-mate. The first live lane-2 turn (2026-09-26)
 * showed lane 1's verified lines carry the partner's team name ("Send <team> the offer"), and
 * those lines are Jev's input. Every text Jev reads goes through `pseudonymise` first.
 *
 * Masked, per league (league_member_identity): each full ESPN name, team name and chat name,
 * and a manager's first name where it reads as a name ("<First> (" as the plan labels partners,
 * "<First>'s", or a first name that is no player's name at all). A first name that is also a
 * player's name elsewhere in the text is left alone, so "Josh Allen" stays a quarterback.
 */
import { db as defaultDb, rows } from '../../db/index.js';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The league's name masks: [{ re, roster }], longest first so a full name wins over a first name. */
export function leagueMateMasks(leagueId, { database = defaultDb } = {}) {
  let ids;
  try {
    ids = database.prepare('SELECT roster_id, espn_name, team_name, chat_name FROM league_member_identity WHERE league_id = ?').all(leagueId);
  } catch (e) { if (/no such table/.test(e?.message ?? '')) return []; throw e; }
  const playerWord = database.prepare(`SELECT 1 FROM players WHERE name LIKE ? OR name LIKE ? LIMIT 1`);
  const out = [];
  for (const r of ids) {
    for (const full of [r.espn_name, r.team_name, r.chat_name]) {
      if (typeof full === 'string' && full.trim().length >= 2) out.push({ text: full.trim(), re: new RegExp(`(?<![\\w])${esc(full.trim())}(?![\\w])`, 'gi'), roster: String(r.roster_id) });
    }
    const first = typeof r.espn_name === 'string' ? r.espn_name.trim().split(/\s+/)[0] : null;
    if (first && first.length >= 3) {
      const isPlayer = !!playerWord.get(`${first} %`, `% ${first}`);
      // As the plan labels a partner ("Rami (…)") or a possessive, always; bare, only when no player is named that.
      out.push({ text: first, re: new RegExp(`(?<![\\w])${esc(first)}(?=\\s*\\(|'s\\b)`, 'g'), roster: String(r.roster_id) });
      if (!isPlayer) out.push({ text: first, re: new RegExp(`(?<![\\w])${esc(first)}(?![\\w])`, 'g'), roster: String(r.roster_id) });
    }
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

/** `text` with every league-mate named as `alias` (the one in focus) or "another manager". */
export function pseudonymise(text, masks, { focusRoster = null, alias = 'MANAGER M1' } = {}) {
  if (typeof text !== 'string' || !masks?.length) return text;
  let out = text;
  for (const m of masks) out = out.replace(m.re, focusRoster != null && m.roster === String(focusRoster) ? alias : 'another manager');
  return out;
}
