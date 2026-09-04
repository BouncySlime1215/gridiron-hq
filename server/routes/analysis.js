import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { unitRoster, computeSOS } from './nfldata.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';

const r = Router();

const ANALYSIS_FIELDS = ['off_scheme_detail', 'def_scheme_detail', 'ol_analysis', 'dl_analysis',
  'lb_analysis', 'secondary_analysis', 'st_analysis', 'coach_analysis'];

function teamContext(team) {
  const players = rows(`SELECT name, position, slot_code, phase FROM players
                        WHERE team_id = ? AND (slot_code IS NOT NULL OR fantasy_relevant = 1)
                        ORDER BY phase, slot_code`, team.id);
  const news = rows(`SELECT date, headline, body, ai_analysis FROM news_items
                     WHERE team_id = ? ORDER BY date DESC, id DESC LIMIT 12`, team.id);
  return { players, news };
}

const fmtUnit = list => list.length
  ? list.slice(0, 12).map(p => `${p.name} (${p.position}${p.age ? `, ${p.age}yo` : ''}${p.experience === 0 ? ', rookie' : ''})`).join(', ')
  : '(not synced)';

async function refreshTeam(_client, team) {
  const { players, news } = teamContext(team);
  const units = unitRoster(team.id);
  const cap = row('SELECT cap_space, dead_money FROM team_cap WHERE team_id = ?', team.id);
  const sos = computeSOS().find(s => s.abbr === team.abbr);

  const skill = players.map(p => `${p.slot_code ?? p.position}: ${p.name}`).join('\n');
  const newsText = news.map(n => `[${n.date}] ${n.headline}${n.body ? ' — ' + n.body : ''}`).join('\n') || '(no recent stories)';
  const current = ANALYSIS_FIELDS.map(f => `${f}: ${team[f]}`).join('\n\n');

  const msg = await callClaude({
    feature: 'team-analysis',
    maxTokens: 3000,
    prompt: `You maintain scouting analyses for the ${team.name} (2026 NFL season). HC ${team.head_coach}, OC ${team.oc_name}, DC ${team.dc_name}. Offense: ${team.off_scheme}. Defense: ${team.def_scheme}.

SKILL DEPTH CHART:
${skill}

ACTUAL 90-MAN ROSTER BY UNIT (from ESPN — this is the source of truth; NEVER name a player who is not listed here or on the skill depth chart):
OFFENSIVE LINE: ${fmtUnit(units.OL)}
INTERIOR D-LINE: ${fmtUnit(units.DL)}
EDGE: ${fmtUnit(units.EDGE)}
LINEBACKERS: ${fmtUnit(units.LB)}
SECONDARY: ${fmtUnit(units.DB)}
SPECIALISTS: ${fmtUnit(units.ST)}

CONTEXT: ${cap ? `Cap space $${Math.round(cap.cap_space).toLocaleString()}, dead money $${Math.round(cap.dead_money ?? 0).toLocaleString()}.` : ''} ${sos ? `Strength of schedule ranks ${sos.rank}/32 (1 = easiest).` : ''}

RECENT NEWS:
${newsText}

CURRENT ANALYSES:
${current}

Task: rewrite any analysis field that is stale, wrong, or vague. Requirements:
- ol_analysis / dl_analysis / lb_analysis / secondary_analysis / st_analysis MUST name specific players from the unit lists above and say how the unit's makeup (talent, age, rookies, depth) affects the team on the field and fantasy production. No generic filler.
- coach_analysis / off_scheme_detail / def_scheme_detail name skill players too (QB/RB/WR/TE), so check them against the SKILL DEPTH CHART with the same rigor: if either currently names a player who is not on the skill depth chart above, that field is stale and MUST be rewritten, even if everything else about it still reads fine.
- Purge any player who is not on the roster above, in every field, not only the unit fields.
- Keep the sharp, opinionated editorial voice. 2-4 sentences per field.
- Omit any field that is already accurate and specific.

Respond with ONLY a JSON object. Keys: any of ${ANALYSIS_FIELDS.join(', ')} (only ones you changed), plus "changed" (boolean) and "reason" (one sentence).`
  });
  const result = parseJson(msg);
  const updates = ANALYSIS_FIELDS.filter(f => typeof result[f] === 'string' && result[f].length > 10);
  if (updates.length > 0) {
    run(`UPDATE nfl_teams SET ${updates.map(f => `${f} = ?`).join(', ')}, analysis_updated_at = datetime('now') WHERE id = ?`,
      ...updates.map(f => result[f]), team.id);
  } else {
    run(`UPDATE nfl_teams SET analysis_updated_at = datetime('now') WHERE id = ?`, team.id);
  }
  return { abbr: team.abbr, changed: updates.length > 0, fields: updates, reason: result.reason ?? '' };
}

/**
 * Shared by the route below AND the scheduler — this used to exist only as
 * an inline route handler, which is why it was never scheduled: there was
 * nothing importable to schedule. Default behavior (no teams/force) only
 * touches teams with news newer than their last analysis, which is what
 * makes it safe to run on a timer rather than only on a manual click — most
 * cycles it does nothing and spends nothing.
 */
export async function refreshStaleAnalyses({ teams: teamAbbrs, force = false } = {}) {
  if (!getApiKey()) return { skipped: true, reason: 'no Anthropic API key configured' };
  const client = null;

  let teams;
  if (Array.isArray(teamAbbrs) && teamAbbrs.length) {
    const list = teamAbbrs.map(a => a.toUpperCase());
    teams = rows(`SELECT * FROM nfl_teams WHERE abbr IN (${list.map(() => '?').join(',')})`, ...list);
  } else if (force) {
    teams = rows('SELECT * FROM nfl_teams');
  } else {
    teams = rows(`SELECT t.* FROM nfl_teams t WHERE EXISTS (
                    SELECT 1 FROM news_items n WHERE n.team_id = t.id
                    AND n.created_at > COALESCE(t.analysis_updated_at, '1970-01-01'))`);
  }
  if (teams.length === 0) return { ok: true, refreshed: [], message: 'No teams have news newer than their analysis.' };

  const results = [];
  const BATCH = 4;
  for (let i = 0; i < teams.length; i += BATCH) {
    const batch = teams.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(t => refreshTeam(client, t)));
    for (let j = 0; j < settled.length; j++) {
      results.push(settled[j].status === 'fulfilled'
        ? settled[j].value
        : { abbr: batch[j].abbr, error: settled[j].reason?.message });
    }
  }
  return { ok: true, refreshed: results };
}

// POST /api/analysis/refresh  { teams?: ["KC", ...], force?: bool }
// Default: only teams with news newer than their last analysis refresh.
r.post('/refresh', async (req, res, next) => {
  try {
    const result = await refreshStaleAnalyses({ teams: req.body?.teams, force: req.body?.force });
    if (result.skipped) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right) to enable live AI analysis.' });
    res.json(result);
  } catch (e) { next(e); }
});


/**
 * Validate every analysis field against the real 90-man roster: flag any player
 * name mentioned who is no longer on that team (e.g. a traded WR still named in
 * last season's scheme blurb).
 */
const ANALYSIS_TEXT_FIELDS = [...ANALYSIS_FIELDS];

function rosterNameSet(teamId) {
  const set = new Set();
  const add = n => {
    if (!n) return;
    set.add(n.toLowerCase());
    const parts = n.split(' ');
    if (parts.length > 1) set.add(parts.slice(1).join(' ').toLowerCase()); // last name
  };
  for (const p of rows('SELECT name FROM roster_players WHERE team_id = ?', teamId)) add(p.name);
  for (const p of rows('SELECT name FROM players WHERE team_id = ?', teamId)) add(p.name);
  return set;
}

// Capitalised multi-word tokens that look like person names.
const NAME_RE = /\b([A-Z][a-zA-Z'’.-]+(?:\s+(?:Jr\.|Sr\.|II|III|IV))?\s+[A-Z][a-zA-Z'’.-]+(?:\s+(?:Jr\.|Sr\.|II|III|IV))?)\b/g;
// Words that start sentences / are football terms, not players.
const NOT_NAMES = new Set(['The','This','That','His','New','Super Bowl','Pro Bowl','All Pro','West Coast','Air Raid',
  'Special Teams','Red Zone','Play Action','O Line','D Line','Wide Zone','Big Nickel','Cover ','Week ']);

function findStaleNames(team) {
  const roster = rosterNameSet(team.id);
  const teamWords = new Set((team.name ?? '').split(' ').map(w => w.toLowerCase()));
  const stale = [];
  for (const field of ANALYSIS_TEXT_FIELDS) {
    const text = team[field];
    if (!text) continue;
    for (const m of text.matchAll(NAME_RE)) {
      const candidate = m[1].trim();
      if (NOT_NAMES.has(candidate)) continue;
      const lower = candidate.toLowerCase();
      // ignore coach names and team/city words
      if (lower === (team.head_coach ?? '').toLowerCase()) continue;
      if (lower === (team.oc_name ?? '').toLowerCase()) continue;
      if (lower === (team.dc_name ?? '').toLowerCase()) continue;
      if (candidate.split(' ').some(w => teamWords.has(w.toLowerCase()))) continue;
      if (roster.has(lower)) continue;
      // last-name-only match counts as on-roster
      const last = candidate.split(' ').slice(-1)[0].toLowerCase();
      if (roster.has(last)) continue;
      stale.push({ field, name: candidate });
    }
  }
  return stale;
}

r.get('/validate', (req, res) => {
  const teams = req.query.team
    ? rows('SELECT * FROM nfl_teams WHERE abbr = ?', String(req.query.team).toUpperCase())
    : rows('SELECT * FROM nfl_teams');
  const out = [];
  for (const t of teams) {
    const stale = findStaleNames(t);
    if (stale.length) out.push({ abbr: t.abbr, name: t.name, stale });
  }
  res.json({ teams_with_stale_names: out.length, total_flags: out.reduce((s, t) => s + t.stale.length, 0), teams: out });
});

export default r;
