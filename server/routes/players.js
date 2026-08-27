import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { trendPct } from './aggregates.js';
import { computeSOS } from './nfldata.js';
import { statsFor, fetchGameLog } from './stats.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';

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
  // real depth-chart starters for this player's team (drives the X-and-O view)
  const depth = {}, depthMulti = {};
  if (player.team_id) {
    for (const s of rows(`SELECT rp.name, rp.position, rp.depth_slot, rp.depth_order, rp.jersey, p.id AS player_id
                          FROM roster_players rp LEFT JOIN players p ON p.espn_id = rp.espn_id
                          WHERE rp.team_id = ? AND rp.depth_slot IS NOT NULL
                            AND rp.depth_order IS NOT NULL AND rp.depth_order <= 4
                          ORDER BY rp.depth_slot, rp.depth_order`, player.team_id)) {
      (depthMulti[s.depth_slot] ??= []).push(s);
      if (s.depth_order === 1 && !depth[s.depth_slot]) depth[s.depth_slot] = s;
    }
  }
  const verdict = row('SELECT verdict, reasoning, generated_at FROM player_analysis WHERE player_id = ?', player.id);
  res.json({
    ...player,
    headshot: headshot(player),
    metrics: metricsFor(player.id),
    ranks,
    news: newsFor(player),
    teammates,
    depth,
    depth_multi: depthMulti,
    stats: statsFor(player.id),
    verdict: verdict ?? null
  });
});

/** Game-by-game log — proxied live from ESPN. */
r.get('/:id/gamelog', async (req, res, next) => {
  try {
    const p = row('SELECT espn_id, name, position FROM players WHERE id = ?', req.params.id);
    if (!p) return res.status(404).json({ error: 'player not found' });
    // some rows come from ranking imports without an ESPN id — fall back to the roster table by name
    let espnId = p.espn_id;
    if (!espnId) {
      const norm = n => n.toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').trim();
      const match = rows('SELECT name, espn_id FROM roster_players WHERE espn_id IS NOT NULL')
        .find(x => norm(x.name) === norm(p.name));
      espnId = match?.espn_id ?? null;
      if (espnId) run('UPDATE players SET espn_id = ? WHERE id = ?', espnId, req.params.id);
    }
    if (!espnId) return res.json({ unavailable: `No ESPN id matched for ${p.name}.`, games: [] });
    const season = Number(req.query.season) || (Number(process.env.NFL_SEASON) || 2026) - 1;
    res.json(await fetchGameLog(espnId, season));
  } catch (e) { next(e); }
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

function playerEvidenceFacts({ player, metrics, news, depth, sos }) {
  const facts = [];
  const add = (id, text, source) => { if (text) facts.push({ id, text, source }); };
  const trend = trendPct(metrics.fc_value, metrics.fc_trend30);
  if (trend != null) add('market.trend', `FantasyCalc value changed ${trend >= 0 ? '+' : ''}${trend.toFixed(1)}% over 30 days.`, 'FantasyCalc');
  if (metrics.ffc_adp ?? metrics.fc_adp) add('market.adp', `Current ADP is ${Number(metrics.ffc_adp ?? metrics.fc_adp).toFixed(1)}.`, 'fantasy market feed');
  if (metrics.sleeper_rank) add('market.sleeper_rank', `Sleeper rank is ${Math.round(metrics.sleeper_rank)}.`, 'Sleeper');
  if (metrics.injury_flag) add('availability.flag', 'The structured player feed currently carries an injury flag.', 'player metrics');
  if (sos) add('schedule.rank', `Remaining schedule ranks ${sos.rank}/32 where 1 is easiest.`, 'computed schedule model');
  if (player.off_scheme) add('team.scheme', `${player.team_name} lists its offense as ${player.off_scheme}.`, 'team profile');
  const competitors = depth.filter(x => x.name !== player.name && x.position === player.position).map(x => x.name).slice(0, 4);
  if (competitors.length) add('depth.competition', `Same-position depth-chart competition: ${competitors.join(', ')}.`, 'synced depth chart');
  news.slice(0, 4).forEach((item, index) => add(`news.${index + 1}`, `[${item.date}] ${item.headline}`, item.source ?? 'news feed'));
  return facts;
}

export function groundPlayerVerdict(selection, facts, fallback = 'HOLD') {
  const allowed = new Map(facts.map(fact => [fact.id, fact]));
  const verdict = new Set(['BUY', 'SELL', 'HOLD']).has(selection?.verdict) ? selection.verdict : fallback;
  const ids = Array.isArray(selection?.evidence_ids)
    ? [...new Set(selection.evidence_ids)].filter(id => allowed.has(id)).slice(0, 4) : [];
  const selected = (ids.length ? ids : facts.slice(0, 3).map(fact => fact.id)).map(id => allowed.get(id)).filter(Boolean);
  return {
    verdict,
    reasoning: selected.length ? selected.map(fact => fact.text).join(' ') : 'No structured evidence is currently available.',
    evidence: selected,
    grounding: { unsupported_claims_allowed: false, prose_source: 'deterministic_evidence_renderer' }
  };
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

    if (!getApiKey()) {
      const h = heuristicVerdict(m);
      if (!h) return res.status(400).json({ error: 'No API key configured (Dev Hub, top right) and no market trend available.' });
      run(`INSERT INTO player_analysis (player_id, verdict, reasoning, generated_at)
           VALUES (?,?,?,datetime('now'))
           ON CONFLICT(player_id) DO UPDATE SET verdict=excluded.verdict, reasoning=excluded.reasoning, generated_at=excluded.generated_at`,
        player.id, h.verdict, `Market signal only (no API key): ${h.why}.`);
      return res.json({ verdict: h.verdict, reasoning: `Market signal only (no API key): ${h.why}.`, source: 'heuristic' });
    }

    const depth = rows(`SELECT name, position, slot_code FROM players
                        WHERE team_id = ? AND slot_code IS NOT NULL AND phase = 'offense'
                        ORDER BY slot_code`, player.team_id ?? -1);
    const sos = player.team_abbr ? computeSOS().find(s => s.abbr === player.team_abbr) : null;
    const facts = playerEvidenceFacts({ player, metrics: m, news, depth, sos });
    const fallback = heuristicVerdict(m)?.verdict ?? 'HOLD';

    const msg = await callClaude({
      feature: 'player-verdict',
      maxTokens: 180,
      prompt: `Select a 2026 redraft verdict for ${player.name} (${player.position}).
You may ONLY select evidence IDs from this packet; you do not write the explanation.
EVIDENCE: ${JSON.stringify(facts)}
Respond with ONLY JSON: {"verdict":"BUY|SELL|HOLD","evidence_ids":["id", "id"]}
Choose 1-4 IDs that genuinely support the verdict. If evidence conflicts or is thin, choose HOLD.`
    });
    const out = groundPlayerVerdict(parseJson(msg), facts, fallback);
    run(`INSERT INTO player_analysis (player_id, verdict, reasoning, generated_at)
         VALUES (?,?,?,datetime('now'))
         ON CONFLICT(player_id) DO UPDATE SET verdict=excluded.verdict, reasoning=excluded.reasoning, generated_at=excluded.generated_at`,
      player.id, out.verdict, out.reasoning);
    res.json({ ...out, source: 'ai_evidence_selection' });
  } catch (e) { next(e); }
});

export default r;
