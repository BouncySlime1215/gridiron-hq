/**
 * STARTUP HEALTH (plan item 56): the app refuses to serve trade cards when any of the three things
 * Nick's rules stand on fails to load: the rules module (campaign/never-give.js), the FantasyCalc value
 * reader (fc-value.js) or the season trade ledger (campaign/trade-memory.js over league_transactions_raw).
 * Fail closed: every trade-card route answers 503 { status: 'fail_closed', banner } instead of a card,
 * and the banner says in plain words what is down. Nothing is recomputed here and no number changes;
 * this only decides whether the card routes answer at all.
 *
 * Flag GRIDIRON_STARTUP_HEALTH=1 (own switch, not preview mode). Off: the gate is a pass-through and no
 * probe runs, so every route answers exactly as before.
 *
 * Each check is a load AND a behaviour check, because a module can import cleanly and still be wrong:
 *   rules        imports, and ruleVerdict on made-up ids still refuses 160 / 80 / 277 as gives, 290 as a
 *                get, a sold player, an unscored or sub-83 get, a missing fc value and an overpay, and
 *                passes one clean even swap.
 *   fc_value     imports, and fcValues(db) reads at least one value (table absent, empty or erroring fails).
 *   trade_ledger imports, and for every league Nick has marked (leagues.my_team_id) soldThisSeason reads
 *                'ok'. No table, a ledger with executed trades none of which read, or an error fails: without
 *                it a player Nick sold this season could come back as a get. No marked league: nothing to
 *                check, and nothing is served for Nick either.
 *
 * The banner is fixed text per check (no error message, path, module or table name); the raw reason goes
 * to the server log only.
 */
export const STARTUP_HEALTH_ENV = 'GRIDIRON_STARTUP_HEALTH';
export const startupHealthOn = (env = process.env) => env?.[STARTUP_HEALTH_ENV] === '1';
/** While failing, the gate probes again at most this often, so a fixed input serves without a restart. */
export const RETRY_MS = 60_000;

export const CHECKS = Object.freeze(['rules', 'fc_value', 'trade_ledger']);
/** What the banner says for each failed check. Plain words only (UI rule: no dev text on screen). */
export const BANNER_LINES = Object.freeze({
  rules: 'Your trade rules could not be checked.',
  fc_value: 'Player trade values could not be read.',
  trade_ledger: "This season's trade history could not be read.",
});
export const BANNER_TAIL = 'Trade ideas are paused until this is fixed, so nothing that breaks your rules can be shown.';

const defaultLoaders = () => ({
  rules: () => import('./campaign/never-give.js'),
  fc_value: () => import('./fc-value.js'),
  trade_ledger: () => import('./campaign/trade-memory.js'),
});

/* ------------------------------------------------------------------ the rules self-test */

// Made-up ids only (9000s), plus the pinned ones the rules must still refuse.
const X = { chip: '9001', chip2: '9002', low: '9003', unscored: '9004', unpriced: '9005', sold: '9006', mine: '9007' };
const SELF_TEST = [
  { why: 'gives 160', t: { give: ['160'], get: [X.chip] }, reason: 'never_give' },
  { why: 'gives 80', t: { give: ['80'], get: [X.chip] }, reason: 'never_give' },
  { why: 'gives 277 with no pick', t: { give: ['277'], get: [X.chip] }, reason: 'never_give' },
  { why: 'gets 290', t: { give: [X.mine], get: ['290'] }, reason: 'never_get' },
  { why: 'gets a sold player', t: { give: [X.mine], get: [X.sold] }, reason: 'sold_this_season' },
  { why: 'gets a sub-83 player', t: { give: [X.mine], get: [X.low] }, reason: 'below_blue_chip' },
  { why: 'gets an unscored player', t: { give: [X.mine], get: [X.unscored] }, reason: 'unscored' },
  { why: 'gets an unpriced player', t: { give: [X.mine], get: [X.unpriced] }, reason: 'no_fc_value' },
  { why: 'overpays', t: { give: [X.mine, X.chip2], get: [X.chip] }, reason: 'overpay' },
];

/** -> null when the rules module behaves, else the first thing it got wrong. Pure; no db. */
export function rulesSelfTest(mod) {
  for (const k of ['ruleVerdict', 'ruleGate', 'soldThisSeason', 'PINNED_NEVER_GIVE', 'PINNED_NEVER_GET']) {
    if (mod?.[k] == null) return `export ${k} missing`;
  }
  for (const id of ['160', '80', '277']) if (!mod.PINNED_NEVER_GIVE.includes(id)) return `pin ${id} missing from never-give`;
  if (!mod.PINNED_NEVER_GET.includes('290')) return 'pin 290 missing from never-get';
  const score = { [X.chip]: 90, [X.chip2]: 88, [X.low]: 70, [X.sold]: 90, [X.mine]: 60, [X.unpriced]: 90, 290: 90 };
  const fc = new Map([[X.chip, 4000], [X.chip2, 3900], [X.low, 3000], [X.unscored, 3000], [X.sold, 4000],
    [X.mine, 4000], ['160', 5000], ['80', 5000], ['277', 3000], ['290', 4000]]);
  const rules = {
    neverGive: new Set(mod.PINNED_NEVER_GIVE), neverGet: new Set(mod.PINNED_NEVER_GET), sold: new Set([X.sold]),
    fc, scoreOf: id => score[String(id)] ?? null, closed: null, ajAllow: new Set(),
  };
  for (const c of SELF_TEST) {
    const v = mod.ruleVerdict(rules, c.t);
    if (v?.ok !== false || !v.reasons?.includes(c.reason)) return `rule check let through a trade that ${c.why}`;
  }
  const clean = mod.ruleVerdict(rules, { give: [X.mine], get: [X.chip] });
  if (clean?.ok !== true) return `rule check refused a clean even swap (${(clean?.reasons ?? []).join(', ')})`;
  return null;
}

/* ------------------------------------------------------------------ the probe */

async function load(loaders, name) {
  try { return { mod: await loaders[name]() }; } catch (e) { return { error: `failed to load (${e?.message ?? String(e)})` }; }
}

/**
 * Probe the three checks once. db: { row, rows } (server/db/index.js). loaders: injected in tests.
 * -> { ok, checked_at, checks: [{ name, ok, reason }], banner: string|null }
 */
export async function probeTradeSafety({ db, loaders = defaultLoaders(), now = () => new Date() } = {}) {
  const checks = [];
  const rulesMod = await load(loaders, 'rules');
  let reason = rulesMod.error ?? null;
  if (!reason) { try { reason = rulesSelfTest(rulesMod.mod); } catch (e) { reason = `self-test threw (${e?.message ?? String(e)})`; } }
  checks.push({ name: 'rules', ok: !reason, reason });

  const fcMod = await load(loaders, 'fc_value');
  reason = fcMod.error ?? null;
  if (!reason && typeof fcMod.mod?.fcValues !== 'function') reason = 'export fcValues missing';
  if (!reason) {
    try {
      const fc = fcMod.mod.fcValues(db);
      if (fc?.status !== 'ok' || !(fc.byId?.size > 0)) reason = `values ${fc?.status ?? 'unreadable'}${fc?.reason ? ` (${fc.reason})` : ''}`;
    } catch (e) { reason = `read threw (${e?.message ?? String(e)})`; }
  }
  checks.push({ name: 'fc_value', ok: !reason, reason });

  const ledgerMod = await load(loaders, 'trade_ledger');
  reason = ledgerMod.error ?? null;
  if (!reason && (typeof ledgerMod.mod?.executedTrades !== 'function' || typeof ledgerMod.mod?.tradeMemory !== 'function')) reason = 'exports executedTrades / tradeMemory missing';
  if (!reason && typeof rulesMod.mod?.soldThisSeason !== 'function') reason = 'ledger reader unavailable (rules module did not load)';
  if (!reason) {
    try {
      const leagues = db.rows(`SELECT id, season, my_team_id FROM leagues WHERE my_team_id IS NOT NULL AND my_team_id != ''`);
      const bad = [];
      for (const l of leagues) {
        const s = rulesMod.mod.soldThisSeason(db, { leagueId: l.id, season: l.season, me: String(l.my_team_id) });
        if (s?.status !== 'ok') bad.push(`league ${l.id}: ${s?.status ?? 'unreadable'}${s?.reason ? ` (${s.reason})` : ''}`);
      }
      if (bad.length) reason = bad.join('; ');
    } catch (e) { reason = `read threw (${e?.message ?? String(e)})`; }
  }
  checks.push({ name: 'trade_ledger', ok: !reason, reason });

  const failed = checks.filter(c => !c.ok);
  return { ok: failed.length === 0, checked_at: now().toISOString(), checks, banner: bannerFor(failed) };
}

/** The banner for the failed checks: fixed text per check, never a raw reason. */
export function bannerFor(failed) {
  if (!failed?.length) return null;
  return [...failed.map(c => BANNER_LINES[c.name]), BANNER_TAIL].join(' ');
}

/* ------------------------------------------------------------------ the trade-card routes */

/**
 * The routes that serve trade cards (a suggested give/get), matched on the full /api path. Coach is not
 * listed: server/services/coach/ is owned by the Coach v2 rebuild, which calls ruleGate itself.
 */
export const CARD_ROUTES = Object.freeze([
  /^\/api\/trades\/[^/]+\/(war-room|post-draft-plan|brain\/plan|brain\/sell-high|title-trades|find|find\/sequences|proposals|offer|offer-many|news-edge)\/?$/,
  /^\/api\/tradelab\/[^/]+\/(analysis|partners|pitch)\/?$/,
  /^\/api\/edge\/trade\/?$/,
  /^\/api\/execution-slate\/(recommend|opportunities)\/?$/,
  /^\/api\/warroom\/[^/]+\/(aj|negotiations)(\/.*)?$/,
]);
export const isCardRoute = p => CARD_ROUTES.some(re => re.test(String(p ?? '').split('?')[0]));

/**
 * The trade-safety state for this process: probe() at startup, gate() as express middleware in front of
 * the card routes, status() for the banner endpoint. While failing, gate() probes again at most every
 * RETRY_MS; once healthy it stays healthy (each request's ruleGate still fails closed on its own inputs).
 */
export function createTradeSafety({ db, loaders, env = process.env, clock = () => Date.now(), log = console } = {}) {
  let last = null, lastAt = 0, inflight = null;
  const probe = async () => {
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await probeTradeSafety({ db, loaders, now: () => new Date(clock()) });
      last = r; lastAt = clock();
      for (const c of r.checks) if (!c.ok) log.error?.(`[startup-health] ${c.name} failed: ${c.reason}`);
      return r;
    })();
    try { return await inflight; } finally { inflight = null; }
  };
  const current = async () => {
    if (!last || (!last.ok && clock() - lastAt >= RETRY_MS)) await probe();
    return last;
  };
  const gate = async (req, res, next) => {
    if (!startupHealthOn(env) || !isCardRoute(req.originalUrl ?? req.url)) return next();
    let r;
    try { r = await current(); } catch (e) {
      log.error?.(`[startup-health] probe threw: ${e?.message ?? String(e)}`);
      r = { ok: false, checks: [], banner: BANNER_TAIL };
    }
    if (r.ok) return next();
    res.status(503).json(publicView(r));
  };
  const status = async () => {
    if (!startupHealthOn(env)) return { enabled: false };
    return publicView(await current());
  };
  return { probe, gate, status, get last() { return last; } };
}

/** What a client sees: check names and ok flags, the banner; never the raw reasons. */
export function publicView(r) {
  return {
    enabled: true,
    status: r.ok ? 'ok' : 'fail_closed',
    checked_at: r.checked_at ?? null,
    checks: (r.checks ?? []).map(c => ({ name: c.name, ok: c.ok })),
    banner: r.ok ? null : r.banner,
  };
}
