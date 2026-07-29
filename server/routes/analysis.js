import { Router } from 'express';
import { rows, row, run } from '../db/index.js';

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

async function refreshTeam(client, team) {
  const { players, news } = teamContext(team);
  const roster = players.map(p => `${p.slot_code ?? p.position}: ${p.name}`).join('\n');
  const newsText = news.map(n => `[${n.date}] ${n.headline}${n.body ? ' — ' + n.body : ''}`).join('\n') || '(no recent stories)';
  const current = ANALYSIS_FIELDS.map(f => `${f}: ${team[f]}`).join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You maintain fantasy-football team analyses for the ${team.name} (2026 season). HC ${team.head_coach}, OC ${team.oc_name}, DC ${team.dc_name}. Offense: ${team.off_scheme}. Defense: ${team.def_scheme}.

CURRENT ROSTER (source of truth — anyone NOT listed is no longer on the team):
${roster}

RECENT NEWS:
${newsText}

CURRENT ANALYSES:
${current}

Task: Did any of the news, roster, or coaching info change the outlook? Rewrite ONLY the analysis fields that are stale — especially any that mention players who are NOT on the current roster, or contradict the news. Keep the same sharp, concise editorial voice (2-4 sentences per field). If a field is still accurate, omit it.

Respond with ONLY a JSON object. Keys: any of ${ANALYSIS_FIELDS.join(', ')} (only the ones you changed), plus "changed" (boolean) and "reason" (one sentence on what drove the update, or why nothing changed).`
    }]
  });
  const text = msg.content[0].text.trim().replace(/^```json?\n?|```$/g, '');
  const result = JSON.parse(text);
  const updates = ANALYSIS_FIELDS.filter(f => typeof result[f] === 'string' && result[f].length > 10);
  if (updates.length > 0) {
    run(`UPDATE nfl_teams SET ${updates.map(f => `${f} = ?`).join(', ')}, analysis_updated_at = datetime('now') WHERE id = ?`,
      ...updates.map(f => result[f]), team.id);
  } else {
    run(`UPDATE nfl_teams SET analysis_updated_at = datetime('now') WHERE id = ?`, team.id);
  }
  return { abbr: team.abbr, changed: updates.length > 0, fields: updates, reason: result.reason ?? '' };
}

// POST /api/analysis/refresh  { teams?: ["KC", ...], force?: bool }
// Default: only teams with news newer than their last analysis refresh.
r.post('/refresh', async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set — add it to .env and restart to enable live AI analysis.' });
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    let teams;
    if (Array.isArray(req.body?.teams) && req.body.teams.length) {
      const list = req.body.teams.map(a => a.toUpperCase());
      teams = rows(`SELECT * FROM nfl_teams WHERE abbr IN (${list.map(() => '?').join(',')})`, ...list);
    } else if (req.body?.force) {
      teams = rows('SELECT * FROM nfl_teams');
    } else {
      teams = rows(`SELECT t.* FROM nfl_teams t WHERE EXISTS (
                      SELECT 1 FROM news_items n WHERE n.team_id = t.id
                      AND n.created_at > COALESCE(t.analysis_updated_at, '1970-01-01'))`);
    }
    if (teams.length === 0) return res.json({ ok: true, refreshed: [], message: 'No teams have news newer than their analysis.' });

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
    res.json({ ok: true, refreshed: results });
  } catch (e) { next(e); }
});

export default r;
