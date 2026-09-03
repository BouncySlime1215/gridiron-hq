import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { unitGrades } from './nfldata.js';
import { SEASON_ENDING_RE, RELEASED_RE, textMentionsFullName } from '../services/player-availability.js';
import { teamTendencies } from '../services/nfl-team-tendencies.js';

const EDITABLE = ['head_coach', 'oc_name', 'dc_name', 'off_scheme', 'off_scheme_detail',
  'def_scheme', 'def_scheme_detail', 'st_coordinator', 'ol_analysis', 'dl_analysis',
  'lb_analysis', 'secondary_analysis', 'st_analysis', 'coach_analysis'];

const r = Router();

r.get('/', (req, res) => {
  res.json(rows('SELECT id, abbr, name, conference, division, head_coach, off_scheme, def_scheme, primary_color, secondary_color FROM nfl_teams ORDER BY conference, division, name'));
});

/**
 * Players ESPN's own depth chart still lists as the starter, but who are
 * actually out for the season — the sync target (roster_players' depth_slot)
 * and the injury signal are two different pipelines with two different
 * update cadences, so a torn-triceps IR move can post to news before ESPN's
 * depth chart catches up.
 *
 * Deliberately does NOT reuse `nfl_news_signals` here — that table only
 * resolves players who are `fantasy_relevant = 1`, which correctly excludes
 * almost every offensive lineman (Tunsil is exactly the case that exposed
 * this: a real season-ending injury that could never appear in the
 * fantasy-scoped signal table no matter how good the extraction regex was).
 * A depth-chart diagram cares about every starter, not just skill positions,
 * so this scans recent team news directly against every rostered name using
 * the same out-of-season/released language, independent of fantasy scoping.
 */
function seasonEndingPlayerIds(teamId) {
  const roster = rows(`SELECT DISTINCT rp.espn_id, rp.name FROM roster_players rp
                       WHERE rp.team_id = ? AND rp.espn_id IS NOT NULL`, teamId);
  if (!roster.length) return new Set();
  const recentNews = rows(`SELECT headline, body FROM news_items
                           WHERE team_id = ? AND COALESCE(published_at, date) >= datetime('now', '-45 days')`, teamId);
  const flagged = new Set();
  for (const player of roster) {
    for (const n of recentNews) {
      const text = `${n.headline ?? ''} ${n.body ?? ''}`;
      // Full-name match, not last-name-only: team news is dense with roster-cut
      // items ("Released WR Noah Brown") that used to falsely flag every other
      // player sharing that surname on the same team as also released.
      if (!textMentionsFullName(text, player.name)) continue;
      if (SEASON_ENDING_RE.test(text) || RELEASED_RE.test(text)) { flagged.add(player.espn_id); break; }
    }
  }
  return flagged;
}

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
  const seasonEnding = seasonEndingPlayerIds(team.id);
  const bySlot = {};
  for (const s of starters) (bySlot[s.depth_slot] ??= []).push(s);

  const depth = {}, multi = {};
  for (const [slot, list] of Object.entries(bySlot)) {
    // Skip anyone flagged season-ending/released and promote the next healthy
    // name at that slot, rather than showing a player who is not on the field.
    const active = list.find(s => !seasonEnding.has(s.espn_id));
    const starter = active ?? list[0];
    const displaced = list.find(s => seasonEnding.has(s.espn_id) && s !== starter);
    depth[slot] = displaced ? { ...starter, replacing: displaced.name } : starter;
    // FormationView's pickSlot() reads depth_multi FIRST and only falls back
    // to `depth` when depth_multi is absent — so depth_multi has to carry the
    // same fix, not just `depth`, or the diagram keeps showing index 0 of the
    // raw ESPN order regardless of what `depth` resolved to.
    multi[slot] = [depth[slot], ...list.filter(s => s !== starter)];
  }

  res.json({ ...team, players, depth, depth_multi: multi, grades: unitGrades(team.id) });
});

/**
 * Measured tendencies from play-by-play — what the team actually does, as
 * opposed to what the written scheme note claims it does.
 */
r.get('/:abbr/tendencies', (req, res) => {
  res.json(teamTendencies(req.params.abbr, {
    season: Number(req.query.season) || undefined
  }));
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
