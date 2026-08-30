import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import { ingestAllSources } from '../news/ingest.js';
import { requireAuthenticated } from '../platform/auth.js';
import { recordAudit } from '../platform/audit.js';
import { newsSignalCoverage, syncStructuredNewsSignals } from '../services/nfl-news-signal.js';
import { normalizePlayerName } from '../services/player-identity.js';
import { newsFantasyTracker } from '../services/news-fantasy-impact.js';

const r = Router();

// Ingestion fans out to external feeds regardless of which authenticated caller
// triggers it, so the cooldown is global (per source set, not per user) — the
// goal is to stop repeated hammering of the same upstream feeds, not to meter
// individual users.
const INGEST_COOLDOWN_MS = 60_000;
let lastIngestAt = 0;
let lastIngestResult = null;

/**
 * Pull every documented RSS source through normalize.js's provenance/dedup pipeline.
 * Authenticated only — this fans out to external feeds and writes to the database,
 * so it must not be an anonymous, unlimited-trigger endpoint.
 */
r.post('/ingest', requireAuthenticated, async (req, res, next) => {
  try {
    const now = Date.now();
    const elapsed = now - lastIngestAt;
    if (elapsed < INGEST_COOLDOWN_MS) {
      return res.status(429).json({ error: 'ingestion was run recently', retry_after_ms: INGEST_COOLDOWN_MS - elapsed });
    }
    lastIngestAt = now;
    const started = performance.now();
    const sources = await ingestAllSources();
    // Deterministic typing is cheap and belongs in the same refresh transaction
    // from the user's perspective. New injury/role reporting should not wait for
    // an hourly scheduler before becoming actionable in the Signal Feed.
    const typing = syncStructuredNewsSignals({ sinceDays: 14, limit: 1500 });
    const { enqueueRecentNewsTriggers } = await import('../services/nfl-capture-dispatch.js');
    const capture_triggers = enqueueRecentNewsTriggers();
    lastIngestResult = { ok: true, sources, typing, capture_triggers,
      duration_ms: Math.round(performance.now() - started), refreshed_at: new Date().toISOString() };
    res.json(lastIngestResult);
  } catch (e) { next(e); }
});

const safeJson = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const materialNews = text => /\b(?:injur|ruled out|doubtful|questionable|practice|starter|benched|released|waived|role|trade|suspend)\w*\b/i.test(text);

/**
 * A bounded, user-ranked news desk. The old feed returned all 1,300+ rows and
 * made React render the archive before the useful stories. This endpoint caps
 * the first paint, ranks roster/material/fresh reporting first, and returns the
 * freshness metrics needed to tell whether "latest" is actually current.
 */
r.get('/desk', requireAuthenticated, (req, res) => {
  const limit = Math.min(120, Math.max(20, Number(req.query.limit) || 80));
  const mine = new Set(myRosterNames(req.auth.userId).map(normalizePlayerName).filter(Boolean));
  const candidates = rows(`SELECT n.*,t.abbr AS team_abbr,t.name AS team_name,t.primary_color
    FROM news_items n LEFT JOIN nfl_teams t ON t.id=n.team_id
    ORDER BY COALESCE(n.published_at,n.date) DESC,n.id DESC LIMIT 500`);
  const now = Date.now();
  const ranked = candidates.map(story => {
    const entities = safeJson(story.entities_json, {});
    const uniquePlayers = [...new Map((entities.players ?? []).map(player => [normalizePlayerName(player.name), player])).values()];
    const reliability = safeJson(story.reliability_json, {});
    const rosterPlayers = uniquePlayers.filter(player => mine.has(normalizePlayerName(player.name)));
    const text = `${story.headline} ${story.body ?? ''}`;
    const published = Date.parse(story.published_at ?? story.date);
    const ageMinutes = Number.isFinite(published) ? Math.max(0, Math.round((now - published) / 60000)) : null;
    const material = materialNews(text);
    const fresh = ageMinutes != null && ageMinutes <= 24 * 60;
    const official = story.source_type === 'official';
    const priority = rosterPlayers.length * 60 + Number(material) * 24 + Number(fresh) * 14
      + Number(official) * 8 + Number(story.importance ?? 2) * 4
      + (Number.isFinite(reliability.score) ? reliability.score * 10 : 0)
      - Math.min(20, (ageMinutes ?? 28800) / 1440);
    const reasons = [];
    if (rosterPlayers.length) reasons.push(`your roster: ${rosterPlayers.map(player => player.name).join(', ')}`);
    if (material) reasons.push('availability or role impact');
    if (fresh) reasons.push('published in the last 24h');
    if (official) reasons.push('official source');
    return { ...story, entities_json: JSON.stringify({ ...entities, players: uniquePlayers }), age_minutes: ageMinutes,
      priority_score: +priority.toFixed(2), priority_reasons: reasons, my_player: rosterPlayers.length > 0 };
  }).sort((a, b) => b.priority_score - a.priority_score || Number(b.id) - Number(a.id)).slice(0, limit);

  const summary = rows(`SELECT COUNT(*) stories,COUNT(DISTINCT source) sources,
      SUM(COALESCE(published_at,date)>=datetime('now','-24 hours')) fresh_24h,
      SUM(ai_analysis IS NOT NULL) analyzed,MAX(ingested_at) latest_ingest,
      MAX(COALESCE(published_at,date)) latest_published,
      AVG(CASE WHEN ingested_at IS NOT NULL AND published_at IS NOT NULL
        THEN (julianday(ingested_at)-julianday(published_at))*1440 END) mean_ingest_lag_minutes
    FROM news_items`)[0];
  res.json({
    stories: ranked,
    stats: { ...summary, returned: ranked.length, roster_players: mine.size,
      latest_ingest_age_minutes: summary.latest_ingest ? Math.max(0, Math.round((now - Date.parse(summary.latest_ingest)) / 60000)) : null,
      signals: newsSignalCoverage() },
    refresh: { cooldown_ms: INGEST_COOLDOWN_MS, last_result: lastIngestResult }
  });
});

r.get('/', (req, res) => {
  const { date, team } = req.query;
  const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 160));
  let sql = `SELECT n.*, t.abbr AS team_abbr, t.name AS team_name, t.primary_color
             FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND n.date = ?'; params.push(date); }
  if (team) { sql += ' AND t.abbr = ?'; params.push(team.toUpperCase()); }
  sql += ' ORDER BY n.date DESC, n.importance DESC, n.id DESC LIMIT ?';
  params.push(limit);
  res.json(rows(sql, ...params));
});

r.get('/dates', (req, res) => {
  res.json(rows('SELECT DISTINCT date FROM news_items ORDER BY date DESC').map(x => x.date));
});

// Manual entry (also used by the Claude Code assisted workflow)
r.post('/', requireAuthenticated, (req, res) => {
  const { date, team_abbr, headline, body, ai_analysis, fantasy_impact, importance = 2, source } = req.body;
  if (!date || !headline) return res.status(400).json({ error: 'date and headline required' });
  if (source && source.toLowerCase() === 'ai analysis') {
    return res.status(400).json({ error: '"AI analysis" is not a valid reporting source — use the ai_analysis field instead' });
  }
  const team = team_abbr ? row('SELECT id FROM nfl_teams WHERE abbr = ?', team_abbr.toUpperCase()) : null;
  const result = run(`INSERT INTO news_items (date, team_id, headline, body, ai_analysis, fantasy_impact, importance, source)
       VALUES (?,?,?,?,?,?,?,?)`,
    date, team?.id ?? null, headline, body ?? null, ai_analysis ?? null,
    fantasy_impact ?? null, importance, source ?? null);
  recordAudit({ actor: String(req.auth.userId), role: 'user', action: 'news.create', entityType: 'news_item', entityId: result.lastInsertRowid, details: { headline, source } });
  res.json({ ok: true });
});

r.delete('/:id', requireAuthenticated, (req, res) => {
  run('DELETE FROM news_items WHERE id = ?', req.params.id);
  recordAudit({ actor: String(req.auth.userId), role: 'user', action: 'news.delete', entityType: 'news_item', entityId: req.params.id });
  res.json({ ok: true });
});

// AI analysis for pasted headlines. Requires ANTHROPIC_API_KEY in env.
r.post('/analyze', requireAuthenticated, async (req, res, next) => {
  try {
    const { date, items } = req.body; // items: [{team_abbr, headline, body?}]
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right), or use manual entry.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    const msg = await callClaude({
      feature: 'news-analyze',
      maxTokens: 2048,
      prompt: `You are an NFL training-camp analyst for a fantasy football dashboard. For each story below, write a JSON array where each element has: "team_abbr", "headline" (cleaned up), "ai_analysis" (2-3 sentences of sharp football analysis: scheme fit, depth chart, usage), "fantasy_impact" (1 sentence, specific), "importance" (1=minor, 2=notable, 3=major). Only respond with the JSON array, no other text.\n\nStories:\n${items.map((it, i) => `${i + 1}. [${it.team_abbr}] ${it.headline}${it.body ? ' — ' + it.body : ''}`).join('\n')}`
    });
    const analyzed = parseJson(msg);
    // `a.ai_analysis` is Claude's read of the pasted headline, not a reporting source —
    // it belongs in the ai_analysis column. `source` describes provenance of the
    // headline itself: whatever the caller attributed it to, or an explicit
    // "user-submitted" fallback. Never the literal "AI analysis" (see normalize.js).
    for (let i = 0; i < analyzed.length; i++) {
      const a = analyzed[i];
      const original = items[i] ?? {};
      const team = row('SELECT id FROM nfl_teams WHERE abbr = ?', (a.team_abbr || '').toUpperCase());
      const source = original.source && original.source.toLowerCase() !== 'ai analysis' ? original.source : 'user-submitted';
      run(`INSERT INTO news_items (date, team_id, headline, body, ai_analysis, fantasy_impact, importance, source, source_url)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        date, team?.id ?? null, a.headline, original.body ?? null, a.ai_analysis, a.fantasy_impact,
        a.importance ?? 2, source, original.source_url ?? null);
    }
    recordAudit({ actor: String(req.auth.userId), role: 'user', action: 'news.analyze', entityType: 'news_item', details: { count: analyzed.length } });
    res.json({ ok: true, count: analyzed.length });
  } catch (e) { next(e); }
});

function myRosterNames(userId) {
  // players on my team(s) across every league I'm a member of — scoped through
  // league_memberships so one authenticated user never sees another user's roster
  // (leagues rows are not otherwise partitioned by owner).
  const out = new Set();
  const myLeagues = rows(`SELECT l.platform, l.payload, l.my_team_id FROM leagues l
    JOIN league_memberships lm ON lm.league_id = l.id
    WHERE lm.user_id = ? AND l.payload IS NOT NULL`, userId);
  for (const lg of myLeagues) {
    let payload; try { payload = JSON.parse(lg.payload); } catch { continue; }
    if (lg.platform === 'sleeper') {
      const mine = (payload.rosters ?? []).find(r => String(r.roster_id) === String(lg.my_team_id))
        ?? (payload.rosters ?? [])[0];
      for (const sid of mine?.players ?? []) {
        const p = row('SELECT name FROM players WHERE sleeper_id = ?', sid);
        if (p) out.add(p.name);
      }
    } else {
      const mine = (payload.teams ?? []).find(t => String(t.id) === String(lg.my_team_id));
      for (const e of mine?.roster?.entries ?? []) {
        const n = e.playerPoolEntry?.player?.fullName;
        if (n) out.add(n);
      }
    }
  }
  return [...out];
}

/** Names of players on the caller's connected rosters, for the News Hub's "My Players" filter. */
r.get('/my-players', requireAuthenticated, (req, res) => {
  res.json({ names: myRosterNames(req.auth.userId) });
});

/**
 * The typed signal feed — what `nfl-news-signal.js` actually extracted, not
 * regenerated prose. Every row here is a claim with a verbatim quote proving
 * it, a status from a fixed enum, and a confidence score, rather than an LLM
 * summary invented fresh on each page load. Existed and ran on a schedule
 * before this route did; it just never reached a page a user looks at.
 *
 * Defaults to the caller's own rostered players when leagues are connected —
 * the news that changes what THEY should do — and falls back to the highest-
 * confidence league-wide claims otherwise.
 */
r.get('/signals', requireAuthenticated, (req, res) => {
  const { team } = req.query;
  const parsedDays = Number(req.query.days ?? 14);
  const days = Number.isFinite(parsedDays) ? Math.min(365, Math.max(1, parsedDays)) : 14;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const mine = myRosterNames(req.auth.userId);
  const myKeys = new Set(mine.map(normalizePlayerName).filter(Boolean));

  let sql = `SELECT s.*, n.source_url AS story_url FROM nfl_news_signals s
             LEFT JOIN news_items n ON n.id = s.news_id
             WHERE s.published_at >= ?`;
  const params = [since];
  if (team) { sql += ' AND s.team = ?'; params.push(String(team).toUpperCase()); }
  sql += ' ORDER BY s.confidence DESC, s.published_at DESC LIMIT 300';
  const all = rows(sql, ...params);

  const scoped = !team && myKeys.size ? all.filter(x => myKeys.has(x.player_key)) : all;
  // One card per player+signal_type: the strongest, most recent claim, not
  // every historical mention of the same injury.
  const latest = new Map();
  for (const claim of scoped) {
    const key = `${claim.player_key}|${claim.signal_type}`;
    if (!latest.has(key)) latest.set(key, claim);
  }
  const tracked = newsFantasyTracker([...latest.values()]);
  res.json({
    scope: !team && myKeys.size ? 'my_roster' : team ? 'team' : 'league',
    roster_size: myKeys.size,
    signals: tracked.signals,
    coverage: newsSignalCoverage(),
    tracker: tracked.tracker
  });
});

/**
 * Twitter ingestion status: real money on a prepaid balance, so this stays
 * one request away rather than buried in a log only a server operator sees.
 */
r.get('/twitter-status', requireAuthenticated, async (req, res, next) => {
  try {
    const { twitterSpendStatus, hasKey } = await import('../services/twitterapi-io.js');
    const { tweetLineCorrelationSummary } = await import('../services/nfl-tweet-line-correlation.js');
    res.json({ configured: hasKey(), spend: twitterSpendStatus(), line_correlation: tweetLineCorrelationSummary() });
  } catch (e) { next(e); }
});

/** "What does this actually mean?" — on-demand, per story. */
r.post('/:id/explain', requireAuthenticated, async (req, res, next) => {
  try {
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }
    const n = row(`SELECT n.*, t.abbr AS team_abbr, t.name AS team_name, t.head_coach, t.oc_name,
                          t.off_scheme, t.off_scheme_detail, t.coach_analysis
                   FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id WHERE n.id = ?`, req.params.id);
    if (!n) return res.status(404).json({ error: 'story not found' });

    const depth = n.team_id
      ? rows(`SELECT name, position, slot_code FROM players
              WHERE team_id = ? AND slot_code IS NOT NULL AND phase = 'offense' ORDER BY slot_code`, n.team_id)
      : [];
    const mine = myRosterNames(req.auth.userId);

    const msg = await callClaude({
      feature: 'news-explain',
      maxTokens: 900,
      prompt: `Explain what this NFL story actually means. 2026 season.

STORY (${n.date}${n.team_abbr ? `, ${n.team_name}` : ''}): ${n.headline}
${n.body ?? ''}

${n.team_abbr ? `TEAM CONTEXT: HC ${n.head_coach}, OC ${n.oc_name}. ${n.off_scheme ?? ''}. ${n.off_scheme_detail ?? ''}
DEPTH CHART (source of truth — never name anyone else as being on this team):
${depth.map(d => `${d.slot_code}: ${d.name}`).join('\n') || 'n/a'}` : ''}

MY FANTASY ROSTER (across my leagues): ${mine.length ? mine.join(', ') : '(no leagues connected)'}

Answer in JSON with exactly two keys:
"team_impact": 2-3 sentences on what this means for ${n.team_name ?? 'the team'} as a whole — scheme, depth chart, who gains and who loses snaps/targets.
"my_impact": 2-3 sentences on what it means specifically for MY fantasy roster listed above. If nobody on my roster is affected, say so plainly and name the one player I should be watching instead.

Respond with ONLY the JSON object.`
    });
    const out = parseJson(msg);
    run(`UPDATE news_items SET ai_analysis = ?, fantasy_impact = ? WHERE id = ?`,
      out.team_impact, out.my_impact, n.id);
    recordAudit({ actor: String(req.auth.userId), role: 'user', action: 'news.explain', entityType: 'news_item', entityId: n.id });
    res.json(out);
  } catch (e) { next(e); }
});

/** Camp roundup: one paragraph on the day + the teams most affected. */
r.post('/roundup', requireAuthenticated, async (req, res, next) => {
  try {
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }
    const date = req.body?.date;
    const stories = date
      ? rows(`SELECT n.headline, n.body, t.abbr FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
              WHERE n.date = ? ORDER BY n.importance DESC LIMIT 60`, date)
      : rows(`SELECT n.headline, n.body, t.abbr FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
              ORDER BY n.date DESC, n.importance DESC LIMIT 60`);
    if (!stories.length) return res.status(400).json({ error: 'No stories to summarize — pull news first.' });

    const mine = myRosterNames(req.auth.userId);
    const msg = await callClaude({
      feature: 'news-roundup',
      maxTokens: 1400,
      prompt: `Here are today's NFL training-camp headlines (2026). Write a camp roundup.

${stories.map(s => `[${s.abbr ?? 'NFL'}] ${s.headline}${s.body ? ' — ' + s.body : ''}`).join('\n')}

MY FANTASY ROSTER: ${mine.length ? mine.join(', ') : '(none connected)'}

Respond with ONLY JSON:
{
  "summary": "one flowing paragraph (5-7 sentences) covering the real story of the day across the league — camp battles, injuries, depth-chart movement. Prioritize what changes fantasy value. No bullet points.",
  "battles": [{"team":"ABBR","battle":"short label e.g. 'QB1 competition'","status":"one sentence on where it stands"}],
  "teams_affected": [{"team":"ABBR","why":"one sentence"}]
}
Limit battles and teams_affected to the 5 most consequential each.`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

export default r;
