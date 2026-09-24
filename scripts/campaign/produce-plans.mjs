#!/usr/bin/env node
/**
 * CAMPAIGN-01 producer: writes the War Room plans JSON for every league.
 *
 * Runs OFF the web server: the refresh loop (scripts/refresh-live-data.mjs,
 * step `warroom_plans`, only when GRIDIRON_WARROOM_ENABLED=1) spawns it after
 * each tick, or run it by hand. The web server only reads the file
 * (server/services/war-room-view.js, WR-1); nothing here runs on a request.
 *
 * Files (all local, all outside the repo: they hold league data):
 *   GRIDIRON_WARROOM_PLANS       output   (default ~/gridiron-local/warroom/plans.json)
 *   GRIDIRON_WARROOM_OBJECTIVES  input    { "<league id>": { kind, goal, target, points_per_week, risk_mode,
 *                                          tolerances, arrive_by, stops, untouchables, version } } (optional)
 *   GRIDIRON_WARROOM_SKIPS       input    JSONL { league, player?, manager?, reason, at } (optional; swipe-deck skips)
 *   GRIDIRON_WARROOM_OFFERS      input    JSONL { league, manager, at } (optional; "I sent it" log, fatigue cap)
 *   GRIDIRON_WARROOM_PUSHES      output   JSONL, one row per league whose next move changed
 *   GRIDIRON_CHAT_DB_PATH        input    local chat DB (optional; labels only)
 * Defaults for the inputs sit next to the plans file.
 *
 * Before planning, every league's requested risk mode goes through EVAL-01's
 * fallback rule on the latest brain report (server/services/campaign/brain-gate.js,
 * FIX-05): a failing, stale (>48 h), missing or unreadable report plans the league
 * on BALANCED with testing-tier signals off; SAFE is never raised. The entry's
 * brain_report and number_health sections come from the same reads.
 *
 * Every re-run diffs each league's next move against the previous plans file and
 * writes `changed` + `reason`; a changed move appends one push row.
 *
 * Usage:
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db> node scripts/campaign/produce-plans.mjs [--leagues 1,2] [--flip-top 3] [--targets 3]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';

export function plansPath(env = process.env) {
  return path.resolve(env.GRIDIRON_WARROOM_PLANS || env.GRIDIRON_WARROOM_SOURCE
    || path.join(os.homedir(), 'gridiron-local', 'warroom', 'plans.json'));
}
const sibling = (env, key, name) => path.resolve(env[key] || path.join(path.dirname(plansPath(env)), name));

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
  const out = { leagues: null, flipTop: 3, targets: 3 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--leagues') out.leagues = argv[++i].split(',').map(Number);
    else if (argv[i] === '--flip-top') out.flipTop = Number(argv[++i]);
    else if (argv[i] === '--targets') out.targets = Number(argv[++i]);
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

async function main() {
  const t0 = Date.now();
  const opts = args(process.argv);
  const env = process.env;
  const out = plansPath(env);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const release = takeLock(out);
  if (!release) { console.log('warroom_plans skipped: another run holds the lock'); return; }
  console.log(`warroom_plans started ${new Date().toISOString()} pid ${process.pid}`);
  try {
    const { loadServices, buildAdapter } = await import('./league-adapter.mjs');
    const { chatRowsFor } = await import('./chat-labels.mjs');
    const { planLeague } = await import('../../server/services/campaign/planner.js');
    const { normaliseObjective } = await import('../../server/services/campaign/objectives.js');
    const { skipWeights } = await import('../../server/services/campaign/partners.js');
    const { diffNextMove } = await import('../../server/services/campaign/replan.js');
    const { rankAttention } = await import('../../server/services/campaign/attention.js');
    const { toEntry, validateEntry, plansFile } = await import('../../server/services/campaign/view.js');
    const { readBrainReport, applyBrainReport, readNumberHealth } = await import('../../server/services/campaign/brain-gate.js');

    const objectives = readObjectives(sibling(env, 'GRIDIRON_WARROOM_OBJECTIVES', 'objectives.json'));
    const skips = readJsonl(sibling(env, 'GRIDIRON_WARROOM_SKIPS', 'skips.jsonl'));
    const offers = readJsonl(sibling(env, 'GRIDIRON_WARROOM_OFFERS', 'offers.jsonl'));
    const previous = readPrevious(out);
    const svc = await loadServices();
    const leagues = svc.db.rows('SELECT id FROM leagues ORDER BY id').map(r => r.id)
      .filter(id => !opts.leagues || opts.leagues.includes(id));

    const entries = [], pushes = [];
    const generated_at = new Date().toISOString();
    // One report card for the whole run: every league is gated on the same read.
    const brainRead = readBrainReport(svc.db.db);
    console.log(`[warroom] brain report: ${brainRead.error ? `UNREADABLE ${brainRead.error}`
      : brainRead.report ? `run ${brainRead.report.run_id} computed ${brainRead.report.computed_at}` : 'none stored yet'}`);
    for (const id of leagues) {
      const tl = Date.now();
      let entry;
      const prev = previous.get(String(id)) ?? null;
      try {
        const chat = await chatRowsFor(id);
        const ta = Date.now();
        const adapter = buildAdapter(svc, id, { chat: chat.rows, offerLog: offers.rows });
        const adapterMs = Date.now() - ta;
        if (adapter.fail) throw new Error(`world failed: ${adapter.fail}`);
        const requested = normaliseObjective(objectives[String(id)] ?? {}, { leagueGoal: objectives[String(id)]?.goal ?? 'title' });
        const brain = applyBrainReport({ objective: requested, report: brainRead.report, error: brainRead.error, now: new Date(generated_at) });
        const objective = brain.objective;
        if (brain.rule.fell_back) console.log(`[warroom] league ${id}: ${brain.rule.reason}`);
        const res = planLeague(adapter, { objective, skips: skipWeights(skips.rows, id), previous: prev,
          budget: { flipTopPer: opts.flipTop, targets: opts.targets } });
        const next = { next_step: res.best?.steps[0] ?? null, objective_version: objective.version, risk_mode: objective.risk_mode,
          roster_key: res.error ? null : adapter.rosterKey() };
        const changed = diffNextMove(prev, next);
        entry = toEntry(res, { names: adapter.names(), as_of: generated_at, previous: prev, changed,
          brain, number_health: readNumberHealth(svc.db.db, id) });
        entry.roster_key = next.roster_key;
        entry.phases_ms = { adapter_and_world: adapterMs, ...(entry.phases_ms ?? {}) };
        entry.inputs = { chat: { status: chat.status, reason: chat.reason ?? null, negotiation: chat.negotiation ?? null },
          skips: { status: skips.status, rows: skips.rows.filter(s => String(s.league) === String(id)).length, bad_lines: skips.bad },
          offers: { status: offers.status, bad_lines: offers.bad }, deadline: adapter.league.deadline_source,
          objective: objective.source,
          brain: { run_id: brain.run_id, requested_mode: brain.objective.requested_risk_mode, mode: brain.rule.mode,
            fell_back: brain.rule.fell_back, testing_tier_enabled: brain.rule.testing_tier_enabled,
            read_error: brainRead.error } };
        const errs = validateEntry(entry);
        if (errs.length) throw new Error(`plans JSON failed its contract check: ${errs.slice(0, 3).join('; ')}`);
      } catch (e) {
        console.error(`[warroom] league ${id}: ${e.stack ?? e}`);
        entry = toEntry({ league: id, me: prev?.me ?? null, error: String(e.message ?? e) },
          { as_of: generated_at, changed: { changed: false, reason: 'planner failed' } });
      }
      entry.runtime_ms = Date.now() - tl;
      if (entry.changed?.changed) pushes.push({ league: id, at: generated_at, reason: entry.changed.reason, next: entry.changed.next_key });
      entries.push(entry);
      console.log(`[warroom] league ${id}: ${entry.error ? `FAILED ${entry.error}` : `ok, next ${entry.changed?.next_key}, changed ${entry.changed?.changed}`} (${Math.round(entry.runtime_ms / 1000)} s, ${entry.rescores ?? 0} rescores, phases ms ${JSON.stringify(entry.phases_ms ?? {})})`);
    }
    const attention = rankAttention(entries.map(e => ({ league: e.league, error: e.error ?? null,
      expected: e.acq?.best?.expected ?? 0, changed: !!e.changed?.changed,
      weeksToDeadline: Number.isInteger(e.deadline_week) && Number.isInteger(e.week) ? e.deadline_week - e.week : null })));
    const file = plansFile(entries, { generated_at, attention, pushes });
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, out);
    if (pushes.length) {
      fs.appendFileSync(sibling(env, 'GRIDIRON_WARROOM_PUSHES', 'pushes.jsonl'), pushes.map(p => JSON.stringify(p)).join('\n') + '\n');
    }
    const failed = entries.filter(e => e.error).length;
    console.log(`warroom_plans ${failed ? 'PARTIAL' : 'ok'} leagues ${entries.length} failed ${failed} changed ${pushes.length} (${Math.round((Date.now() - t0) / 1000)} s) -> ${out}`);
    if (failed === entries.length && entries.length) process.exitCode = 1;
  } finally { release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
