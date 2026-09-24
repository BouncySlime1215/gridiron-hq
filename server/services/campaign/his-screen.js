/**
 * HIS-SCREEN (WAR-ROOM-UI.md v3, new mode 2): any offer, shown the way the
 * partner sees it.
 *
 *   roster     his roster before and after, with what leaves and what arrives
 *   value view each player priced HIS way next to ours (his clone:
 *              counterparty-pricing.js#playerValuation), and the package as his
 *              clone reads it (readDeal: their_perceived_give / _get)
 *   gives up   what he sends, his value and ours
 *   title odds his title-odds change from the one paired season sim
 *              (season-sim.js#tradeImpact, `them`), with its SE and 2-SE check
 *   fair       the "fair on his screen" badge: his clone's % (what he gets minus
 *              what he gives, over what he gives) inside the finder's window
 *              (paths.js SCREEN_WINDOW). No clone for him -> `unknown`, never a
 *              badge computed on OUR market values and labelled as his.
 *
 * buildHisScreen is pure (tests hand in fixtures). computeHisScreen reads the DB
 * and the sim for one offer: heavy, so it runs in the producer (every deck move,
 * his-screens.json) or a worker thread, never on the request thread; hisScreenFor
 * (the route) only reads (HIS-SCREEN-FIX, below). Default-off behind GRIDIRON_HIS_SCREEN; preview mode
 * (preview-mode.js) turns it on locally and the response then says so.
 *
 * Every number is a typed field ({ status: ok | unknown, value?, reason?, source })
 * in the warroom-plans/1 style (view.js), so a missing read is a sentence.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { screenPct, SCREEN_WINDOW, NOISE_K } from './paths.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';
import { warRoomPlansPath } from '../warroom-flag.js';

export const HIS_SCREEN_ENV = 'GRIDIRON_HIS_SCREEN';
export const HIS_SCREEN_OFF_REASON =
  'His screen is default-off, unconfirmed forward: its fair badge reads his clone\'s value view '
  + '(counterparty-pricing.js#readDeal), and no graded check (E1/E2) has confirmed that view predicts his answer yet. '
  + `Set ${HIS_SCREEN_ENV}=1 to switch it on.`;

const fin = v => typeof v === 'number' && Number.isFinite(v);
const ok = (value, source, meta = {}) => ({ status: 'ok', value, source, ...meta });
const unknown = (reason, source) => ({ status: 'unknown', source, reason });
const ids = a => (a ?? []).map(String);
const sum = (list, f) => list.reduce((s, x) => s + (f(x) ?? 0), 0);

/** Site flag, read per call. `enabled` from the caller wins; preview turns an unset site flag on. */
export function hisScreenGate(enabled) {
  if (enabled !== undefined) return { on: !!enabled, preview: false };
  if (process.env[HIS_SCREEN_ENV] === '1') return { on: true, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/**
 * The badge, from his clone's package read. pct: his % (null when he gives nothing of value).
 *   fair  inside the window        short  below it (he feels he loses)
 *   rich  above it (you overpay)   unknown no clone / no price
 */
export function fairBadge(pct, { clone = true, window = SCREEN_WINDOW } = {}) {
  const src = 'clone.price';
  if (!clone) return unknown('No clone of this manager (no counterparty read for his roster), so his screen cannot be priced his way.', src);
  if (!fin(pct)) return unknown('He gives nothing with a market value, so there is no % on his screen.', src);
  const verdict = pct < window.low ? 'short' : pct > window.high ? 'rich' : 'fair';
  const s = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  const text = verdict === 'fair' ? `Fair on his screen (${s}; window ${window.low}% to +${window.high}%).`
    : verdict === 'short' ? `Short on his screen (${s}): he reads it as losing more than ${-window.low}%.`
      : `Rich on his screen (${s}): you give him more than +${window.high}% on his own values.`;
  return ok({ verdict, pct, window: { ...window }, text }, src);
}

/** His title-odds change as a typed field, from tradeImpact's `them` block. */
export function titleField(impact) {
  const src = 'sim.title';
  if (!impact) return unknown('The season sim was not run for this offer.', src);
  if (impact.error) return unknown(`The season sim could not score this offer: ${impact.error}.`, src);
  const t = impact.them ?? {};
  if (!fin(t.title_before) || !fin(t.title_after)) return unknown('The season sim returned no title odds for his team.', src);
  const delta = fin(t.title_delta) ? t.title_delta : t.title_after - t.title_before;
  const out = ok({ before: t.title_before, after: t.title_after, delta }, src, { unit: 'title_odds' });
  if (fin(t.title_delta_se) && t.title_delta_se >= 0) {
    out.se = t.title_delta_se;
    out.clears_2se = t.title_delta_se > 0 && Math.abs(delta) > NOISE_K * t.title_delta_se;
  }
  return out;
}

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST'];
const posRank = p => { const i = POS_ORDER.indexOf(String(p)); return i < 0 ? POS_ORDER.length : i; };

/**
 * offer: Nick's side { partner, give, get } (give = what Nick sends = what HE receives).
 * hisRoster: his player ids today. players: Map id -> { name, position, value, ros_ppg }.
 * clone: null, or { deal: readDeal(...) result, perPlayer: Map id -> playerValuation result, needs? }.
 * impact: tradeImpact result (or { error }) or null.
 */
export function buildHisScreen({ offer, hisRoster, players, clone = null, impact = null }) {
  const P = id => players.get(String(id)) ?? players.get(Number(id)) ?? null;
  const arriving = ids(offer.give), leaving = ids(offer.get);
  const before = ids(hisRoster);
  const missing = leaving.filter(id => !before.includes(id));
  if (missing.length) {
    return { partner: String(offer.partner), error: `not on his roster: ${missing.join(', ')}` };
  }
  const needs = new Set((clone?.needs ?? []).map(String));
  const row = (id, tag) => {
    const p = P(id) ?? {};
    const v = clone?.perPlayer?.get(String(id)) ?? null;
    const ours = Math.max(0, Number(p.value) || 0);
    return {
      id: String(id), name: p.name ?? `player ${id}`, position: p.position ?? null,
      ros_ppg: fin(p.ros_ppg) ? p.ros_ppg : null,
      value_ours: ours,
      value_his: v && fin(v.their_value) ? ok(v.their_value, 'clone.price', { multiplier: v.multiplier })
        : unknown(clone ? 'His clone has no per-player read here.' : 'No clone of this manager.', 'clone.price'),
      reasons: (v?.factors ?? []).map(f => f.why).filter(Boolean),
      ...(tag ? { move: tag } : {}),
      ...(tag === 'arrives' && needs.has(String(p.position)) ? { fills_need: true } : {}),
    };
  };
  const sort = list => list.sort((a, b) => posRank(a.position) - posRank(b.position) || b.value_ours - a.value_ours);
  const afterIds = [...before.filter(id => !leaving.includes(id)), ...arriving];
  const rosterBefore = sort(before.map(id => row(id, leaving.includes(id) ? 'leaves' : null)));
  const rosterAfter = sort(afterIds.map(id => row(id, arriving.includes(id) ? 'arrives' : null)));
  const counts = list => list.reduce((m, r) => { const k = r.position ?? '?'; m[k] = (m[k] ?? 0) + 1; return m; }, {});

  const givesUp = rosterBefore.filter(r => r.move === 'leaves');
  const gets = rosterAfter.filter(r => r.move === 'arrives');
  const market = {
    his_give: sum(givesUp, r => r.value_ours), his_get: sum(gets, r => r.value_ours),
  };
  market.pct = screenPct(market.his_get, market.his_give);

  const deal = clone?.deal ?? null;
  const cloneGive = deal && fin(deal.their_perceived_give) ? deal.their_perceived_give : null;
  const cloneGet = deal && fin(deal.their_perceived_get) ? deal.their_perceived_get : null;
  const hisPct = cloneGive != null && cloneGet != null ? screenPct(cloneGet, cloneGive) : null;
  const value_view = deal
    ? ok({
      his_give: cloneGive, his_get: cloneGet, pct: hisPct,
      market_pct: market.pct,
      informed: !!deal.perception_informed,
      basis: deal.perception_informed
        ? 'his clone: our market values moved by his own reads (chat, profile, needs), package capped at +/-15%'
        : 'his clone has no read on these players, so his view equals market value',
    }, 'clone.price')
    : unknown('No clone of this manager, so only market values are known.', 'clone.price');

  return {
    partner: String(offer.partner),
    offer: { give: arriving, get: leaving },
    roster: { before: rosterBefore, after: rosterAfter, counts_before: counts(rosterBefore), counts_after: counts(rosterAfter) },
    gives_up: givesUp,
    gets,
    market: { his_give: market.his_give, his_get: market.his_get, pct: fin(market.pct) ? market.pct : null, source: 'market.fc' },
    value_view,
    title_odds: titleField(impact),
    fair: fairBadge(hisPct, { clone: !!deal }),
  };
}


/* ------------------------------------------------------------ computing one screen
 * HIS-SCREEN-FIX: the heavy part (asset universe, rosters, clone layer, the paired
 * season sim; ~5-8 s per offer on league 4) never runs on the web server's request
 * thread. It runs in two places only:
 *   1. the campaign producer (scripts/campaign/produce-plans.mjs), which writes every
 *      deck move's screen to his-screens.json next to the plans file (writeHisScreens);
 *   2. one long-lived worker thread (this file, workerPool below) for an offer that is not on the
 *      deck, e.g. a Trade Lab card, cached per plan version (hisScreenFor below).
 */

/** Asset universe + rosters + counterparty layer once per league sync, for a batch of offers. */
function memoServices(s) {
  const teamsBy = new Map(), layerBy = new Map(), worldBy = new Map();
  const k = lg => `${lg.id}|${lg.fetched_at ?? ''}`;
  return {
    ...s,
    teamsFor(lg) {
      if (!teamsBy.has(k(lg))) teamsBy.set(k(lg), s.engine.loadRosters(lg, s.engine.assetUniverse(lg, s.format.deriveFormat(lg).formatKey)));
      return teamsBy.get(k(lg));
    },
    /** The paired sim's world (same seed and runs as tradeImpact's own), built once per sync. */
    worldFor(lg) {
      if (!s.sim.tradeImpactWorld) return null;
      if (!worldBy.has(k(lg))) {
        let w = null;
        try { w = s.sim.tradeImpactWorld(lg, { universe: [] }); } catch { w = null; }
        worldBy.set(k(lg), w?.fail ? null : w);
      }
      return worldBy.get(k(lg));
    },
    layerFor(lg, opts) {
      const key = `${k(lg)}|${opts.season}|${opts.week}`;
      if (!layerBy.has(key)) layerBy.set(key, s.cp.counterpartyLayer(lg.id, opts));
      return layerBy.get(key);
    },
  };
}

/**
 * One offer's screen body from the DB and the sim (no gate, no wrap). Heavy: never
 * call it on the request thread. `world` (optional): a season-sim tradeImpactWorld
 * built once for a batch, so each offer only rescores two lineups.
 */
export function computeHisScreen(lg, { partner, give = [], get = [] }, s, { world = null } = {}) {
  const m0 = s.teamsFor ? s : memoServices(s);
  const me = String(lg.my_team_id ?? '');
  const teams = m0.teamsFor(lg);
  const mine = teams.find(t => t.roster_id === me);
  const his = teams.find(t => t.roster_id === String(partner));
  if (!mine) return { error: 'your team is not set for this league' };
  if (!his || his.roster_id === me) return { error: 'the partner is not another team in this league' };
  const giveIds = ids(give), getIds = ids(get);
  if (!giveIds.length && !getIds.length) return { error: 'the offer names no players' };
  const owns = (t, id) => t.players.some(p => String(p.id) === id);
  const notMine = giveIds.filter(id => !owns(mine, id));
  if (notMine.length) return { error: `not on your roster: ${notMine.join(', ')}` };
  const notHis = getIds.filter(id => !owns(his, id));
  if (notHis.length) return { error: `not on his roster: ${notHis.join(', ')}` };

  const players = new Map();
  for (const p of [...mine.players, ...his.players]) players.set(String(p.id), p);
  const slim = id => { const p = players.get(id); return { id: p.id, name: p.name, position: p.position, value: p.value }; };

  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : (lg.payload ?? {});
  const season = lg.season ?? payload.seasonId ?? null;
  const week = m0.week.leagueCurrentWeek(lg);
  const layer = m0.layerFor(lg, { season, week });
  const m = layer.get(his.roster_id) ?? null;
  const clone = m ? {
    deal: m0.cp.readDeal({ theirGive: getIds.map(slim), theirGet: giveIds.map(slim), managerProfile: m }),
    perPlayer: new Map([...his.players.map(p => String(p.id)), ...giveIds].map(id => [id, m0.cp.playerValuation(m, slim(id))])),
    needs: m.needs ? [...m.needs] : [],
  } : null;

  let impact;
  try {
    impact = m0.sim.tradeImpact(lg, { myTeamId: me, theirTeamId: his.roster_id, iGive: giveIds.map(Number), iGet: getIds.map(Number),
      ...(world ? { world } : {}) });
  } catch (e) {
    impact = { error: String(e.message ?? e) };
  }
  return buildHisScreen({ offer: { partner: his.roster_id, give: giveIds, get: getIds },
    hisRoster: his.players.map(p => p.id), players, clone, impact });
}

async function loadServices() {
  return {
    engine: await import('../trade-engine.js'),
    format: await import('../format.js'),
    cp: await import('../counterparty-pricing.js'),
    sim: await import('../season-sim.js'),
    week: await import('../league-week.js'),
  };
}

/* ------------------------------------------------------------ the precomputed file */

export const HIS_SCREENS_SCHEMA = 'his-screens/1';
/** his-screens.json, next to the plans file (warroom-flag.js is the one reader of that path's variable). */
export const hisScreensPath = () => path.join(path.dirname(path.resolve(warRoomPlansPath())), 'his-screens.json');

/** One key per offer in Nick's terms, order-free: `partner|give ids|get ids`. */
export function offerKey({ partner, give = [], get = [] }) {
  const k = a => ids(a).sort().join('+');
  return `${String(partner)}|${k(give)}|${k(get)}`;
}

/**
 * Every deck move's steps (alternatives.value[*].steps[*]) of every league that planned,
 * as { league, move_id, step, offer }. The deck's head is next_move, so it is covered.
 */
export function deckOffers(plans) {
  const out = [];
  for (const e of plans?.leagues ?? []) {
    if (e.error || e.alternatives?.status !== 'ok') continue;
    for (const mv of e.alternatives.value ?? []) {
      (mv.steps ?? []).forEach((st, i) => out.push({ league: e.league, move_id: mv.move_id, step: i + 1,
        offer: { partner: String(st.partner), give: ids(st.give), get: ids(st.get) } }));
    }
  }
  return out;
}

/**
 * Producer side: the screen for every deck move, one world per league. Pure over its
 * inputs except `svc` and `leagueRow` (tests inject both). Returns the his-screens/1 doc.
 * A league whose screens fail keeps a { error } entry; the other leagues still ship.
 */
export async function precomputeHisScreens(plans, { leagueRow, svc = null, clock = Date.now, log = () => {} } = {}) {
  const s = memoServices(svc ?? await loadServices());
  const byLeague = new Map();
  for (const o of deckOffers(plans)) {
    if (!byLeague.has(o.league)) byLeague.set(o.league, []);
    byLeague.get(o.league).push(o);
  }
  const leagues = {};
  for (const [id, offers] of byLeague) {
    const t0 = clock();
    try {
      const lg = leagueRow(id);
      if (!lg?.payload) throw new Error('league missing or not synced');
      const universe = [...new Set(offers.flatMap(o => [...o.offer.give, ...o.offer.get]).map(Number))];
      let world = null;
      if (s.sim.tradeImpactWorld) {
        try { world = s.sim.tradeImpactWorld(lg, { universe }); } catch (e) { log(`[his-screen] league ${id}: world failed (${e.message}); per-offer sims`); }
        if (world?.fail) world = null;
      }
      const screens = {}, moves = {};
      for (const o of offers) {
        const key = offerKey(o.offer);
        if (!screens[key]) screens[key] = computeHisScreen(lg, o.offer, s, { world });
        (moves[o.move_id] ??= []).push(key);
      }
      // A move is covered when the step its deck card shows (step 1) has a screen. A later
      // step of a chained move can give a player Nick only gets in step 1, so today's
      // rosters refuse it with a reason (counted in steps_covered, not hidden).
      const good = o => !!screens[offerKey(o.offer)] && !screens[offerKey(o.offer)].error;
      const coverage = { moves: Object.keys(moves).length, moves_covered: offers.filter(o => o.step === 1 && good(o)).length,
        steps: offers.length, steps_covered: offers.filter(good).length };
      leagues[String(id)] = { screens, moves, coverage, runtime_ms: clock() - t0 };
      log(`[his-screen] league ${id}: ${coverage.moves_covered}/${coverage.moves} deck moves, ${coverage.steps_covered}/${coverage.steps} steps in ${Math.round((clock() - t0) / 1000)} s`);
    } catch (e) {
      leagues[String(id)] = { error: String(e.message ?? e), runtime_ms: clock() - t0,
        coverage: { moves: new Set(offers.map(o => o.move_id)).size, moves_covered: 0, steps: offers.length, steps_covered: 0 } };
      log(`[his-screen] league ${id}: FAILED ${e.message ?? e}`);
    }
  }
  return { schema: HIS_SCREENS_SCHEMA, plans_generated_at: plans?.generated_at ?? null, generated_at: new Date(clock()).toISOString(), leagues };
}

/**
 * The producer's one call (after the plans write): gate, compute, atomic write.
 * Never throws: a failure is logged and the previous his-screens file stays, so
 * the plans run is never failed by this step.
 */
export async function writeHisScreens(plans, { file = hisScreensPath(), enabled, log = console.log, keep = [], ...opts } = {}) {
  const gate = hisScreenGate(enabled);
  if (!gate.on) { log(`[his-screen] skipped: ${HIS_SCREEN_ENV} is off (preview off too)`); return { status: 'off' }; }
  try {
    const leagueRow = opts.leagueRow ?? (await import('../../db/index.js')).row.bind(null, 'SELECT * FROM leagues WHERE id = ?');
    const doc = await precomputeHisScreens(plans, { ...opts, leagueRow, log });
    // REFRESH-L4 (produce-plans --leagues): leagues the run did not replan keep their plans
    // entry unchanged, so their screens are carried from the last file instead of dropped.
    if (keep.length) carryKept(doc, file, keep, log);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
    const c = { moves: 0, moves_covered: 0, steps: 0, steps_covered: 0 };
    for (const l of Object.values(doc.leagues)) for (const k of Object.keys(c)) c[k] += l.coverage[k];
    log(`[his-screen] wrote ${file}: ${c.moves_covered}/${c.moves} deck moves, ${c.steps_covered}/${c.steps} steps`);
    return { status: 'ok', ...c };
  } catch (e) {
    log(`[his-screen] FAILED ${e.stack ?? e}`);
    return { status: 'failed', error: String(e.message ?? e) };
  }
}

/** Copy `keep` leagues' screens from the file on disk into `doc` (a league the run computed wins). */
function carryKept(doc, file, keep, log) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log(`[his-screen] previous file unreadable (${e.message}); kept leagues have no screens until they run`);
    return;
  }
  if (prev?.schema !== HIS_SCREENS_SCHEMA) { log('[his-screen] previous file has another schema; kept leagues have no screens until they run'); return; }
  const carried = [];
  for (const id of keep.map(String)) {
    if (prev.leagues?.[id] && !doc.leagues[id]) { doc.leagues[id] = prev.leagues[id]; carried.push(id); }
  }
  if (carried.length) log(`[his-screen] kept leagues ${carried.join(',')} from the last file`);
}

/* ------------------------------------------------------------ the request thread: reads only */

let fileCache = { key: null, doc: null };
/** The his-screens file, re-read only when its mtime or size changes (one async stat per request). */
export async function readHisScreens(file = hisScreensPath()) {
  let st;
  try { st = await fsp.stat(file); } catch { fileCache = { key: null, doc: null }; return null; }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (fileCache.key === key) return fileCache.doc;
  let doc = null;
  try {
    doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (doc?.schema !== HIS_SCREENS_SCHEMA) doc = null;
  } catch { doc = null; }
  fileCache = { key, doc };
  return doc;
}

/** Off-deck offers: per plan version, a small in-memory cache and one in-flight run per key. */
const CACHE_MAX = 64, CACHE_TTL_MS = 30 * 60 * 1000, WORKER_BUDGET_MS = 120_000;
const cache = new Map(), inflight = new Map();
export function _resetHisScreenCache() {
  cache.clear(); inflight.clear(); fileCache = { key: null, doc: null };
  if (pool) { const p = pool; pool = null; p.worker.terminate().catch(() => {}); }
}

/**
 * One long-lived worker thread per server process for off-deck offers. It opens its
 * own DB connection and keeps the league's asset universe, rosters and clone layer
 * per sync (memoServices), so only its first offer pays the cold cost. It exits after
 * IDLE_MS without work; a timed-out offer terminates it and the next one starts fresh.
 */
const IDLE_MS = 5 * 60 * 1000;
let pool = null;

function workerPool() {
  if (pool) return pool;
  const worker = new Worker(new URL(import.meta.url), { workerData: { hisScreenWorker: true }, env: process.env });
  worker.unref();
  const p = { worker, pending: new Map(), seq: 0, idle: null };
  const failAll = err => { for (const { reject, timer } of p.pending.values()) { clearTimeout(timer); reject(err); } p.pending.clear(); };
  worker.on('message', ({ id, value, error }) => {
    const job = p.pending.get(id);
    if (!job) return;
    p.pending.delete(id); clearTimeout(job.timer);
    error ? job.reject(new Error(error)) : job.resolve(value);
    if (!p.pending.size) armIdle(p);
  });
  worker.on('error', err => { if (pool === p) pool = null; failAll(err); });
  worker.on('exit', code => { if (pool === p) pool = null; failAll(new Error(`his screen worker exited with code ${code}`)); });
  pool = p;
  return p;
}
function armIdle(p) {
  clearTimeout(p.idle);
  p.worker.unref(); // an idle worker never keeps the process alive
  p.idle = setTimeout(() => { if (!p.pending.size) { if (pool === p) pool = null; p.worker.terminate().catch(() => {}); } }, IDLE_MS);
  p.idle.unref?.();
}

function runInWorker(leagueId, offer) {
  const p = workerPool();
  clearTimeout(p.idle);
  p.worker.ref(); // a pending offer keeps the process alive until it answers
  return new Promise((resolve, reject) => {
    const id = ++p.seq;
    const timer = setTimeout(() => {
      p.pending.delete(id);
      if (pool === p) pool = null;
      p.worker.terminate().catch(() => {});
      reject(new Error(`his screen took longer than ${WORKER_BUDGET_MS / 1000} s and was stopped`));
    }, WORKER_BUDGET_MS);
    timer.unref?.();
    p.pending.set(id, { resolve, reject, timer });
    p.worker.postMessage({ id, leagueId, offer });
  });
}

/* The worker side of this same file: own DB connection, services memoized per league sync. */
if (!isMainThread && workerData?.hisScreenWorker) {
  const { row } = await import('../../db/index.js');
  const s = memoServices(await loadServices());
  parentPort.on('message', ({ id, leagueId, offer }) => {
    try {
      const lg = row('SELECT * FROM leagues WHERE id = ?', Number(leagueId));
      // The sim falls back to its own world when a named player sits outside this one (a free agent).
      const value = lg?.payload ? computeHisScreen(lg, offer, s, { world: s.worldFor(lg) }) : { error: 'league missing or not synced' };
      parentPort.postMessage({ id, value: JSON.parse(JSON.stringify(value)) });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e?.message ?? e) });
    }
  });
}

/**
 * GET /api/trades/:leagueId/his-screen. The request thread only reads:
 *   1. the producer's his-screens.json (every deck move), `precomputed` says when;
 *   2. else this plan version's in-memory cache;
 *   3. else one worker-thread run (deduped per key), then cached. `computed_off_thread: true`.
 * `svc` (tests only) computes inline instead of in a worker; `file` points at a his-screens file.
 */
export async function hisScreenFor(lg, { partner, give = [], get = [], enabled, svc = null, file, compute = null } = {}) {
  const gate = hisScreenGate(enabled);
  if (!gate.on) return { enabled: false, reason: HIS_SCREEN_OFF_REASON };
  const wrap = body => ({ enabled: true, league: lg.id, ...body, ...(gate.preview ? previewFields(HIS_SCREEN_OFF_REASON) : {}) });
  const offer = { partner: String(partner), give: ids(give), get: ids(get) };
  if (!offer.give.length && !offer.get.length) return wrap({ error: 'the offer names no players' });
  const key = offerKey(offer);

  const doc = await readHisScreens(file);
  const hit = doc?.leagues?.[String(lg.id)]?.screens?.[key];
  if (hit) return wrap({ ...hit, precomputed: { as_of: doc.generated_at, plans_generated_at: doc.plans_generated_at } });

  const version = `${lg.id}|${lg.fetched_at ?? ''}|${doc?.plans_generated_at ?? 'none'}|${key}`;
  const now = Date.now();
  const c = cache.get(version);
  if (c && now - c.at < CACHE_TTL_MS) return wrap({ ...c.body, computed_off_thread: true, cached: true });

  if (svc) return wrap(computeHisScreen(lg, offer, svc));
  if (!inflight.has(version)) {
    const run = (compute ?? runInWorker)(lg.id, offer)
      .then(body => { cache.set(version, { at: Date.now(), body }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); return body; })
      .finally(() => inflight.delete(version));
    inflight.set(version, run);
  }
  try {
    return wrap({ ...(await inflight.get(version)), computed_off_thread: true });
  } catch (e) {
    return wrap({ error: `his screen could not be computed: ${e.message ?? e}` });
  }
}
