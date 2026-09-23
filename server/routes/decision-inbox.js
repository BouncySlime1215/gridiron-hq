/**
 * The Decision Inbox — the August 2026 platform audit's global recommendation #1
 * (docs/evidence/historical/platform-audit-2026-08-24-findings.md)
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
// Fantasy-NFL only. MLB was removed from the product (#128); 'MLB' is an invalid
// sport like any other and publishRecommendation() below rejects it rather than
// storing it.
const VALID_SPORT = new Set(['NFL']);

/**
 * Exported for `test/decision-inbox.test.js`, which asserts the published shape and no
 * longer has an HTTP response to read it out of. It is a seam over live code, not dead
 * code: `publishRecommendation` returns through it on every call.
 */
export function toRecommendation(rec) {
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

/*
 * `URGENCY_RANK` used to live here and is gone with the routes. It ordered the list
 * GET / returned — high before medium before low, then soonest expiry. That ordering
 * was route-side and has no home now; whatever reads this table next orders it itself.
 * Recording that here rather than leaving a constant nothing uses.
 */

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
  // Expiry used to be lazy on the READ path, swept before every GET. Those routes are
  // gone, so without this line nothing would ever mark a row expired again and every
  // stale recommendation would read as `open` forever — the table's next reader would
  // be told to act on things that lapsed weeks ago. Moving the sweep onto the write
  // path keeps the guarantee with a caller that actually still runs: the two engines
  // publish on every lineup and waiver recompute, so it fires at least as often as the
  // reads it used to hang off.
  expireStale();

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

/*
 * THE FOUR HTTP ROUTES THAT USED TO BE HERE ARE GONE (2026-09-20).
 *
 * GET /, GET /summary, POST /, POST /:id/resolve. Nothing in the client called any
 * of them — verified against the whole client tree, not an `api(` inventory — and no
 * script dialled them either. They were named by the wiring map's `route-no-caller`
 * rule for weeks, inside a row that read "decision-inbox.js | 4", which is why nobody
 * saw them.
 *
 * `publishRecommendation` below is NOT dead and must stay: `waiver-brain.js:38` and
 * `trade-engine.js:59` both import it, and both keep writing. The table keeps filling;
 * what changed is that the reader is Coach, reading and citing
 * `decision_recommendations` directly, rather than an HTTP surface no page ever opened.
 *
 * WHAT WENT WITH THEM, SAID PLAINLY. `POST /:id/resolve` was the only thing that could
 * ever set `status`, `resolved_at` or `outcome`, so no row can now be marked actioned
 * or dismissed; rows leave `open` only by expiring. That is not a capability this
 * deletion removed — nothing called that route either, so nothing has resolved a row
 * since the table was created. The deletion makes an existing gap visible instead of
 * leaving four routes standing to imply it was covered. Whoever gives this table a
 * reader owns giving it a way to drain.
 *
 * The deleted page is not coming back — nav is eight tabs. If a decision inbox is ever
 * wanted again it belongs on an existing tab, not as a ninth.
 */

export default r;
