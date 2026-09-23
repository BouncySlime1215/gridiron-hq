/**
 * The consensus arm (HX-01): grade a policy's start/sit calls against a consensus source on
 * one common pair set, with C-01's one decision instrument.
 *
 * Reusable by C-01's standing gate and by S-03: hand it rows of one shape,
 *   { season, week, position, player_id, actual, <arm>: value, ... }
 * where every arm is "higher = start" (a rank enters as -rank), and it returns pair accuracy
 * for both arms (house rule, startSitPairAccuracy's), the disagreements oriented to the policy,
 * and C-01's grade of them (gradeDecisions: win rate, points per decision, player-clustered and
 * week-clustered 90% CIs, MDE80). Pre-registration:
 * docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md.
 *
 * It lives in scripts/, not server/: a server module that only a script imports is a blocking
 * wiring finding (scripts/wiring-map.mjs, module-reaches-no-surface). When C-01's gate grows a
 * consensus arm, its owner imports this file or moves it under server/services/gates/.
 *
 * FantasyPros ECR is a BENCHMARK ONLY (FantasyPros Terms of Use: "a single copy made for
 * personal use only"): the rows are read from a local file that is never committed, never
 * served and never printed. Only aggregates leave this module.
 *
 * Sign convention: policy minus baseline. Positive points per decision, a win rate above 0.5
 * and a positive pair-accuracy difference favour the policy.
 */
import { gradeDecisions, pigeonholeBootstrap } from '../server/services/gates/baseline-gate.js';
import { startSitDecisions } from '../server/services/gates/start-sit-gate.js';
import { holm, normalCdf } from '../server/services/stats-util.js';

/** C-01's instrument, pinned by identity in test/historical-consensus-head-to-head.test.js. */
export const GRADER = gradeDecisions;
export const PAIR_BOOTSTRAP = pigeonholeBootstrap;
export const DECISIONS = startSitDecisions;

/** Every consensus source HX-01 considered, and what it may be used for. */
export const CONSENSUS_SOURCES = Object.freeze({
  fantasypros_ecr: Object.freeze({
    kind: 'rank',
    what: 'FantasyPros weekly expert consensus rank, pages weekly-qb/rb/wr/te (PPR pages on the current file)',
    via: 'dynastyprocess/data db_fpecr.parquet (GPL-3.0 repository; the data is FantasyPros\')',
    use: 'benchmark only: read from a local file, never committed, never served, aggregates only',
    history: 'Friday scrapes, 2021-2024 and 2026'
  }),
  espn_weekly: Object.freeze({
    kind: 'points',
    what: 'ESPN\'s weekly projection for rostered players, at lock',
    via: 'league_roster_snapshots.projected_points, source = final (scripts/collect-roster-snapshots.mjs)',
    use: 'first-party to the synced leagues; a benchmark in HX-01',
    history: '2026 only: the app\'s ESPN client reads each league\'s current season only'
  }),
  sleeper_rotowire: Object.freeze({
    kind: 'points',
    what: 'Sleeper weekly projections (RotoWire\'s numbers)',
    via: 'undocumented Sleeper projections endpoint',
    use: 'not used: past-week values are re-stamped after the week, so no historical value can be shown to be pregame',
    history: 'none usable'
  })
});

/** The pre-registered week bands. */
export const WEEK_BANDS = Object.freeze([
  Object.freeze({ band: '2-4', from: 2, to: 4 }),
  Object.freeze({ band: '5-8', from: 5, to: 8 }),
  Object.freeze({ band: '9-13', from: 9, to: 13 }),
  Object.freeze({ band: '14-18', from: 14, to: 18 })
]);

export function weekBand(week) {
  return WEEK_BANDS.find(b => week >= b.from && week <= b.to)?.band ?? null;
}

/** The FantasyPros weekly page each app position is ranked on. */
export const ECR_PAGE_POSITION = Object.freeze({
  'weekly-qb': 'QB', 'weekly-rb': 'RB', 'weekly-wr': 'WR', 'weekly-te': 'TE'
});

const ECR_COLUMNS = ['page_type', 'scrape_date', 'id', 'pos', 'team', 'ecr'];

/** One CSV line into fields: double-quoted fields may hold commas, and "" is a literal quote. */
export function splitCsvLine(line) {
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * The local benchmark export (page_type,scrape_date,id,pos,team,ecr, and optionally player).
 * A row whose ECR is not a number is skipped. `player` is carried only when the file has it
 * (the name cross-check in the runner reads it; nothing else does).
 */
export function parseEcrCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.length);
  const header = splitCsvLine(lines.shift() ?? '');
  const at = Object.fromEntries([...ECR_COLUMNS, 'player'].map(c => [c, header.indexOf(c)]));
  const missing = ECR_COLUMNS.filter(c => at[c] < 0);
  if (missing.length) throw new Error(`ECR file: missing column(s) ${missing.join(', ')}`);
  const out = [];
  for (const line of lines) {
    const f = splitCsvLine(line);
    const ecr = Number(f[at.ecr]);
    if (!Number.isFinite(ecr)) continue;
    const row = { page_type: f[at.page_type], scrape_date: f[at.scrape_date], fp_id: String(f[at.id]),
      pos: f[at.pos], team: f[at.team], ecr };
    if (at.player >= 0) row.player = f[at.player];
    out.push(row);
  }
  return out;
}

/** Regular-season week bounds from game dates: `${season}|${week}` -> { season, week, first, last }. */
export function weekBounds(gameRows, { maxWeek = 18 } = {}) {
  const out = new Map();
  for (const g of gameRows) {
    if (!(g.week >= 1 && g.week <= maxWeek) || !g.gameday) continue;
    const key = `${g.season}|${g.week}`;
    const b = out.get(key) ?? { season: g.season, week: g.week, first: g.gameday, last: g.gameday };
    if (g.gameday < b.first) b.first = g.gameday;
    if (g.gameday > b.last) b.last = g.gameday;
    out.set(key, b);
  }
  return out;
}

const DAY_MS = 86_400_000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The week a scrape dated `date` ranks (prereg §5.2): the week whose last game is on or after
 * the scrape, whose previous week's last game is before it, and whose last game is at most 7
 * days away. Week 1 has no previous week; any other week whose previous week is unknown maps
 * nothing. The earliest such week wins.
 */
export function weekForScrape(date, bounds) {
  let best = null;
  for (const b of bounds.values()) {
    if (b.last < date) continue;
    const gap = daysBetween(date, b.last);
    if (gap > 7) continue;
    if (b.week > 1) {
      const prev = bounds.get(`${b.season}|${b.week - 1}`);
      if (!prev || !(prev.last < date)) continue;
    }
    if (!best || b.last < best.last) best = b;
  }
  return best ? { season: best.season, week: best.week } : null;
}

/** The latest scrape of each week: `${season}|${week}` -> date. Dates that map to no week drop. */
export function latestScrapeByWeek(dates, bounds, { excludeSeasons = [] } = {}) {
  const out = new Map();
  for (const d of dates) {
    const wk = weekForScrape(d, bounds);
    if (!wk || excludeSeasons.includes(wk.season)) continue;
    const key = `${wk.season}|${wk.week}`;
    if (!out.has(key) || d > out.get(key)) out.set(key, d);
  }
  return out;
}

/**
 * Consensus values keyed `${season}|${week}|${player_id}` -> { value: -ecr, ecr, scrape_date }.
 *
 * Order matters and is pinned: the page is read, the scrape is mapped to its week, and a row
 * in an excluded (held-out) season is dropped BEFORE its id is looked up; only then is the
 * week's latest scrape kept, the FantasyPros id mapped to an app player, and the page checked
 * against the app's position.
 *
 * @param idMap       { get(fantasyprosId) -> app player id }
 * @param positionOf  app player id -> app position
 */
export function ecrConsensus(ecrRows, { bounds, idMap, positionOf, excludeSeasons = [] }) {
  const counts = { rows_in: ecrRows.length, not_skill_page: 0, unmapped_week: 0, excluded_season: 0,
    not_latest_scrape: 0, unmapped_player: 0, position_mismatch: 0, duplicate: 0, kept: 0, by_season: {} };
  const staged = [];
  const weekOf = new Map();
  for (const r of ecrRows) {
    const page = ECR_PAGE_POSITION[r.page_type];
    if (!page) { counts.not_skill_page++; continue; }
    if (!weekOf.has(r.scrape_date)) weekOf.set(r.scrape_date, weekForScrape(r.scrape_date, bounds));
    const wk = weekOf.get(r.scrape_date);
    if (!wk) { counts.unmapped_week++; continue; }
    if (excludeSeasons.includes(wk.season)) { counts.excluded_season++; continue; }
    staged.push({ r, page, wk });
  }
  const scrapeByWeek = new Map();
  for (const { r, wk } of staged) {
    const key = `${wk.season}|${wk.week}`;
    if (!scrapeByWeek.has(key) || r.scrape_date > scrapeByWeek.get(key)) scrapeByWeek.set(key, r.scrape_date);
  }
  const values = new Map();
  const weeksBySeason = new Map();
  for (const { r, page, wk } of staged) {
    if (r.scrape_date !== scrapeByWeek.get(`${wk.season}|${wk.week}`)) { counts.not_latest_scrape++; continue; }
    const playerId = idMap.get(r.fp_id);
    if (playerId == null) { counts.unmapped_player++; continue; }
    if (positionOf(playerId) !== page) { counts.position_mismatch++; continue; }
    const key = `${wk.season}|${wk.week}|${playerId}`;
    if (values.has(key)) { counts.duplicate++; continue; }
    values.set(key, { value: -r.ecr, ecr: r.ecr, scrape_date: r.scrape_date });
    counts.kept++;
    if (!weeksBySeason.has(wk.season)) weeksBySeason.set(wk.season, { weeks: new Set(), kept: 0 });
    const s = weeksBySeason.get(wk.season);
    s.weeks.add(wk.week);
    s.kept++;
  }
  for (const [season, s] of [...weeksBySeason].sort(([a], [b]) => a - b)) {
    counts.by_season[season] = { weeks: s.weeks.size, kept: s.kept };
  }
  return { values, scrapeByWeek, counts };
}

/** Each row with its consensus value for the same season, week and player, or null. */
export function withConsensus(rows, values) {
  return rows.map(r => ({ ...r, consensus: values.get(`${r.season}|${r.week}|${r.player_id}`)?.value ?? null }));
}

/**
 * The leak guard (prereg §5.1.3): keep a row only when his team's game is strictly after the
 * scrape date used for his week. Applied to every arm's rows, so all arms grade the same rows.
 *
 * @param gameDateOf (season, week, team) -> 'YYYY-MM-DD' or undefined
 */
export function leakGuard(rows, { scrapeByWeek, gameDateOf }) {
  const out = { kept: [], dropped_game_on_or_before_scrape: 0, no_game_date: 0, no_scrape: 0 };
  for (const r of rows) {
    const scrape = scrapeByWeek.get(`${r.season}|${r.week}`);
    if (!scrape) { out.no_scrape++; continue; }
    const gameDate = gameDateOf(r.season, r.week, r.team_prev);
    if (!gameDate) { out.no_game_date++; continue; }
    if (gameDate > scrape) out.kept.push(r);
    else out.dropped_game_on_or_before_scrape++;
  }
  return out;
}

/**
 * The common pair set (prereg §5.3): every point arm values him at least `threshold`, and the
 * consensus ranks him. A pair is formed only among rows that pass.
 */
export function commonSet(rows, { pointArms, threshold = 4, consensusArm = 'consensus' }) {
  return rows.filter(r => Number.isFinite(r[consensusArm])
    && pointArms.every(a => Number.isFinite(r[a]) && r[a] >= threshold));
}

/** startSitPairAccuracy's rule (promote-early-week-weights.mjs:153): 1, 0, or 0.5 on any tie. */
export function pairScore(vx, vy, ax, ay) {
  return (ax === ay || vx === vy) ? 0.5 : ((vx > vy) === (ax > ay) ? 1 : 0);
}

function pairGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.season}|${r.week}|${r.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/** Every same (season, week, position) pair once, scored for arms p and q. */
export function pairScores(rows, p, q) {
  const out = [];
  for (const list of pairGroups(rows).values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        out.push({ a: x.player_id, b: y.player_id,
          sp: pairScore(x[p], y[p], x.actual, y.actual), sq: pairScore(x[q], y[q], x.actual, y.actual) });
      }
    }
  }
  return out;
}

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Map the rows onto C-01's decision shape, policy = arm p, baseline = arm q. */
function asDecisionRows(rows, p, q) {
  return rows.map(r => ({ season: r.season, week: r.week, position: r.position, player_id: r.player_id,
    policy: r[p], baseline: r[q], actual: r.actual }));
}

/**
 * Policy p against baseline q on rows that are already the common set.
 *
 * `keepWeeks` keeps gradeDecisions' weekly table and failing weeks (the pooled cell); breakout
 * cells drop them. Stops if C-01's pair count or pair accuracy disagrees with this file's.
 */
export function headToHead(rows, p, q, { iterations = 2000, seed = 1, keepWeeks = false } = {}) {
  const decided = DECISIONS(asDecisionRows(rows, p, q), { threshold: -Infinity });
  const scored = pairScores(rows, p, q);
  if (decided.pairs !== scored.length) {
    throw new Error(`pair count: C-01 startSitDecisions ${decided.pairs} vs consensus arm ${scored.length}`);
  }
  const accP = r4(mean(scored.map(s => s.sp)));
  const accQ = r4(mean(scored.map(s => s.sq)));
  if (scored.length && (accP !== decided.pair_accuracy.policy || accQ !== decided.pair_accuracy.baseline)) {
    throw new Error(`pair accuracy: C-01 ${JSON.stringify(decided.pair_accuracy)} vs consensus arm ${accP}/${accQ}`);
  }
  const boot = scored.length
    ? PAIR_BOOTSTRAP(scored.map(s => ({ policy_id: s.a, baseline_id: s.b })), { diff: scored.map(s => s.sp - s.sq) },
      { iterations, seed }).diff
    : { ci90: null, se: null };
  const grade = GRADER(decided.disagreements, { iterations, seed });
  const decisions = { ...grade };
  delete decisions.iterations;
  delete decisions.seed;
  if (!keepWeeks) {
    delete decisions.per_week;
    delete decisions.failing_weeks;
  }
  return {
    policy: p, baseline: q, rows: rows.length, pairs: scored.length,
    agreement_share: decided.agreement_share,
    pair_accuracy: {
      policy: accP, baseline: accQ,
      diff: scored.length ? r4(mean(scored.map(s => s.sp - s.sq))) : null,
      ci90: boot.ci90 ? boot.ci90.map(r4) : null, se: r4(boot.se)
    },
    decisions,
    verdict: cellVerdict(grade)
  };
}

/**
 * The pre-registered cell verdict (prereg §7): ahead needs the player-clustered points bound
 * above 0 AND the player-clustered win-rate bound above 0.5; behind needs the points bound
 * below 0.
 */
export function cellVerdict(grade) {
  if (!grade || !(grade.n > 0)) return 'no_disagreements';
  const points = grade.ci90?.player?.points;
  const winRate = grade.ci90?.player?.win_rate;
  if (Array.isArray(points) && points[0] > 0 && Array.isArray(winRate) && winRate[0] > 0.5) return 'policy_ahead';
  if (Array.isArray(points) && points[1] < 0) return 'baseline_ahead';
  return 'not_distinguishable';
}

/** Two-sided normal p-value of points per decision, from its player-clustered SE. */
export function twoSidedP(grade) {
  const est = grade?.points_per_decision;
  const se = grade?.se?.points;
  if (!Number.isFinite(est) || !(se > 0)) return null;
  return 2 * (1 - normalCdf(Math.abs(est / se)));
}

/**
 * The "where" family (prereg §7.2): Holm over the cells at family alpha; a cell's win or loss
 * counts only when its CI verdict and its Holm-adjusted p agree.
 *
 * @param cells [{ key, grade }] where grade is a gradeDecisions result
 */
export function holmCells(cells, { alpha = 0.10 } = {}) {
  const p = cells.map(c => twoSidedP(c.grade));
  const adjusted = holm(p.map(v => v ?? 1));
  return cells.map((c, i) => {
    const ciVerdict = cellVerdict(c.grade);
    const decided = (ciVerdict === 'policy_ahead' || ciVerdict === 'baseline_ahead') && adjusted[i] < alpha;
    return { key: c.key, p: p[i], p_holm: adjusted[i], ci_verdict: ciVerdict,
      verdict: decided ? ciVerdict : (ciVerdict === 'no_disagreements' ? ciVerdict : 'not_distinguishable') };
  });
}

/**
 * The known-nonzero instrument control (prereg §8.4): a policy that knows the actual points
 * must win every disagreement it has with the baseline, and the baseline against itself must
 * have none. If the oracle finds nothing, these rows cannot show an edge.
 */
export function instrumentControl(rows, baseline) {
  const oracle = DECISIONS(rows.map(r => ({ season: r.season, week: r.week, position: r.position,
    player_id: r.player_id, policy: r.actual, baseline: r[baseline], actual: r.actual })), { threshold: -Infinity })
    .disagreements;
  const identity = DECISIONS(asDecisionRows(rows, baseline, baseline), { threshold: -Infinity }).disagreements;
  const margins = oracle.map(d => d.policy_points - d.baseline_points);
  const o = { n: oracle.length, win_rate: oracle.length ? r4(margins.filter(m => m > 0).length / oracle.length) : null,
    points_per_decision: r4(mean(margins)) };
  // A win rate of exactly 1 already needs at least one disagreement (it is null on none).
  return { oracle: o, identity: { n: identity.length },
    passed: o.win_rate === 1 && o.points_per_decision > 0 && identity.length === 0 };
}

/**
 * Season, week-band and position cells (and season x band, season x position), each a
 * headToHead without the weekly table. Every pair lives inside one (season, week, position),
 * so each family of cells partitions the pooled pairs exactly.
 */
export function breakouts(rows, p, q, opts = {}) {
  const cellOpts = { ...opts, keepWeeks: false };
  const by = keyOf => {
    const groups = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return Object.fromEntries([...groups].map(([key, list]) => [key, headToHead(list, p, q, cellOpts)]));
  };
  return {
    by_season: by(r => r.season),
    by_band: by(r => weekBand(r.week)),
    by_position: by(r => r.position),
    by_season_band: by(r => (weekBand(r.week) ? `${r.season} ${weekBand(r.week)}` : null)),
    by_season_position: by(r => `${r.season} ${r.position}`)
  };
}
