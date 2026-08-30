/**
 * Typed, cutoff-safe news evidence for fantasy and betting.
 *
 * News prose never changes a projection directly. This layer extracts factual
 * claims with provenance and timestamps. The shared player-week engine exposes
 * those claims to both fantasy and props; the spread model receives a shadow
 * team-impact candidate that must pass ablation before gaining authority.
 */
import { db, rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { nflKickoffDate } from './date-util.js';
import { callClaude, getApiKey, parseJson } from './claude.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_news_signals (
    news_id INTEGER NOT NULL,
    player_key TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT,
    team TEXT,
    signal_type TEXT NOT NULL,
    status TEXT,
    body_part TEXT,
    unavailable_probability REAL,
    role_delta REAL,
    confidence REAL NOT NULL,
    published_at TEXT NOT NULL,
    source TEXT,
    source_url TEXT,
    evidence_span TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (news_id,player_key,signal_type)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_player ON nfl_news_signals(player_key,published_at);
  CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_team ON nfl_news_signals(team,published_at);
  CREATE TABLE IF NOT EXISTS nfl_news_extraction_attempts (
    news_id INTEGER NOT NULL,extractor_version TEXT NOT NULL,attempted_at TEXT NOT NULL,
    accepted_claims INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(news_id,extractor_version)
  );
`);

const EXTRACTOR_VERSION = 'typed-rules-2026.1';
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

const STATUS_RULES = [
  // Transaction-wire language. Distinct from an injury-driven "out": a
  // release changes the ROSTER, not just this week's availability — the
  // player may sign elsewhere within days, which "out for season" would
  // misstate. Ordered before the season-ending rule so a released player
  // whose team also mentions "injured reserve" in the same sentence
  // ("released from injured reserve") resolves to the transaction, not a
  // fresh season-ending claim.
  { re: /\b(?:waived|released|cut|terminated)\b/i, status: 'released', unavailable: 1.0, confidence: 0.95 },
  // "Torn X" for any of these body parts is a season-ending injury in NFL
  // practice regardless of which one — this was hardcoded to only "acl" and
  // "achilles" and silently missed everything else (e.g. "torn triceps"),
  // which is exactly the gap that let a season-ending starter keep showing
  // as active on a depth-chart diagram.
  { re: /(?:out for (?:the )?season|season[- ]ending|torn (?:acl|achilles|triceps|pector\w*|pec|quad(?:riceps)?|bicep|patella|meniscus)|ruptured \w+|placed on (?:injured reserve|ir))\b/i, status: 'out_for_season', unavailable: 0.995, confidence: 0.97 },
  { re: /(?:ruled out|will not play|won['’]t play|to miss|expected to miss|sidelined)\b/i, status: 'out', unavailable: 0.94, confidence: 0.9 },
  { re: /\bdoubtful\b/i, status: 'doubtful', unavailable: 0.76, confidence: 0.92 },
  { re: /\bquestionable\b/i, status: 'questionable', unavailable: 0.38, confidence: 0.86 },
  { re: /(?:did not participate|dnp|missed practice)\b/i, status: 'did_not_practice', unavailable: 0.52, confidence: 0.84 },
  { re: /(?:limited participant|limited in practice)\b/i, status: 'limited', unavailable: 0.22, confidence: 0.84 },
  { re: /(?:full participant|full practice|cleared to play|will play|good to go|['’]fine['’]|on the mend|returns? to practice)\b/i, status: 'available_positive', unavailable: 0.06, confidence: 0.78 }
];

const ROLE_RULES = [
  { re: /(?:named|will be|remains?) (?:the )?(?:starting|starter|qb1|rb1)\b/i, status: 'starter_confirmed', delta: 0.2, confidence: 0.86 },
  { re: /(?:benched|demoted|loses? (?:the )?starting job|backup role)\b/i, status: 'role_down', delta: -0.45, confidence: 0.9 },
  { re: /(?:expanded role|more touches|more targets|larger role|workload increase)\b/i, status: 'role_up', delta: 0.18, confidence: 0.72 },
  { re: /(?:snap count|limited workload|reduced role|committee)\b/i, status: 'role_limited', delta: -0.18, confidence: 0.7 }
];

const BODY_PARTS = ['ankle', 'knee', 'hamstring', 'quadriceps', 'quad', 'groin', 'shoulder',
  'concussion', 'head', 'back', 'foot', 'toe', 'achilles', 'acl', 'mcl', 'hip', 'wrist',
  'hand', 'elbow', 'rib', 'calf', 'neck'];
const AVAILABILITY_VALUES = Object.fromEntries(STATUS_RULES.map(rule => [rule.status, rule.unavailable]));
const ROLE_VALUES = Object.fromEntries(ROLE_RULES.map(rule => [rule.status, rule.delta]));

function teamForEntity(entity, fallbackTeamId) {
  const byPlayer = entity?.id == null ? null
    : rows(`SELECT t.abbr FROM players p LEFT JOIN nfl_teams t ON t.id=p.team_id WHERE p.id=?`, entity.id)[0]?.abbr;
  if (byPlayer) return byPlayer;
  return fallbackTeamId == null ? null : rows('SELECT abbr FROM nfl_teams WHERE id=?', fallbackTeamId)[0]?.abbr ?? null;
}

function candidatePlayers(item) {
  const entities = parse(item.entities_json, {});
  const unique = new Map();
  for (const entity of entities.players ?? []) {
    const key = normalizePlayerName(entity.name);
    if (!key) continue;
    const current = unique.get(key);
    if (!current || (entity.confidence ?? 0) > (current.confidence ?? 0)) unique.set(key, entity);
  }
  return [...unique.values()];
}

export function syncStructuredNewsSignals({ sinceDays = 14, limit = 1000 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const items = rows(`SELECT id,team_id,headline,body,published_at,source,source_url,
      entities_json,reliability_json FROM news_items
    WHERE published_at IS NOT NULL AND published_at>=?
    ORDER BY published_at DESC LIMIT ?`, since, limit);
  const insert = db.prepare(`INSERT INTO nfl_news_signals
    (news_id,player_key,player_id,player_name,team,signal_type,status,body_part,
     unavailable_probability,role_delta,confidence,published_at,source,source_url,evidence_span,extractor_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(news_id,player_key,signal_type) DO UPDATE SET
      status=excluded.status,body_part=excluded.body_part,
      unavailable_probability=excluded.unavailable_probability,role_delta=excluded.role_delta,
      confidence=excluded.confidence,published_at=excluded.published_at,source=excluded.source,
      source_url=excluded.source_url,evidence_span=excluded.evidence_span,
      extractor_version=excluded.extractor_version`);
  let signals = 0, skippedNoPlayer = 0, skippedNoClaim = 0;
  for (const item of items) {
    const text = `${item.headline ?? ''}. ${item.body ?? ''}`.slice(0, 1600);
    const players = candidatePlayers(item);
    if (!players.length) { skippedNoPlayer++; continue; }
    const bodyPart = BODY_PARTS.find(part => new RegExp(`\\b${part}\\b`, 'i').test(text)) ?? null;
    const reliability = parse(item.reliability_json, {});
    const reliabilityCap = Number.isFinite(reliability.score) ? clamp(reliability.score) : 0.85;
    let itemSignals = 0;
    for (const entity of players) {
      const key = normalizePlayerName(entity.name), team = teamForEntity(entity, item.team_id);
      for (const rule of STATUS_RULES) {
        const match = text.match(rule.re);
        if (!match) continue;
        insert.run(item.id, key, entity.id == null ? null : String(entity.id), entity.name, team,
          'availability', rule.status, bodyPart, rule.unavailable, null,
          Math.min(rule.confidence, reliabilityCap), item.published_at, item.source, item.source_url,
          match[0], EXTRACTOR_VERSION);
        signals++; itemSignals++; break;
      }
      for (const rule of ROLE_RULES) {
        const match = text.match(rule.re);
        if (!match) continue;
        insert.run(item.id, key, entity.id == null ? null : String(entity.id), entity.name, team,
          'role', rule.status, null, null, rule.delta,
          Math.min(rule.confidence, reliabilityCap), item.published_at, item.source, item.source_url,
          match[0], EXTRACTOR_VERSION);
        signals++; itemSignals++; break;
      }
    }
    if (!itemSignals) skippedNoClaim++;
  }
  return { reviewed: items.length, signals, skipped_no_player: skippedNoPlayer,
    skipped_no_typed_claim: skippedNoClaim, extractor_version: EXTRACTOR_VERSION };
}

export function playerNewsSignal(playerName, { team = null, before = null, maxAgeDays = 14 } = {}) {
  const key = normalizePlayerName(playerName);
  if (!key) return null;
  const cutoff = before ?? new Date().toISOString();
  const since = new Date(new Date(cutoff).getTime() - maxAgeDays * 86400000).toISOString();
  const claims = rows(`SELECT * FROM nfl_news_signals WHERE player_key=?
      AND published_at<=? AND published_at>=?
      ${team ? 'AND (team=? OR team IS NULL)' : ''}
    ORDER BY confidence DESC,published_at DESC`, ...[key, cutoff, since, ...(team ? [team] : [])]);
  if (!claims.length) return null;
  const availability = claims.find(claim => claim.signal_type === 'availability') ?? null;
  const role = claims.find(claim => claim.signal_type === 'role') ?? null;
  return {
    player: playerName, team, cutoff, availability, role, claims: claims.slice(0, 8),
    numeric_authority: 0,
    policy: 'Typed context for fantasy and props; shadow-only numeric influence until chronological ablation and forward calibration pass.'
  };
}

export function playerWeekNewsSignal(playerName, { season, week, team } = {}) {
  const game = team ? rows(`SELECT gameday,gametime FROM game_lines
    WHERE season=? AND week=? AND team=? LIMIT 1`, season, week, team)[0] : null;
  let before = new Date().toISOString();
  if (game?.gameday) {
    const time = /^\d{1,2}:\d{2}/.test(game.gametime ?? '') ? game.gametime : '23:59';
    const parsed = nflKickoffDate(game.gameday, time);
    if (parsed && parsed < new Date(before)) before = parsed.toISOString();
  }
  return playerNewsSignal(playerName, { team, before });
}

export function teamNewsSignals(team, { before = null, maxAgeDays = 14 } = {}) {
  const cutoff = before ?? new Date().toISOString();
  const since = new Date(new Date(cutoff).getTime() - maxAgeDays * 86400000).toISOString();
  const claims = rows(`SELECT * FROM nfl_news_signals WHERE team=? AND published_at<=? AND published_at>=?
    ORDER BY confidence DESC,published_at DESC`, team, cutoff, since);
  const latestByPlayerType = new Map();
  for (const claim of claims) {
    const key = `${claim.player_key}|${claim.signal_type}`;
    if (!latestByPlayerType.has(key)) latestByPlayerType.set(key, claim);
  }
  const active = [...latestByPlayerType.values()];
  const unavailableBurden = active.filter(x => x.signal_type === 'availability')
    .reduce((sum, claim) => sum + (claim.unavailable_probability ?? 0) * claim.confidence, 0);
  const rolePressure = active.filter(x => x.signal_type === 'role')
    .reduce((sum, claim) => sum + (claim.role_delta ?? 0) * claim.confidence, 0);
  return { team, cutoff, claims: active, unavailable_burden: +unavailableBurden.toFixed(3),
    role_pressure: +rolePressure.toFixed(3), production_eligible: false,
    note: 'News impact is a visible shadow candidate. It cannot move a spread or projection until full-pipeline ablation and forward evidence pass.' };
}

export function newsSignalCoverage() {
  const summary = rows(`SELECT COUNT(*) signals,COUNT(DISTINCT news_id) stories,
      COUNT(DISTINCT player_key) players,MAX(published_at) latest,
      SUM(signal_type='availability') availability,SUM(signal_type='role') role
    FROM nfl_news_signals`)[0];
  const untyped = rows(`SELECT COUNT(*) n FROM news_items
    WHERE published_at>=datetime('now','-14 days')
      AND (headline LIKE '%injur%' OR headline LIKE '%out %' OR headline LIKE '%practice%')
      AND id NOT IN (SELECT news_id FROM nfl_news_signals)`)[0]?.n ?? 0;
  return { ...summary, recent_material_untyped: untyped, extractor_version: EXTRACTOR_VERSION };
}

/**
 * LLM extraction for material stories the deterministic rules could not type.
 * The model chooses from fixed enums and known identities. Every claim is
 * rejected unless its evidence span occurs verbatim in the supplied story.
 */
export async function syncAiNewsSignals({ sinceDays = 7, limit = 20 } = {}) {
  if (!getApiKey()) return { skipped: true, reason: 'no Anthropic key configured' };
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const candidates = rows(`SELECT id,team_id,headline,body,published_at,source,source_url,
      entities_json,reliability_json FROM news_items
    WHERE published_at>=? AND id NOT IN (SELECT news_id FROM nfl_news_signals)
      AND id NOT IN (SELECT news_id FROM nfl_news_extraction_attempts WHERE extractor_version='claude-typed-news-2026.1')
      AND (headline LIKE '%injur%' OR headline LIKE '%out %' OR headline LIKE '%practice%'
        OR headline LIKE '%starter%' OR headline LIKE '%benched%' OR headline LIKE '%role%')
    ORDER BY published_at DESC LIMIT ?`, since, limit)
    .map(item => ({ ...item, players: candidatePlayers(item).map(player => player.name) }))
    .filter(item => item.players.length);
  if (!candidates.length) return { reviewed: 0, accepted: 0, rejected: 0, note: 'no untyped material stories with resolved player entities' };
  const promptStories = candidates.map(item => ({ news_id: item.id, players: item.players,
    text: `${item.headline}. ${item.body ?? ''}`.slice(0, 1600) }));
  const response = await callClaude({ feature: 'nfl-news-typed-extraction', maxTokens: 2200,
    prompt: `Extract factual NFL availability and role claims. This is data extraction, not advice.

Return ONLY a JSON array. Each object must have:
- news_id: one supplied integer
- player_name: exactly one player name listed for that story
- signal_type: "availability" or "role"
- status: availability must be one of ${JSON.stringify(Object.keys(AVAILABILITY_VALUES))}; role must be one of ${JSON.stringify(Object.keys(ROLE_VALUES))}
- body_part: explicit body part from text or null
- confidence: 0 to 1
- evidence_span: an exact verbatim substring from that story proving the status

Do not infer a claim that is not explicit. Do not create players. Do not output a projection, probability, point impact, edge, pick, or stake. Return [] when the text is ambiguous.

STORIES:
${JSON.stringify(promptStories)}` });
  const claims = parseJson(response);
  if (!Array.isArray(claims)) return { reviewed: candidates.length, accepted: 0, rejected: 1, error: 'extractor did not return an array' };
  const byId = new Map(candidates.map(item => [Number(item.id), item]));
  const insert = db.prepare(`INSERT INTO nfl_news_signals
    (news_id,player_key,player_id,player_name,team,signal_type,status,body_part,
     unavailable_probability,role_delta,confidence,published_at,source,source_url,evidence_span,extractor_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(news_id,player_key,signal_type) DO UPDATE SET status=excluded.status,
      body_part=excluded.body_part,unavailable_probability=excluded.unavailable_probability,
      role_delta=excluded.role_delta,confidence=excluded.confidence,evidence_span=excluded.evidence_span,
      extractor_version=excluded.extractor_version`);
  let accepted = 0, rejected = 0;
  const acceptedByNews = new Map();
  for (const claim of claims) {
    const item = byId.get(Number(claim.news_id));
    const signalType = claim.signal_type;
    const values = signalType === 'availability' ? AVAILABILITY_VALUES : signalType === 'role' ? ROLE_VALUES : null;
    const canonicalName = item?.players.find(name => normalizePlayerName(name) === normalizePlayerName(claim.player_name));
    const text = item ? `${item.headline}. ${item.body ?? ''}`.slice(0, 1600) : '';
    const span = String(claim.evidence_span ?? '');
    if (!item || !values || !Object.hasOwn(values, claim.status) || !canonicalName || !span || !text.includes(span)) {
      rejected++; continue;
    }
    const entity = candidatePlayers(item).find(player => normalizePlayerName(player.name) === normalizePlayerName(canonicalName));
    const team = teamForEntity(entity, item.team_id);
    const reliability = parse(item.reliability_json, {});
    const cap = Number.isFinite(reliability.score) ? clamp(reliability.score) : 0.8;
    insert.run(item.id, normalizePlayerName(canonicalName), entity?.id == null ? null : String(entity.id),
      canonicalName, team, signalType, claim.status,
      claim.body_part && BODY_PARTS.includes(String(claim.body_part).toLowerCase()) ? String(claim.body_part).toLowerCase() : null,
      signalType === 'availability' ? values[claim.status] : null,
      signalType === 'role' ? values[claim.status] : null,
      Math.min(clamp(Number(claim.confidence) || 0), cap), item.published_at, item.source,
      item.source_url, span, 'claude-typed-news-2026.1');
    accepted++; acceptedByNews.set(item.id, (acceptedByNews.get(item.id) ?? 0) + 1);
  }
  const attempt = db.prepare(`INSERT OR REPLACE INTO nfl_news_extraction_attempts
    (news_id,extractor_version,attempted_at,accepted_claims) VALUES (?,?,?,?)`);
  for (const item of candidates) attempt.run(item.id, 'claude-typed-news-2026.1',
    new Date().toISOString(), acceptedByNews.get(item.id) ?? 0);
  return { reviewed: candidates.length, proposed: claims.length, accepted, rejected,
    policy: 'Known identities + fixed enums + exact evidence span. Numeric values are mapped after extraction.' };
}
