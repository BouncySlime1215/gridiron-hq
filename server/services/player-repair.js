import { db, rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

db.exec(`CREATE TABLE IF NOT EXISTS player_identity_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
  stable_id_type TEXT NOT NULL, stable_id TEXT NOT NULL, old_name TEXT NOT NULL,
  new_name TEXT NOT NULL, evidence_rows INTEGER NOT NULL, evidence_share REAL NOT NULL,
  repaired_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS player_identity_repairs_no_update BEFORE UPDATE ON player_identity_repairs
  BEGIN SELECT RAISE(ABORT, 'player identity repair audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS player_identity_repairs_no_delete BEFORE DELETE ON player_identity_repairs
  BEGIN SELECT RAISE(ABORT, 'player identity repair audit is immutable'); END;`);

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

/**
 * Find fantasy-relevant rows that never got an espn_id but sit on the same
 * team+position as a row ESPN *did* confirm — the shape a real rookie
 * promotion leaves behind. When a player is replaced at a roster slot, the
 * old occupant's row keeps its team_id and its (now stale) name; the ESPN
 * sync creates a brand-new row for the new occupant rather than reusing the
 * old one, because `findPlayerMatch` requires the *name* to agree and these
 * two rows never share one. `playerIdentityRepairPlan` above can't catch
 * this either — it only groups rows by normalized name, and these two have
 * different names by construction.
 *
 * This is exactly how one real WAS rookie's actual draft picks, rankings and
 * dynasty values ended up permanently attributed to a different, stale
 * player's name everywhere the app displays them: the old row (unclaimed,
 * espn_id NULL) picked up a Sleeper id and real league activity under its
 * old name, while the true current occupant of that roster slot lived in a
 * second, ESPN-linked row the whole time. Read-only, same as the rest of
 * this file — a human has to confirm which row is the stale one before
 * anything gets merged.
 */
export function unclaimedTeamPositionDuplicates() {
  const players = rows(`SELECT id,name,position,team_id,espn_id,sleeper_id,fantasy_relevant
    FROM players WHERE team_id IS NOT NULL AND position IS NOT NULL`);
  const byTeamPos = new Map();
  for (const p of players) {
    const key = `${p.team_id}|${p.position}`;
    if (!byTeamPos.has(key)) byTeamPos.set(key, []);
    byTeamPos.get(key).push(p);
  }
  const referenceTables = playerReferenceTables();
  const review = [];
  for (const list of byTeamPos.values()) {
    const claimed = list.filter(p => p.espn_id != null);
    const shadows = list.filter(p => p.espn_id == null && p.fantasy_relevant
      && !claimed.some(c => normalizePlayerName(c.name) === normalizePlayerName(p.name)));
    if (claimed.length !== 1 || !shadows.length) continue;
    review.push({
      team_id: claimed[0].team_id, position: claimed[0].position,
      espn_linked: { ...claimed[0], references: refCounts(claimed[0].id, referenceTables) },
      shadows: shadows.map(p => ({ ...p, references: refCounts(p.id, referenceTables) })),
      reason: 'A different name occupies this exact team+position with no espn_id of its own. ' +
        'Likely the same real roster slot under a stale name — never auto-merge on name alone.'
    });
  }
  return { dry_run: true, review_groups: review.length, review,
    note: 'No rows were changed. Confirm identity (e.g. against the team roster feed) before merging.' };
}

/**
 * Audit the players.gsis_id <-> nflverse crosswalk written by
 * server/services/nflverse.js#syncCrosswalk. Read-only: lists three distinct
 * failure shapes rather than fixing anything, so a human (or the repair pass
 * this feeds) can see the actual damage before touching a row.
 *
 *  - name_mismatches: a row's gsis_id points at nflverse weekly/depth/injury/
 *    opportunity data for a *different* named person — the shape you get when
 *    a stale gsis_id -> player_id binding wins over the espn_id match.
 *  - shared_gsis: the same gsis_id assigned to more than one players row —
 *    always a bug, since a real NFL identity is one row.
 *  - missing_gsis: an offense-skill player with a stable espn_id but no
 *    gsis_id at all, so player_week_usage can never carry their rows.
 */
export function gsisCrosswalkAudit() {
  const players = rows(`SELECT id, name, position, espn_id, gsis_id FROM players WHERE gsis_id IS NOT NULL`);

  const nameSources = [
    { table: 'nfl_player_week_features', nameCol: 'player_name', idCol: 'player_id' },
    { table: 'nfl_depth', nameCol: 'player_name', idCol: 'gsis_id' },
    { table: 'nfl_injuries', nameCol: 'full_name', idCol: 'gsis_id' },
    { table: 'nfl_ffopportunity_weekly', nameCol: 'player_name', idCol: 'player_gsis_id' }
  ];

  const name_mismatches = [];
  for (const p of players) {
    for (const src of nameSources) {
      const evidence = rows(`SELECT "${src.nameCol}" AS name, COUNT(*) AS n FROM "${src.table}"
        WHERE "${src.idCol}" = ? AND "${src.nameCol}" IS NOT NULL AND "${src.nameCol}" != ''
        GROUP BY "${src.nameCol}" ORDER BY n DESC`, p.gsis_id);
      if (!evidence.length) continue;
      const total = evidence.reduce((s, e) => s + e.n, 0);
      const top = evidence[0];
      // nflverse sources abbreviate first names ("T.Kelce") while players.name is
      // full ("Travis Kelce"); compare on last-name + first-initial, not exact string.
      const shortForm = n => normalizePlayerName(n).split(' ').filter(Boolean)
        .map((w, i, arr) => i === arr.length - 1 ? w : w[0]).join('');
      if (shortForm(top.name) === shortForm(p.name)) continue;
      name_mismatches.push({
        player_id: p.id, player_name: p.name, position: p.position, gsis_id: p.gsis_id,
        source: src.table, nflverse_name: top.name, evidence_rows: top.n, evidence_total: total
      });
    }
  }

  const shared_gsis = rows(`SELECT gsis_id, COUNT(*) AS n, GROUP_CONCAT(id) AS player_ids, GROUP_CONCAT(name, ' | ') AS names
    FROM players WHERE gsis_id IS NOT NULL GROUP BY gsis_id HAVING COUNT(*) > 1`);

  const missing_gsis = rows(`SELECT id, name, position, espn_id FROM players
    WHERE espn_id IS NOT NULL AND gsis_id IS NULL AND position IN ('QB','RB','WR','TE')`);

  return {
    generated_at: new Date().toISOString(), dry_run: true,
    players_with_gsis: players.length,
    name_mismatches, name_mismatch_count: name_mismatches.length,
    shared_gsis, shared_gsis_count: shared_gsis.length,
    missing_gsis, missing_gsis_count: missing_gsis.length
  };
}

/**
 * Find rows where the GSIS-linked name disagrees with the master label. This
 * is deliberately read-only: a row may also own Sleeper, ESPN, roster and
 * draft references, so a single source is not allowed to rename the person.
 */
export function canonicalGsisLabelConflicts() {
  const evidence = rows(`SELECT p.id,p.name,p.gsis_id,d.player_name,COUNT(*) evidence_rows
    FROM players p JOIN nfl_depth d ON d.gsis_id=p.gsis_id
    WHERE p.espn_id IS NULL AND p.gsis_id IS NOT NULL AND d.player_name IS NOT NULL AND d.player_name!=''
    GROUP BY p.id,d.player_name ORDER BY p.id,evidence_rows DESC`);
  const byPlayer = new Map();
  for (const item of evidence) {
    const list = byPlayer.get(item.id) ?? [];
    list.push(item); byPlayer.set(item.id, list);
  }
  const candidates = [];
  for (const list of byPlayer.values()) {
    const total = list.reduce((sum, item) => sum + Number(item.evidence_rows), 0);
    const best = list[0], share = total ? Number(best.evidence_rows) / total : 0;
    if (total < 4 || share < 0.8 || normalizePlayerName(best.name) === normalizePlayerName(best.player_name)) continue;
    candidates.push({ player_id: best.id, gsis_id: best.gsis_id, old_name: best.name,
      new_name: best.player_name, evidence_rows: total, evidence_share: +share.toFixed(3) });
  }
  return { dry_run: true, conflicts: candidates, count: candidates.length,
    rule: 'Quarantine only. A GSIS label conflict cannot rename or merge a master row until ESPN, Sleeper and attached references agree.' };
}
