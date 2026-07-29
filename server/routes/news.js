import { Router } from 'express';
import { rows, row, run } from '../db/index.js';

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
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set. Add it to .env and restart, or use manual entry.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are an NFL training-camp analyst for a fantasy football dashboard. For each story below, write a JSON array where each element has: "team_abbr", "headline" (cleaned up), "ai_analysis" (2-3 sentences of sharp football analysis: scheme fit, depth chart, usage), "fantasy_impact" (1 sentence, specific), "importance" (1=minor, 2=notable, 3=major). Only respond with the JSON array, no other text.\n\nStories:\n${items.map((it, i) => `${i + 1}. [${it.team_abbr}] ${it.headline}${it.body ? ' — ' + it.body : ''}`).join('\n')}`
      }]
    });
    const text = msg.content[0].text.trim().replace(/^```json?\n?|```$/g, '');
    const analyzed = JSON.parse(text);
    for (const a of analyzed) {
      const team = row('SELECT id FROM nfl_teams WHERE abbr = ?', (a.team_abbr || '').toUpperCase());
      run(`INSERT INTO news_items (date, team_id, headline, ai_analysis, fantasy_impact, importance, source)
           VALUES (?,?,?,?,?,?,?)`,
        date, team?.id ?? null, a.headline, a.ai_analysis, a.fantasy_impact, a.importance ?? 2, 'AI analysis');
    }
    res.json({ ok: true, count: analyzed.length });
  } catch (e) { next(e); }
});

export default r;
