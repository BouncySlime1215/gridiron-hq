import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';

const r = Router();

r.get('/', (req, res) => {
  const { date, team } = req.query;
  let sql = `SELECT n.*, t.abbr AS team_abbr, t.name AS team_name, t.primary_color
             FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND n.date = ?'; params.push(date); }
  if (team) { sql += ' AND t.abbr = ?'; params.push(team.toUpperCase()); }
  sql += ' ORDER BY n.date DESC, n.importance DESC, n.id DESC';
  res.json(rows(sql, ...params));
});

r.get('/dates', (req, res) => {
  res.json(rows('SELECT DISTINCT date FROM news_items ORDER BY date DESC').map(x => x.date));
});

// Manual entry (also used by the Claude Code assisted workflow)
r.post('/', (req, res) => {
  const { date, team_abbr, headline, body, ai_analysis, fantasy_impact, importance = 2, source } = req.body;
  if (!date || !headline) return res.status(400).json({ error: 'date and headline required' });
  const team = team_abbr ? row('SELECT id FROM nfl_teams WHERE abbr = ?', team_abbr.toUpperCase()) : null;
  run(`INSERT INTO news_items (date, team_id, headline, body, ai_analysis, fantasy_impact, importance, source)
       VALUES (?,?,?,?,?,?,?,?)`,
    date, team?.id ?? null, headline, body ?? null, ai_analysis ?? null,
    fantasy_impact ?? null, importance, source ?? null);
  res.json({ ok: true });
});

r.delete('/:id', (req, res) => {
  run('DELETE FROM news_items WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// AI analysis for pasted headlines. Requires ANTHROPIC_API_KEY in env.
r.post('/analyze', async (req, res, next) => {
  try {
    const { date, items } = req.body; // items: [{team_abbr, headline, body?}]
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right), or use manual entry.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    const msg = await callClaude({
      feature: 'news-analyze',
      maxTokens: 2048,
      prompt: `You are an NFL training-camp analyst for a fantasy football dashboard. For each story below, write a JSON array where each element has: "team_abbr", "headline" (cleaned up), "ai_analysis" (2-3 sentences of sharp football analysis: scheme fit, depth chart, usage), "fantasy_impact" (1 sentence, specific), "importance" (1=minor, 2=notable, 3=major). Only respond with the JSON array, no other text.\n\nStories:\n${items.map((it, i) => `${i + 1}. [${it.team_abbr}] ${it.headline}${it.body ? ' — ' + it.body : ''}`).join('\n')}`
    });
    const analyzed = parseJson(msg);
    for (const a of analyzed) {
      const team = row('SELECT id FROM nfl_teams WHERE abbr = ?', (a.team_abbr || '').toUpperCase());
      run(`INSERT INTO news_items (date, team_id, headline, ai_analysis, fantasy_impact, importance, source)
           VALUES (?,?,?,?,?,?,?)`,
        date, team?.id ?? null, a.headline, a.ai_analysis, a.fantasy_impact, a.importance ?? 2, 'AI analysis');
    }
    res.json({ ok: true, count: analyzed.length });
  } catch (e) { next(e); }
});

function myRosterNames() {
  // players on my team(s) across every connected league
  const out = new Set();
  for (const lg of rows('SELECT platform, payload, my_team_id FROM leagues WHERE payload IS NOT NULL')) {
    let payload; try { payload = JSON.parse(lg.payload); } catch { continue; }
    if (lg.platform === 'sleeper') {
      const mine = (payload.rosters ?? []).find(r => String(r.roster_id) === String(lg.my_team_id))
        ?? (payload.rosters ?? [])[0];
      for (const sid of mine?.players ?? []) {
        const p = row('SELECT name FROM players WHERE sleeper_id = ?', sid);
        if (p) out.add(p.name);
      }
    } else {
      const mine = (payload.teams ?? []).find(t => String(t.id) === String(lg.my_team_id));
      for (const e of mine?.roster?.entries ?? []) {
        const n = e.playerPoolEntry?.player?.fullName;
        if (n) out.add(n);
      }
    }
  }
  return [...out];
}

/** "What does this actually mean?" — on-demand, per story. */
r.post('/:id/explain', async (req, res, next) => {
  try {
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }
    const n = row(`SELECT n.*, t.abbr AS team_abbr, t.name AS team_name, t.head_coach, t.oc_name,
                          t.off_scheme, t.off_scheme_detail, t.coach_analysis
                   FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id WHERE n.id = ?`, req.params.id);
    if (!n) return res.status(404).json({ error: 'story not found' });

    const depth = n.team_id
      ? rows(`SELECT name, position, slot_code FROM players
              WHERE team_id = ? AND slot_code IS NOT NULL AND phase = 'offense' ORDER BY slot_code`, n.team_id)
      : [];
    const mine = myRosterNames();

    const msg = await callClaude({
      feature: 'news-explain',
      maxTokens: 900,
      prompt: `Explain what this NFL story actually means. 2026 season.

STORY (${n.date}${n.team_abbr ? `, ${n.team_name}` : ''}): ${n.headline}
${n.body ?? ''}

${n.team_abbr ? `TEAM CONTEXT: HC ${n.head_coach}, OC ${n.oc_name}. ${n.off_scheme ?? ''}. ${n.off_scheme_detail ?? ''}
DEPTH CHART (source of truth — never name anyone else as being on this team):
${depth.map(d => `${d.slot_code}: ${d.name}`).join('\n') || 'n/a'}` : ''}

MY FANTASY ROSTER (across my leagues): ${mine.length ? mine.join(', ') : '(no leagues connected)'}

Answer in JSON with exactly two keys:
"team_impact": 2-3 sentences on what this means for ${n.team_name ?? 'the team'} as a whole — scheme, depth chart, who gains and who loses snaps/targets.
"my_impact": 2-3 sentences on what it means specifically for MY fantasy roster listed above. If nobody on my roster is affected, say so plainly and name the one player I should be watching instead.

Respond with ONLY the JSON object.`
    });
    const out = parseJson(msg);
    run(`UPDATE news_items SET ai_analysis = ?, fantasy_impact = ? WHERE id = ?`,
      out.team_impact, out.my_impact, n.id);
    res.json(out);
  } catch (e) { next(e); }
});

/** Camp roundup: one paragraph on the day + the teams most affected. */
r.post('/roundup', async (req, res, next) => {
  try {
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }
    const date = req.body?.date;
    const stories = date
      ? rows(`SELECT n.headline, n.body, t.abbr FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
              WHERE n.date = ? ORDER BY n.importance DESC LIMIT 60`, date)
      : rows(`SELECT n.headline, n.body, t.abbr FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
              ORDER BY n.date DESC, n.importance DESC LIMIT 60`);
    if (!stories.length) return res.status(400).json({ error: 'No stories to summarize — pull news first.' });

    const mine = myRosterNames();
    const msg = await callClaude({
      feature: 'news-roundup',
      maxTokens: 1400,
      prompt: `Here are today's NFL training-camp headlines (2026). Write a camp roundup.

${stories.map(s => `[${s.abbr ?? 'NFL'}] ${s.headline}${s.body ? ' — ' + s.body : ''}`).join('\n')}

MY FANTASY ROSTER: ${mine.length ? mine.join(', ') : '(none connected)'}

Respond with ONLY JSON:
{
  "summary": "one flowing paragraph (5-7 sentences) covering the real story of the day across the league — camp battles, injuries, depth-chart movement. Prioritize what changes fantasy value. No bullet points.",
  "battles": [{"team":"ABBR","battle":"short label e.g. 'QB1 competition'","status":"one sentence on where it stands"}],
  "teams_affected": [{"team":"ABBR","why":"one sentence"}]
}
Limit battles and teams_affected to the 5 most consequential each.`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

export default r;
