#!/usr/bin/env node
/**
 * Build the manager archetype profiles, then (optionally) ask Jev to read them.
 *
 * Three stages, in order, because each depends on the one before:
 *   1. all-play outcomes - by RUNNING scripts/luck-panel.mjs --json, not by
 *      reimplementing it. That script owns the all-play measurement and its
 *      published benchmarks; a second copy here would be a second thing to keep
 *      correct.
 *   2. draft-revealed preference - server/services/manager-archetypes.js.
 *   3. Jev, typed questions over each manager's own draft record, pseudonymised.
 *
 * The report at the end prints the REPEATABILITY of every draft metric before it
 * prints a single manager. A revealed preference that does not reproduce the
 * next season is not a preference, and with 12 league-seasons most of these
 * metrics will not clear that bar. Printing it first is the honest order.
 *
 * Usage:
 *   node scripts/build-manager-archetypes.mjs                # measure only
 *   node scripts/build-manager-archetypes.mjs --jev          # + gateway call
 *   node scripts/build-manager-archetypes.mjs --jev --dry-run  # cost estimate only
 *
 * Jev needs AI_GATEWAY_API_KEY, which lives in .env.local and is NOT read
 * automatically:
 *   node --env-file-if-exists=.env.local scripts/build-manager-archetypes.mjs --jev
 */
process.env.SCHEDULER_DISABLED = '1';
import { execFileSync } from 'node:child_process';
import { printJsonThenExit } from './lib/flush-then-exit.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WANT_JEV = argv.includes('--jev');
const DRY_RUN = argv.includes('--dry-run');
const AS_JSON = argv.includes('--json');
// Jev is billed on input tokens; the chat classifier measured $0.042 per million.
const USD_PER_MTOK = 0.042;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 1.0);

const {
  buildManagerArchetypes, metricRepeatability, splitHalfReliability, managerProfile,
  jevStateFor, storeJevAnswers, JEV_QUESTIONS, MANAGER_ARCHETYPE_VERSION,
} = await import(path.join(REPO, 'server/services/manager-archetypes.js'));
const { rows } = await import(path.join(REPO, 'server/db/index.js'));

// ---------------------------------------------------------------- 1. outcomes
let luckPanel = null;
try {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/luck-panel.mjs'), '--json'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  luckPanel = JSON.parse(out);
} catch (e) {
  // Not fatal, and not papered over: the outcome half is simply absent and the
  // report says so.
  console.error(`luck-panel.mjs failed (${String(e.message).slice(0, 200)}) - outcome metrics will be missing`);
}

// ------------------------------------------------------------- 2. measurement
const summary = buildManagerArchetypes({ luckPanel });
const reliability = splitHalfReliability(summary.detail);
const repeatability = metricRepeatability({ reliability });

const fmt = v => (v == null ? '   -  ' : (v >= 0 ? ' ' : '') + v.toFixed(2));
const owners = new Map(rows(`SELECT espn_member_id, owner_name, MAX(season) AS s
                             FROM league_season_teams WHERE espn_member_id IS NOT NULL
                             GROUP BY espn_member_id`).map(r => [r.espn_member_id, r.owner_name]));

if (!AS_JSON) {
  console.log(`\n=== manager archetypes (${MANAGER_ARCHETYPE_VERSION}) ===`);
  console.log(`${summary.league_seasons} league-seasons, ${summary.managers} managers, `
    + `${summary.draft_manager_seasons} manager-seasons of draft data, `
    + `${summary.outcome_manager_seasons} with outcomes, ${summary.rows_written} metric rows`);
  console.log(`consensus source by season: ${JSON.stringify(summary.consensus_sources)}`);
  if (!luckPanel) console.log('OUTCOMES MISSING: all-play, luck and record metrics were not computed this run');

  console.log(`\n--- metric repeatability (does the same person reproduce it next season?) ---`);
  console.log('  metric                             pairs   yoy r   90% interval   spear   worstLOO  reliab');
  for (const m of repeatability) {
    if (m.n_pairs < 6) continue;
    const ci = m.yoy_r_lo == null ? '      -       ' : `[${fmt(m.yoy_r_lo)},${fmt(m.yoy_r_hi)}]`;
    console.log(`  ${m.metric.padEnd(33)} ${String(m.n_pairs).padStart(5)}  ${fmt(m.year_over_year_r)}  ${ci}`
      + `  ${fmt(m.yoy_spearman)}   ${fmt(m.yoy_r_min_loo)}    ${fmt(m.reliability)}`);
  }
  console.log('  spear/worstLOO: the two columns that decide whether a yoy r is a TRAIT or a PERSON.');
  console.log('          worstLOO drops each manager\'s pairs in turn and keeps the worst r. The cluster');
  console.log('          bootstrap cannot catch this: a manager with four seasons in one league sits in');
  console.log('          three of the seven clusters and is resampled into almost every draw.');
  console.log('  yoy r: same manager, same league, consecutive seasons; interval bootstraps');
  console.log('         league-season CLUSTERS, which is the unit of inference here.');
  console.log('  reliab: two balanced halves of the SAME draft (rounds 1,4,5,8 vs 2,3,6,7),');
  console.log('          Spearman-Brown corrected. A metric');
  console.log('          that cannot reproduce itself within one draft cannot be expected to across years,');
  console.log('          and its yoy zero is uninformative rather than a finding.');
  console.log('  between: share of variance between managers rather than within one manager.');

  console.log(`\n--- managers, career ---`);
  console.log('  manager              szn  picks   auto  slot-cons   sd  risk  brand  homer  all-play   luck');
  const careers = rows(`SELECT DISTINCT member_id FROM manager_archetypes
                        WHERE league_id = 0 AND season = 0 AND version = ?`, MANAGER_ARCHETYPE_VERSION);
  const table = careers.map(({ member_id }) => {
    const p = managerProfile(member_id).seasons.career ?? { metrics: {}, samples: {} };
    return { member_id, m: p.metrics, n: p.samples };
  }).sort((a, b) => (b.m.picks_n ?? 0) * (b.m.seasons_observed ?? 0) - (a.m.picks_n ?? 0) * (a.m.seasons_observed ?? 0));
  for (const t of table) {
    const who = (owners.get(t.member_id) ?? t.member_id).slice(0, 19);
    console.log(`  ${who.padEnd(20)} ${String(t.m.seasons_observed ?? 0).padStart(3)}`
      + ` ${String(t.n.picks_n ?? 0).padStart(6)}`
      + ` ${fmt(t.m.auto_draft_rate)}  ${fmt(t.m.pick_minus_consensus_mean)}`
      + ` ${fmt(t.m.pick_minus_consensus_sd)} ${fmt(t.m.risk_prior_fp_cv_excess)}`
      + ` ${fmt(t.m.name_brand_premium_excess)} ${fmt(t.m.homer_top_team_share)}`
      + `   ${fmt(t.m.all_play)} ${fmt(t.m.luck_wins)}`);
  }
  console.log('  slot-cons = board slot minus consensus rank IN ROUNDS (+ = waited, - = reached); sd = its spread');
  console.log('  risk = prior-season weekly scoring CV of his picks vs his league average (+ = more erratic)');
  console.log('  brand = how far his picks had fallen in consensus since last year vs league average');
  console.log('  luck = wins his record gained over his all-play rate; + = he is priced above his roster');
}

// -------------------------------------------------------------------- 3. Jev
let jevReport = null;
if (WANT_JEV) {
  const eligible = rows(`SELECT member_id, value AS seasons FROM manager_archetypes
                         WHERE league_id = 0 AND season = 0 AND metric = 'seasons_observed' AND version = ?`,
  MANAGER_ARCHETYPE_VERSION);
  // Pseudonyms are assigned here and never leave the machine; see jevStateFor.
  const states = eligible.map((e, i) => {
    const alias = `M${String(i + 1).padStart(2, '0')}`;
    return { ...e, alias, ...jevStateFor(e.member_id, alias, summary.detail) };
  }).filter(s => s.n_picks >= 8);

  const chars = states.reduce((a, s) => a + s.state.length, 0);
  // ~4 characters per token, plus the fixed question block (~900 tokens) once
  // per call. Deliberately an over-estimate: better to refuse a run that would
  // have been cheap than to spend money the estimate said was free.
  const estTokens = Math.round(chars / 4 + states.length * 900);
  const estUsd = (estTokens / 1e6) * USD_PER_MTOK;
  console.log(`\n--- Jev ---`);
  console.log(`${states.length} managers, ${chars.toLocaleString()} state chars, `
    + `~${estTokens.toLocaleString()} input tokens, ESTIMATED COST ~$${estUsd.toFixed(4)} (budget $${MAX_USD})`);
  if (estUsd > MAX_USD) { console.log('estimate exceeds budget - not calling the gateway'); process.exit(1); }
  if (DRY_RUN) {
    console.log('\n--- dry run: state for the first manager ---\n');
    console.log(states[0]?.state ?? '(none)');
    process.exit(0);
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log('AI_GATEWAY_API_KEY is not set - source .env.local first '
      + '(node --env-file-if-exists=.env.local ...). Not calling the gateway.');
    process.exit(1);
  }

  const { experimental_evaluate: evaluate } = await import('ai');
  const questions = Object.fromEntries(Object.entries(JEV_QUESTIONS)
    .map(([k, q]) => [k, { type: q.type, instructions: q.instructions, criteria: q.criteria }]));
  let ok = 0, failed = 0, tokens = 0;
  for (const s of states) {
    try {
      const result = await evaluate({ model: 'typesafe-ai/jev', state: s.state, questions });
      storeJevAnswers(s.member_id, result.answers, {
        nSeasons: s.n_seasons, nPicks: s.n_picks, stateChars: s.state.length, model: 'typesafe-ai/jev',
      });
      tokens += result?.usage?.inputTokens ?? 0;
      ok++;
    } catch (err) {
      failed++;
      const msg = String(err?.message ?? err);
      console.log(`  ${s.alias} failed: ${msg.slice(0, 160)}`);
      if (/authentication|not have access|free tier|insufficient/i.test(msg)) break;
    }
    if ((tokens / 1e6) * USD_PER_MTOK > MAX_USD) { console.log('budget reached - stopping'); break; }
  }
  const usd = (tokens / 1e6) * USD_PER_MTOK;
  jevReport = { managers: states.length, ok, failed, input_tokens: tokens, usd: +usd.toFixed(4) };
  console.log(`Jev: ${ok} profiled, ${failed} failed, ${tokens.toLocaleString()} input tokens (~$${usd.toFixed(4)})`);

  if (!AS_JSON && ok) {
    console.log(`\n  manager              risk  recency  position bias        info speed          [basis]`);
    for (const s of states) {
      const j = managerProfile(s.member_id).jev;
      if (!Object.keys(j).length) continue;
      const top = q => {
        const p = j[q]?.p ?? {};
        const best = Object.entries(p).filter(([k]) => k !== 'mean').sort((a, b) => b[1] - a[1])[0];
        return best ? `${best[0]} ${(best[1] * 100).toFixed(0)}%` : '-';
      };
      const who = (owners.get(s.member_id) ?? s.alias).slice(0, 19);
      console.log(`  ${who.padEnd(20)} ${fmt(j.risk_appetite?.p?.mean)} ${fmt(j.recency_bias?.p?.mean)}`
        + `   ${top('position_bias').padEnd(20)} ${top('information_speed').padEnd(20)}`
        + ` [${j.information_speed?.basis ?? '-'}]`);
    }
    console.log('  risk/recency are 0-4 score means. information_speed and trade_style are');
    console.log('  basis=inference_only: no transaction history exists yet for them to rest on.');

    // Does a Jev answer distinguish between people at all? A question where 44
    // of 45 managers get the same argmax and the probabilities barely move is
    // not profiling anybody; it is reporting the prior once per manager. Worth
    // more than the answers themselves, because a degenerate column read as a
    // measurement is how a profile starts lying.
    const profiles = states.map(s => ({ s, jev: managerProfile(s.member_id).jev }))
      .filter(x => Object.keys(x.jev).length);
    console.log(`\n  --- do these answers discriminate between managers? (n=${profiles.length}) ---`);
    console.log('  question                    modal answer         share  max sd  basis');
    for (const q of Object.keys(JEV_QUESTIONS)) {
      const dists = profiles.map(x => x.jev[q]?.p ?? {});
      const keys = [...new Set(dists.flatMap(d => Object.keys(d)))].filter(k => k !== 'mean');
      if (!keys.length) continue;
      const sdOf = k => {
        const vals = dists.map(d => d[k]).filter(Number.isFinite);
        if (vals.length < 3) return 0;
        const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.sqrt(vals.reduce((a, v) => a + (v - mu) ** 2, 0) / (vals.length - 1));
      };
      const argmaxes = dists.map(d => Object.entries(d).filter(([k]) => k !== 'mean')
        .sort((a, b) => b[1] - a[1])[0]?.[0]).filter(Boolean);
      const counts = argmaxes.reduce((a, k) => { a[k] = (a[k] ?? 0) + 1; return a; }, {});
      const [modal, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? ['-', 0];
      const maxSd = Math.max(...keys.map(sdOf));
      console.log(`  ${q.padEnd(28)}${String(modal).padEnd(20)} ${(count / argmaxes.length).toFixed(2)}`
        + `   ${maxSd.toFixed(3)}  ${JEV_QUESTIONS[q].basis}`);
    }
    console.log('  share = fraction of managers whose top answer is the modal one. A share near 1.00');
    console.log('  with a small sd means the question was answered from the prompt, not the manager.');

    // And where a Jev score has a measured counterpart, do they agree? Jev was
    // handed the measurement, so disagreement means one of them is noise - and
    // the repeatability table above already says which of the measurements are.
    const corr = (a, b) => {
      const pairs = profiles.map(x => [a(x), b(x)]).filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));
      if (pairs.length < 8) return null;
      const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
      const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      return sxx && syy ? { r: sxy / Math.sqrt(sxx * syy), n: pairs.length } : null;
    };
    const careerOf = x => managerProfile(x.s.member_id).seasons.career?.metrics ?? {};
    const checks = [
      ['risk_appetite score', 'risk_prior_fp_cv_excess',
        x => x.jev.risk_appetite?.p?.mean, x => careerOf(x).risk_prior_fp_cv_excess],
      ['recency_bias score', 'name_brand_premium_excess',
        x => x.jev.recency_bias?.p?.mean, x => careerOf(x).name_brand_premium_excess],
      ['information_speed set_and_forget', 'auto_draft_rate',
        x => x.jev.information_speed?.p?.set_and_forget, x => careerOf(x).auto_draft_rate],
    ];
    console.log('\n  --- does Jev track the numbers it was given? ---');
    for (const [label, against, fa, fb] of checks) {
      const c = corr(fa, fb);
      console.log(`  ${label.padEnd(34)} vs ${against.padEnd(26)} r = ${c ? c.r.toFixed(2) : '-'} (n=${c?.n ?? 0})`);
    }
  }
}

if (AS_JSON) {
  // This report is CAPTURED — server/services/scheduler.js:637 reads it through
  // execFile. `console.log` then `process.exit(0)` loses its tail, and the
  // report grows with the number of leagues, so it moves towards that cliff.
  // printJsonThenExit exits once the bytes have actually left the process.
  printJsonThenExit({
    summary: { ...summary, detail: undefined },
    repeatability,
    reliability,
    jev: jevReport,
  });
}
// The human path only. It prints many small lines rather than one large report,
// and no parent captures this script without --json; left as it was so this
// change is the machine path and nothing else.
process.exit(0);
