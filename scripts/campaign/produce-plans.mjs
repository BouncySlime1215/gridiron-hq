#!/usr/bin/env node
/**
 * CAMPAIGN-01 producer: writes the War Room plans JSON for every league.
 *
 * Runs OFF the web server: the refresh loop (scripts/refresh-live-data.mjs,
 * step `warroom_plans`, only when warroom-flag.js#warRoomFlag is on) spawns it after
 * each tick, or run it by hand. The web server only reads the file
 * (server/services/war-room-view.js, WR-1); nothing here runs on a request.
 *
 * Files (all local, all outside the repo: they hold league data):
 *   plans file                   output   server/services/warroom-flag.js#warRoomPlansPath()
 *                                         (default ~/gridiron-local/warroom/plans.json)
 *   GRIDIRON_WARROOM_OBJECTIVES  input    { "<league id>": { kind, goal, target, points_per_week, risk_mode,
 *                                          tolerances, arrive_by, stops, untouchables, version } } (optional)
 *   GRIDIRON_WARROOM_SKIPS       input    JSONL { league, player?, manager?, reason, at } (optional; swipe-deck skips)
 *   GRIDIRON_WARROOM_OFFERS      input    JSONL { league, manager, at } (optional; "I sent it" log, fatigue cap)
 *   GRIDIRON_WARROOM_PUSHES      output   JSONL, one row per league whose next move changed
 *   GRIDIRON_CHAT_DB_PATH        input    local chat DB (optional; labels only)
 * Defaults for the inputs sit next to the plans file.
 *
 * The file is the War Room contract (server/services/campaign/plans-schema.js,
 * `warroom-plans/1`), built by buildPlansFile below and checked
 * with validatePlans before it replaces the live file. Every re-run diffs each
 * league's next move against the previous file (`_run.changed`); a changed move
 * appends one push row. --no-finder skips the Trade Lab finder baseline
 * (`finder_best_expected` is then unknown with that reason).
 *
 * ONE-PLANNER: this is the only planner and plans.json its only output.
 *   - ACQ-01's 2-for-1 / 1-for-2 search (PR #267) runs inside the path search
 *     (server/services/campaign/search.js#searchTarget) behind GRIDIRON_TWO_FOR_ONE
 *     (default off; on under preview-mode.js#previewUnconfirmed). Its counts and the
 *     IDEA-038 comparison go to `_run.inputs.two_for_one`. There is no acq-plans.json.
 *   - FLIP-01's nightly / on-news schedule (PR #265) is `--tick`: it re-runs this
 *     producer when plans.json is a day old, or when news about a rostered player
 *     landed since the last run (at most one news run an hour). The flip map it
 *     refreshes is plans.json's `flip_map`; there is no second flip output.
 *   - Nick's unreachable managers (FIX-02c nick block) are never a step, flip leg or
 *     target owner (search.js, partners.js#excluded).
 *
 * Usage:
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db> node scripts/campaign/produce-plans.mjs [--leagues 1,2] [--flip-top 3] [--targets 3] [--no-finder] [--tick]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateLeague, validatePlans } from '../../server/services/campaign/plans-schema.js';
import { planLeague } from '../../server/services/campaign/planner.js';
import { normaliseObjective } from '../../server/services/campaign/objectives.js';
import { skipWeights } from '../../server/services/campaign/partners.js';
import { diffNextMove } from '../../server/services/campaign/replan.js';
import { rankAttention } from '../../server/services/campaign/attention.js';
import { toEntry, failedEntry, plansFile } from '../../server/services/campaign/view.js';
import { warRoomPlansPath } from '../../server/services/warroom-flag.js';
import { previewUnconfirmed } from '../../server/services/preview-mode.js';
import { newSearchStats, twoForOneSummary } from '../../server/services/campaign/search.js';

process.env.SCHEDULER_DISABLED = '1';

/** The plans file: warroom-flag.js is the one reader of its path variable. */
export const plansPath = () => path.resolve(warRoomPlansPath());
const sibling = (env, key, name) => path.resolve(env[key] || path.join(path.dirname(plansPath()), name));

/** The flag for the 2-for-1 search: 'on' (GRIDIRON_TWO_FOR_ONE=1), 'preview' (on only via preview mode) or 'off'. */
export const TWO_FOR_ONE_ENV = 'GRIDIRON_TWO_FOR_ONE';
export function twoForOneFlag(env = process.env) {
  if (env[TWO_FOR_ONE_ENV] === '1') return 'on';
  return previewUnconfirmed() ? 'preview' : 'off';
}

/* FLIP-01's schedule, as this producer's runner (moved in from PR #265 flip-radar.js#decideRun). */
export const NIGHTLY_MINUTES = 24 * 60;
/** Two news runs are at least this far apart, so a burst of news costs one run. */
export const NEWS_GAP_MINUTES = 60;

/** Whether a --tick runs now. Pure. lastAt: the previous plans file's generated_at. */
export function decideRun({ lastAt, now = Date.now(), newsHits = 0, force = false }) {
  if (force) return { run: true, trigger: 'manual' };
  const ageMin = lastAt ? (now - Date.parse(lastAt)) / 60_000 : Infinity;
  if (!(ageMin < NIGHTLY_MINUTES)) return { run: true, trigger: 'nightly' };
  if (newsHits > 0 && ageMin >= NEWS_GAP_MINUTES) return { run: true, trigger: 'news' };
  return { run: false, reason: newsHits > 0 ? 'news seen, inside the news gap' : 'fresh, no news since' };
}

/** News rows newer than `since` about a player rostered in any of `leagueIds` (count only). */
export function newsHitsSince(db, leagueIds, since, normalise) {
  const names = new Set();
  for (const id of leagueIds) {
    const lg = db.row('SELECT payload FROM leagues WHERE id = ?', id);
    let p = lg?.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { if (e instanceof SyntaxError) continue; throw e; } }
    for (const t of p?.teams ?? []) for (const e of t.roster?.entries ?? []) {
      const n = normalise(e.playerPoolEntry?.player?.fullName);
      if (n) names.add(n);
    }
  }
  if (!names.size) return 0;
  return db.rows(`SELECT player_name FROM nfl_news_signals WHERE created_at > datetime(?)`, since ?? '1970-01-01T00:00:00Z')
    .filter(r => names.has(normalise(r.player_name))).length;
}

/** JSONL reader: absent file -> []; a bad line is counted and reported, never silently dropped. */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], bad: 0, status: 'absent' };
  const rows = []; let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad, status: 'ok' };
}

/** Objectives file: absent -> {}; unreadable -> throws (the producer keeps the previous plans file). */
export function readObjectives(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: expected an object keyed by league id`);
  return parsed;
}

function readPrevious(file) {
  if (!fs.existsSync(file)) return new Map();
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map((p.leagues ?? []).map(e => [String(e.league), e]));
  } catch (e) {
    console.warn(`[warroom] previous plans file unreadable (${e.message}); every league reads as a first plan`);
    return new Map();
  }
}

function args(argv) {
  const out = { leagues: null, flipTop: 3, targets: 3, finder: true, tick: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--leagues') out.leagues = argv[++i].split(',').map(Number);
    else if (argv[i] === '--flip-top') out.flipTop = Number(argv[++i]);
    else if (argv[i] === '--targets') out.targets = Number(argv[++i]);
    else if (argv[i] === '--no-finder') out.finder = false;
    else if (argv[i] === '--tick') out.tick = true;
  }
  return out;
}

function takeLock(file) {
  const lock = `${file}.lock`;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); return null; } catch { /* stale lock: owner is gone */ }
  }
  fs.writeFileSync(lock, String(process.pid));
  return () => { try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}

/* ------------------------------------------------------------------ the per-league loop
 * FIX-03: shared by main() (real adapters from the DB) and the contract fixture
 * (test/fixtures/warroom-contract/make-producer-plans.mjs, the made-up league).
 * No DB, env or file access in here: each league brings a `load()` that returns
 * its adapter. Every entry is checked with plans-schema.js#validateLeague before
 * it is kept; one that fails is written as the contract's failed shape
 * ({ league, me, names, error }) and the other leagues still ship. The whole
 * file is checked with validatePlans before it is returned; a file that fails
 * throws, so main() keeps the previous plans file.
 */

/**
 * leagues: [{ id, load: async () => ({ adapter, chat?, adapterMs? }) }]
 * opts: { generated_at, objectives ({ id: raw objective }), skips (rows), previous (Map id -> last entry),
 *         inputs ({ skips, offers } read status), clock, budget, log,
 *         flags (FIX-02b, optional): model-flags.js#modelFlags() for the head's producer_version }
 */
export async function buildPlansFile(leagues, {
  generated_at, objectives = {}, skips = [], previous = new Map(), inputs = {}, clock = Date.now, budget = {}, log = () => {},
  flags = null, twoForOne = 'off', trigger = null,
} = {}) {
  const entries = [], best = new Map();
  for (const { id, load } of leagues) {
    const t0 = clock();
    const prev = previous.get(String(id)) ?? null;
    let entry, res = null;
    try {
      const { adapter, chat = null, adapterMs = 0 } = await load();
      if (adapter.fail) throw new Error(`world failed: ${adapter.fail}`);
      // ONE-PLANNER: the 2-for-1 search runs inside searchTarget; its counts come back on this sink.
      if (twoForOne !== 'off') {
        adapter.searchOpts = { ...(adapter.searchOpts ?? {}), twoForOne: true };
        adapter.searchStats = newSearchStats(true);
      }
      const raw = objectives[String(id)] ?? {};
      const objective = normaliseObjective(raw, { leagueGoal: raw.goal ?? 'title' });
      res = planLeague(adapter, { objective, skips: skipWeights(skips, id), budget });
      const rosterKey = res.error ? null : adapter.rosterKey?.() ?? null;
      const changed = diffNextMove(prev?._run ?? null, { next_step: res.best?.steps[0] ?? null,
        objective_version: objective.version, risk_mode: objective.risk_mode, roster_key: rosterKey });
      entry = toEntry(res, { names: adapter.names(), as_of: generated_at, previous: prev, changed });
      if (entry._run) {
        entry._run.roster_key = rosterKey;
        entry._run.phases_ms = { adapter_and_world: adapterMs, ...entry._run.phases_ms };
        entry._run.inputs = {
          chat: chat ? { status: chat.status, reason: chat.reason ?? null, negotiation: chat.negotiation ?? null,
            // FIX-02c: Nick's own read (nick_override + manager_notes), applied over every chat label.
            nick: { status: chat.nick_status ?? 'unknown', reason: chat.nick_reason ?? chat.reason ?? null, rosters: chat.nick_rosters ?? 0 } }
            : { status: 'not_read' },
          skips: { ...(inputs.skips ?? { status: 'none' }), rows: skips.filter(s => String(s.league) === String(id)).length },
          offers: inputs.offers ?? { status: 'none' },
          deadline: adapter.league?.deadline_source ?? null, objective: objective.source,
          // Off and untriggered, the entry is byte-for-byte the incumbent's (the committed contract fixture).
          ...(trigger ? { trigger } : {}),
          ...(twoForOne !== 'off' ? { two_for_one: { flag: twoForOne, ...twoForOneSummary(adapter.searchStats) } } : {}),
        };
      }
      const v = validateLeague(entry);
      if (!v.ok) throw new Error(`plans JSON failed its contract check: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
      if (res.best) best.set(String(id), res.best.expected);
    } catch (e) {
      log(`[warroom] league ${id}: ${e.stack ?? e}`);
      entry = failedEntry({ league: id, me: res?.me ?? prev?.me ?? null, error: String(e.message ?? e) });
    }
    if (entry._run) entry._run.runtime_ms = clock() - t0;
    entries.push(entry);
    log(`[warroom] league ${id}: ${entry.error ? `FAILED ${entry.error}`
      : `ok, next ${entry._run.changed.next_key}, changed ${entry._run.changed.changed}`} (${Math.round((clock() - t0) / 1000)} s, ${entry._run?.rescores ?? 0} rescores, phases ms ${JSON.stringify(entry._run?.phases_ms ?? {})})`);
  }

  // Attention budget across the leagues (north-star row 19): each league carries its own row.
  const ranked = rankAttention(entries.map(e => ({ league: e.league, error: e.error ?? null, expected: best.get(String(e.league)) ?? 0,
    changed: !!e._run?.changed?.changed,
    weeksToDeadline: Number.isInteger(e._run?.deadline_week) && Number.isInteger(e._run?.week) ? e._run.deadline_week - e._run.week : null })));
  for (const e of entries) {
    if (e.error) continue;
    const r = ranked.find(x => x.league === e.league);
    e.attention = { status: 'ok', value: { rank: r.rank, of: entries.length, reason: r.why }, source: 'campaign.plan' };
  }

  const file = plansFile(entries, { generated_at, flags });
  const v = validatePlans(file);
  if (!v.ok) throw new Error(`plans file failed its contract check: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
  return file;
}

/** One push row per league whose next move changed. */
export function pushesOf(file) {
  return file.leagues.filter(e => e._run?.changed?.changed)
    .map(e => ({ league: e.league, at: file.generated_at, reason: e._run.changed.reason, next: e._run.changed.next_key }));
}

async function main() {
  const t0 = Date.now();
  const opts = args(process.argv);
  const env = process.env;
  const out = plansPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const release = takeLock(out);
  if (!release) { console.log('warroom_plans skipped: another run holds the lock'); return; }
  try {
    const { loadServices, buildAdapter } = await import('./league-adapter.mjs');
    const svc = await loadServices();
    const leagueIds = svc.db.rows('SELECT id FROM leagues ORDER BY id').map(r => r.id)
      .filter(id => !opts.leagues || opts.leagues.includes(id));
    let trigger = 'manual';
    if (opts.tick) {
      let lastAt = null;
      try { lastAt = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).generated_at ?? null : null; } catch { lastAt = null; }
      const { normalizePlayerName } = await import('../../server/services/player-identity.js');
      const newsHits = lastAt ? newsHitsSince(svc.db, leagueIds, lastAt, normalizePlayerName) : 0;
      const d = decideRun({ lastAt, newsHits });
      if (!d.run) { console.log(`warroom_plans skipped: ${d.reason}`); return; }
      trigger = d.trigger;
    }
    const twoForOne = twoForOneFlag(env);
    console.log(`warroom_plans started ${new Date().toISOString()} pid ${process.pid} trigger ${trigger} two_for_one ${twoForOne}`);
    const { chatRowsFor } = await import('./chat-labels.mjs');
    const { modelFlags } = await import('../../server/services/campaign/model-flags.js');
    const flags = await modelFlags();
    console.log(`[warroom] model flags ${JSON.stringify(flags)}`);

    const objectives = readObjectives(sibling(env, 'GRIDIRON_WARROOM_OBJECTIVES', 'objectives.json'));
    const skips = readJsonl(sibling(env, 'GRIDIRON_WARROOM_SKIPS', 'skips.jsonl'));
    const offers = readJsonl(sibling(env, 'GRIDIRON_WARROOM_OFFERS', 'offers.jsonl'));
    const previous = readPrevious(out);
    const leagues = leagueIds
      .map(id => ({ id, load: async () => {
        const chat = await chatRowsFor(id);
        const ta = Date.now();
        const adapter = buildAdapter(svc, id, { chat: chat.rows, offerLog: offers.rows, finder: opts.finder });
        return { adapter, chat, adapterMs: Date.now() - ta };
      } }));

    const generated_at = new Date().toISOString();
    // Checked with validatePlans inside; a file that fails throws here and the previous file stays.
    const file = await buildPlansFile(leagues, { generated_at, objectives, skips: skips.rows, previous,
      inputs: { skips: { status: skips.status, bad_lines: skips.bad }, offers: { status: offers.status, bad_lines: offers.bad } },
      budget: { flipTopPer: opts.flipTop, targets: opts.targets }, flags, twoForOne, trigger,
      log: line => (line.includes('FAILED') || line.includes('\n') ? console.error(line) : console.log(line)) });
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, out);
    const pushes = pushesOf(file);
    if (pushes.length) {
      fs.appendFileSync(sibling(env, 'GRIDIRON_WARROOM_PUSHES', 'pushes.jsonl'), pushes.map(p => JSON.stringify(p)).join('\n') + '\n');
    }
    const entries = file.leagues;
    const failed = entries.filter(e => e.error).length;
    console.log(`warroom_plans ${failed ? 'PARTIAL' : 'ok'} leagues ${entries.length} failed ${failed} changed ${pushes.length} (${Math.round((Date.now() - t0) / 1000)} s) -> ${out}`);
    if (failed === entries.length && entries.length) process.exitCode = 1;
  } finally { release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
