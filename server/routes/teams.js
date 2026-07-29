import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { unitGrades } from './nfldata.js';

const EDITABLE = ['head_coach', 'oc_name', 'dc_name', 'off_scheme', 'off_scheme_detail',
  'def_scheme', 'def_scheme_detail', 'st_coordinator', 'ol_analysis', 'dl_analysis',
  'lb_analysis', 'secondary_analysis', 'st_analysis', 'coach_analysis'];

const r = Router();

r.get('/', (req, res) => {
  res.json(rows('SELECT id, abbr, name, conference, division, head_coach, off_scheme, def_scheme, primary_color, secondary_color FROM nfl_teams ORDER BY conference, division, name'));
});

r.get('/:abbr', (req, res) => {
  const team = row('SELECT * FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  const players = rows('SELECT * FROM players WHERE team_id = ? ORDER BY phase, slot_code', team.id);

  // Real starters straight off ESPN's depth chart — this is what the X-and-O
  // diagrams render, so the O-line and all 11 defenders are actual players.
  // ranks 1-3 per slot: rank 1 is the starter, 2-3 fill WR2/WR3 and rotational spots
  const starters = rows(`SELECT rp.name, rp.position, rp.depth_slot, rp.depth_order, rp.jersey, rp.espn_id,
                                p.id AS player_id
                         FROM roster_players rp
                         LEFT JOIN players p ON p.espn_id = rp.espn_id
                         WHERE rp.team_id = ? AND rp.depth_slot IS NOT NULL
                           AND rp.depth_order IS NOT NULL AND rp.depth_order <= 4
                         ORDER BY rp.depth_slot, rp.depth_order`, team.id);
  const depth = {}, multi = {};
  for (const s of starters) {
    (multi[s.depth_slot] ??= []).push(s);
    if (s.depth_order === 1 && !depth[s.depth_slot]) depth[s.depth_slot] = s;
  }

  res.json({ ...team, players, depth, depth_multi: multi, grades: unitGrades(team.id) });
});

r.put('/:abbr', (req, res) => {
  const team = row('SELECT id FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  const sets = [], params = [];
  for (const key of EDITABLE) {
    if (key in req.body) { sets.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no editable fields provided' });
  run(`UPDATE nfl_teams SET ${sets.join(', ')} WHERE id = ?`, ...params, team.id);
  res.json({ ok: true, updated: sets.length });
});

export default r;
