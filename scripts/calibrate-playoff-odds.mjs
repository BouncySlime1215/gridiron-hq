/**
 * Are a week-w playoff probability's numbers right? Nobody had ever checked.
 *
 * `season-sim.js` publishes playoff and title percentages on League Hub, and
 * `trade-verify.js:78-90` bounds only their Monte Carlo NOISE -- how much the
 * number moves between runs of the same simulation. Nothing in this repository
 * has ever compared such a probability against what actually happened. A
 * simulation can be perfectly stable and perfectly wrong, and a percentage that
 * has never been graded is a number with a decimal point and no evidence.
 *
 * WHAT THIS GRADES, AND WHAT IT CANNOT. It grades the MACHINERY: from the games
 * played through week w, simulate every remaining scheduled game by resampling
 * each team's own observed weekly scores, seed the league as Sleeper does (wins,
 * then points for), and read off how often each team qualifies. That is
 * `season-sim.js`'s structure with one substitution -- empirical team-week draws
 * where the app uses per-player projections -- so what comes out is a calibration
 * of the simulate-and-count step and of the bracket logic, on real finishes.
 *
 * It is NOT a calibration of the app's projections, and cannot be: these are
 * Sleeper leagues, `players.sleeper_id` covers 751 of 8,556 players, and a roster
 * priced off an 8.8% crosswalk would be measuring the crosswalk. Where the app's
 * own number is worse than this one, the projections are the difference; where it
 * is better, the projections are earning something. This establishes the floor,
 * not the app's score, and the distinction is the whole point of running it.
 *
 * NOTHING IS FITTED HERE. The resampler has no parameters, so there is no
 * fit-and-test split to get wrong and no season is held out: every league-season
 * in the corpus is a test case. That is a property worth stating rather than a
 * corner cut -- a per-season breakdown is printed so instability is visible.
 *
 *   node scripts/calibrate-playoff-odds.mjs                 # every season, 200 sims
 *   node scripts/calibrate-playoff-odds.mjs --sims 500 --seasons 2024,2025
 *   node scripts/calibrate-playoff-odds.mjs --json          # machine-readable
 *
 * Reads the corpus and nothing else. Writes nothing, anywhere.
 */
import { historyStatus, regularSeasonWeeks, weeklyPanel, varianceComponents }
  from '../server/services/history-corpus.js';
import { fitOutlook, predictOutlook, OUTLOOK_GATE } from '../server/services/team-outlook.js';
import { brierScore, reliabilityBins } from '../server/services/calibration-metrics.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SIMS = Number(flag('sims', 200));
const JSON_OUT = argv.includes('--json');
const SEASONS = flag('seasons') ? flag('seasons').split(',').map(Number) : null;
const LEAGUE_CAP = flag('leagues') ? Number(flag('leagues')) : null;
const NO_OUTLOOK = argv.includes('--no-outlook');
const EVAL_WEEKS = [2, 3, 4, 5, 6, 7, 8];
const BINS = 10;
const MIN_OBSERVATIONS = 2;   // a bootstrap needs at least two draws to be a distribution
const MIN_REMAINING = 1;      // and at least one unplayed game, or there is nothing to simulate

const status = historyStatus();
if (!status.available) {
  console.error(`REFUSED: ${status.reason}`);
  process.exit(1);
}

const raw = regularSeasonWeeks(SEASONS);
if (!raw.length) { console.error('REFUSED: the corpus produced no regular-season weeks.'); process.exit(1); }

// The panel supplies the standings at week w -- `wins_so_far` and `points_so_far` are
// exactly what a seed reads -- so this script never recomputes head-to-head itself.
const panel = weeklyPanel({ rows: raw });
const standing = new Map();
for (const p of panel) standing.set(`${p.league_id}|${p.roster_id}|${p.week}`, p);

/**
 * The fitted alternative, graded on the same rows: `team-outlook.js`'s logistic on
 * league-relative features. LEAVE ONE SEASON OUT -- for each graded season the model is
 * fitted on the others and predicts that one -- because an in-sample fit would flatter it
 * against a simulator that fits nothing, and the comparison would be worthless.
 *
 * This is here because "is the Monte Carlo or the fitted model better at week w" is the
 * question a reader actually has, and answering it costs one fit per season.
 */
const outlookP = new Map();
if (!NO_OUTLOOK) {
  const allSeasons = [...new Set(panel.map(r => r.season))].sort();
  for (const held of allSeasons) {
    const fitRows = panel.filter(r => r.season !== held);
    const testRows = panel.filter(r => r.season === held);
    if (!fitRows.length || !testRows.length) continue;
    const vc = varianceComponents({ panel: fitRows });
    if (!vc || !vc.between_positive) continue;
    const fit = fitOutlook({ panel: fitRows, k: vc.k, weeks: EVAL_WEEKS, l2: OUTLOOK_GATE.l2 });
    if (!fit?.weeks?.length) continue;
    for (const r of testRows) {
      const p = predictOutlook(fit, r);
      if (p != null) outlookP.set(`${r.league_id}|${r.roster_id}|${r.week}`, p);
    }
  }
}

const leagues = new Map();
for (const r of raw) {
  const lg = leagues.get(r.league_id) ?? {
    league_id: r.league_id, season: r.season, num_teams: r.num_teams,
    playoff_teams: r.playoff_teams, teams: new Map(), weeks: new Set()
  };
  const team = lg.teams.get(r.roster_id) ?? { roster_id: r.roster_id, byWeek: new Map(), made_playoffs: r.made_playoffs ? 1 : 0 };
  team.byWeek.set(r.week, r);
  lg.teams.set(r.roster_id, team);
  lg.weeks.add(r.week);
  leagues.set(r.league_id, lg);
}
const leagueList = [...leagues.values()]
  .filter(lg => lg.playoff_teams > 0 && lg.playoff_teams < lg.teams.size)
  .slice(0, LEAGUE_CAP ?? undefined);

/** Mulberry32: deterministic, so two runs of this script agree. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pairs = [];                       // { season, week, p, y, in_cut_now }
let leagueWeeksGraded = 0, leagueWeeksSkipped = 0;

for (const lg of leagueList) {
  const weeks = [...lg.weeks].sort((a, b) => a - b);
  const lastWeek = weeks[weeks.length - 1];
  const rosterIds = [...lg.teams.keys()];

  for (const w of EVAL_WEEKS) {
    if (lastWeek - w < MIN_REMAINING) { leagueWeeksSkipped++; continue; }

    // Each team's observations through w, and its standing at w.
    const observed = new Map(), wins0 = new Map(), points0 = new Map();
    let usable = true;
    for (const id of rosterIds) {
      const team = lg.teams.get(id);
      const seen = [];
      for (const [week, row] of team.byWeek) if (week <= w) seen.push(row.points);
      const st = standing.get(`${lg.league_id}|${id}|${w}`);
      if (seen.length < MIN_OBSERVATIONS || !st) { usable = false; break; }
      observed.set(id, seen);
      wins0.set(id, st.wins_so_far);
      points0.set(id, st.points_so_far);
    }
    if (!usable) { leagueWeeksSkipped++; continue; }

    // The remaining schedule, each matchup once. Known ex ante: these are fixed
    // schedules, so using them at week w leaks nothing about the outcomes.
    const remaining = [];
    for (const week of weeks) {
      if (week <= w) continue;
      const seenPair = new Set();
      for (const id of rosterIds) {
        const row = lg.teams.get(id).byWeek.get(week);
        const opp = row?.opponent_roster_id;
        if (opp == null || !lg.teams.has(opp)) continue;
        const key = id < opp ? `${id}|${opp}` : `${opp}|${id}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        remaining.push([id, opp]);
      }
    }
    if (!remaining.length) { leagueWeeksSkipped++; continue; }

    const qualified = new Map(rosterIds.map(id => [id, 0]));
    const rand = rng(Number(String(lg.league_id).slice(-9)) + w * 7919);
    const wins = new Map(), points = new Map();
    for (let s = 0; s < SIMS; s++) {
      for (const id of rosterIds) { wins.set(id, wins0.get(id)); points.set(id, points0.get(id)); }
      for (const [a, b] of remaining) {
        const oa = observed.get(a), ob = observed.get(b);
        const sa = oa[(rand() * oa.length) | 0], sb = ob[(rand() * ob.length) | 0];
        points.set(a, points.get(a) + sa);
        points.set(b, points.get(b) + sb);
        if (sa > sb) wins.set(a, wins.get(a) + 1);
        else if (sb > sa) wins.set(b, wins.get(b) + 1);
        else { wins.set(a, wins.get(a) + 0.5); wins.set(b, wins.get(b) + 0.5); }
      }
      const order = rosterIds.slice().sort((x, y) =>
        (wins.get(y) - wins.get(x)) || (points.get(y) - points.get(x)));
      for (let i = 0; i < lg.playoff_teams; i++) qualified.set(order[i], qualified.get(order[i]) + 1);
    }

    // The naive comparison: whoever is inside the cut right now.
    const nowOrder = rosterIds.slice().sort((x, y) =>
      (wins0.get(y) - wins0.get(x)) || (points0.get(y) - points0.get(x)));
    const inCutNow = new Set(nowOrder.slice(0, lg.playoff_teams));

    for (const id of rosterIds) {
      pairs.push({
        season: lg.season, week: w,
        p: qualified.get(id) / SIMS,
        y: lg.teams.get(id).made_playoffs,
        base: lg.playoff_teams / lg.teams.size,
        in_cut_now: inCutNow.has(id) ? 1 : 0,
        outlook: outlookP.get(`${lg.league_id}|${id}|${w}`) ?? null
      });
    }
    leagueWeeksGraded++;
  }
}

// Both metrics come from server/services/calibration-metrics.js, which has its own
// tests: the conclusion below rests on them, and a function that only ever runs
// against these 184,959 rows is one nobody can show failing.
const brier = rows => brierScore(rows);
const brierOf = (rows, pick) => brierScore(rows, pick);
const reliability = rows => reliabilityBins(rows, BINS)
  .map(b => ({ ...b, observed: +b.observed.toFixed(4) }));

const summarise = rows => {
  const bins = reliability(rows);
  return {
    n: rows.length,
    brier: +brier(rows).toFixed(5),
    brier_base_rate: +brierOf(rows, r => r.base).toFixed(5),
    brier_current_cut: +brierOf(rows, r => r.in_cut_now).toFixed(5),
    observed_rate: +(rows.reduce((s, r) => s + r.y, 0) / rows.length).toFixed(4),
    mean_predicted: +(rows.reduce((s, r) => s + r.p, 0) / rows.length).toFixed(4),
    max_bin_gap: +Math.max(...bins.map(b => Math.abs(b.predicted - b.observed))).toFixed(4),
    bins,
    ...outlookBlock(rows)
  };
};

/** The fitted model's score on exactly the rows where it produced a probability. */
function outlookBlock(rows) {
  const scored = rows.filter(r => r.outlook != null);
  if (!scored.length) return { outlook: null };
  const asOutlook = scored.map(r => ({ ...r, p: r.outlook }));
  const bins = reliability(asOutlook);
  return {
    outlook: {
      n: scored.length,
      brier: +brier(asOutlook).toFixed(5),
      brier_simulation_same_rows: +brier(scored).toFixed(5),
      mean_predicted: +(scored.reduce((s, r) => s + r.outlook, 0) / scored.length).toFixed(4),
      max_bin_gap: +Math.max(...bins.map(b => Math.abs(b.predicted - b.observed))).toFixed(4)
    }
  };
}

const report = {
  sims: SIMS, eval_weeks: EVAL_WEEKS, bins: BINS,
  corpus: { leagues: status.leagues, team_seasons: status.team_seasons,
    seasons: status.seasons.map(s => s.season) },
  league_weeks_graded: leagueWeeksGraded, league_weeks_skipped: leagueWeeksSkipped,
  overall: summarise(pairs),
  by_week: Object.fromEntries(EVAL_WEEKS
    .map(w => [w, pairs.filter(r => r.week === w)])
    .filter(([, rows]) => rows.length)
    .map(([w, rows]) => [w, summarise(rows)])),
  by_season: Object.fromEntries([...new Set(pairs.map(r => r.season))].sort()
    .map(season => [season, summarise(pairs.filter(r => r.season === season))]))
};

if (JSON_OUT) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

console.log(`corpus: ${report.corpus.leagues} leagues, seasons ${report.corpus.seasons.join(', ')}`);
console.log(`graded ${leagueWeeksGraded} league-weeks (${pairs.length} team-weeks), `
  + `skipped ${leagueWeeksSkipped}; ${SIMS} sims each\n`);
console.log('week      n   Brier   base   cut   mean p   observed   worst gap   fitted   fitted gap');
for (const [w, s] of Object.entries(report.by_week)) {
  const o = s.outlook;
  console.log(`  ${String(w).padStart(2)} ${String(s.n).padStart(7)}  ${s.brier.toFixed(4)}  `
    + `${s.brier_base_rate.toFixed(4)}  ${s.brier_current_cut.toFixed(4)}  `
    + `${s.mean_predicted.toFixed(4)}   ${s.observed_rate.toFixed(4)}      ${s.max_bin_gap.toFixed(4)}`
    + (o ? `   ${o.brier.toFixed(4)}   ${o.max_bin_gap.toFixed(4)}` : '        -        -'));
}
console.log('\nby season');
for (const [season, s] of Object.entries(report.by_season)) {
  console.log(`  ${season}  n ${String(s.n).padStart(7)}  Brier ${s.brier.toFixed(4)} `
    + `(base ${s.brier_base_rate.toFixed(4)})  worst bin gap ${s.max_bin_gap.toFixed(4)}`);
}
console.log('\nreliability, all weeks pooled (equal-count bins)');
console.log('  predicted  observed      n');
for (const b of report.overall.bins) {
  console.log(`   ${b.predicted.toFixed(4)}    ${b.observed.toFixed(4)}  ${String(b.n).padStart(7)}`);
}
console.log(`\noverall Brier ${report.overall.brier} against ${report.overall.brier_base_rate} `
  + `for the league's base rate and ${report.overall.brier_current_cut} for "whoever is in the cut now".`);
