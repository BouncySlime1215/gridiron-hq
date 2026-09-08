/**
 * The Decision Inbox — CODEX_SUGGESTIONS.md's global recommendation #1
 * ("Build a universal Decision Inbox", P1 design project). One table any
 * engine, fantasy or betting, can publish a normalized recommendation into,
 * so the Dashboard can be a ranked queue instead of a directory of links.
 * See server/migrations/020_decision_recommendations.js for the schema and
 * why it does not replace trades.js's existing ephemeral `/:leagueId/inbox`
 * or the betting side's own forward-ledger/pick lifecycle.
 *
 * `publishRecommendation` is the "publish" side any engine calls — exported
 * here (alongside the router, same pattern as `vorBoard` in routes/edge.js
 * or `analyzeLeague` in routes/tradelab.js, both already imported back into
 * services) so a service module can call it as a plain function without
 * going through HTTP. Currently wired from:
 *   - server/services/trade-engine.js's lineupDiff() — a start/sit gap.
 *   - server/services/waiver-brain.js's waiverUpgrades() — a waiver upgrade.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { rows, row, run } from '../db/index.js';

const r = Router();

const VALID_URGENCY = new Set(['high', 'medium', 'low']);
const VALID_SPORT = new Set(['NFL', 'MLB']);

function toRecommendation(rec) {
  return {
    id: rec.id,
    leagueId: rec.league_id,
    sport: rec.sport,
    type: rec.type,
    subjectIds: rec.subject_ids ? JSON.parse(rec.subject_ids) : [],
    title: rec.title,
    rationale: rec.rationale,
    expectedValue: rec.expected_value,
    confidence: rec.confidence,
    urgency: rec.urgency,
    expiresAt: rec.expires_at,
    status: rec.status,
    sourceModel: rec.source_model,
    sourceVersion: rec.source_version,
    link: rec.link,
    createdAt: rec.created_at,
    resolvedAt: rec.resolved_at,
    outcome: rec.outcome
  };
}

/**
 * Lazily expires anything past its `expires_at` that is still `open`. Called
 * before every read so "open" never returns something the user can no longer
 * act on, without needing a background sweep job for a personal single-user
 * app that is not always running.
 */
function expireStale() {
  // expires_at is stored exactly as the publisher sends it — usually a JS
  // `.toISOString()` value ('...T...Z', milliseconds) — while `datetime('now')`
  // renders SQLite's own 'YYYY-MM-DD HH:MM:SS' format. Comparing those two
  // TEXT representations directly with <= is a lexicographic string compare,
  // not a time compare, and 'T' (0x54) sorts after the space SQLite uses, so
  // it would silently never fire. Routing both sides through datetime()
  // parses them to a common representation before comparing.
  run(`UPDATE decision_recommendations SET status = 'expired', resolved_at = datetime('now')
       WHERE status = 'open' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`);
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Publishes (or refreshes) one recommendation. This is a plain function, not
 * a route handler, so an engine can call it inline wherever the triggering
 * condition is actually computed — the engine's existing return value to its
 * own callers is untouched; this only adds the side effect of a row.
 *
 * `dedupKey` scopes the upsert: if an open recommendation with the same key
 * already exists, it is refreshed in place (title/rationale/numbers/expiry)
 * rather than duplicated — required because the two wired-in engines
 * (lineupDiff, waiverUpgrades) are called from GET routes and recompute
 * their condition on every page load. Once a row is resolved, a later
 * publish with the same key opens a fresh row rather than reopening the old
 * one, so resolution history is never silently overwritten.
 */
export function publishRecommendation({
  dedupKey, leagueId = null, sport, type, subjectIds = [], title, rationale = null,
  expectedValue = null, confidence = null, urgency = 'medium', expiresAt = null,
  sourceModel, sourceVersion = null, link = null
}) {
  if (!dedupKey) throw new Error('publishRecommendation requires dedupKey');
  if (!VALID_SPORT.has(sport)) throw new Error(`publishRecommendation: invalid sport "${sport}"`);
  if (!type || typeof type !== 'string') throw new Error('publishRecommendation requires type');
  if (!title || typeof title !== 'string') throw new Error('publishRecommendation requires title');
  if (!sourceModel || typeof sourceModel !== 'string') throw new Error('publishRecommendation requires sourceModel');
  const safeUrgency = VALID_URGENCY.has(urgency) ? urgency : 'medium';

  const existing = row(`SELECT id FROM decision_recommendations WHERE dedup_key = ? AND status = 'open'`, dedupKey);
  if (existing) {
    run(`UPDATE decision_recommendations SET
           league_id = ?, sport = ?, type = ?, subject_ids = ?, title = ?, rationale = ?,
           expected_value = ?, confidence = ?, urgency = ?, expires_at = ?,
           source_model = ?, source_version = ?, link = ?
         WHERE id = ?`,
      leagueId, sport, type, JSON.stringify(subjectIds), title, rationale,
      expectedValue, confidence, safeUrgency, expiresAt,
      sourceModel, sourceVersion, link, existing.id);
    return toRecommendation(row('SELECT * FROM decision_recommendations WHERE id = ?', existing.id));
  }

  const id = crypto.randomUUID();
  run(`INSERT INTO decision_recommendations
         (id, league_id, sport, type, subject_ids, title, rationale, expected_value, confidence,
          urgency, expires_at, status, source_model, source_version, link, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
    id, leagueId, sport, type, JSON.stringify(subjectIds), title, rationale,
    expectedValue, confidence, safeUrgency, expiresAt,
    sourceModel, sourceVersion, link, dedupKey);
  return toRecommendation(row('SELECT * FROM decision_recommendations WHERE id = ?', id));
}

/** List open recommendations, most urgent and soonest-expiring first. */
r.get('/', (req, res, next) => {
  try {
    expireStale();
    const leagueId = req.query.league_id ? Number(req.query.league_id) : null;
    const params = [];
    let where = `status = 'open'`;
    if (leagueId) { where += ' AND league_id = ?'; params.push(leagueId); }
    const list = rows(`SELECT * FROM decision_recommendations WHERE ${where} ORDER BY
        CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
        datetime(expires_at) ASC, created_at DESC`, ...params);
    // Belt-and-suspenders re-sort in JS: the SQL CASE above already orders by
    // urgency, but keeping URGENCY_RANK here documents the contract the
    // client relies on and guards against the SQL and JS falling out of sync.
    list.sort((a, b) => (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2));
    res.json(list.map(toRecommendation));
  } catch (e) { next(e); }
});

/** Badge/summary counts for the Dashboard header. */
r.get('/summary', (req, res, next) => {
  try {
    expireStale();
    const leagueId = req.query.league_id ? Number(req.query.league_id) : null;
    const params = [];
    let where = `status = 'open'`;
    if (leagueId) { where += ' AND league_id = ?'; params.push(leagueId); }
    const open = rows(`SELECT urgency FROM decision_recommendations WHERE ${where}`, ...params);
    res.json({
      total: open.length,
      high: open.filter(o => o.urgency === 'high').length,
      medium: open.filter(o => o.urgency === 'medium').length,
      low: open.filter(o => o.urgency === 'low').length
    });
  } catch (e) { next(e); }
});

/** Any engine can publish over HTTP too, not just server-side callers. */
r.post('/', (req, res, next) => {
  try {
    const b = req.body ?? {};
    const rec = publishRecommendation({
      dedupKey: b.dedupKey, leagueId: b.leagueId ?? null, sport: b.sport, type: b.type,
      subjectIds: b.subjectIds ?? [], title: b.title, rationale: b.rationale ?? null,
      expectedValue: b.expectedValue ?? null, confidence: b.confidence ?? null,
      urgency: b.urgency ?? 'medium', expiresAt: b.expiresAt ?? null,
      sourceModel: b.sourceModel, sourceVersion: b.sourceVersion ?? null, link: b.link ?? null
    });
    res.json(rec);
  } catch (e) {
    if (e.message?.startsWith('publishRecommendation')) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Resolve (or dismiss) one recommendation with an outcome. */
r.post('/:id/resolve', (req, res, next) => {
  try {
    const existing = row('SELECT * FROM decision_recommendations WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'recommendation not found' });
    const status = ['actioned', 'dismissed', 'expired'].includes(req.body?.status) ? req.body.status : 'dismissed';
    const outcome = req.body?.outcome ?? null;
    run(`UPDATE decision_recommendations SET status = ?, outcome = ?, resolved_at = datetime('now') WHERE id = ?`,
      status, outcome, req.params.id);
    res.json(toRecommendation(row('SELECT * FROM decision_recommendations WHERE id = ?', req.params.id)));
  } catch (e) { next(e); }
});

export default r;
