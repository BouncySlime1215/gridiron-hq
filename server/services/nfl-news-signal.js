/**
 * Typed, cutoff-safe news evidence for fantasy and betting.
 *
 * News prose never changes a projection directly. This layer extracts factual
 * claims with provenance and timestamps. The shared player-week engine exposes
 * those claims to both fantasy and props; the spread model receives a shadow
 * team-impact candidate that must pass ablation before gaining authority.
 */
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { nflKickoffDate } from './date-util.js';
import { callClaude, getApiKey, parseJson } from './claude.js';

const EXTRACTOR_VERSION = 'typed-rules-2026.1';
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const TRUSTED_PUBLISHER_DOMAINS = Object.freeze([
  'espn.com', 'nfl.com', 'apnews.com', 'reuters.com', 'theathletic.com'
]);

function sourceHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
}

function socialHandle(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(x|twitter)\.com$/i.test(parsed.hostname)) return null;
    return parsed.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') ?? null;
  } catch { return null; }
}

/** Source identity is evaluated separately from claim extraction. A plausible
 * sentence from an untrusted URL stays visible in quarantine but cannot reach
 * any model feature. */
export function newsSourceVerification(item) {
  const host = sourceHost(item?.source_url);
  if (!host) return { state: 'quarantined', reason: 'missing or invalid source URL' };
  if (TRUSTED_PUBLISHER_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    return { state: 'verified', reason: `allowlisted primary publisher domain: ${host}` };
  }
  const handle = socialHandle(item.source_url);
  if (handle) {
    const registryReady = rows(`SELECT 1 ok FROM sqlite_master
      WHERE type='table' AND name='news_source_validation' LIMIT 1`).length > 0;
    if (!registryReady) return { state: 'quarantined', reason: 'social source registry has not been initialized' };
    const checkedAfter = new Date(Date.now() - 30 * 86400000).toISOString();
    const source = rows(`SELECT verdict,checked_at FROM news_source_validation
      WHERE lower(handle)=lower(?) AND checked_at>=? LIMIT 1`, handle, checkedAfter)[0];
    return source?.verdict === 'valid'
      ? { state: 'verified', reason: `live-validated social source @${handle}` }
      : { state: 'quarantined', reason: `social source @${handle} lacks a fresh valid identity check` };
  }
  return { state: 'quarantined', reason: `domain ${host} is not in the verified source registry` };
}

// Exported so other typed-evidence modules (nfl-news-events.js's contradiction
// detector) can classify a claim's polarity with the exact same vocabulary
// this module already uses, instead of maintaining a second copy of the rules.
export const STATUS_RULES = [
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

export const ROLE_RULES = [
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

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A period after "Jr"/"Sr"/a roman numeral/a single initial is part of a
// NAME, not a sentence end -- naively splitting there tears a player's own
// name in half (real example: "Michael Penix Jr. shined in his return to
// full practice" split right after "Jr." into "...Michael Penix Jr." /
// "shined in...", which then matched the story's OTHER player instead,
// because the actual status clause no longer contained Penix's name).
const SENTENCE_ABBREVIATIONS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'mr', 'mrs', 'ms', 'dr', 'st', 'vs']);
/**
 * Sentence/line boundaries, plus a bare " - " separator (common in terse
 * feed headlines joining two unrelated claims, e.g. "Player A returns to
 * practice - Player B: quote") -- still no NLP dependency, just a second
 * hand-written boundary alongside the punctuation one, matching this file's
 * existing regex-only style. A period is skipped as a boundary when the word
 * immediately before it is a known name abbreviation or a single initial.
 */
function splitIntoClauses(text) {
  const str = String(text ?? '');
  const clauses = [];
  let start = 0;
  const boundaryRe = /([.!?])\s+|\r?\n+| - /g;
  let match;
  while ((match = boundaryRe.exec(str))) {
    if (match[1] === '.') {
      const word = /([A-Za-z]+)\.?$/.exec(str.slice(0, match.index))?.[1]?.toLowerCase() ?? '';
      if (word.length <= 1 || SENTENCE_ABBREVIATIONS.has(word)) continue;
    }
    clauses.push(str.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  clauses.push(str.slice(start));
  return clauses.map(s => s.trim()).filter(Boolean);
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function lastNameOf(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts.at(-1).toLowerCase().replace(/\.$/, ''))) parts.pop();
  return parts.at(-1) ?? fullName;
}

/**
 * A story naming several players does not mean every one of them shares the
 * story's first-matching status: a single injury report can say one player
 * is a full participant in the same paragraph that says another remains
 * limited, and the old code matched every rule against the WHOLE story text
 * for every entity, so whichever status/body-part happened to appear
 * anywhere in the text landed on ALL of them (confirmed against real synced
 * signals: e.g. news_id 88956/88968, where a Ravens report differentiating
 * Zay Flowers from Devontez Walker still stored the identical status AND
 * the identical body_part -- Teddye Buchanan's "knee" -- for both players).
 *
 * Each player's rule matching is restricted here to the clause(s) that
 * actually name them: their full name, or their last name when it is
 * unique among this story's OTHER candidate players (common in injury-
 * report shorthand, "Panthers RB Brooks..."). A clause naming several
 * players together ("Released A, B and C") still resolves to that same
 * clause for each of them -- a genuinely joint claim, not a bug -- while
 * clauses about different players stop bleeding into each other. A
 * single-player story is returned unchanged: its whole text was already
 * "local" to that one player, so behavior there is identical to before.
 */
function localTextForPlayer(text, entity, allEntities) {
  if (allEntities.length <= 1) return text;
  const last = lastNameOf(entity.name);
  const lastIsUnique = allEntities.filter(other => lastNameOf(other.name).toLowerCase() === last.toLowerCase()).length === 1;
  const nameRe = new RegExp(`\\b${escapeRegExp(entity.name)}\\b`, 'i');
  const lastRe = lastIsUnique ? new RegExp(`\\b${escapeRegExp(last)}\\b`, 'i') : null;
  const clauses = splitIntoClauses(text).filter(clause => nameRe.test(clause) || (lastRe && lastRe.test(clause)));
  return clauses.length ? clauses.join(' ') : text;
}

// WP08/R1: nfl_news_signals is append-only (migration 053) -- a re-sync or
// re-extraction of the same story no longer overwrites the existing row, it
// INSERTS A NEW VERSION. `upsertVersionedSignal` reads the one row
// `nfl_news_signals_current` (that migration's view) already resolves as
// "the latest version" for this exact key, and `_contentEqual` decides
// whether the new claim actually differs from it. Only a genuine content
// change gets a new row -- an identical re-run (the common case: most
// stories are re-synced every pass and have not changed) is a no-op, per
// this WP's own acceptance ("repeating the same fetch does not duplicate
// versions"). Uses `rows`/`run` (not a module-scope db.prepare) deliberately:
// a prepared statement built at import time would run before some callers'
// test setup has applied migrations yet, throwing "no such table" for a
// table that is about to exist a moment later.
const _CONTENT_FIELDS = ['status', 'body_part', 'unavailable_probability', 'role_delta', 'confidence',
  'published_at', 'source', 'source_url', 'evidence_span', 'extractor_version',
  'verification_state', 'verification_reason'];
function _contentEqual(existing, next) {
  return _CONTENT_FIELDS.every(field => (existing[field] ?? null) === (next[field] ?? null));
}
/** Inserts a new version only if it genuinely differs from the current one. Returns whether it inserted. */
function upsertVersionedSignal(next) {
  const existing = rows(`SELECT * FROM nfl_news_signals_current WHERE news_id=? AND player_key=? AND signal_type=?`,
    next.news_id, next.player_key, next.signal_type)[0];
  if (existing && _contentEqual(existing, next)) return false;
  run(`INSERT INTO nfl_news_signals
    (news_id,player_key,player_id,player_name,team,signal_type,status,body_part,
     unavailable_probability,role_delta,confidence,published_at,source,source_url,evidence_span,extractor_version,
     verification_state,verification_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    next.news_id, next.player_key, next.player_id, next.player_name, next.team,
    next.signal_type, next.status, next.body_part, next.unavailable_probability, next.role_delta,
    next.confidence, next.published_at, next.source, next.source_url, next.evidence_span,
    next.extractor_version, next.verification_state, next.verification_reason);
  return true;
}

export function syncStructuredNewsSignals({ sinceDays = 14, limit = 1000 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const items = rows(`SELECT id,team_id,headline,body,published_at,source,source_url,source_type,
      entities_json,reliability_json FROM news_items
    WHERE published_at IS NOT NULL AND published_at>=?
    ORDER BY published_at DESC LIMIT ?`, since, limit);
  let signals = 0, newVersions = 0, skippedNoPlayer = 0, skippedNoClaim = 0;
  for (const item of items) {
    const text = `${item.headline ?? ''}. ${item.body ?? ''}`.slice(0, 1600);
    const players = candidatePlayers(item);
    if (!players.length) { skippedNoPlayer++; continue; }
    const reliability = parse(item.reliability_json, {});
    const reliabilityCap = Number.isFinite(reliability.score) ? clamp(reliability.score) : 0.85;
    const verification = newsSourceVerification(item);
    let itemSignals = 0;
    for (const entity of players) {
      const key = normalizePlayerName(entity.name), team = teamForEntity(entity, item.team_id);
      const localText = localTextForPlayer(text, entity, players);
      const bodyPart = BODY_PARTS.find(part => new RegExp(`\\b${part}\\b`, 'i').test(localText)) ?? null;
      for (const rule of STATUS_RULES) {
        const match = localText.match(rule.re);
        if (!match) continue;
        if (upsertVersionedSignal({ news_id: item.id, player_key: key,
          player_id: entity.id == null ? null : String(entity.id), player_name: entity.name, team,
          signal_type: 'availability', status: rule.status, body_part: bodyPart,
          unavailable_probability: rule.unavailable, role_delta: null,
          confidence: Math.min(rule.confidence, reliabilityCap), published_at: item.published_at,
          source: item.source, source_url: item.source_url, evidence_span: match[0],
          extractor_version: EXTRACTOR_VERSION, verification_state: verification.state,
          verification_reason: verification.reason })) newVersions++;
        signals++; itemSignals++; break;
      }
      for (const rule of ROLE_RULES) {
        const match = localText.match(rule.re);
        if (!match) continue;
        if (upsertVersionedSignal({ news_id: item.id, player_key: key,
          player_id: entity.id == null ? null : String(entity.id), player_name: entity.name, team,
          signal_type: 'role', status: rule.status, body_part: null,
          unavailable_probability: null, role_delta: rule.delta,
          confidence: Math.min(rule.confidence, reliabilityCap), published_at: item.published_at,
          source: item.source, source_url: item.source_url, evidence_span: match[0],
          extractor_version: EXTRACTOR_VERSION, verification_state: verification.state,
          verification_reason: verification.reason })) newVersions++;
        signals++; itemSignals++; break;
      }
    }
    if (!itemSignals) skippedNoClaim++;
  }
  const quarantine = rows(`SELECT COUNT(*) n FROM nfl_news_signals_current WHERE verification_state='quarantined'`)[0]?.n ?? 0;
  return { reviewed: items.length, signals, new_versions: newVersions, quarantined: Number(quarantine),
    skipped_no_player: skippedNoPlayer, skipped_no_typed_claim: skippedNoClaim, extractor_version: EXTRACTOR_VERSION };
}

export function playerNewsSignal(playerName, { team = null, before = null, maxAgeDays = 14 } = {}) {
  const key = normalizePlayerName(playerName);
  if (!key) return null;
  const cutoff = before ?? new Date().toISOString();
  const since = new Date(new Date(cutoff).getTime() - maxAgeDays * 86400000).toISOString();
  // published_at<=cutoff alone is not enough: a claim can be published before
  // the cutoff but not actually extracted into this table (created_at, the
  // pipeline's own receipt timestamp -- see the CREATE TABLE default) until
  // after it. Requiring created_at<=cutoff too is what makes this genuinely
  // "knowable as of cutoff" rather than knowable only in hindsight -- the
  // same class of look-ahead risk as news_items.ingested_at, one layer over.
  //
  // R2 (2026-09-15): `created_at` is written by this table's own `DEFAULT
  // (datetime('now'))` -- SQLite's space-separated 'YYYY-MM-DD HH:MM:SS', no
  // 'T', no 'Z' -- while `cutoff`/`before` arrive as JS ISO strings
  // ('YYYY-MM-DDTHH:MM:SS.sssZ'). A bare `created_at<=?` compares those as
  // plain TEXT, and ' ' (0x20) sorts before 'T' (0x54): for any two same-DATE
  // timestamps this made created_at<=cutoff evaluate true regardless of the
  // actual time of day -- confirmed empirically (node:sqlite): a row whose
  // created_at was the current instant still compared <= a cutoff from an
  // hour earlier. That silently defeated the one check this line exists for.
  // Wrapping both sides in SQLite's own `datetime()` normalizes both formats
  // to the same canonical form before comparing (the same fix already used
  // for `draft_at` in draft-ingest.js) -- no data migration needed, since the
  // stored values were never wrong, only compared incorrectly.
  // WP08/R1: nfl_news_signals is append-only (migration 053) -- several
  // versions can now share (news_id,player_key,signal_type). The NOT EXISTS
  // clause keeps only the LATEST version of each key that was itself
  // knowable by the cutoff (a later version created after the cutoff, or a
  // later version whose own verification_state disqualifies it, does not
  // count -- see this file's note on upsertVersionedSignal/the migration for
  // why "the latest verified-as-of-cutoff version" is deliberately not the
  // same question as "the latest version, verified or not").
  const claims = rows(`SELECT s.* FROM nfl_news_signals s WHERE s.player_key=? AND s.verification_state='verified'
      AND s.published_at<=? AND s.published_at>=?
      AND datetime(s.created_at)<=datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM nfl_news_signals s2
        WHERE s2.news_id=s.news_id AND s2.player_key=s.player_key AND s2.signal_type=s.signal_type
          AND s2.id>s.id AND datetime(s2.created_at)<=datetime(?)
      )
      ${team ? 'AND (s.team=? OR s.team IS NULL)' : ''}
    ORDER BY s.published_at DESC,s.confidence DESC`,
    ...[key, cutoff, since, cutoff, cutoff, ...(team ? [team] : [])]);
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
  // Same knowable-by-cutoff requirement as playerNewsSignal above: a claim
  // published before the cutoff but extracted (created_at) after it was not
  // actually available to a decision made at that cutoff. Same R2
  // datetime()-normalization fix, for the same reason -- see that function.
  // Same WP08/R1 latest-version-as-of-cutoff filter too (this is one dedup
  // dimension: several VERSIONS of the same story's claim; the
  // latestByPlayerType map below is a SEPARATE dimension, collapsing across
  // DIFFERENT stories for the same player -- both are needed, in this order).
  const claims = rows(`SELECT s.* FROM nfl_news_signals s WHERE s.team=? AND s.verification_state='verified'
      AND s.published_at<=? AND s.published_at>=?
      AND datetime(s.created_at)<=datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM nfl_news_signals s2
        WHERE s2.news_id=s.news_id AND s2.player_key=s.player_key AND s2.signal_type=s.signal_type
          AND s2.id>s.id AND datetime(s2.created_at)<=datetime(?)
      )
    ORDER BY s.published_at DESC,s.confidence DESC`, team, cutoff, since, cutoff, cutoff);
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
  const quarantined = rows(`SELECT COUNT(*) n FROM nfl_news_signals s WHERE s.team=? AND s.verification_state='quarantined'
    AND s.published_at<=? AND s.published_at>=? AND datetime(s.created_at)<=datetime(?)
    AND NOT EXISTS (
      SELECT 1 FROM nfl_news_signals s2
      WHERE s2.news_id=s.news_id AND s2.player_key=s.player_key AND s2.signal_type=s.signal_type
        AND s2.id>s.id AND datetime(s2.created_at)<=datetime(?)
    )`, team, cutoff, since, cutoff, cutoff)[0]?.n ?? 0;
  return { team, cutoff, claims: active, quarantined_claims: Number(quarantined), unavailable_burden: +unavailableBurden.toFixed(3),
    role_pressure: +rolePressure.toFixed(3), production_eligible: false,
    note: 'News impact is a visible shadow candidate. It cannot move a spread or projection until full-pipeline ablation and forward evidence pass.' };
}

export function newsSignalCoverage() {
  // WP08/R1: the CURRENT-version view, not the raw append-only table --
  // counting raw rows here would count every superseded version as if it
  // were its own signal.
  const summary = rows(`SELECT COUNT(*) signals,COUNT(DISTINCT news_id) stories,
      COUNT(DISTINCT player_key) players,MAX(published_at) latest,
      SUM(signal_type='availability') availability,SUM(signal_type='role') role,
      SUM(verification_state='verified') verified,SUM(verification_state='quarantined') quarantined
    FROM nfl_news_signals_current`)[0];
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
  const candidates = rows(`SELECT id,team_id,headline,body,published_at,source,source_url,source_type,
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
  let accepted = 0, rejected = 0, newVersions = 0;
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
    const verification = newsSourceVerification(item);
    if (upsertVersionedSignal({ news_id: item.id, player_key: normalizePlayerName(canonicalName),
      player_id: entity?.id == null ? null : String(entity.id), player_name: canonicalName, team,
      signal_type: signalType, status: claim.status,
      body_part: claim.body_part && BODY_PARTS.includes(String(claim.body_part).toLowerCase())
        ? String(claim.body_part).toLowerCase() : null,
      unavailable_probability: signalType === 'availability' ? values[claim.status] : null,
      role_delta: signalType === 'role' ? values[claim.status] : null,
      confidence: Math.min(clamp(Number(claim.confidence) || 0), cap), published_at: item.published_at,
      source: item.source, source_url: item.source_url, evidence_span: span,
      extractor_version: 'claude-typed-news-2026.1', verification_state: verification.state,
      verification_reason: verification.reason })) newVersions++;
    accepted++; acceptedByNews.set(item.id, (acceptedByNews.get(item.id) ?? 0) + 1);
  }
  const attempt = db.prepare(`INSERT OR REPLACE INTO nfl_news_extraction_attempts
    (news_id,extractor_version,attempted_at,accepted_claims) VALUES (?,?,?,?)`);
  for (const item of candidates) attempt.run(item.id, 'claude-typed-news-2026.1',
    new Date().toISOString(), acceptedByNews.get(item.id) ?? 0);
  return { reviewed: candidates.length, proposed: claims.length, accepted, rejected, new_versions: newVersions,
    policy: 'Known identities + fixed enums + exact evidence span + independently verified source. Quarantined claims have zero model authority.' };
}
