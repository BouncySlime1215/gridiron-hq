#!/usr/bin/env node
/**
 * Pin what the trade engine prices TODAY, so the availability fit can be judged
 * on a measured difference instead of an argument.
 *
 * `scripts/fit-availability.mjs` writes nfl_availability_rates and
 * nfl_availability_role_rates. Neither table exists on the live database, so
 * contingency.js#fittedAvailability falls back to its hardcoded constants and
 * every chance-to-play number in the app is one of those constants. The fit
 * replaces them with measured rates, and the code's own note (contingency.js:654)
 * puts the gap for the ordinary case at 0.708 against 0.952 — a healthy starter
 * priced roughly twenty-five points too low today.
 *
 * That lands with no deploy and no restart. Both tables' fitted_at stamps are in
 * ASSET_INPUT_TABLES (trade-engine.js:224-225), so the asset cache invalidates
 * itself the moment the script commits and the next request reprices. Which means
 * that on a day when five pull requests also ship, "the trade numbers changed"
 * will be true of both, and nobody will be able to separate them without a
 * before-reading taken first.
 *
 * Two reads per league, one target each:
 *   GET /api/trades/:id/rosters — pick the target, and record the basis
 *   GET /api/trades/:id/offer   — the valuation, the horizon and the seeded
 *                                playoff odds it rests on
 *
 * `--find` adds a third, GET /api/trades/:id/find, which is the only surface that
 * carries `acceptance`: the band is attached in findTrades (trade-engine.js:1921)
 * and not on the offer ladder, so an offer response has no acceptance number to
 * compare and its absence there means nothing. The band reads `edge`, which is
 * value-derived, so it moves with the fit even though nothing in the counterparty
 * layer reads availability. It is off by default because that search evaluates
 * every package against every team and measured 5-24 seconds of CPU before this
 * machine's own latency.
 *
 * The offer response carries all of it: `target.active_probability` is the raw
 * availability number, `context.playoff_odds` comes from a 1000-run season
 * simulation (HORIZON_SIM_SEED, deterministic), and season-sim.js:212 calls
 * weeklyAvailability once per simulated week — so the same fit moves the odds
 * too, through a second path. `model_context.availability_basis` says which
 * layer priced it: 'constants' before the fit, 'pooled' or 'role' after.
 *
 *   node scripts/capture-availability-baseline.mjs --out=before.json
 *   ... run the fit ...
 *   node scripts/capture-availability-baseline.mjs --compare=before.json
 *
 * Compare mode re-reads the SAME target players the baseline chose, by id, and
 * prints field-by-field deltas. It must, because the pick rule ("most valuable
 * player I do not own") can itself change once values move, and comparing two
 * different players would show a difference that means nothing.
 *
 * Deliberately NOT included: GET /api/model/:id/simulate. Its cache is a plain
 * Map keyed on league, runs, week and seed (model.js:107-111) with no data
 * fingerprint, cleared only by a league sync or a process restart. Calling it
 * before the fit would warm that cache with pre-fit odds and the after-reading
 * would come back identical — a false negative rather than a measurement. The
 * same fact is worth knowing on deploy day: after the fit runs, the title-odds
 * card served by that route keeps its old number until the machine restarts or a
 * league syncs, while every trade surface reprices immediately.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = process.env.GRIDIRON_BASE_URL ?? 'https://gridiron-hq.fly.dev';
const TOKEN = process.env.GRIDIRON_FLY_TOKEN ?? '';
const arg = (name, fallback = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const COMPARE = arg('compare');
const OUT = arg('out', COMPARE ? null : 'availability-baseline.json');
const LEAGUES = (arg('leagues', '1,2,3,4,5') ?? '').split(',').map(Number).filter(Number.isFinite);
// The machine cold starts in 60-180s and stalls in bursts while heavy jobs hold
// the thread, so a timeout here is not an answer about the app.
const TIMEOUT_MS = Number(arg('timeout', '240')) * 1000;
const ATTEMPTS = Number(arg('attempts', '4'));
const WITH_FIND = process.argv.includes('--find');

if (!TOKEN) {
  console.error('GRIDIRON_FLY_TOKEN is not set; every call would come back 401.');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get (path) {
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not json; the text is the evidence */ }
      last = { path, status: res.status, body, text: body ? null : text.slice(0, 400),
        ms: Date.now() - started, attempt };
      if (res.status < 500) return last;
    } catch (e) {
      last = { path, status: 0, body: null, text: String(e?.message ?? e),
        ms: Date.now() - started, attempt,
        hung: e?.name === 'TimeoutError' || e?.name === 'AbortError' };
    }
    if (attempt < ATTEMPTS) await sleep(attempt * 5000);
  }
  return last;
}

/** A digest of the whole response, so a change anywhere shows even if no field below moved. */
const digest = value => crypto.createHash('sha256')
  .update(JSON.stringify(value, (_k, v) => (v instanceof Object && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v)))
  .digest('hex').slice(0, 16);

const num = v => (Number.isFinite(v) ? v : null);

/** The fields worth naming individually. Everything else rides in the digest. */
function handleFor (offer) {
  const ctx = offer?.context ?? {};
  const target = offer?.target ?? {};
  const open = offer?.open_with ?? null;
  return {
    availability_basis_flat: ctx.availability_basis ?? null,
    availability_basis: offer?.model_context?.availability_basis ?? null,
    season: num(ctx.season), week: num(ctx.week),
    playoff_odds: num(ctx.playoff_odds),
    playoff_odds_source: ctx.playoff_odds_source ?? null,
    playoff_odds_interval: ctx.playoff_odds_interval ?? null,
    horizon_now: num(ctx.horizon?.now),
    horizon_playoff: num(ctx.horizon?.playoff),
    target: {
      id: target.id ?? null, name: target.name ?? null, position: target.position ?? null,
      injury_status: target.injury_status ?? null, practice_status: target.practice_status ?? null,
      active_probability: num(target.active_probability),
      value: num(target.value), adj_ppg: num(target.adj_ppg), ppg: num(target.ppg),
      ros_ppg: num(target.ros_ppg), floor: num(target.floor), ceiling: num(target.ceiling)
    },
    their_cost: num(offer?.their_cost),
    upside_ppg: num(offer?.upside_ppg),
    upside_ppg_horizon: num(offer?.upside_ppg_horizon),
    offers: Array.isArray(offer?.offers) ? offer.offers.length : null,
    error: offer?.error ?? null,
    open_with: open ? {
      i_give: (open.i_give ?? []).map(p => p.name).join(' + '),
      give_value: num(open.give_value), ratio: num(open.ratio),
      my_ppg_delta: num(open.me?.ppg_delta), their_ppg_delta: num(open.them?.ppg_delta),
      horizon_value: num(open.horizon?.value), efficiency: num(open.efficiency),
      // Acceptance is edge-derived, so it moves when valuations move even though
      // nothing in the counterparty layer reads availability.
      acceptance: open.counterparty?.acceptance ?? open.acceptance ?? null,
      perception_delta: num(open.counterparty?.perception_delta)
    } : null,
    response_digest: digest(offer ?? null)
  };
}

/** The deals the finder would actually show, keyed by the engine's own idea id. */
function findHandle (body) {
  const deals = Array.isArray(body?.deals) ? body.deals : (body?.ideas ?? []);
  const out = {};
  for (const d of deals.slice(0, 3)) {
    const key = d.id ?? `${(d.i_give ?? []).map(p => p.id).join('-')}_${(d.i_get ?? []).map(p => p.id).join('-')}`;
    out[key] = {
      i_give: (d.i_give ?? []).map(p => p.name).join(' + '),
      i_get: (d.i_get ?? []).map(p => p.name).join(' + '),
      ratio: num(d.ratio), my_ppg_delta: num(d.me?.ppg_delta), their_ppg_delta: num(d.them?.ppg_delta),
      horizon_value: num(d.horizon?.value),
      edge: d.edge ?? null,
      acceptance: d.acceptance ?? null,
      perception_delta: num(d.counterparty?.perception_delta)
    };
  }
  return { deals: (body?.deals ?? body?.ideas ?? []).length, top: out };
}

/** Most valuable player on someone else's roster: a stable pick, and one the engine will price. */
function pickTarget (rosters) {
  const mine = String(rosters?.my_team_id ?? '');
  const others = (rosters?.teams ?? []).filter(t => String(t.roster_id) !== mine);
  const all = others.flatMap(t => (t.players ?? []).map(p => ({ ...p, roster_id: t.roster_id })));
  return all.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.id - b.id)[0] ?? null;
}

async function captureLeague (leagueId, forcedTarget) {
  const out = { league_id: leagueId, captured_at: new Date().toISOString() };
  const rosters = await get(`/api/trades/${leagueId}/rosters`);
  out.rosters = { status: rosters.status, ms: rosters.ms, attempts: rosters.attempt };
  if (rosters.status !== 200 || !rosters.body) {
    out.error = `rosters read failed: ${rosters.status}${rosters.hung ? ' (no response)' : ''} ${rosters.text ?? ''}`.trim();
    return out;
  }
  out.my_team_id = rosters.body.my_team_id ?? null;
  out.model_context_basis = rosters.body.model_context?.availability_basis ?? null;

  const target = forcedTarget
    ? (rosters.body.teams ?? []).flatMap(t => (t.players ?? []).map(p => ({ ...p, roster_id: t.roster_id })))
      .find(p => p.id === forcedTarget) ?? { id: forcedTarget, roster_id: null }
    : pickTarget(rosters.body);
  if (!target) { out.error = 'no player on another roster to price'; return out; }
  out.target_id = target.id;
  out.target_name = target.name ?? null;

  const offer = await get(`/api/trades/${leagueId}/offer`
    + `?team_id=${encodeURIComponent(out.my_team_id ?? '')}&player_id=${target.id}`);
  out.offer = { status: offer.status, ms: offer.ms, attempts: offer.attempt };
  if (offer.status !== 200 || !offer.body) {
    out.error = `offer read failed: ${offer.status}${offer.hung ? ' (no response)' : ''} ${offer.text ?? ''}`.trim();
    return out;
  }
  out.handle = handleFor(offer.body);

  if (WITH_FIND) {
    const find = await get(`/api/trades/${leagueId}/find`
      + `?team_id=${encodeURIComponent(out.my_team_id ?? '')}&limit=3`);
    out.find = { status: find.status, ms: find.ms, attempts: find.attempt };
    if (find.status === 200 && find.body) out.find_handle = findHandle(find.body);
    else out.find_error = `find read failed: ${find.status}${find.hung ? ' (no response)' : ''}`;
  }
  return out;
}

/* ------------------------------------------------------------------ compare */

const flatten = (value, prefix = '') => Object.entries(value ?? {}).flatMap(([k, v]) =>
  (v && typeof v === 'object' && !Array.isArray(v)
    ? flatten(v, `${prefix}${k}.`)
    : [[`${prefix}${k}`, v]]));

function report (before, after) {
  let moved = 0, same = 0;
  for (const league of after.leagues) {
    const was = before.leagues.find(l => l.league_id === league.league_id);
    console.log(`\nleague ${league.league_id} — ${league.target_name ?? league.target_id ?? 'no target'}`);
    if (league.error) { console.log(`  not captured: ${league.error}`); continue; }
    if (!was?.handle) { console.log('  no baseline for this league'); continue; }
    if (was.target_id !== league.target_id) {
      console.log(`  target mismatch: baseline priced ${was.target_id}, this run ${league.target_id}`);
    }
    const b = new Map([...flatten(was.handle), ...flatten(was.find_handle, 'find.')]);
    for (const [key, now] of [...flatten(league.handle), ...flatten(league.find_handle, 'find.')]) {
      const then = b.get(key);
      if (JSON.stringify(then) === JSON.stringify(now)) { same++; continue; }
      moved++;
      const delta = Number.isFinite(then) && Number.isFinite(now)
        ? ` (${now - then > 0 ? '+' : ''}${+(now - then).toFixed(4)})` : '';
      console.log(`  ${key}: ${JSON.stringify(then)} -> ${JSON.stringify(now)}${delta}`);
    }
  }
  console.log(`\n${moved} field(s) moved, ${same} unchanged.`);
  console.log(moved === 0
    ? 'Nothing moved. Either the fit has not run, or it wrote no rows — read availability_basis above.'
    : 'Measured difference, against a baseline taken before the fit.');
}

/* --------------------------------------------------------------------- main */

const baseline = COMPARE ? JSON.parse(fs.readFileSync(COMPARE, 'utf8')) : null;
const leagues = baseline ? baseline.leagues.map(l => l.league_id) : LEAGUES;
const run = { base: BASE, captured_at: new Date().toISOString(), leagues: [] };

for (const id of leagues) {
  const forced = baseline?.leagues.find(l => l.league_id === id)?.target_id ?? null;
  const league = await captureLeague(id, forced);
  run.leagues.push(league);
  const basis = league.handle?.availability_basis?.basis ?? league.model_context_basis?.basis ?? '?';
  console.log(`league ${id}: ${league.error ? `FAILED — ${league.error}`
    : `${league.target_name} priced, basis ${basis}, `
      + `active_probability ${league.handle?.target?.active_probability}, `
      + `playoff odds ${league.handle?.playoff_odds}`}`);
}

if (baseline) report(baseline, run);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(run, null, 2)); console.log(`\nwritten to ${OUT}`); }
process.exitCode = run.leagues.every(l => l.error) ? 1 : 0;
