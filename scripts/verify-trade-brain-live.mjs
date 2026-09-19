#!/usr/bin/env node
/**
 * Check, against a running deployment, whether the Trade Brain is actually working.
 *
 * The Trade Brain was built, tested and merged while nothing exercised it in a
 * live app: the signals were only ever built by a loop script on one laptop, the
 * proposals prompt had never once been sent, and no page read either. Tests pass
 * against fixtures, so they cannot tell us any of that. This does the one thing
 * fixtures cannot: it asks a real deployment what it has.
 *
 * Every check reports the URL it called and the status it got, and says which of
 * three things it found, because they mean different things and get confused:
 *
 *   - 404 on a route this repository defines  -> the deployed build predates the
 *     code. That is a deploy problem, not a data problem.
 *   - 200 with available:false or an empty     -> the route is live and honest:
 *     the build step has not run on that box yet.
 *   - 410                                     -> the route exists and is retired
 *     on purpose (server/routes/trades.js#retired). Not evidence of age.
 *
 * A hang is its own outcome and is reported as such. On 2026-09-19 the app
 * answered nothing at all for five minutes because the heavy sync tier runs on
 * the main thread, so "no response" is a state this script has to name rather
 * than report as a failed check.
 *
 * GET only, and nothing here writes. One check can spend money and is opt-in:
 * /proposals sends a real model call on a cache miss, against a shared daily
 * budget, so it runs only with --proposals.
 *
 * Usage:
 *   GRIDIRON_FLY_TOKEN=... node scripts/verify-trade-brain-live.mjs
 *   GRIDIRON_FLY_TOKEN=... node scripts/verify-trade-brain-live.mjs --proposals
 *   ... --base=http://127.0.0.1:5177        # a local server instead of Fly
 *   ... --league=4                          # one league instead of all
 *   ... --json                              # last line is JSON, for a loop
 *
 * Exit 0 when every mandatory check passed, 1 when any failed, 2 when the app
 * never answered (nothing was checked, so nothing is proven either way).
 */

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const BASE = (value('base') || process.env.GRIDIRON_BASE_URL || 'https://gridiron-hq.fly.dev').replace(/\/$/, '');
const TOKEN = process.env.GRIDIRON_FLY_TOKEN || process.env.GRIDIRON_TOKEN || '';
const ONE_LEAGUE = value('league');
const WITH_PROPOSALS = flag('proposals');
const AS_JSON = flag('json');
const TIMEOUT_MS = Number(value('timeout') || 60000);

if (!TOKEN) {
  console.error('No token. Set GRIDIRON_FLY_TOKEN (or GRIDIRON_TOKEN) to a bearer token for the app.');
  process.exit(1);
}

const checks = [];
const record = (name, state, detail, evidence) => {
  checks.push({ name, state, detail, evidence });
  if (!AS_JSON) {
    const mark = { pass: 'ok  ', fail: 'FAIL', skip: 'skip', info: '--  ' }[state] || '?   ';
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
    if (evidence) console.log(`       ${evidence}`);
  }
};

/**
 * One GET. Returns { status, body, text, ms, hung }. A hang is not an error
 * here: it is the finding, so it comes back as hung rather than throwing.
 */
async function get (path) {
  const url = `${BASE}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json; text is the evidence */ }
    return { url, status: res.status, body, text, ms: Date.now() - started, hung: false };
  } catch (e) {
    const hung = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { url, status: 0, body: null, text: String(e?.message ?? e), ms: Date.now() - started, hung };
  }
}

const short = (s, n = 160) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

// 0. Does the app answer at all? Everything after this is meaningless if not.
const root = await get('/api/leagues');
if (root.hung || root.status === 0) {
  record('app answers', 'fail', root.hung ? `no response in ${Math.round(root.ms / 1000)}s` : 'transport error',
    `${root.url} — ${short(root.text)}`);
  if (AS_JSON) console.log(JSON.stringify({ base: BASE, answered: false, checks }, null, 2));
  else console.log('\nThe app never answered, so nothing was verified. This is not a failing feature.');
  process.exit(2);
}
record('app answers', 'pass', `${root.status} in ${root.ms}ms`, root.url);

// 1. Which leagues does this token actually see? An empty list means this
//    token's user has no memberships, not that the app has no leagues.
let leagues = [];
if (root.status === 200 && Array.isArray(root.body)) {
  leagues = root.body.map(l => ({ id: l.id, name: l.name, season: l.season, week: l.current_week ?? l.week }));
  record('leagues visible', leagues.length ? 'pass' : 'fail',
    leagues.length ? `${leagues.length} league(s)` : 'none — this token has no league memberships',
    leagues.map(l => `${l.id} ${l.name} (season ${l.season}, week ${l.week})`).join(' | '));
} else {
  record('leagues visible', 'fail', `${root.status}`, short(root.text));
}

const targets = ONE_LEAGUE ? leagues.filter(l => String(l.id) === String(ONE_LEAGUE)) : leagues;

// 2. Is the Anthropic key configured? Admin-only, so a 403 is a gap in this
//    token's permission, not a gap in the deployment.
const dev = await get('/api/dev/status');
if (dev.status === 200) {
  const configured = dev.body?.api_key?.configured;
  record('model key configured', configured ? 'pass' : 'fail',
    configured ? `yes (${dev.body.api_key.masked})` : 'no — proposals cannot be asked for',
    dev.url);
} else if (dev.status === 403) {
  record('model key configured', 'skip', 'this token is not a platform admin, so the key cannot be read here', dev.url);
} else {
  record('model key configured', dev.status === 404 ? 'fail' : 'skip',
    dev.status === 404 ? 'route absent from the deployed build' : `${dev.status}`, short(dev.text));
}

// 3. Per league: the hand-set tier table, and the measured signals.
const perLeague = [];
for (const lg of targets) {
  const entry = { id: lg.id, name: lg.name };

  const mgrs = await get(`/api/trades/${lg.id}/brain/managers`);
  if (mgrs.status === 200 && Array.isArray(mgrs.body?.managers)) {
    entry.manager_profiles_set = mgrs.body.managers.filter(m => m.is_set).length;
    entry.managers = mgrs.body.managers.length;
    record(`league ${lg.id} hand-set tiers`, 'pass',
      `${entry.manager_profiles_set} of ${entry.managers} set by hand`, mgrs.url);
  } else if (mgrs.status === 200 && mgrs.body?.error) {
    entry.manager_profiles_set = null;
    record(`league ${lg.id} hand-set tiers`, 'fail', mgrs.body.error, mgrs.url);
  } else if (mgrs.status === 404) {
    entry.manager_profiles_set = null;
    record(`league ${lg.id} hand-set tiers`, 'fail',
      '404 — the deployed build predates this route', mgrs.url);
  } else {
    entry.manager_profiles_set = null;
    record(`league ${lg.id} hand-set tiers`, 'fail', `${mgrs.status}`, short(mgrs.text));
  }

  const sig = await get(`/api/trades/${lg.id}/managers/signals`);
  if (sig.status === 200 && sig.body) {
    const mgrRows = Array.isArray(sig.body.managers) ? sig.body.managers : [];
    const total = mgrRows.reduce((n, m) => n + (Array.isArray(m.signals) ? m.signals.length : 0), 0);
    const priceable = mgrRows.reduce((n, m) => n + (m.signals || []).filter(s => s.priceable).length, 0);
    const corpus = mgrRows.filter(m => m.corpus).length;
    entry.signals_available = !!sig.body.available;
    entry.signal_rows = total;
    entry.priceable_rows = priceable;
    entry.corpus_managers = corpus;
    entry.computed_at = sig.body.computed_at ?? null;
    if (sig.body.available && total > 0) {
      record(`league ${lg.id} measured signals`, 'pass',
        `${total} signal rows across ${mgrRows.length} managers, ${priceable} priceable, ${corpus} with chat`,
        `built ${entry.computed_at ?? 'unknown'} — ${sig.url}`);
    } else {
      record(`league ${lg.id} measured signals`, 'fail',
        sig.body.reason || 'available:false with no reason given', sig.url);
    }
  } else if (sig.status === 404) {
    entry.signals_available = null;
    record(`league ${lg.id} measured signals`, 'fail',
      '404 — the signals route is not in the deployed build', sig.url);
  } else {
    entry.signals_available = null;
    record(`league ${lg.id} measured signals`, 'fail', `${sig.status}`, short(sig.text));
  }

  perLeague.push(entry);
}

// 4. Proposals. Opt-in, because a cache miss sends a real model call and draws
//    on a shared daily budget. One league only, never a loop over five.
if (WITH_PROPOSALS && targets.length) {
  const lg = targets[0];
  const prop = await get(`/api/trades/${lg.id}/proposals`);
  if (prop.status === 200 && prop.body) {
    const n = Array.isArray(prop.body.proposals) ? prop.body.proposals.length : 0;
    const rejected = Array.isArray(prop.body.rejected) ? prop.body.rejected.length : 0;
    if (n > 0) {
      record(`league ${lg.id} proposals`, 'pass',
        `${n} proposal(s) from ${prop.body.source}, ${rejected} rejected by the verifier`,
        `${prop.url} — first opener: ${short(prop.body.proposals[0]?.opener, 120)}`);
    } else if (prop.body.refused) {
      record(`league ${lg.id} proposals`, 'fail',
        `refused: ${prop.body.reason || 'no reason given'}`, prop.url);
    } else {
      record(`league ${lg.id} proposals`, 'fail',
        `none returned (source ${prop.body.source}): ${prop.body.reason || 'no reason given'}`, prop.url);
    }
  } else if (prop.status === 404) {
    record(`league ${lg.id} proposals`, 'fail', '404 — the proposals route is not in the deployed build', prop.url);
  } else if (prop.status === 500 && /trade_proposal_cache/.test(prop.text)) {
    record(`league ${lg.id} proposals`, 'fail',
      '500 — the proposal cache table is missing, so the deployed schema predates migration 060', short(prop.text));
  } else {
    record(`league ${lg.id} proposals`, 'fail', `${prop.status}`, short(prop.text));
  }
} else if (!WITH_PROPOSALS) {
  record('proposals', 'skip', 'pass --proposals to send a real model call (costs money on a cache miss)');
}

const failed = checks.filter(c => c.state === 'fail');
const summary = {
  base: BASE,
  answered: true,
  checked_at: new Date().toISOString(),
  leagues: perLeague,
  passed: checks.filter(c => c.state === 'pass').length,
  failed: failed.length,
  skipped: checks.filter(c => c.state === 'skip').length,
  checks
};

if (AS_JSON) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, against ${BASE}`);
  if (failed.length) console.log(`Still not working: ${failed.map(c => c.name).join(', ')}`);
}

process.exit(failed.length ? 1 : 0);
