import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { trendPct } from './aggregates.js';

const r = Router();

function headshot(p) {
  if (p.espn_id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.espn_id}.png`;
  if (p.sleeper_id) return `https://sleepercdn.com/content/nfl/players/${p.sleeper_id}.jpg`;
  return null;
}

function metricsFor(playerId) {
  const m = {};
  for (const x of rows('SELECT source, value FROM player_metrics WHERE player_id = ?', playerId)) m[x.source] = x.value;
  return m;
}

// News matching: full name always; bare last name only for that player's own team
// (so "Brown" doesn't pull A.J. Brown / Chase Brown / Cleveland Browns together).
function newsFor(player) {
  const full = `%${player.name}%`;
  const last = `%${player.name.split(' ').slice(-1)[0]}%`;
  return rows(`SELECT n.*, t.abbr AS team_abbr FROM news_items n
               LEFT JOIN nfl_teams t ON t.id = n.team_id
               WHERE (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?)
                  OR (n.team_id IS NOT NULL AND n.team_id = ?
                      AND (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?))
               ORDER BY n.date DESC LIMIT 10`,
    full, full, full, player.team_id ?? -1, last, last, last);
}

r.get('/', (req, res) => {
  const { position, q } = req.query;
  let sql = `SELECT p.*, t.abbr AS team_abbr, t.name AS team_name
             FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE 1=1`;
  const params = [];
  if (position) { sql += ' AND p.position = ?'; params.push(position); }
  if (q) { sql += ' AND p.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.name';
  res.json(rows(sql, ...params).map(p => ({ ...p, headshot: headshot(p) })));
});

r.get('/:id', (req, res) => {
  const player = row(`SELECT p.*, t.abbr AS team_abbr, t.name AS team_name, t.head_coach, t.oc_name, t.dc_name,
                             t.off_scheme, t.off_scheme_detail, t.def_scheme, t.def_scheme_detail,
                             t.ol_analysis, t.dl_analysis, t.lb_analysis, t.secondary_analysis, t.st_analysis,
                             t.coach_analysis, t.primary_color
                      FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, req.params.id);
  if (!player) return res.status(404).json({ error: 'player not found' });
  const ranks = rows(`SELECT re.rank, re.tier, re.note, rs.name AS set_name
                      FROM ranking_entries re JOIN ranking_sets rs ON rs.id = re.set_id
                      WHERE re.player_id = ?`, player.id);
  const teammates = player.team_id
    ? rows('SELECT id, name, position, slot_code, phase FROM players WHERE team_id = ? ORDER BY phase, slot_code', player.team_id)
    : [];
  const verdict = row('SELECT verdict, reasoning, generated_at FROM player_analysis WHERE player_id = ?', player.id);
  res.json({
    ...player,
    headshot: headshot(player),
    metrics: metricsFor(player.id),
    ranks,
    news: newsFor(player),
    teammates,
    verdict: verdict ?? null
  });
});

// Heuristic buy/sell used when no API key is configured (and as the AI's starting point).
function heuristicVerdict(m) {
  const pct = trendPct(m.fc_value, m.fc_trend30);
  if (pct == null) return null;
  const s = Math.abs(pct).toFixed(1);
  if (pct > 5) return { verdict: 'SELL', why: `market value up ${s}% in 30 days — sell into the hype` };
  if (pct < -5) return { verdict: 'BUY', why: `market value down ${s}% in 30 days — buy the dip` };
  return { verdict: 'HOLD', why: `market value is stable (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% in 30 days)` };
}

// AI buy/sell verdict grounded in this year's roster, scheme, market trend and news.
r.post('/:id/analyze', async (req, res, next) => {
  try {
    const player = row(`SELECT p.*, t.abbr AS team_abbr, t.name AS team_name, t.head_coach, t.oc_name,
                               t.off_scheme, t.off_scheme_detail, t.ol_analysis, t.coach_analysis
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, req.params.id);
    if (!player) return res.status(404).json({ error: 'player not found' });
    const m = metricsFor(player.id);
    const news = newsFor(player);

    if (!process.env.ANTHROPIC_API_KEY) {
      const h = heuristicVerdict(m);
      if (!h) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set and no market trend available.' });
      run(`INSERT INTO player_analysis (player_id, verdict, reasoning, generated_at)
           VALUES (?,?,?,datetime('now'))
           ON CONFLICT(player_id) DO UPDATE SET verdict=excluded.verdict, reasoning=excluded.reasoning, generated_at=excluded.generated_at`,
        player.id, h.verdict, `Market signal only (no API key): ${h.why}.`);
      return res.json({ verdict: h.verdict, reasoning: `Market signal only (no API key): ${h.why}.`, source: 'heuristic' });
    }

    const depth = rows(`SELECT name, position, slot_code FROM players
                        WHERE team_id = ? AND slot_code IS NOT NULL AND phase = 'offense'
                        ORDER BY slot_code`, player.team_id ?? -1);

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Fantasy football buy/sell call for THIS season (2026 redraft).

PLAYER: ${player.name}, ${player.position}, ${player.team_name ?? 'free agent'}
TEAM CONTEXT: HC ${player.head_coach ?? '?'}, OC ${player.oc_name ?? '?'}. Offense: ${player.off_scheme ?? '?'} — ${player.off_scheme_detail ?? ''}
O-LINE: ${player.ol_analysis ?? 'n/a'}
CURRENT DEPTH CHART (source of truth — only these players are on the team):
${depth.map(d => `${d.slot_code}: ${d.name}`).join('\n') || 'n/a'}

MARKET SIGNALS: ${JSON.stringify({ fantasycalc_value: m.fc_value, trend_30day_pct: m.fc_trend30, adp: m.ffc_adp ?? m.fc_adp, sleeper_rank: m.sleeper_rank, injury_flag: m.injury_flag })}

RECENT NEWS:
${news.map(n => `[${n.date}] ${n.headline}${n.body ? ' — ' + n.body : ''}`).join('\n') || '(none)'}

Give a BUY, SELL, or HOLD call for this season. Ground it in scheme fit, target/touch competition from the depth chart above, the market trend, and the news. Never mention players who aren't on the depth chart. Be specific and opinionated, 3-4 sentences.

Respond with ONLY JSON: {"verdict":"BUY|SELL|HOLD","reasoning":"..."}`
      }]
    });
    const text = msg.content[0].text.trim().replace(/^```json?\n?|```$/g, '');
    const out = JSON.parse(text);
    run(`INSERT INTO player_analysis (player_id, verdict, reasoning, generated_at)
         VALUES (?,?,?,datetime('now'))
         ON CONFLICT(player_id) DO UPDATE SET verdict=excluded.verdict, reasoning=excluded.reasoning, generated_at=excluded.generated_at`,
      player.id, out.verdict, out.reasoning);
    res.json({ ...out, source: 'ai' });
  } catch (e) { next(e); }
});

export default r;
