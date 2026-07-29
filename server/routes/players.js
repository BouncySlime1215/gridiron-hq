import { Router } from 'express';
import { rows, row } from '../db/index.js';

const r = Router();

r.get('/', (req, res) => {
  const { position, q } = req.query;
  let sql = `SELECT p.*, t.abbr AS team_abbr, t.name AS team_name
             FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE 1=1`;
  const params = [];
  if (position) { sql += ' AND p.position = ?'; params.push(position); }
  if (q) { sql += ' AND p.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.name';
  res.json(rows(sql, ...params));
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
  // Full-name mentions always count; bare last-name mentions only count for
  // stories tagged to this player's own team (so "Brown" doesn't cross-match
  // A.J. Brown / Chase Brown / the Cleveland Browns).
  const full = `%${player.name}%`;
  const last = `%${player.name.split(' ').slice(-1)[0]}%`;
  const news = rows(`SELECT n.*, t.abbr AS team_abbr FROM news_items n
                     LEFT JOIN nfl_teams t ON t.id = n.team_id
                     WHERE (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?)
                        OR (n.team_id IS NOT NULL AND n.team_id = ?
                            AND (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?))
                     ORDER BY n.date DESC LIMIT 10`,
    full, full, full, player.team_id ?? -1, last, last, last);
  const teammates = player.team_id
    ? rows('SELECT id, name, position, slot_code, phase FROM players WHERE team_id = ? ORDER BY phase, slot_code', player.team_id)
    : [];
  res.json({ ...player, ranks, news, teammates });
});

export default r;
