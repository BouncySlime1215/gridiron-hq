import { Router } from 'express';
import { getApiKey, setApiKey, clearApiKey, getWorkspaceId, setWorkspaceId, clearWorkspaceId, usageSummary, PRICING } from '../services/claude.js';
import { rows, row } from '../db/index.js';
import { canonicalGsisLabelConflicts, playerIdentityRepairPlan, unclaimedTeamPositionDuplicates } from '../services/player-repair.js';
import { allSources } from '../services/source-registry.js';
import { listJobs } from '../platform/jobs.js';

const r = Router();

const mask = k => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null);

r.get('/status', (req, res) => {
  const key = getApiKey();
  const usage = usageSummary(30);
  const dataFreshness = {
    rosters: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM roster_players`),
    cap: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM team_cap`),
    news: row(`SELECT MAX(created_at) AS at, COUNT(*) AS n FROM news_items`),
    market: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM player_metrics`),
    stats: row(`SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM player_season_stats`)
  };
  const workspaceId = getWorkspaceId();
  res.json({
    api_key: key ? { configured: true, masked: mask(key) } : { configured: false },
    workspace_id: workspaceId ? { configured: true, value: workspaceId } : { configured: false },
    pricing: PRICING['claude-haiku-4-5-20251001'],
    model: 'claude-haiku-4-5-20251001',
    usage,
    data: dataFreshness,
    // platform/jobs.js maintains name/status/lastRunAt/lastError/runCount on
    // every tick of every registered job, and until 2026-09-20 nothing read
    // any of it. Its two registrations are the draft auto-pick clock and the
    // finalize watch (routes/drafts.js), so the unread field that mattered was
    // `lastError`: a draft clock could fail on every tick during a live draft
    // and say so to nobody. Serving it here is what that module's own header
    // had been claiming the Dev Hub already did.
    background_jobs: listJobs()
  });
});

r.put('/key', (req, res) => {
  const { key } = req.body ?? {};
  if (!key || !/^sk-ant-/.test(key)) {
    return res.status(400).json({ error: 'That does not look like an Anthropic key (expected it to start with sk-ant-).' });
  }
  const result = setApiKey(key.trim());
  res.json({ ok: true, masked: mask(key.trim()), ...result });
});

r.delete('/key', (req, res) => { clearApiKey(); res.json({ ok: true }); });

// Only needed for Anthropic Console's newer "identity-linked" API keys, which
// are rejected with a 400 on every call until a request also declares the
// workspace it acts in. There's no way to detect this from the key string
// alone, so the field stays optional and empty for everyone else.
r.put('/workspace-id', (req, res) => {
  const { workspace_id } = req.body ?? {};
  if (!workspace_id || typeof workspace_id !== 'string' || !workspace_id.trim()) {
    return res.status(400).json({ error: 'workspace_id required' });
  }
  const result = setWorkspaceId(workspace_id.trim());
  res.json({ ok: true, ...result });
});

r.delete('/workspace-id', (req, res) => { clearWorkspaceId(); res.json({ ok: true }); });

/*
 * `GET /dev/usage` was here and is gone (2026-09-20). It answered
 * `usageSummary(Number(req.query.days) || 30)`, and `/dev/status` above
 * already answers `usage: usageSummary(30)` -- the same call, the same
 * default. Nothing in the client, the scripts or the tests ever called it,
 * and nothing ever passed `?days=`, so the only thing it added over
 * `/dev/status` was a parameter with no caller.
 *
 * If a window other than 30 days is wanted, it belongs on `/dev/status`,
 * which something actually reads, rather than on a second route that has to
 * be discovered first.
 */
/*
 * Three read-only dry-runs over the player identity table. Only the first has
 * a button (DevHub.tsx, "Run dry-run"); the other two are reached by hand,
 * and they are kept on purpose rather than deleted as uncalled.
 *
 * Deleting a diagnostic because nothing calls it is how an install loses the
 * tools it needs exactly once, in the hour it has a problem. None of the
 * three writes anything -- they report a plan -- so the cost of keeping them
 * is three lines, and the cost of removing them is being unable to answer
 * "which identities are in conflict" without writing the query again.
 *
 * They are covered by test/dev-routes.test.js so they cannot rot unnoticed,
 * which is the thing an uncalled route is actually at risk of.
 */
r.get('/player-identity/repair-plan', (req, res) => res.json(playerIdentityRepairPlan()));
r.get('/player-identity/gsis-conflicts', (req, res) => res.json(canonicalGsisLabelConflicts()));
r.get('/player-identity/team-position-duplicates', (req, res) => res.json(unclaimedTeamPositionDuplicates()));

/**
 * Every ingestion source the app has — scheduled or on-demand — with its
 * declared cadence, cutoff semantics, failure mode, and live staleness.
 * Build Order 0.5: the point is that nothing here is a silent guess.
 */
r.get('/sources', (req, res) => {
  const sources = allSources();
  res.json({ count: sources.length, stale: sources.filter(s => s.stale).length, sources });
});


/** One button: repull every live data source. */
r.post('/refresh-all', async (req, res, next) => {
  try {
    const { syncRosters, syncDepthChart, syncSchedules, syncCap } = await import('./nfldata.js');
    const { syncPlayersFromESPN, syncGeneralNews } = await import('./espn.js');
    const { syncStats } = await import('./stats.js');
    const { syncTop100 } = await import('./accolades.js');
    const { clearModelCache } = await import('./model.js');

    const step = async (name, fn) => {
      try { return { name, ok: true, ...(await fn()) }; }
      catch (e) { return { name, ok: false, error: e.message }; }
    };
    const results = [];
    results.push(await step('rosters', syncRosters));
    results.push(await step('depth charts', () => syncDepthChart()));
    results.push(await step('players', syncPlayersFromESPN));
    results.push(await step('schedules', () => syncSchedules()));
    results.push(await step('salary cap', syncCap));
    results.push(await step('stats', () => syncStats()));
    results.push(await step('news', syncGeneralNews));
    results.push(await step('NFL Top 100', () => syncTop100()));

    // syncSchedules() clears the matchup cache itself; the model cache also
    // memoises per-league projections and should not survive a full data refresh.
    clearModelCache();

    res.json({ ok: true, steps: results,
      failed: results.filter(r => !r.ok).map(r => `${r.name}: ${r.error}`) });
  } catch (e) { next(e); }
});

export default r;
