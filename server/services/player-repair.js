import { db, rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

function playerReferenceTables() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()
    .map(x => x.name)
    .filter(name => db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().some(c => c.name === 'player_id'));
}

function refCounts(playerId, tables) {
  const out = {};
  for (const table of tables) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}" WHERE player_id=?`).get(playerId)?.n ?? 0;
    if (n) out[table] = n;
  }
  return out;
}

/**
 * Read-only repair plan. Only id-less, fantasy-irrelevant seed shadows are
 * classed as safe. Distinct ESPN ids are always held for human review.
 */
export function playerIdentityRepairPlan() {
  const players = rows(`SELECT id,name,position,team_id,espn_id,sleeper_id,fantasy_relevant FROM players ORDER BY id`);
  const groups = new Map();
  for (const p of players) {
    const key = `${normalizePlayerName(p.name)}|${p.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const duplicateGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
  const referenceTables = playerReferenceTables();
  const safe = [], review = [];
  for (const [key, list] of duplicateGroups) {
    const canonical = list.filter(p => p.espn_id != null);
    const shadows = list.filter(p => p.espn_id == null && !p.fantasy_relevant);
    const payload = { key, name: list[0].name, position: list[0].position,
      rows: list.map(p => ({ ...p, references: refCounts(p.id, referenceTables) })) };
    if (canonical.length === 1 && shadows.length && canonical.length + shadows.length === list.length) {
      safe.push({ ...payload, canonical_id: canonical[0].id, merge_ids: shadows.map(p => p.id),
        note: 'Safe candidate: unclaimed seed shadow into one stable ESPN identity.' });
    } else {
      review.push({ ...payload, reason: canonical.length > 1
        ? 'Multiple stable ESPN identities share this normalized name; never auto-merge.'
        : 'The group does not have exactly one stable identity plus orphan seed shadows.' });
    }
  }
  return {
    generated_at: new Date().toISOString(), dry_run: true, players: players.length,
    duplicate_groups: duplicateGroups.length, safe_groups: safe.length, review_groups: review.length,
    reference_tables: referenceTables, safe, review,
    note: 'No rows were changed. Apply is intentionally absent until each collision policy is reviewed.'
  };
}
