/**
 * NEGOTIATE-UI: the counter builder's live rescore (WAR-ROOM-UI.md v3 mode 1,
 * COACH-ANCHOR.md "what_if").
 *
 * Nick edits the package; each edit is scored twice:
 *   - his title odds: season-sim.js#tradeImpact against a world built once per
 *     league sync (tradeImpactWorld, the RL-19-2 fast rescore). Only the two changed
 *     lineups are re-solved, so an edit costs one rescore, not a season simulation.
 *     Same seed and run count as every other title-odds surface, so a package here
 *     and the same package on a trade card are the same number.
 *   - his side: counterparty-pricing.js#readDeal -> trade-acceptance.js#acceptanceBand,
 *     the same model the campaign producer prices every step with
 *     (scripts/campaign/league-adapter.mjs priceStep), edge assumed passed as there.
 *
 * His yes-point is where the package breaks even on HIS numbers, on the market
 * screen: screen% = (what he gets - what he gives) / what he gives, FantasyCalc
 * values. readDeal's perception_shift is how much more (in the same %) his own
 * valuations add beyond ours, so he breaks even at screen% = -perception_shift.
 * With no read on how he prices these players, the yes-point is market-fair (0%)
 * and says so. Both are guesses (the acceptance model is unvalidated, E1 pending).
 *
 * The world holds tens of MB, so at most two league states are kept.
 *
 * NEGOTIATE-UI-FIX: all of this runs OFF the request thread. The world build is
 * ~24 s of synchronous work on league 4 and each edit ~0.3-0.6 s, so the route
 * talks to one unref'd worker (negotiateEngine below, the COACH-NEGOTIATE #327
 * pattern) that holds the rescorers: the first call for a league sync starts the
 * build and answers "still being built"; after that each edit is one message round
 * trip, awaited (never Atomics.wait: the Express thread stays free), capped at
 * ENGINE_CALL_MS.
 *
 * TODO(batch-4 people merge): read his yes-point from the one counterpart model,
 * server/services/people/counterpart.js, once it is on main. Until then it is the
 * existing acceptance model below (counterparty-pricing.js#readDeal +
 * trade-acceptance.js#acceptanceBand), the one the campaign producer prices with.
 */
import { Worker } from 'node:worker_threads';
import { screenPct } from './paths.js';
import { P_ACCEPT_LABEL } from './playbook.js';

/** The builder's slider range on his screen, the planner's own price-curve window. */
export const SCREEN_AXIS = Object.freeze({ low: -35, high: 45 });
/** Most players on one side of a counter. */
export const MAX_SIDE = 4;
const KEEP = 2;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'D/ST', 'DST']);

/** The real simulator and pricing (the bench script reuses them). */
export async function defaultDeps() {
  const [sim, cp, pyes, week] = await Promise.all([
    import('../season-sim.js'), import('../counterparty-pricing.js'),
    import('../p-yes.js'), import('../league-week.js')
  ]);
  return {
    world: lg => sim.tradeImpactWorld(lg),
    impact: (lg, opts) => sim.tradeImpact(lg, opts),
    layer: lg => cp.counterpartyLayer(lg.id, { season: lg.season, week: week.leagueCurrentWeek(lg) }),
    readDeal: cp.readDeal,
    // PYES-ONE: through the one module, with no baseline table: the counter builder prices
    // package CONTENT, which the content-blind activity baseline cannot, so it keeps the clone band.
    band: args => pyes.pYesFor(args),
    now: () => performance.now()
  };
}

const cache = new Map();

/** Test hook. */
export function __resetRescorers() { cache.clear(); }

/** The cache key for one league sync. */
export const syncKey = lg => `${lg.id}@${lg.fetched_at ?? ''}`;

/**
 * The rescorer for this league's current sync, built on first use and kept while
 * `fetched_at` is unchanged. `deps` replaces the simulator and pricing (tests).
 */
export async function rescorerFor(lg, deps = null) {
  const key = syncKey(lg);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = makeRescorer(lg, deps ?? await defaultDeps());
  for (const k of [...cache.keys()]) if (k.startsWith(`${lg.id}@`)) cache.delete(k);
  cache.set(key, r);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  return r;
}

const ok = (value, source, extra = {}) => ({ status: 'ok', value, source, ...extra });
const hiddenField = (status, source, reason) => ({ status, source, reason });

/** Build the world, the rosters and his profile once; score packages against them. */
export function makeRescorer(lg, deps) {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const world = deps.world(lg);
  const buildMs = Math.round(now() - t0);
  if (!world || world.fail) {
    const why = String(world?.fail?.error ?? world?.fail ?? 'no world');
    return { fail: `The season simulation could not be built for this league (${why}).`, build_ms: buildMs };
  }
  const assets = world.prep.assets;
  const teams = new Map(world.prep.teams.map(t => [String(t.roster_id), t.players.map(p => Number(p.id))]));
  const me = String(lg.my_team_id);
  let layer = null, layerError = null;
  try { layer = deps.layer(lg); } catch (e) { layerError = e.message ?? String(e); }

  const slim = id => {
    const p = assets.get(Number(id));
    return { id: Number(id), name: p?.name ?? `Player ${id}`, position: p?.position ?? '', value: Math.max(0, Number(p?.value) || 0) };
  };
  const label = p => (p.position ? `${p.name} (${p.position})` : p.name);
  const sum = ids => ids.reduce((s, id) => s + slim(id).value, 0);

  /** A roster as the builder lists it: most valuable first. */
  const roster = team => (teams.get(String(team)) ?? [])
    .map(slim).filter(p => SCORED.has(p.position) || p.value > 0)
    .sort((a, b) => b.value - a.value || a.id - b.id)
    .map(p => ({ id: String(p.id), label: label(p), value: p.value }));

  /** Problems with a package, in plain words; [] when it can be scored. */
  const problems = ({ partner, give, get }) => {
    const out = [];
    const mine = new Set(teams.get(me) ?? []), his = new Set(teams.get(String(partner)) ?? []);
    if (!his.size) out.push(`Team ${partner} is not in this league's simulation.`);
    if (String(partner) === me) out.push('That is your own team.');
    for (const [side, ids, owner] of [['give', give, mine], ['get', get, his]]) {
      if (!Array.isArray(ids) || ids.length < 1) out.push(`Pick at least one player to ${side}.`);
      else if (ids.length > MAX_SIDE) out.push(`At most ${MAX_SIDE} players to ${side}.`);
      else if (new Set(ids.map(String)).size !== ids.length) out.push(`A player is listed twice on the ${side} side.`);
      else for (const id of ids) if (!owner.has(Number(id))) out.push(`Player ${id} is not on the ${side === 'give' ? 'your' : 'his'} roster.`);
    }
    return out;
  };

  /** Where a package sits on his market screen, in %: what he gets vs what he gives. */
  const screenOf = (give, get) => screenPct(sum(give), sum(get));

  /** His side of one package: P(yes) band, yes-point, where it sits on his screen. */
  const hisSide = (partner, give, get) => {
    const screen = screenOf(give, get);
    const m = layer?.get?.(String(partner)) ?? null;
    let read = null, readError = null;
    try {
      read = m ? { ...deps.readDeal({ theirGive: get.map(slim), theirGet: give.map(slim), managerProfile: m }), counterparty_data: true }
        : { receptiveness: 1, perception_delta: null, counterparty_data: false };
    } catch (e) { readError = e.message ?? String(e); }
    const band = read ? deps.band({ counterparty: read, edge: { passes: true }, profile: m?.negotiation ?? null }) : null;
    const b = band?.band ?? null;
    const p_yes = b
      ? ok(b.mid, 'clone.accept', { unit: 'probability', guess: true, band: { low: b.low, high: b.high }, basis: P_ACCEPT_LABEL })
      : hiddenField('failed', 'clone.accept', readError ? `His read failed (${readError}).`
        : `No chance of yes could be priced (${band?.basis ?? 'no band'}).`);
    const shift = read?.perception_informed ? Number(read.perception_shift) : NaN;
    const yes_point = !Number.isFinite(screen) ? hiddenField('unknown', 'clone.price', 'He gives nothing with a market value, so there is no screen to place a price on.')
      : Number.isFinite(shift)
        ? ok(-shift, 'clone.price', { guess: true, basis: 'where the package breaks even on his own valuations (his read moves these players by ' + `${shift >= 0 ? '+' : ''}${shift.toFixed(1)}% vs the market)` })
        : ok(0, 'clone.price', { guess: true, basis: layerError
          ? `his profile could not be read (${layerError}), so his break-even is taken as market-fair`
          : 'no read on how he prices these players, so his break-even is taken as market-fair' });
    return {
      screen: Number.isFinite(screen) ? ok(screen, 'market.fc', { unit: 'percent' })
        : hiddenField('unknown', 'market.fc', 'He gives nothing with a market value.'),
      yes_point, p_yes
    };
  };

  /**
   * Score one package. Returns { ms, nick, his, problems } — `problems` non-empty
   * means nothing was scored and every number is absent.
   */
  const score = ({ partner, give, get }) => {
    give = (give ?? []).map(String); get = (get ?? []).map(String);
    const bad = problems({ partner, give, get });
    if (bad.length) return { problems: bad };
    const t = now();
    const r = deps.impact(lg, { myTeamId: me, theirTeamId: String(partner), iGive: give.map(Number), iGet: get.map(Number), world });
    const ms = Math.round((now() - t) * 10) / 10;
    let nick;
    if (!r || r.error || !r.me) {
      const f = hiddenField('failed', 'sim.title', `The rescore failed (${r?.error ?? 'no result'}).`);
      nick = { title_before: f, title_after: f, title_odds_delta: f };
    } else {
      const d = r.me;
      nick = {
        title_before: ok(d.title_before, 'sim.title', { unit: 'title_odds' }),
        title_after: ok(d.title_after, 'sim.title', { unit: 'title_odds' }),
        title_odds_delta: ok(d.title_delta, 'sim.title', { unit: 'title_odds', se: d.title_delta_se ?? undefined, clears_2se: !!d.title_delta_clears_noise })
      };
    }
    return { problems: [], ms, runs: r?.runs ?? null, nick, his: hisSide(partner, give, get) };
  };

  return {
    build_ms: buildMs, me, axis: SCREEN_AXIS, teams: [...teams.keys()],
    score, roster, screenOf, problems,
    label: id => label(slim(id))
  };
}

/* ------------------------------------------------ one rescore, as the route serves it */

/**
 * Everything one counter-builder edit needs from a built rescorer, in one call (so
 * the worker answers it in one round trip): the score, the walk-away package's place
 * on his screen, labels for the players named, and the rosters when asked.
 */
export function rescoreWith(R, { partner, give, get, walkGive = null, walkGet = null, rosters = false }) {
  const scored = R.score({ partner, give, get });
  if (scored.problems?.length) return { problems: scored.problems };
  return {
    problems: [], scored, build_ms: R.build_ms, axis: R.axis,
    walk_screen: walkGive ? R.screenOf(walkGive, walkGet ?? []) : null,
    labels: Object.fromEntries([...give, ...get].map(id => [String(id), R.label(id)])),
    ...(rosters ? { rosters: { mine: R.roster(R.me), his: R.roster(partner) } } : {})
  };
}

/* ------------------------------------------------------- the worker (off-thread) */

/** Longest one edit may wait on the worker before it is said to be unscored. */
export const ENGINE_CALL_MS = 8000;
const BUILDING_REASON = 'The counter builder is still being built for this league in the background ' +
  '(about 25 s after each league sync). Try again in a few seconds.';

/** The worker's body (eval'd, CommonJS): imports this module and serves it. */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.module).then(m => m.serveEngine(parentPort))
  .catch(e => parentPort.postMessage({ op: 'dead', error: String(e && e.message || e) }));
`;

/**
 * Inside the worker: build rescorers on 'build', answer 'rescore'. Reads the league
 * row itself (its own SQLite connection, like report-worker.js).
 */
export async function serveEngine(port) {
  const { row } = await import('../../db/index.js');
  const built = new Map();
  port.on('message', async msg => {
    if (msg.op === 'build') {
      let out;
      try {
        const lg = row('SELECT * FROM leagues WHERE id = ?', msg.leagueId);
        if (!lg) throw new Error('the league is not in the database');
        for (const k of [...built.keys()]) if (k.startsWith(`${msg.leagueId}@`)) built.delete(k);
        const R = makeRescorer(lg, await defaultDeps());
        if (R.fail) out = { fail: R.fail, build_ms: R.build_ms };
        else {
          built.set(msg.key, R);
          while (built.size > KEEP) built.delete(built.keys().next().value);
          out = { build_ms: R.build_ms };
        }
      } catch (e) { out = { fail: `The counter builder could not be built (${e?.message ?? e}).` }; }
      port.postMessage({ op: 'built', key: msg.key, ...out });
      return;
    }
    if (msg.op === 'rescore') {
      try {
        const R = built.get(msg.key);
        if (!R) throw new Error(`not built for ${msg.key}`);
        port.postMessage({ op: 'answer', id: msg.id, value: JSON.parse(JSON.stringify(rescoreWith(R, msg.req))) });
      } catch (e) { port.postMessage({ op: 'answer', id: msg.id, error: String(e?.message ?? e) }); }
    }
  });
}

/**
 * The engine the route talks to. `rescore(lg, req)` resolves to one of
 *   { status: 'building', reason }                   the build is running (started now if not)
 *   { status: 'failed', reason, build_ms? }          the build or the call failed
 *   { status: 'ok', ...rescoreWith() }               scored (or `problems`)
 * and never blocks the calling thread. `warm(lg)` starts the build early.
 * `makeWorker` replaces the worker (tests).
 */
export function createNegotiateEngine({ makeWorker = null, callMs = ENGINE_CALL_MS } = {}) {
  let state = null;
  const spawn = () => {
    if (state) return state;
    const worker = makeWorker ? makeWorker()
      : new Worker(WORKER_SRC, { eval: true, workerData: { module: import.meta.url } });
    worker.unref?.();
    const s = { worker, seq: 0, pending: new Map(), ready: new Map(), building: new Set() };
    const die = why => {
      if (state === s) state = null;
      for (const p of s.pending.values()) p.done({ status: 'failed', reason: `The counter builder stopped (${why}).` });
      s.pending.clear();
    };
    worker.on('message', msg => {
      if (msg?.op === 'built') {
        s.building.delete(msg.key);
        s.ready.set(msg.key, msg.fail ? { fail: msg.fail, build_ms: msg.build_ms } : { build_ms: msg.build_ms });
      } else if (msg?.op === 'answer') {
        const p = s.pending.get(msg.id);
        if (!p) return; // answered after its call timed out
        s.pending.delete(msg.id);
        p.done(msg.error ? { status: 'failed', reason: `The rescore failed (${msg.error}).` } : { status: 'ok', ...msg.value });
      } else if (msg?.op === 'dead') die(msg.error);
    });
    worker.on('error', e => die(e?.message ?? String(e)));
    worker.on('exit', code => die(`exit ${code}`));
    state = s;
    return s;
  };

  /** Where this league's sync stands; starts the build when nothing is running. */
  const status = lg => {
    const key = syncKey(lg);
    let s;
    try { s = spawn(); } catch (e) { return { status: 'failed', reason: `The counter builder could not start (${e?.message ?? e}).` }; }
    const got = s.ready.get(key);
    if (got?.fail) return { status: 'failed', reason: got.fail, build_ms: got.build_ms };
    if (got) return { status: 'ready', key, s };
    if (!s.building.has(key)) {
      for (const k of [...s.ready.keys()]) if (k.startsWith(`${lg.id}@`)) s.ready.delete(k);
      s.building.add(key);
      s.worker.postMessage({ op: 'build', key, leagueId: lg.id });
    }
    return { status: 'building', reason: BUILDING_REASON };
  };

  return {
    warm: lg => { status(lg); },
    status: lg => { const st = status(lg); return st.status === 'ready' ? { status: 'ready' } : st; },
    rescore(lg, req) {
      const st = status(lg);
      if (st.status !== 'ready') return Promise.resolve(st);
      const { s, key } = st;
      const id = ++s.seq;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          s.pending.delete(id);
          resolve({ status: 'failed', reason: `The rescore took longer than ${callMs / 1000} s; try again.` });
        }, callMs);
        timer.unref?.();
        s.pending.set(id, { done: v => { clearTimeout(timer); resolve(v); } });
        s.worker.postMessage({ op: 'rescore', id, key, req });
      });
    },
    async stop() { const s = state; state = null; if (s) await s.worker.terminate?.(); }
  };
}

/** The one engine the server uses (the worker starts on first use). */
export const negotiateEngine = createNegotiateEngine();

/**
 * An in-process engine over a given rescorer factory (tests, the bench's direct
 * mode): same answers as the worker, no thread.
 */
export function localEngine(factory) {
  return {
    warm() {},
    status: () => ({ status: 'ready' }),
    async rescore(lg, req) {
      const R = await factory(lg);
      if (R.fail) return { status: 'failed', reason: R.fail, build_ms: R.build_ms };
      return { status: 'ok', ...rescoreWith(R, req) };
    },
    async stop() {}
  };
}
