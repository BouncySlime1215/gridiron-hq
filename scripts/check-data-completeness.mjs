/**
 * Does the fantasy platform actually have the data it needs?
 *
 * Written 2026-09-19 because "the source reports ok" and "the table holds rows"
 * are different claims, and the app had been trusting the first. Every nflverse
 * feed reported healthy for months while `player_week_usage` held zero rows for
 * the season being played, because the sync was succeeding at fetching seasons
 * that had not changed.
 *
 * WHAT "EXPECTED" MEANS HERE, because it is a judgement and not a number anyone
 * can read off a source. Three different kinds, and the script never mixes them:
 *
 *   per_season_week  A season-and-week table. Expected is derived from the
 *                    table's OWN completed seasons rather than from a constant
 *                    invented here: take the median row count across completed
 *                    seasons, and require each completed season to hold at least
 *                    FLOOR of that. Self-calibrating, so it stays right when the
 *                    league changes size or a position filter changes. A table
 *                    with fewer than two completed seasons cannot be judged this
 *                    way and says so rather than guessing.
 *   identity         A table of things, not of weeks. Expected is a fill rate on
 *                    the columns other tables join on.
 *   singleton        Model state. Expected is an exact count, usually 0 or 1.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not fetch, write, or repair
 * anything. It reports. Deciding to backfill is a human's call, and at least one
 * gap here (`nfl_qbr_weekly` 2021-2024) is held open ON PURPOSE, because filling
 * it flips the volume-shrinkage promotion gate from pass to fail. A checker that
 * quietly fixed things would have destroyed that.
 *
 *   node scripts/check-data-completeness.mjs
 *   node scripts/check-data-completeness.mjs --json
 *
 * Exits 1 if anything in the `blocks_projections` class is short, 0 otherwise.
 * A `degrades` or `by_design` gap never fails the run; it is printed and
 * explained, because a gap you have decided to live with is not a failure.
 */
import { rows, row } from '../server/db/index.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const COMPLETED_WEEKS = 18;
const FLOOR = 0.8;        // a completed season must hold >= 80% of the median completed season
const CURRENT_FLOOR = 0.5; // the in-progress season is graded per week played, more loosely
/* Only the seasons the models actually train on. game_lines reaches back to
 * 1999, and printing 27 healthy rows above the one that matters is how a real
 * gap gets skimmed past. Widen it here if a model's window ever widens. */
const WINDOW_FROM = SEASON - 5;

/**
 * Weeks of the current season whose games are finished and whose stats should
 * therefore have settled.
 *
 * THIS MUST NOT COME FROM A TABLE BEING CHECKED. The first version of this
 * function read MAX(week) FROM player_week_usage, which is circular: it asked
 * the possibly-broken table how much data it ought to contain. Against a
 * database reproducing the live gap — usage empty for 2026 — it concluded that
 * no weeks had been played and passed the table as healthy. It reported `ok` on
 * the exact defect this script exists to catch.
 *
 * `game_lines` is the independent source: it is populated from the schedule
 * ahead of time, so a missing stats table cannot make it look like the season
 * has not started. A week counts as finished only when nearly every game in it
 * carries a final score, because a week two games into its Sunday has no
 * settled stats and must not be demanded of a stats table yet.
 */
const SETTLED = 0.9;
function weeksPlayed() {
  const wk = rows(`SELECT week, COUNT(*) n, SUM(CASE WHEN team_score IS NOT NULL THEN 1 ELSE 0 END) done
                     FROM game_lines WHERE season = ? GROUP BY week`, SEASON);
  return wk.filter(w => w.n > 0 && w.done / w.n >= SETTLED).length;
}

/**
 * `blocks_projections` — a projection is absent or wrong without it.
 * `degrades`          — a named signal goes quiet; the projection still computes.
 * `by_design`         — empty is the correct state, and why.
 */
const SPEC = [
  /* Severity is per column, not per table, and deliberately so. Only gsis_id
   * actually stops a projection existing; the other two cost a feature each.
   * Calling all three blocking would have made the BLOCKING line fire on a
   * database whose projections were fine, and a checker that cries wolf is one
   * people stop reading. */
  { table: 'players', kind: 'identity', severity: 'mixed',
    why: 'The hinge of the whole chain. Every weekly stat is keyed on gsis_id.',
    fill: [['gsis_id', 0.85, 'blocks_projections', 'weekly usage is keyed on this and is dropped without it'],
           ['espn_id', 0.70, 'degrades', 'the crosswalk matches on this, and the league tools read it'],
           ['sleeper_id', 0.50, 'degrades', 'the injury flag has no other source']] },

  { table: 'player_week_usage', kind: 'per_season_week', severity: 'blocks_projections',
    why: 'Targets, carries and snaps per player-week. The projection is a function of this.' },
  { table: 'player_week_snaps', kind: 'per_season_week', severity: 'blocks_projections',
    why: 'Snap share, which is how the model tells a starter from a rotational player.' },
  { table: 'game_lines', kind: 'per_season_week', severity: 'blocks_projections',
    why: 'Spread and implied total. Without it every game looks like a coin flip at 44 points.' },

  { table: 'nfl_injuries', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'a player ruled out still projects as though he plays' },
  { table: 'nfl_depth', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'no slot or role context, so a backup reads like a starter' },
  { table: 'nfl_snaps', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'participation trend, which the usage features lean on' },
  { table: 'nfl_ngs', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'separation and air-yards signals' },
  { table: 'nfl_ffopportunity_weekly', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'the external expected-points benchmark',
    note: 'Measured 2026-09-19: NOT an input to the shrinkage gate in any amount.' },
  { table: 'nfl_pfr_adv', kind: 'per_season_week', severity: 'degrades', from: 2024,
    degradesWhat: 'pressure and route data',
    note: 'Upstream publishes advstats_week only from 2024. 2021-2023 are 404 at the source, not a local gap.' },
  { table: 'nfl_qbr_weekly', kind: 'per_season_week', severity: 'degrades',
    degradesWhat: 'the QB structural head documented at projections.js:230',
    note: 'The 2021-2024 gap is HELD OPEN ON PURPOSE: filling it flips the volume-shrinkage gate from pass to fail. Report it, do not fill it.' },

  { table: 'shrinkage_fits', kind: 'singleton', severity: 'by_design', expect: 0,
    activeColumn: 'active',
    why: 'Empty means production uses the hand-picked volume constants, which is the current intended state until the promotion runs.' },
  { table: 'weekly_ensemble_fits', kind: 'singleton', severity: 'by_design', expect: 0,
    why: 'Empty means the ensemble weights are the checked-in defaults.' },
];

function completedSeasons(table, from) {
  const floor = Math.max(WINDOW_FROM, Number(from) || 0);
  return rows(`SELECT season, COUNT(*) n, COUNT(DISTINCT week) w FROM ${table}
               WHERE season < ? AND season >= ${floor}
               GROUP BY season ORDER BY season`, SEASON);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

function checkPerSeasonWeek(spec, played) {
  const hist = completedSeasons(spec.table, spec.from);
  const out = { table: spec.table, kind: spec.kind, severity: spec.severity, seasons: [], problems: [] };
  if (hist.length < 2) {
    out.undecidable = `only ${hist.length} completed season(s) present — cannot derive an expectation from history`;
    out.seasons = hist.map(h => ({ season: h.season, rows: h.n, weeks: h.w, expected: null, verdict: 'unknown' }));
    if (hist.length === 0) out.problems.push('no rows in ANY completed season');
    return out;
  }
  const med = median(hist.map(h => h.n));
  for (const h of hist) {
    const need = Math.round(med * FLOOR);
    const short = h.n < need || h.w < COMPLETED_WEEKS;
    out.seasons.push({ season: h.season, rows: h.n, weeks: h.w, expected: `>=${need} rows / ${COMPLETED_WEEKS} weeks`,
      verdict: short ? 'SHORT' : 'ok' });
    if (short) out.problems.push(`${h.season}: ${h.n} rows across ${h.w} weeks, expected >=${need} across ${COMPLETED_WEEKS}`);
  }
  // the season being played, graded against its own completed seasons, pro-rated
  const cur = row(`SELECT COUNT(*) n, COUNT(DISTINCT week) w FROM ${spec.table} WHERE season = ?`, SEASON);
  const perWeek = med / COMPLETED_WEEKS;
  const need = played > 0 ? Math.round(perWeek * played * CURRENT_FLOOR) : 0;
  const short = played > 0 && (cur.n < need);
  out.seasons.push({ season: SEASON, rows: cur.n, weeks: cur.w,
    expected: played > 0 ? `>=${need} rows / ~${played} weeks` : 'nothing played yet',
    verdict: cur.n === 0 && played > 0 ? 'EMPTY' : short ? 'SHORT' : 'ok' });
  if (cur.n === 0 && played > 0) out.problems.push(`${SEASON}: EMPTY while ${played} week(s) have been played`);
  else if (short) out.problems.push(`${SEASON}: ${cur.n} rows, expected >=${need} after ${played} week(s)`);
  return out;
}

function checkIdentity(spec) {
  const total = row(`SELECT COUNT(*) n FROM ${spec.table}`).n;
  const out = { table: spec.table, kind: spec.kind, severity: spec.severity, total, fill: [], problems: [], softProblems: [] };
  if (!total) { out.problems.push('table is empty'); return out; }
  for (const [col, need, sev, why] of spec.fill) {
    const n = row(`SELECT COUNT(*) n FROM ${spec.table} WHERE ${col} IS NOT NULL`).n;
    const rate = n / total;
    const ok = rate >= need;
    out.fill.push({ column: col, filled: n, of: total, rate: +(rate * 100).toFixed(1),
      expected: `>=${need * 100}%`, severity: sev, verdict: ok ? 'ok' : 'SHORT', why });
    if (!ok) {
      (sev === 'blocks_projections' ? out.problems : (out.softProblems ??= []))
        .push(`${col}: ${n}/${total} (${(rate * 100).toFixed(1)}%), expected >=${need * 100}% — ${why}`);
    }
  }
  return out;
}

function checkSingleton(spec) {
  const total = row(`SELECT COUNT(*) n FROM ${spec.table}`).n;
  const out = { table: spec.table, kind: spec.kind, severity: spec.severity, total, expected: spec.expect, problems: [] };
  if (spec.activeColumn) out.active = row(`SELECT COUNT(*) n FROM ${spec.table} WHERE ${spec.activeColumn} = 1`).n;
  if (total !== spec.expect) {
    out.problems.push(`${total} rows, expected ${spec.expect}` +
      (out.active !== undefined ? ` (${out.active} active)` : ''));
  }
  return out;
}

/**
 * Can the weekly tables still find their players?
 *
 * The question this answers is "the live `players` table holds 965 rows where a
 * rebuild from the same sources holds 8,294 — does that cost us history?"
 *
 * NOTE ON THE SCHEMA, because the obvious query is the wrong one.
 * `player_week_usage.player_id` is NOT a gsis_id; it is a foreign key to
 * `players.id`, the local row id. Written as a gsis_id join it returns zero
 * matches for every row and reports a 100% orphan rate on a perfectly healthy
 * database. So there are two different things to measure, and only both
 * together answer the question:
 *
 *   orphans  rows pointing at a players row that is not there. Referential
 *            breakage — real, but it is not what a small players table causes.
 *   distinct the number of players a season actually has rows FOR. A players
 *            table too small to cover retired players does not orphan anything;
 *            it means the rows were never created, which is silent absence and
 *            invisible to an integrity check.
 */
function checkReferential(table) {
  const out = { table, kind: 'referential', severity: 'degrades', seasons: [], problems: [] };
  const totalPlayers = row('SELECT COUNT(*) n FROM players').n;
  for (const r of rows(`SELECT season, COUNT(*) n, COUNT(DISTINCT player_id) players,
                          SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) orphans
                        FROM ${table} u LEFT JOIN players p ON p.id = u.player_id
                        WHERE season >= ? GROUP BY season ORDER BY season`, WINDOW_FROM)) {
    const share = r.n ? r.orphans / r.n : 0;
    out.seasons.push({ season: r.season, rows: r.n, distinctPlayers: r.players,
      orphans: r.orphans, orphanShare: +(share * 100).toFixed(2),
      verdict: share > 0.01 ? 'ORPHANS' : 'ok' });
    if (share > 0.01) out.problems.push(`${r.season}: ${r.orphans}/${r.n} rows (${(share * 100).toFixed(2)}%) point at a players row that is not there`);
  }
  out.playersTotal = totalPlayers;
  return out;
}

const played = weeksPlayed();
const results = [];
for (const spec of SPEC) {
  try {
    results.push(spec.kind === 'identity' ? checkIdentity(spec)
      : spec.kind === 'singleton' ? checkSingleton(spec)
      : checkPerSeasonWeek(spec, played));
  } catch (e) {
    results.push({ table: spec.table, kind: spec.kind, severity: spec.severity,
      problems: [`could not be read: ${e.message}`], error: true });
  }
}

const referential = checkReferential('player_week_usage');
results.push(referential);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ season: SEASON, weeks_played: played, results }, null, 2));
} else {
  console.log(`\nData completeness — season ${SEASON}, ${played} week(s) finished`);
  console.log(`(weeks counted from game_lines final scores, never from a table under test)\n`);
  for (const spec of SPEC) {
    const r = results.find(x => x.table === spec.table);
    const bad = r.problems.length;
    const soft = r.softProblems?.length ?? 0;
    const mark = r.error ? '??' : bad ? (spec.severity === 'by_design' ? '!!' : 'XX') : soft ? '!!' : 'ok';
    console.log(`[${mark}] ${r.table}  (${spec.severity})`);
    if (spec.why) console.log(`     ${spec.why}`);
    if (spec.note) console.log(`     NOTE: ${spec.note}`);
    if (r.undecidable) console.log(`     CANNOT JUDGE: ${r.undecidable}`);
    if (r.seasons) for (const s of r.seasons) {
      console.log(`     ${s.season}  ${String(s.rows).padStart(7)} rows  ${String(s.weeks).padStart(2)} wk   expected ${s.expected ?? '—'}   ${s.verdict}`);
    }
    if (r.fill) for (const f of r.fill) {
      console.log(`     ${f.column.padEnd(12)} ${String(f.filled).padStart(6)}/${f.of}  ${String(f.rate).padStart(5)}%  expected ${f.expected}  ${f.verdict}` +
        (f.verdict === 'SHORT' ? `   (${f.severity === 'blocks_projections' ? 'BLOCKING' : 'degrades'}: ${f.why})` : ''));
    }
    if (r.kind === 'singleton') console.log(`     ${r.total} rows${r.active !== undefined ? `, ${r.active} active` : ''}, expected ${r.expected}`);
    if (bad && spec.severity === 'degrades') console.log(`     IF THIS STAYS SHORT: ${spec.degradesWhat}`);
    console.log('');
  }
  console.log(`[${referential.problems.length ? '!!' : 'ok'}] player_week_usage -> players  (referential)`);
  console.log(`     Can the weekly rows still find their players? players holds ${referential.playersTotal} rows.`);
  console.log(`     Orphans mean breakage; a low DISTINCT count means rows were never created at all.`);
  for (const s2 of referential.seasons) {
    console.log(`     ${s2.season}  ${String(s2.rows).padStart(7)} rows  ${String(s2.distinctPlayers).padStart(4)} distinct players  ${String(s2.orphans).padStart(5)} orphans (${s2.orphanShare}%)  ${s2.verdict}`);
  }
  console.log('');

  const blocking = results.filter(r => r.severity !== 'degrades' && r.severity !== 'by_design' && r.problems.length);
  const degraded = results.filter(r => (r.severity === 'degrades' && r.problems.length) || r.softProblems?.length);
  console.log(blocking.length
    ? `BLOCKING: ${blocking.length} table(s) the projection needs are short — ${blocking.map(r => r.table).join(', ')}`
    : 'BLOCKING: none. Every table the projection needs holds what it should.');
  if (degraded.length) console.log(`DEGRADED: ${degraded.map(r => r.table).join(', ')} — signals quiet, projections still compute.`);
  process.exitCode = blocking.length ? 1 : 0;
}
