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
 *                                          tolerances, arrive_by, stops, untouchables, version } } (optional;
 *                                          CLI/test input only)
 *   GRIDIRON_WARROOM_SKIPS       input    JSONL { league, player?, manager?, reason, at } (optional; CLI/test input only)
 *   GRIDIRON_WARROOM_PUSHES      output   JSONL, one row per league whose next move changed
 *   GRIDIRON_CHAT_DB_PATH        input    local chat DB (optional; labels only)
 *   GRIDIRON_COUNTERPART         flag     =1 turns on the ONE-COUNTERPART model (people/counterpart.js):
 *                                         targets, partner order and the reply prior adjusted by named
 *                                         features; unset follows the preview switch; =0 keeps it off
 *   panels.json                  cache    reasoning panels reuse cache (FIX-08), next to the plans file
 * Defaults for the inputs sit next to the plans file.
 *
 * The file is the War Room contract (server/services/campaign/plans-schema.js,
 * `warroom-plans/1`), built by buildPlansFile below and checked
 * with validatePlans before it replaces the live file. Every re-run diffs each
 * league's next move against the previous file (`_run.changed`); a changed move
 * appends one push row. --no-finder skips the Trade Lab finder baseline
 * (`finder_best_expected` is then unknown with that reason).
 *
 * Before planning, every league's requested risk mode goes through EVAL-01's
 * fallback rule on the latest brain report (server/services/campaign/brain-gate.js,
 * FIX-05): a failing, stale (>48 h), missing or unreadable report plans the league
 * on BALANCED with testing-tier signals off; SAFE is never raised. The entry's
 * brain_report and number_health sections come from the same reads.
 *
 * War Room inputs (FIX-07) come from the DB, not files: `warroom_requests` (076)
 * folds into each league's objective and skip weights
 * (server/services/campaign/requests.js), and a request overrides the files for
 * the same key. The pending rows are stamped consumed_at in the same transaction
 * as the plans write; a league whose planner failed keeps its rows pending. The
 * fatigue cap counts `trade_outcomes WHERE sent_at IS NOT NULL` (War Room and
 * TradeCard "I sent it" alike) next to ESPN's own proposals (league-adapter.mjs).
 *
 * Reasoning (FIX-08): after planning and before the write, every deck move gets
 * `reasoning` (scripts/reasoning/reason-plans.mjs). Calls are made only when
 * the reasoning flag (server/services/reasoning-flag.js, or preview) is on AND
 * GRIDIRON_ALLOW_PAID_RUN is set; otherwise each move's reasoning is 'unknown'
 * with the reason. The file is checked with validatePlans again after it.
 *
 * Usage:
 *   SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<db> node scripts/campaign/produce-plans.mjs [--leagues 1,2] [--flip-top 3] [--targets 3] [--no-finder]
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

process.env.SCHEDULER_DISABLED = '1';

/** The plans file: warroom-flag.js is the one reader of its path variable. */
export const plansPath = () => path.resolve(warRoomPlansPath());
const sibling = (env, key, name) => path.resolve(env[key] || path.join(path.dirname(plansPath()), name));

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
  const out = { leagues: null, flipTop: 3, targets: 3, finder: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--leagues') out.leagues = argv[++i].split(',').map(Number);
    else if (argv[i] === '--flip-top') out.flipTop = Number(argv[++i]);
    else if (argv[i] === '--targets') out.targets = Number(argv[++i]);
    else if (argv[i] === '--no-finder') out.finder = false;
  }
  return out;
}

/** The producer's lock on the plans file; scripts/reasoning/run.mjs takes the same one. */
export function takeLock(file) {
  const lock = `${file}.lock`;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); return null; } catch { /* stale lock: owner is gone */ }
  }
  fs.writeFileSync(lock, String(process.pid));
  return () => { try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}

/** The objectives/skips files alone (CLI, tests, the contract fixture): no DB, nothing to consume. */
export function fileInputs(id, { objectiveRow = null, fileSkips = [] } = {}) {
  const raw = objectiveRow ?? {};
  return { objective: normaliseObjective(raw, { leagueGoal: raw.goal ?? 'title' }), weights: skipWeights(fileSkips, id),
    consume: null, summary: { status: 'not_read', reason: 'files only (no warroom_requests read)' } };
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
 *         inputs ({ skips } read status), clock, budget, log,
 *         flags (FIX-02b, optional): model-flags.js#modelFlags() for the head's producer_version,
 *         brain (FIX-05, optional): { read: readBrainReport result, applyBrainReport, numberHealth: id -> readNumberHealth result },
 *         leagueInputs (FIX-07, optional): (id, { objectiveRow, fileSkips }) -> { objective, weights, consume, summary }
 *           (requests.js#leagueInputs; default: the objectives/skips files alone),
 *         consumed (optional array): each league that ships pushes its `consume` here for requests.js#consumeWith }
 * Without `brain`, brain_report and number_health are unknown "not read" and the requested mode is planned.
 */
export async function buildPlansFile(leagues, {
  generated_at, objectives = {}, skips = [], previous = new Map(), inputs = {}, clock = Date.now, budget = {}, log = () => {},
  flags = null, brain = null, leagueInputs = fileInputs, consumed = null,
} = {}) {
  const entries = [], best = new Map();
  for (const { id, load } of leagues) {
    const t0 = clock();
    const prev = previous.get(String(id)) ?? null;
    let entry, res = null;
    try {
      const { adapter, chat = null, adapterMs = 0, counterpart = null } = await load();
      if (adapter.fail) throw new Error(`world failed: ${adapter.fail}`);
      // FIX-07: War Room requests fold into the objective and skip weights (files as fallback).
      const ins = leagueInputs(id, { objectiveRow: objectives[String(id)] ?? null, fileSkips: skips });
      const requested = ins.objective;
      // FIX-05: the brain report gates the risk mode before planning; the plan is built on the effective mode.
      const gate = brain ? brain.applyBrainReport({ objective: requested, report: brain.read.report, error: brain.read.error,
        now: new Date(generated_at) }) : null;
      const objective = gate ? gate.objective : requested;
      if (gate?.rule.fell_back) log(`[warroom] league ${id}: ${gate.rule.reason}`);
      res = planLeague(adapter, { objective, skips: ins.weights, budget });
      const rosterKey = res.error ? null : adapter.rosterKey?.() ?? null;
      const changed = diffNextMove(prev?._run ?? null, { next_step: res.best?.steps[0] ?? null,
        objective_version: objective.version, risk_mode: objective.risk_mode, roster_key: rosterKey });
      entry = toEntry(res, { names: adapter.names(), as_of: generated_at, previous: prev, changed,
        brain: gate, number_health: brain ? brain.numberHealth(id) : null });
      if (entry._run) {
        entry._run.roster_key = rosterKey;
        entry._run.phases_ms = { adapter_and_world: adapterMs, ...entry._run.phases_ms };
        entry._run.inputs = {
          chat: chat ? { status: chat.status, reason: chat.reason ?? null, negotiation: chat.negotiation ?? null,
            // FIX-02c: Nick's own read (nick_override + manager_notes), applied over every chat label.
            nick: { status: chat.nick_status ?? 'unknown', reason: chat.nick_reason ?? chat.reason ?? null, rosters: chat.nick_rosters ?? 0 } }
            : { status: 'not_read' },
          skips: { ...(inputs.skips ?? { status: 'none' }), rows: skips.filter(s => String(s.league) === String(id)).length },
          // ONE-COUNTERPART: people.counterpart's summary (people/counterpart.js) and the models the planner used.
          counterpart: counterpart ? { ...counterpart, models: res.counterpart?.models ?? [] } : { status: 'not_read' },
          // Nick's untouchables (the reader's nick block): ids excluded from targets, gets and flip legs.
          untouchable: res.untouchable ?? { ids: [], refused_targets: [] },
          requests: ins.summary,
          deadline: adapter.league?.deadline_source ?? null, objective: objective.source,
          brain: gate ? { run_id: gate.run_id, requested_mode: requested.risk_mode, mode: gate.rule.mode,
            fell_back: gate.rule.fell_back, testing_tier_enabled: gate.rule.testing_tier_enabled,
            read_error: brain.read.error } : { status: 'not_read' },
        };
      }
      const v = validateLeague(entry);
      if (!v.ok) throw new Error(`plans JSON failed its contract check: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
      if (res.best) best.set(String(id), res.best.expected);
      if (consumed && ins.consume) consumed.push(ins.consume);
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
  console.log(`warroom_plans started ${new Date().toISOString()} pid ${process.pid}`);
  try {
    const { loadServices, buildAdapter } = await import('./league-adapter.mjs');
    const { chatRowsFor } = await import('./chat-labels.mjs');
    // ONE-COUNTERPART (RULINGS 17): GRIDIRON_COUNTERPART=1, or the local preview switch; =0 vetoes.
    const { flagOn, counterpartsFor } = await import('./counterpart-inputs.mjs');
    const counterpartOn = flagOn(env);
    console.log(`[warroom] counterpart model ${counterpartOn ? 'on' : 'off'}`);
    const { modelFlags } = await import('../../server/services/campaign/model-flags.js');
    const flags = await modelFlags();
    console.log(`[warroom] model flags ${JSON.stringify(flags)}`);
    // Dynamic: number-audit.js opens the app DB on import (the contract fixture imports this file without a DB).
    const { readBrainReport, applyBrainReport, readNumberHealth } = await import('../../server/services/campaign/brain-gate.js');
    const { readNumberAudit } = await import('../../server/services/number-audit.js');
    // Dynamic: requests.js also opens the app DB on import (the contract fixture imports this file without a DB).
    const { leagueInputs, consumeWith } = await import('../../server/services/campaign/requests.js');

    const objectives = readObjectives(sibling(env, 'GRIDIRON_WARROOM_OBJECTIVES', 'objectives.json'));
    const skips = readJsonl(sibling(env, 'GRIDIRON_WARROOM_SKIPS', 'skips.jsonl'));
    const previous = readPrevious(out);
    const svc = await loadServices();
    const leagues = svc.db.rows('SELECT id FROM leagues ORDER BY id').map(r => r.id)
      .filter(id => !opts.leagues || opts.leagues.includes(id))
      .map(id => ({ id, load: async () => {
        const chat = await chatRowsFor(id);
        const ta = Date.now();
        const adapter = buildAdapter(svc, id, { chat: chat.rows, finder: opts.finder });
        let counterpart = { status: 'off', reason: 'GRIDIRON_COUNTERPART unset and the preview switch off (or =0)' };
        if (counterpartOn && !adapter.fail) {
          const cp = await counterpartsFor(svc, id, adapter);
          adapter.counterparts = cp.counterparts;
          counterpart = cp.summary;
        }
        return { adapter, chat, adapterMs: Date.now() - ta, counterpart };
      } }));

    const generated_at = new Date().toISOString();
    // FIX-05: one report card for the whole run; every league is gated on the same read.
    const brainRead = readBrainReport(svc.db.db);
    console.log(`[warroom] brain report: ${brainRead.error ? `UNREADABLE ${brainRead.error}`
      : brainRead.report ? `run ${brainRead.report.run_id} computed ${brainRead.report.computed_at}` : 'none stored yet'}`);
    const brain = { read: brainRead, applyBrainReport, numberHealth: id => readNumberHealth(svc.db.db, id, { read: readNumberAudit }) };
    const consumed = [];
    // Checked with validatePlans inside; a file that fails throws here and the previous file stays.
    const file = await buildPlansFile(leagues, { generated_at, objectives, skips: skips.rows, previous,
      inputs: { skips: { status: skips.status, bad_lines: skips.bad } }, leagueInputs, consumed,
      budget: { flipTopPer: opts.flipTop, targets: opts.targets }, flags, brain,
      log: line => (line.includes('FAILED') || line.includes('\n') ? console.error(line) : console.log(line)) });
    // FIX-08: reasoning goes into each move before the one atomic write. Both gates
    // off (or either) -> no call, and every move says why its panel is missing.
    const { reasonPlans } = await import('../reasoning/reason-plans.mjs');
    const reasoning = await reasonPlans({ plans: file, plansFile: out, env, log: l => console.log(JSON.stringify(l)) });
    if (reasoning.result.status === 'failed') console.error(`[warroom] reasoning step failed: ${reasoning.result.error}`);
    console.log(`[warroom] reasoning ${JSON.stringify(reasoning.summary)}`);
    const checked = validatePlans(file);
    if (!checked.ok) throw new Error(`plans file failed its contract check after reasoning: ${checked.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
    const tmp = `${out}.tmp-${process.pid}`;
    // FIX-07: stamp the consumed requests in the same transaction as the plans write.
    const stamped = consumeWith(consumed, () => {
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, out);
    }, { at: generated_at });
    console.log(`[warroom] requests consumed ${stamped.consumed}, campaign_steps written ${stamped.campaign_steps}`
      + (typeof stamped.campaign_steps_skipped === 'string' ? ` (${stamped.campaign_steps_skipped})` : ''));
    reasoning.commit();
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
