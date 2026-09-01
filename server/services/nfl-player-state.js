/**
 * Dated NFL player-state ledger.
 *
 * A current roster is not historical evidence. This module records immutable
 * roster snapshots and verified transaction events so every downstream model
 * can ask the same question: "what did we know about this player at cutoff?"
 * It never rewrites `players` and never guesses through an ambiguous identity.
 */
import { db, rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_roster_snapshots (
    captured_at TEXT NOT NULL,
    player_id INTEGER,
    espn_id INTEGER,
    gsis_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT,
    team TEXT NOT NULL,
    status TEXT,
    depth_slot TEXT,
    depth_order INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (captured_at,team,player_name)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_roster_snapshot_cutoff
    ON nfl_roster_snapshots(captured_at,team);
  CREATE TABLE IF NOT EXISTS nfl_player_roster_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    espn_id INTEGER,
    gsis_id TEXT,
    player_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    from_team TEXT,
    to_team TEXT,
    roster_status TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    news_id INTEGER,
    source TEXT NOT NULL,
    source_url TEXT,
    confidence REAL NOT NULL,
    verification_state TEXT NOT NULL,
    evidence TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_roster_event_cutoff
    ON nfl_player_roster_events(effective_at,player_id);
  CREATE TABLE IF NOT EXISTS nfl_player_state_quarantine (
    news_id INTEGER PRIMARY KEY,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const eventColumns = new Set(db.prepare('PRAGMA table_info(nfl_player_roster_events)').all().map(column => column.name));
if (!eventColumns.has('event_key')) {
  db.exec(`ALTER TABLE nfl_player_roster_events ADD COLUMN event_key TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_roster_event_key ON nfl_player_roster_events(event_key)`);
}

const parseJson = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

/** Parse the team-facing meaning of one official transaction sentence. */
export function classifyRosterMove(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/\b(?:acquired|traded for)\b/i.test(value)) return { event_type: 'traded', roster_status: 'active', direction: 'to' };
  if (/\bclaimed\b.*\bwaivers?\b/i.test(value)) return { event_type: 'claimed', roster_status: 'active', direction: 'to' };
  if (/\b(?:signed|re-signed|re-signed)\b/i.test(value)) {
    return /practice squad/i.test(value)
      ? { event_type: 'practice_squad_signed', roster_status: 'practice_squad', direction: 'to' }
      : { event_type: 'signed', roster_status: 'active', direction: 'to' };
  }
  if (/\b(?:waived|released|cut|terminated)\b/i.test(value)) {
    return { event_type: /waived/i.test(value) ? 'waived' : 'released', roster_status: 'free_agent', direction: 'from' };
  }
  if (/\b(?:placed|transferred)\b.*\b(?:injured reserve|\bIR\b|reserve\/non-football)/i.test(value)) {
    return { event_type: 'reserve', roster_status: 'reserve', direction: 'same' };
  }
  if (/\b(?:activated|reinstated|designated for return)\b/i.test(value)) {
    return { event_type: 'activated', roster_status: 'active', direction: 'same' };
  }
  return null;
}

function stableEntity(item) {
  const entities = parseJson(item.entities_json, {}).players ?? [];
  if (entities.length !== 1 || entities[0].id == null || Number(entities[0].confidence ?? 0) < 0.95) return null;
  const entity = entities[0];
  const player = rows(`SELECT id,name,espn_id,gsis_id FROM players WHERE id=? LIMIT 1`, entity.id)[0];
  if (!player || normalizePlayerName(player.name) !== normalizePlayerName(entity.name)) return null;
  return player;
}

/** Materialize only deterministic, official-wire transaction claims. */
export function syncRosterEventsFromNews({ before = null, limit = 5000 } = {}) {
  const items = rows(`SELECT n.id,n.headline,n.published_at,n.entities_json,n.source,n.source_url,
      n.reliability_json,t.abbr team
    FROM news_items n LEFT JOIN nfl_teams t ON t.id=n.team_id
    WHERE n.source='ESPN Transactions' AND n.published_at IS NOT NULL
      ${before ? 'AND n.published_at<=?' : ''}
    ORDER BY n.published_at,n.id LIMIT ?`, ...[...(before ? [before] : []), limit]);
  const insert = db.prepare(`INSERT INTO nfl_player_roster_events
    (player_id,espn_id,gsis_id,player_name,event_type,from_team,to_team,roster_status,
     effective_at,news_id,source,source_url,confidence,verification_state,evidence,event_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key) DO UPDATE SET
      from_team=excluded.from_team,to_team=excluded.to_team,roster_status=excluded.roster_status,
      effective_at=excluded.effective_at,confidence=excluded.confidence,evidence=excluded.evidence`);
  const quarantine = db.prepare(`INSERT INTO nfl_player_state_quarantine(news_id,reason,evidence)
    VALUES (?,?,?) ON CONFLICT(news_id) DO UPDATE SET reason=excluded.reason,evidence=excluded.evidence`);
  let stored = 0, ignored = 0, quarantined = 0;
  for (const item of items) {
    const move = classifyRosterMove(item.headline);
    if (!move) { ignored++; continue; }
    const reliability = parseJson(item.reliability_json, {});
    const player = stableEntity(item);
    if (!item.team || reliability.tier !== 'official_wire' || !player) {
      quarantine.run(item.id, !item.team ? 'missing transaction team'
        : reliability.tier !== 'official_wire' ? 'source is not official wire'
          : 'transaction does not resolve to exactly one stable player identity', item.headline);
      quarantined++; continue;
    }
    let direction = move.direction;
    if (move.event_type === 'traded') {
      const playerIndex = normalizePlayerName(item.headline).indexOf(normalizePlayerName(player.name));
      const exchangeIndex = normalizePlayerName(item.headline).search(/\b(?:for|in exchange for)\b/);
      // On the team's mirrored wire, “acquired a pick ... for PLAYER” means
      // PLAYER left that team. The same player appears in both trade stories.
      if (playerIndex >= 0 && exchangeIndex >= 0 && exchangeIndex < playerIndex) direction = 'from';
    }
    let fromTeam = direction === 'from' ? item.team : null;
    let toTeam = direction === 'to' ? item.team : direction === 'same' ? item.team : null;
    // A paired trade wire often names the origin. Use it only when unambiguous.
    const named = rows(`SELECT t.abbr FROM nfl_teams t WHERE instr(lower(?),lower(t.name))>0`, item.headline);
    if (move.event_type === 'traded' && named.length === 1 && named[0].abbr !== item.team) {
      if (direction === 'from') toTeam = named[0].abbr;
      else fromTeam = named[0].abbr;
    }
    const eventKey = [item.id, player.id, move.event_type].join('|');
    const result = insert.run(player.id, player.espn_id, player.gsis_id, player.name,
      move.event_type, fromTeam, toTeam, move.roster_status, item.published_at,
      item.id, item.source, item.source_url, Math.min(0.99, Number(reliability.score) || 0.95),
      'verified', item.headline, eventKey);
    stored += result.changes;
  }
  return { reviewed: items.length, stored, ignored, quarantined };
}

/** Persist the current full roster as a dated baseline without mutating history. */
export function captureCurrentRosterSnapshot({ capturedAt = null, source = 'espn_roster' } = {}) {
  // The rows may be an older cached roster. Label the snapshot with when ESPN
  // was actually fetched, never with the time this function happened to run.
  capturedAt ??= rows(`SELECT MAX(fetched_at) captured_at FROM roster_players`)[0]?.captured_at;
  if (!capturedAt) return { captured_at: null, players: 0, limitation: 'roster rows have no source timestamp' };
  const current = rows(`SELECT p.id player_id,rp.espn_id,p.gsis_id,rp.name player_name,rp.position,
      t.abbr team,rp.status,rp.depth_slot,rp.depth_order
    FROM roster_players rp JOIN nfl_teams t ON t.id=rp.team_id
    LEFT JOIN players p ON p.espn_id=rp.espn_id`);
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_roster_snapshots
    (captured_at,player_id,espn_id,gsis_id,player_name,position,team,status,depth_slot,depth_order,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let stored = 0;
  db.exec('BEGIN');
  try {
    for (const player of current) stored += insert.run(capturedAt, player.player_id, player.espn_id,
      player.gsis_id, player.player_name, player.position, player.team, player.status,
      player.depth_slot, player.depth_order, source).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { captured_at: capturedAt, players: stored };
}

/** Latest known team/status at a cutoff. Snapshot is the baseline; later events win. */
export function rosterStateAt(cutoff = new Date().toISOString()) {
  const capture = rows(`SELECT MAX(captured_at) captured_at FROM nfl_roster_snapshots WHERE captured_at<=?`, cutoff)[0]?.captured_at;
  const state = new Map();
  if (capture) for (const player of rows(`SELECT * FROM nfl_roster_snapshots WHERE captured_at=?`, capture)) {
    const key = player.player_id == null ? `name:${normalizePlayerName(player.player_name)}` : String(player.player_id);
    state.set(key, { ...player, effective_at: capture, evidence_kind: 'roster_snapshot' });
  }
  const after = capture ?? '0000-01-01T00:00:00Z';
  for (const event of rows(`SELECT * FROM nfl_player_roster_events
      WHERE effective_at>? AND effective_at<=? AND verification_state='verified'
      ORDER BY effective_at,id`, after, cutoff)) {
    const key = event.player_id == null ? `name:${normalizePlayerName(event.player_name)}` : String(event.player_id);
    const prior = state.get(key) ?? {};
    state.set(key, { ...prior, ...event,
      team: event.to_team ?? (event.roster_status === 'free_agent' ? null : event.from_team ?? prior.team ?? null),
      evidence_kind: 'roster_event' });
  }
  return { cutoff, baseline_captured_at: capture ?? null, players: state };
}

export function playerStateCoverage(cutoff = new Date().toISOString()) {
  const state = rosterStateAt(cutoff);
  const eventCount = rows(`SELECT COUNT(*) n FROM nfl_player_roster_events WHERE effective_at<=?`, cutoff)[0]?.n ?? 0;
  const quarantine = rows(`SELECT COUNT(*) n FROM nfl_player_state_quarantine`)[0]?.n ?? 0;
  return { cutoff, baseline_captured_at: state.baseline_captured_at, players: state.players.size,
    events: Number(eventCount), quarantined: Number(quarantine),
    cutoff_safe: Boolean(state.baseline_captured_at),
    limitation: state.baseline_captured_at ? null : 'No roster snapshot exists at or before this cutoff.' };
}
