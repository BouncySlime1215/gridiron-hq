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
// Individual defensive players (EDGE/DL/LB/CB/S) are depth-chart/X's-and-O's data,
// not standard fantasy draft slots — they stay fantasy_relevant=0. Every offensive
// skill slot and the kicker are real draftable fantasy positions regardless of
// whether they made the curated top-100 consensus board below.
const FANTASY_SLOT = new Set(['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'WR3', 'TE1', 'K']);

export function seedIfEmpty() {
  console.log('Reconciling seed data...');
  const insertTeam = db.prepare(`INSERT INTO nfl_teams
    (abbr, name, conference, division, head_coach, oc_name, dc_name, off_scheme, off_scheme_detail,
     def_scheme, def_scheme_detail, st_coordinator, ol_analysis, dl_analysis, lb_analysis,
     secondary_analysis, st_analysis, coach_analysis, primary_color, secondary_color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(abbr) DO UPDATE SET name=excluded.name,conference=excluded.conference,division=excluded.division,
      head_coach=excluded.head_coach,oc_name=excluded.oc_name,dc_name=excluded.dc_name,
      off_scheme=excluded.off_scheme,off_scheme_detail=excluded.off_scheme_detail,
      def_scheme=excluded.def_scheme,def_scheme_detail=excluded.def_scheme_detail,
      st_coordinator=excluded.st_coordinator,ol_analysis=excluded.ol_analysis,dl_analysis=excluded.dl_analysis,
      lb_analysis=excluded.lb_analysis,secondary_analysis=excluded.secondary_analysis,
      st_analysis=excluded.st_analysis,coach_analysis=excluded.coach_analysis,
      primary_color=excluded.primary_color,secondary_color=excluded.secondary_color`);
  const insertPlayer = db.prepare(`INSERT INTO players
    (name, position, team_id, depth_rank, slot_code, phase, fantasy_relevant)
    VALUES (?,?,?,?,?,?,?)`);

  const teamIds = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of TEAMS) {
      insertTeam.run(t.abbr, t.name, t.conference, t.division, t.head_coach, t.oc_name,
        t.dc_name, t.off_scheme, t.off_scheme_detail, t.def_scheme, t.def_scheme_detail,
        t.st_coordinator, t.ol_analysis, t.dl_analysis, t.lb_analysis, t.secondary_analysis,
        t.st_analysis, t.coach_analysis, t.primary_color, t.secondary_color);
      teamIds[t.abbr] = row('SELECT id FROM nfl_teams WHERE abbr=?', t.abbr).id;
    }

    const playerIdByName = {};
    for (const [abbr, slots] of Object.entries(DEPTH)) {
      for (const [slot, name] of Object.entries(slots)) {
        const depthRank = /2$/.test(slot) ? 2 : /3$/.test(slot) ? 3 : 1;
        let player = row('SELECT id FROM players WHERE team_id=? AND slot_code=? ORDER BY id LIMIT 1', teamIds[abbr], slot);
        if (!player) {
          const result = insertPlayer.run(name, SLOT_POS[slot], teamIds[abbr], depthRank, slot, SLOT_PHASE[slot], FANTASY_SLOT.has(slot) ? 1 : 0);
          player = { id: Number(result.lastInsertRowid) };
        } else {
          run(`UPDATE players SET name=?,position=?,depth_rank=?,phase=?,fantasy_relevant=? WHERE id=?`,
            name, SLOT_POS[slot], depthRank, SLOT_PHASE[slot], FANTASY_SLOT.has(slot) ? 1 : 0, player.id);
        }
        playerIdByName[name] = player.id;
      }
    // Team defense/special-teams unit — drafted as one entity, same as every other
    // fantasy platform. Named to match what ESPN sync produces for the same team
    // ("{Nickname} D/ST"), so a later sync updates this row by name instead of
    // creating a duplicate.
      const nickname = TEAMS.find(t => t.abbr === abbr)?.name.split(' ').pop();
      if (nickname) {
        const defense = row(`SELECT id FROM players WHERE team_id=? AND position='DEF' ORDER BY id LIMIT 1`, teamIds[abbr]);
        if (defense) run(`UPDATE players SET name=?,slot_code='DEF',phase='defense',fantasy_relevant=1 WHERE id=?`, `${nickname} D/ST`, defense.id);
        else insertPlayer.run(`${nickname} D/ST`, 'DEF', teamIds[abbr], 1, 'DEF', 'defense', 1);
      }
    }

  // Default ranking set from the consensus board; add any board players missing from depth charts.
    let setId = row(`SELECT id FROM ranking_sets WHERE name='My 2026 Board' AND scoring='PPR' ORDER BY id LIMIT 1`)?.id;
    if (!setId) {
      run(`INSERT INTO ranking_sets (name, scoring) VALUES ('My 2026 Board', 'PPR')`);
      setId = row('SELECT last_insert_rowid() AS id').id;
    }
    const insertEntry = db.prepare(`INSERT INTO ranking_entries (set_id, player_id, rank, tier) VALUES (?,?,?,?)
      ON CONFLICT(set_id, player_id) DO UPDATE SET rank=excluded.rank,tier=excluded.tier`);

    DEFAULT_BOARD.forEach(([name, pos, abbr], i) => {
      let pid = playerIdByName[name] ?? row('SELECT id FROM players WHERE name=? ORDER BY id LIMIT 1', name)?.id;
      if (!pid) {
        const result = insertPlayer.run(name, pos, teamIds[abbr] ?? null, 1, null, 'offense', 1);
        pid = Number(result.lastInsertRowid);
      }
      run('UPDATE players SET fantasy_relevant = 1 WHERE id = ?', pid);
      const tier = i < 6 ? 1 : i < 15 ? 2 : i < 30 ? 3 : i < 50 ? 4 : i < 75 ? 5 : 6;
      insertEntry.run(setId, pid, i + 1, tier);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  console.log('Seed reconciliation complete.');
}
