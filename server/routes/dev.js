import { Router } from 'express';
import { getApiKey, setApiKey, clearApiKey, usageSummary, PRICING } from '../services/claude.js';
import { rows, row } from '../db/index.js';

const r = Router();

const mask = k => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null);

r.get('/status', (req, res) => {
  const key = getApiKey();
  const usage = usageSummary(30);
  const dataFreshness = {
    rosters: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM roster_players`),
    cap: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM team_cap`),
    news: row(`SELECT MAX(created_at) AS at, COUNT(*) AS n FROM news_items`),
    market: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM player_metrics`),
    stats: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM player_season_stats`)
  };
  res.json({
    api_key: key ? { configured: true, masked: mask(key) } : { configured: false },
    pricing: PRICING['claude-haiku-4-5-20251001'],
    model: 'claude-haiku-4-5-20251001',
    usage,
    data: dataFreshness
  });
});

r.put('/key', (req, res) => {
  const { key } = req.body ?? {};
  if (!key || !/^sk-ant-/.test(key)) {
    return res.status(400).json({ error: 'That does not look like an Anthropic key (expected it to start with sk-ant-).' });
  }
  const result = setApiKey(key.trim());
  res.json({ ok: true, masked: mask(key.trim()), ...result });
});

r.delete('/key', (req, res) => { clearApiKey(); res.json({ ok: true }); });

r.get('/usage', (req, res) => res.json(usageSummary(Number(req.query.days) || 30)));

export default r;
