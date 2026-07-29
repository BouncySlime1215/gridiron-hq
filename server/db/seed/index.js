import { db, row, run } from '../index.js';
import { TEAMS } from './teams.js';
import { DEPTH, DEFAULT_BOARD } from './players.js';

const SLOT_PHASE = {
  QB: 'offense', RB1: 'offense', RB2: 'offense', WR1: 'offense', WR2: 'offense', WR3: 'offense', TE1: 'offense',
  EDGE: 'defense', DL: 'defense', LB: 'defense', CB: 'defense', S: 'defense', K: 'special_teams'
};
const SLOT_POS = {
  QB: 'QB', RB1: 'RB', RB2: 'RB', WR1: 'WR', WR2: 'WR', WR3: 'WR', TE1: 'TE',
  EDGE: 'EDGE', DL: 'DL', LB: 'LB', CB: 'CB', S: 'S', K: 'K'
};

export function seedIfEmpty() {
  const count = row('SELECT COUNT(*) AS n FROM nfl_teams').n;
  if (count > 0) return;

  console.log('Seeding database...');
  const insertTeam = db.prepare(`INSERT INTO nfl_teams
    (abbr, name, conference, division, head_coach, oc_name, dc_name, off_scheme, off_scheme_detail,
     def_scheme, def_scheme_detail, st_coordinator, ol_analysis, dl_analysis, lb_analysis,
     secondary_analysis, st_analysis, coach_analysis, primary_color, secondary_color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertPlayer = db.prepare(`INSERT INTO players
    (name, position, team_id, depth_rank, slot_code, phase, fantasy_relevant)
    VALUES (?,?,?,?,?,?,?)`);

  const teamIds = {};
  for (const t of TEAMS) {
    const r = insertTeam.run(t.abbr, t.name, t.conference, t.division, t.head_coach, t.oc_name,
      t.dc_name, t.off_scheme, t.off_scheme_detail, t.def_scheme, t.def_scheme_detail,
      t.st_coordinator, t.ol_analysis, t.dl_analysis, t.lb_analysis, t.secondary_analysis,
      t.st_analysis, t.coach_analysis, t.primary_color, t.secondary_color);
    teamIds[t.abbr] = Number(r.lastInsertRowid);
  }

  const playerIdByName = {};
  for (const [abbr, slots] of Object.entries(DEPTH)) {
    for (const [slot, name] of Object.entries(slots)) {
      const depthRank = /2$/.test(slot) ? 2 : /3$/.test(slot) ? 3 : 1;
      const r = insertPlayer.run(name, SLOT_POS[slot], teamIds[abbr], depthRank, slot, SLOT_PHASE[slot], 0);
      playerIdByName[name] = Number(r.lastInsertRowid);
    }
  }

  // Default ranking set from the consensus board; add any board players missing from depth charts.
  run(`INSERT INTO ranking_sets (name, scoring) VALUES ('My 2026 Board', 'PPR')`);
  const setId = row('SELECT last_insert_rowid() AS id').id;
  const insertEntry = db.prepare(
    'INSERT INTO ranking_entries (set_id, player_id, rank, tier) VALUES (?,?,?,?)');

  DEFAULT_BOARD.forEach(([name, pos, abbr], i) => {
    let pid = playerIdByName[name];
    if (!pid) {
      const r = insertPlayer.run(name, pos, teamIds[abbr] ?? null, 1, null, 'offense', 1);
      pid = Number(r.lastInsertRowid);
      playerIdByName[name] = pid;
    }
    run('UPDATE players SET fantasy_relevant = 1 WHERE id = ?', pid);
    const tier = i < 6 ? 1 : i < 15 ? 2 : i < 30 ? 3 : i < 50 ? 4 : i < 75 ? 5 : 6;
    insertEntry.run(setId, pid, i + 1, tier);
  });

  console.log('Seed complete.');
}
