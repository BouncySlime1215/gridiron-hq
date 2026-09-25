/**
 * BROKEN-01a: the number audit. Which numbers the app shows are broken right now,
 * per league, in plain words.
 *
 * Two kinds of check, both over one per-league SNAPSHOT of what the app's own
 * producers answer today:
 *
 *  1. Duplicate producers (BROKEN-NUMBERS.md rows A-E and H; ENGINE-ARCHITECTURE
 *     §10.2). The same number is computed in more than one place; each copy is
 *     read here and a disagreement past a tolerance is a 'broken' row naming the
 *     pages on both sides.
 *       A projection_basis   the rate the title sim's world centres each player on vs
 *                            the finder's rest-of-season rate (season-sim.js
 *                            prepareSeason vs trade-engine.js buildAssetUniverse; BASIS-02)
 *       B title_odds_paths   My team's /simulate, Trade Lab/TradeCard's tradeImpact
 *                            world, the finder's horizon sim (myPlayoffOdds)
 *       C weekly_range       one lineup-week's range from the four samplers
 *                            (trade card lineupSpread, season-sim pools, ceiling
 *                            lineup, lineup posture)
 *       D current_week       tradeWeekContext vs leagueCurrentWeek vs simStartWeek
 *       E p_play_default     rostered players priced on the `?? 0.92` default, and
 *                            chance-to-play differing between the two callers
 *       H checked_out        activity.manager (engine state) beside checkedOutFactor
 *  2. Invariants on served numbers: probabilities in [0,1], title odds summing to 1
 *     and playoff odds to the league's playoff spots, ordered ranges, no NaN, and
 *     each source's data age against its max.
 *
 * Rows F and G (three player values, three "this week" numbers) are labelling
 * problems with no tolerance to test; they stay on the inventory until EA-07.
 *
 * WHERE IT RUNS: only in the refresh loop (scripts/refresh-live-data.mjs), never in
 * the web server. The web process reads `number_audit` through readNumberAudit and
 * recomputes nothing; the heavy producers are imported lazily inside
 * collectLeagueSnapshot so the route's import of this file stays cheap.
 *
 * A producer that throws or answers with an error is not skipped: its check is a
 * 'warn' row that says it could not be measured and why.
 */
import { db } from '../db/index.js';

export const TOLERANCES = Object.freeze({
  // Two paths' odds for the same team, in percentage points. Two independent 1,200-1,500
  // run sims differ by ~1.8 pts (sd) at p = 0.3 from Monte Carlo alone; 4 is ~2.3 sd.
  title_odds_pts: 4,
  playoff_odds_pts: 5,
  rank_corr_min: 0.9,       // Spearman of the two projection bases over rostered players
  range_pts: 10,            // spread of one lineup-week's p10 (or p90) across samplers
  p_play_gap: 0.10,         // chance-to-play gap between two callers, same player-week
  title_sum: 0.02,          // |sum of title odds - 1|
  playoff_sum: 0.05,        // |sum of playoff odds - playoff spots|
});

/**
 * Every check: its plain-English title, the inventory row it measures, the cause
 * as the code has it, and what to trust while it is broken.
 */
export const CHECKS = Object.freeze({
  title_odds_paths: {
    row: 'B', title: 'Title odds differ between pages',
    cause: 'Three separate simulations with their own caches and random seeds (My team uses a fresh random world per server start; Trade Lab uses one seed per sync; the trade finder its own fixed seed).',
    trust: 'Use the Trade Lab / TradeCard number for decisions: it is repeatable on the same sync. Treat gaps of a few points as noise.',
  },
  projection_basis: {
    row: 'A', title: 'Title tab and trade finder rank players differently',
    cause: 'The title simulator prices players on last season\'s projections (rescaled only when the rest-of-season basis is on, and players with no last-season projection are not simulated); the trade finder uses this season\'s rest-of-season rate.',
    trust: 'For who helps you, trust the trade finder\'s rest-of-season numbers; read title odds as last-season-based until EA-07.',
  },
  weekly_range: {
    row: 'C', title: 'Weekly ranges differ between pages',
    cause: 'Four separate samplers for one lineup-week (trade card, season sim, ceiling lineup, lineup posture), with different inputs and methods.',
    trust: 'Use the trade card\'s range (this week\'s chance to play included); read the others as rough.',
  },
  current_week: {
    row: 'D', title: 'Pages disagree on the current week',
    cause: 'Three week producers: the NFL schedule\'s next unplayed week (trade engine), the league\'s own week, and the simulator\'s start week.',
    trust: 'The league\'s own week (League Hub) is the one your matchups use.',
  },
  p_play_default: {
    row: 'E', title: 'Chance to play is guessed for some players',
    cause: 'Players with no availability read are priced at a 92% default (trade-engine.js, season-sim.js), and the callers ask for different weeks.',
    trust: 'Check the news for the listed players before starting or trading for them.',
  },
  checked_out: {
    row: 'H', title: 'Two "checked out" signals at once',
    cause: 'activity.manager (engine) and checkedOutFactor (counterparty pricing) both nudge receptiveness for the same dead starts.',
    trust: 'Read Trade Brain\'s receptiveness as slightly overstated against managers who left a dead starter in.',
  },
  inv_probability_range: {
    row: null, title: 'A probability is outside 0-100%',
    cause: 'A served odds value is below 0 or above 1.',
    trust: 'Do not use the affected odds until the next refresh clears this.',
  },
  inv_odds_sum: {
    row: null, title: 'League odds do not add up',
    cause: 'Title odds must sum to 100% across the league and playoff odds to the number of playoff spots.',
    trust: 'Do not use the affected odds until the next refresh clears this.',
  },
  inv_range_order: {
    row: null, title: 'A weekly range is out of order',
    cause: 'A floor above its median or ceiling, or a negative floor.',
    trust: 'Do not use the affected range until the next refresh clears this.',
  },
  inv_no_nan: {
    row: null, title: 'A number is missing (NaN)',
    cause: 'A producer returned NaN or Infinity instead of a number.',
    trust: 'Do not use the affected number until the next refresh clears this.',
  },
  source_age: {
    row: null, title: 'Data is older than it should be',
    cause: 'A source has not synced within its expected window.',
    trust: 'Numbers are from the last good sync; press Refresh all before acting on them.',
  },
});

const pct = v => `${(v * 100).toFixed(0)}%`;
const pts = v => `${(Math.abs(v) * 100).toFixed(1)} pts`;
const isNum = v => typeof v === 'number';
const finite = v => isNum(v) && Number.isFinite(v);
const unique = list => [...new Set(list.flat().filter(Boolean))];

function row(checkId, status, detail, { pages = [], values = {} } = {}) {
  const c = CHECKS[checkId];
  return { check_id: checkId, status, inventory_row: c.row, title: c.title, detail,
    cause: c.cause, trust: c.trust, pages_affected: unique(pages), values };
}
const unmeasured = (checkId, why, pages = []) => row(checkId, 'warn', `Could not measure: ${why}`, { pages });

/** Largest pairwise gap among finite values: { gap, a, b } (a, b are the entries). */
function widest(entries, pick) {
  const ok = entries.filter(e => finite(pick(e)));
  let best = null;
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const gap = Math.abs(pick(ok[i]) - pick(ok[j]));
      if (!best || gap > best.gap) best = { gap, a: ok[i], b: ok[j] };
    }
  }
  return best;
}

function titleOddsRow(snap, tol) {
  const paths = snap.title_paths ?? [];
  const me = String(snap.my_team_id ?? '');
  const failed = paths.filter(p => p.error);
  const title = widest(paths.filter(p => p.title), p => p.title?.[me]);
  const playoff = widest(paths.filter(p => p.playoff), p => p.playoff?.[me]);
  if (!title && !playoff) {
    return unmeasured('title_odds_paths', failed.map(p => `${p.label}: ${p.error}`).join('; ') || 'fewer than two paths answered',
      paths.map(p => p.pages));
  }
  const values = Object.fromEntries(paths.map(p => [p.id, {
    title: p.title?.[me] ?? null, playoff: p.playoff?.[me] ?? null, error: p.error ?? null }]));
  const titleBad = title && title.gap * 100 > tol.title_odds_pts;
  const playoffBad = playoff && playoff.gap * 100 > tol.playoff_odds_pts;
  const worst = titleBad ? { ...title, kind: 'title', limit: tol.title_odds_pts }
    : playoffBad ? { ...playoff, kind: 'playoff', limit: tol.playoff_odds_pts } : null;
  if (worst) {
    const v = p => (worst.kind === 'title' ? p.title : p.playoff)[me];
    return row('title_odds_paths', 'broken',
      `${worst.a.label} and ${worst.b.label} disagree on your ${worst.kind} odds: ${pct(v(worst.a))} vs ${pct(v(worst.b))} `
      + `(${pts(worst.gap)} apart; limit ${worst.limit} pts).`,
      { pages: [worst.a.pages, worst.b.pages], values });
  }
  const note = failed.length ? ` ${failed.map(p => `${p.label} could not be read (${p.error})`).join('; ')}.` : '';
  return row('title_odds_paths', failed.length ? 'warn' : 'ok',
    `Title odds agree within ${title ? pts(title.gap) : 'n/a'}, playoff odds within ${playoff ? pts(playoff.gap) : 'n/a'}.${note}`,
    { pages: failed.map(p => p.pages), values });
}

function projectionBasisRow(snap, tol) {
  const b = snap.projection_basis;
  const pages = ['My team (title odds)', 'Trade Lab (title impact)', 'Trade finder'];
  if (!b || b.error) return unmeasured('projection_basis', b?.error ?? 'not collected', pages);
  if (!finite(b.rank_corr)) return unmeasured('projection_basis', `only ${b.n ?? 0} players priced by both`, pages);
  const bad = b.rank_corr < tol.rank_corr_min;
  return row('projection_basis', bad ? 'broken' : 'ok',
    `Rank agreement between the title simulator's and the trade finder's player rates is ${b.rank_corr.toFixed(2)} `
    + `over ${b.n} rostered players (needs ${tol.rank_corr_min}); average gap ${finite(b.mean_abs_ppg_diff) ? b.mean_abs_ppg_diff.toFixed(1) : '?'} pts/game.`
    + (b.unsimulated ? ` ${b.unsimulated} of them are not in the title simulator at all.` : ''),
    { pages: bad ? pages : [], values: b });
}

function weeklyRangeRow(snap, tol) {
  const list = snap.weekly_ranges ?? [];
  const failed = list.filter(r => r.error);
  const floor = widest(list.filter(r => !r.error), r => r.floor);
  const ceiling = widest(list.filter(r => !r.error), r => r.ceiling);
  const values = Object.fromEntries(list.map(r => [r.id, { floor: r.floor ?? null, median: r.median ?? null,
    ceiling: r.ceiling ?? null, error: r.error ?? null }]));
  if (!floor && !ceiling) {
    return unmeasured('weekly_range', failed.map(r => `${r.label}: ${r.error}`).join('; ') || 'fewer than two samplers answered',
      list.map(r => r.pages));
  }
  const worst = [floor && { ...floor, kind: 'floor' }, ceiling && { ...ceiling, kind: 'ceiling' }]
    .filter(Boolean).sort((a, b) => b.gap - a.gap)[0];
  if (worst.gap > tol.range_pts) {
    const v = r => r[worst.kind];
    return row('weekly_range', 'broken',
      `Your lineup's weekly ${worst.kind} this week: ${worst.a.label} says ${v(worst.a).toFixed(1)}, `
      + `${worst.b.label} says ${v(worst.b).toFixed(1)} (${worst.gap.toFixed(1)} pts apart; limit ${tol.range_pts}).`,
      { pages: [worst.a.pages, worst.b.pages], values });
  }
  const note = failed.length ? ` ${failed.map(r => `${r.label} could not be read (${r.error})`).join('; ')}.` : '';
  return row('weekly_range', failed.length ? 'warn' : 'ok',
    `Weekly floors agree within ${floor ? floor.gap.toFixed(1) : 'n/a'} pts, ceilings within ${ceiling ? ceiling.gap.toFixed(1) : 'n/a'}.${note}`,
    { pages: failed.map(r => r.pages), values });
}

function currentWeekRow(snap) {
  const list = (snap.current_weeks ?? []).filter(w => !w.error);
  if (list.length < 2) return unmeasured('current_week', 'fewer than two week producers answered');
  const values = Object.fromEntries((snap.current_weeks ?? []).map(w => [w.id, w.week ?? null]));
  const weeks = new Set(list.map(w => w.week));
  if (weeks.size > 1) {
    const text = list.map(w => `${w.label} week ${w.week}`).join(', ');
    return row('current_week', 'broken', `Different "current week"s: ${text}.`,
      { pages: list.map(w => w.pages), values });
  }
  return row('current_week', 'ok', `All pages use week ${list[0].week}.`, { values });
}

function pPlayRow(snap, tol) {
  const p = snap.p_play;
  const pages = ['Trade finder / trade cards', 'Title odds (season sim)'];
  if (!p || p.error) return unmeasured('p_play_default', p?.error ?? 'not collected', pages);
  const gapBad = finite(p.max_caller_gap) && p.max_caller_gap > tol.p_play_gap;
  const status = gapBad ? 'broken' : p.defaulted > 0 ? 'warn' : 'ok';
  const parts = [`${p.defaulted} of ${p.rostered} rostered players have no chance-to-play read and are priced at 92%.`];
  if (finite(p.max_caller_gap)) parts.push(`Largest gap between the trade engine's and the simulator's chance to play for one player: ${pts(p.max_caller_gap)}${gapBad ? ` (limit ${pts(tol.p_play_gap)})` : ''}.`);
  return row('p_play_default', status, parts.join(' '), { pages: status === 'ok' ? [] : pages, values: p });
}

function checkedOutRow(snap) {
  const c = snap.checked_out;
  const pages = ['Trade Brain'];
  if (!c || c.error) return unmeasured('checked_out', c?.error ?? 'not collected', pages);
  const on = (c.signals ?? []).filter(s => s.on);
  const values = Object.fromEntries((c.signals ?? []).map(s => [s.id, s.on]));
  if (on.length > 1) {
    return row('checked_out', 'broken', `${on.map(s => s.label).join(' and ')} are both applied to the same managers.`,
      { pages, values });
  }
  return row('checked_out', 'ok', on.length ? `Only ${on[0].label} is applied.` : 'No "checked out" signal is applied.', { values });
}

function probabilityRangeRow(snap) {
  const bad = [];
  for (const p of snap.title_paths ?? []) {
    for (const kind of ['title', 'playoff']) {
      for (const [team, v] of Object.entries(p[kind] ?? {})) {
        if (finite(v) && (v < 0 || v > 1)) bad.push({ path: p, kind, team, v });
      }
    }
  }
  if (bad.length) {
    return row('inv_probability_range', 'broken',
      `${bad.length} odds outside 0-100%, e.g. ${bad[0].path.label} ${bad[0].kind} odds ${pct(bad[0].v)}.`,
      { pages: bad.map(b => b.path.pages), values: { count: bad.length } });
  }
  return row('inv_probability_range', 'ok', 'Every served odds value is between 0 and 100%.');
}

function oddsSumRow(snap, tol) {
  const spots = Number(snap.playoff_teams);
  const bad = [];
  const values = {};
  for (const p of snap.title_paths ?? []) {
    if (p.complete === false) continue; // a path that serves one team only has no league sum
    const t = Object.values(p.title ?? {}), q = Object.values(p.playoff ?? {});
    const tSum = t.length > 1 && t.every(finite) ? t.reduce((s, v) => s + v, 0) : null;
    const qSum = q.length > 1 && q.every(finite) ? q.reduce((s, v) => s + v, 0) : null;
    values[p.id] = { title_sum: tSum, playoff_sum: qSum };
    if (tSum != null && Math.abs(tSum - 1) > tol.title_sum) bad.push(`${p.label} title odds sum to ${pct(tSum)}`);
    if (qSum != null && Number.isFinite(spots) && spots > 0 && Math.abs(qSum - spots) > tol.playoff_sum) {
      bad.push(`${p.label} playoff odds sum to ${qSum.toFixed(2)} for ${spots} spots`);
    }
  }
  if (bad.length) {
    return row('inv_odds_sum', 'broken', `${bad.join('; ')}.`,
      { pages: (snap.title_paths ?? []).map(p => p.pages), values });
  }
  return row('inv_odds_sum', 'ok', `Title odds sum to 100% and playoff odds to ${Number.isFinite(spots) ? spots : '?'} spots.`, { values });
}

function rangeOrderRow(snap) {
  const bad = (snap.weekly_ranges ?? []).filter(r => !r.error).filter(r => {
    const q = [r.floor, r.median, r.ceiling].filter(finite);
    return (finite(r.floor) && r.floor < 0) || q.some((v, i) => i > 0 && v < q[i - 1]);
  });
  if (bad.length) {
    return row('inv_range_order', 'broken',
      bad.map(r => `${r.label} range is out of order (floor ${r.floor}, median ${r.median ?? '-'}, ceiling ${r.ceiling})`).join('; ') + '.',
      { pages: bad.map(r => r.pages) });
  }
  return row('inv_range_order', 'ok', 'Every weekly range runs floor <= median <= ceiling.');
}

/** Every number under the served parts of the snapshot that is NaN or +/-Infinity, with its path. */
function nonFinite(value, at, out, pages) {
  if (isNum(value)) { if (!Number.isFinite(value)) out.push({ at, pages }); return; }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'pages' || k === 'label' || k === 'error') continue;
    nonFinite(v, `${at}.${k}`, out, pages);
  }
}

function noNanRow(snap) {
  const out = [];
  for (const p of snap.title_paths ?? []) nonFinite({ title: p.title, playoff: p.playoff }, p.label, out, p.pages);
  for (const r of snap.weekly_ranges ?? []) nonFinite({ floor: r.floor, median: r.median, ceiling: r.ceiling }, r.label, out, r.pages);
  for (const w of snap.current_weeks ?? []) nonFinite({ week: w.week }, w.label, out, w.pages);
  if (out.length) {
    return row('inv_no_nan', 'broken', `${out.length} served value${out.length === 1 ? ' is' : 's are'} NaN or infinite: ${out.slice(0, 3).map(o => o.at).join(', ')}.`,
      { pages: out.map(o => o.pages), values: { at: out.map(o => o.at) } });
  }
  return row('inv_no_nan', 'ok', 'No served value is NaN or infinite.');
}

/** SQLite `datetime('now')` text is UTC without a zone; ISO text carries one. */
export function parseStamp(s) {
  if (s == null || s === '') return NaN;
  const text = String(s);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

function sourceAgeRow(snap, now) {
  const sources = snap.sources ?? [];
  if (!sources.length) return unmeasured('source_age', 'no sources listed');
  const stale = [];
  const values = {};
  for (const s of sources) {
    const at = parseStamp(s.as_of);
    const age = Number.isFinite(at) ? (now - at) / 60_000 : null;
    values[s.id] = { as_of: s.as_of ?? null, age_minutes: age == null ? null : Math.round(age), max_age_minutes: s.max_age_minutes };
    if (age == null) stale.push({ s, text: `${s.label} has never synced` });
    else if (age > s.max_age_minutes) stale.push({ s, text: `${s.label} last synced ${ageText(age)} ago (max ${ageText(s.max_age_minutes)})` });
  }
  if (stale.length) {
    return row('source_age', 'warn', `${stale.map(x => x.text).join('; ')}.`,
      { pages: stale.map(x => x.s.pages ?? []), values });
  }
  return row('source_age', 'ok', `Every source synced within its window (${sources.map(s => s.label).join(', ')}).`, { values });
}

const ageText = minutes => (minutes >= 120 ? `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} h` : `${Math.round(minutes)} min`);

/**
 * The checks over one league's snapshot. Pure: no database, no clock except `now`.
 * @returns {Array<{check_id, status, inventory_row, title, detail, cause, trust, pages_affected, values}>}
 */
export function evaluateSnapshot(snap, { now = Date.now(), tolerances = TOLERANCES } = {}) {
  const tol = { ...TOLERANCES, ...tolerances };
  return [
    projectionBasisRow(snap, tol),
    titleOddsRow(snap, tol),
    weeklyRangeRow(snap, tol),
    currentWeekRow(snap),
    pPlayRow(snap, tol),
    checkedOutRow(snap),
    probabilityRangeRow(snap),
    oddsSumRow(snap, tol),
    rangeOrderRow(snap),
    noNanRow(snap),
    sourceAgeRow(snap, now),
  ];
}

/* ------------------------------------------------------------ storage */

export function numberAuditTableExists(database = db) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='number_audit'").get();
}

/** Upsert one league's rows. `first_seen_at` holds while a check keeps its status. */
export function writeAuditRows(leagueId, auditRows, { asOf = new Date().toISOString(), database = db } = {}) {
  const stmt = database.prepare(`INSERT INTO number_audit
      (league_id, check_id, status, inventory_row, title, detail, cause, trust, pages_affected, values_json, as_of, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(league_id, check_id) DO UPDATE SET
      first_seen_at = CASE WHEN number_audit.status = excluded.status THEN number_audit.first_seen_at ELSE excluded.first_seen_at END,
      status = excluded.status, inventory_row = excluded.inventory_row, title = excluded.title,
      detail = excluded.detail, cause = excluded.cause, trust = excluded.trust,
      pages_affected = excluded.pages_affected, values_json = excluded.values_json, as_of = excluded.as_of`);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const r of auditRows) {
      stmt.run(Number(leagueId), r.check_id, r.status, r.inventory_row ?? null, r.title, r.detail, r.cause ?? null,
        r.trust ?? null, JSON.stringify(r.pages_affected ?? []), JSON.stringify(r.values ?? {}, jsonSafe), asOf, asOf);
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

/** JSON has no NaN: keep it visible as a string rather than letting it become null. */
const jsonSafe = (_k, v) => (isNum(v) && !Number.isFinite(v) ? String(v) : v);

const STATUS_ORDER = { broken: 0, warn: 1, ok: 2 };

/**
 * What GET /api/number-audit serves: the stored rows, worst first. Reads only.
 * `table_missing` when the migration has not run yet (the server applies it on boot).
 */
export function readNumberAudit(leagueId = null, { database = db } = {}) {
  if (!numberAuditTableExists(database)) {
    return { league_id: leagueId, table_missing: true, as_of: null, broken: 0, warn: 0, ok: 0, rows: [] };
  }
  const list = (leagueId == null
    ? database.prepare('SELECT * FROM number_audit').all()
    : database.prepare('SELECT * FROM number_audit WHERE league_id = ?').all(Number(leagueId)))
    .map(r => ({
      league_id: r.league_id, check_id: r.check_id, status: r.status, inventory_row: r.inventory_row,
      title: r.title, detail: r.detail, cause: r.cause, trust: r.trust,
      pages_affected: parseJson(r.pages_affected, []), values: parseJson(r.values_json, {}),
      as_of: r.as_of, first_seen_at: r.first_seen_at,
    }))
    .sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.check_id.localeCompare(b.check_id));
  const count = s => list.filter(r => r.status === s).length;
  return {
    league_id: leagueId, table_missing: false,
    as_of: list.reduce((m, r) => (m == null || r.as_of > m ? r.as_of : m), null),
    broken: count('broken'), warn: count('warn'), ok: count('ok'), rows: list,
  };
}

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch (e) {
    // A stored value that is not JSON is a writer bug; surface it on the row.
    return { unreadable: String(e.message) };
  }
}

/* ------------------------------------------------------------ collection */

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/** Spearman rank correlation (average ranks for ties). */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = v => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mean = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2; dy += (ry[i] - mean) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const oddsMap = (teams, key) => Object.fromEntries((teams ?? []).map(t => [String(t.roster_id), t[key]]));
const errorText = e => String(e?.message ?? e).slice(0, 200);

/** Run one producer; an error answer or a throw becomes `{ error }` on the entry. */
/**
 * Row A's numbers. BASIS-02: the pair is the rate the served world actually centres
 * each rostered player on (sim-basis.js#simPlayerRates, per game played) against the
 * finder's ros_ppg. A rostered player the finder rates but the sim does not simulate
 * scores 0 in every simulated week, so he counts as 0 (and in `unsimulated`). The old
 * pair, last season's raw projection vs ros_ppg, is kept as `last_season_rank_corr`:
 * it never moved when the sim's scale did, which is why the row stayed broken.
 */
export function projectionBasisSnapshot({ rates, rostered, lastSeason }) {
  const rated = rostered.filter(p => finite(p.ros_ppg));
  const pairs = rated.map(p => [rates.get(p.id) ?? 0, p.ros_ppg]);
  const unsimulated = rated.filter(p => !rates.has(p.id)).map(p => p.id);
  const diff = pairs.length ? pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length : NaN;
  const old = rated.map(p => [lastSeason?.get(p.id)?.ppg, p.ros_ppg]).filter(([a]) => finite(a));
  return {
    rank_corr: spearman(pairs.map(x => x[0]), pairs.map(x => x[1])), n: pairs.length, mean_abs_ppg_diff: diff,
    basis: 'sim_world', unsimulated: unsimulated.length, unsimulated_ids: unsimulated.slice(0, 5),
    last_season_rank_corr: old.length ? spearman(old.map(x => x[0]), old.map(x => x[1])) : NaN,
  };
}

function attempt(fn) {
  try {
    const out = fn();
    if (out && typeof out === 'object' && out.error) return { error: String(out.error) };
    return out;
  } catch (e) { return { error: errorText(e) }; }
}

/**
 * One league's snapshot from the app's own producers, exactly as the pages call
 * them. Heavy (three season simulations and the asset universe), so it runs only
 * in the refresh loop. Every producer is attempted independently.
 */
export async function collectLeagueSnapshot(lg, { now = Date.now() } = {}) {
  const [sim, te, ceiling, posture, weekMod, proj, contingency, pricing, preview, scoring, fmt, scheduler, simBasis] = await Promise.all([
    import('./season-sim.js'), import('./trade-engine.js'), import('./ceiling-lineup.js'),
    import('./lineup-posture.js'), import('./league-week.js'), import('./projections.js'),
    import('./contingency.js'), import('./counterparty-pricing.js'), import('./preview-mode.js'),
    import('./scoring.js'), import('./format.js'), import('./scheduler.js'), import('./sim-basis.js'),
  ]);
  const SEASON = Number(process.env.NFL_SEASON) || 2026;
  const me = String(lg.my_team_id ?? '');
  const leagueScoring = scoring.scoringFor(lg);
  const snap = { league_id: lg.id, my_team_id: me, playoff_teams: null, title_paths: [], weekly_ranges: [],
    current_weeks: [], sources: [] };

  // D: the three week producers.
  const tradeWeek = attempt(() => te.tradeWeekContext());
  const leagueWeek = attempt(() => ({ week: weekMod.leagueCurrentWeek(lg) }));
  const simWeek = attempt(() => ({ week: sim.simStartWeek(lg) }));
  snap.current_weeks = [
    { id: 'trade_engine', label: 'Trade finder / trade cards', pages: ['Trade finder', 'Trade cards'], ...pickWeek(tradeWeek) },
    { id: 'league_week', label: 'League Hub', pages: ['League Hub', 'Start/Sit'], ...pickWeek(leagueWeek) },
    { id: 'season_sim', label: 'Title odds simulator', pages: ['My team (title odds)', 'Trade Lab (title impact)'], ...pickWeek(simWeek) },
  ];
  const week = Number.isFinite(leagueWeek.week) ? leagueWeek.week : tradeWeek.week;

  // B: the title-odds paths, each exactly as its page calls it. The My team path is
  // deliberately unseeded, as the page's /simulate call is (MyTeam.tsx, runs=1500).
  const myTeamSim = attempt(() => sim.simulateSeason(lg, { runs: 1500, scoring: leagueScoring }));
  const world = attempt(() => sim.tradeImpactWorld(lg, {}));
  const worldBase = world.error ? world : world.fail ? { error: world.fail.error ?? 'world failed' } : world.base;
  const horizon = attempt(() => te.myPlayoffOdds(lg));
  snap.playoff_teams = myTeamSim.playoff_teams ?? worldBase.playoff_teams ?? null;
  snap.title_paths = [
    { id: 'my_team', label: 'My team', pages: ['My team'], complete: true,
      ...(myTeamSim.error ? { error: myTeamSim.error } : { title: oddsMap(myTeamSim.teams, 'title_odds'), playoff: oddsMap(myTeamSim.teams, 'playoff_odds') }) },
    { id: 'trade_lab', label: 'Trade Lab title impact', pages: ['Trade Lab (title impact)', 'TradeCard title button'], complete: true,
      ...(worldBase.error ? { error: worldBase.error } : { title: oddsMap(worldBase.teams, 'title_odds'), playoff: oddsMap(worldBase.teams, 'playoff_odds') }) },
    { id: 'finder_horizon', label: 'Trade finder horizon', pages: ['Trade finder (playoff weighting)'], complete: false,
      ...(horizon.error ? { error: horizon.error } : horizon.value == null ? { error: horizon.source ?? 'no value' } : { playoff: { [me]: horizon.value } }) },
  ];

  // A + E + C need the finder's priced roster.
  const { formatKey } = fmt.deriveFormat(lg);
  const assets = attempt(() => te.assetUniverse(lg, formatKey));
  const teams = assets.error ? assets : attempt(() => te.loadRosters(lg, assets));
  const rostered = teams.error ? [] : teams.flatMap(t => t.players).filter(p => SKILL.has(p.position));

  snap.projection_basis = (() => {
    if (teams.error) return { error: teams.error };
    if (world.error || world.fail) return { error: world.error ?? world.fail?.error ?? 'no world' };
    const base = attempt(() => proj.buildProjections({ through: SEASON - 1, scoring: leagueScoring }));
    if (base.error) return { error: base.error };
    return projectionBasisSnapshot({ rates: simBasis.simPlayerRates(world), rostered, lastSeason: base });
  })();

  snap.p_play = (() => {
    if (teams.error) return { error: teams.error };
    const tWeek = tradeWeek.week, sWeek = simWeek.week;
    const a = attempt(() => contingency.weeklyAvailability(SEASON, tWeek, { through: SEASON - 1 }));
    const b = attempt(() => contingency.weeklyAvailability(SEASON, sWeek));
    if (a.error || b.error) return { error: a.error ?? b.error };
    let defaulted = 0, gap = 0;
    const examples = [];
    for (const p of rostered) {
      const pa = a.get(p.id)?.active_probability, pb = b.get(p.id)?.active_probability;
      if (pa == null || pb == null) { defaulted++; if (examples.length < 5) examples.push(p.id); }
      gap = Math.max(gap, Math.abs((pa ?? 0.92) - (pb ?? 0.92)));
    }
    return { rostered: rostered.length, defaulted, default_player_ids: examples, max_caller_gap: gap,
      trade_engine_week: tWeek, season_sim_week: sWeek };
  })();

  // C: one lineup-week (your highest-mean lineup, this week) from each sampler.
  const mine = teams.error ? null : teams.find(t => t.roster_id === me);
  const range = (id, label, pages, fn) => {
    const r = attempt(fn);
    return { id, label, pages, ...(r.error ? { error: r.error } : r) };
  };
  snap.weekly_ranges = [
    range('trade_card', 'Trade card', ['Trade cards', 'Trade Lab'], () => {
      if (!mine) return { error: teams.error ?? 'your team is not in this league' };
      const s = te.lineupSpread(te.bestLineup(mine.players, te.lineupSlots(lg), 'current_week_ppg'));
      return { floor: s.floor, median: s.mean, ceiling: s.ceiling };
    }),
    range('season_sim', 'Title odds simulator', ['My team (title odds)', 'Trade Lab (title impact)'], () => {
      if (world.error || world.fail) return { error: world.error ?? world.fail?.error ?? 'no world' };
      const arr = world.points?.get(me)?.get(sim.simStartWeek(lg));
      if (!arr) return { error: 'your team has no simulated week' };
      const sorted = Float64Array.from(arr).sort();
      return { floor: quantile(sorted, 0.1), median: quantile(sorted, 0.5), ceiling: quantile(sorted, 0.9) };
    }),
    range('ceiling_lineup', 'Ceiling lineup', ['My team (ceiling lineup)'], () => {
      const c = ceiling.ceilingLineup(lg.id, { teamId: me, week, objective: 'mean' });
      if (c.error) return { error: c.error };
      const d = c.versus_highest_mean?.distribution ?? c.distribution;
      return { floor: d.floor, median: d.median, ceiling: d.ceiling };
    }),
    range('lineup_posture', 'Start/Sit posture', ['Start/Sit'], () => {
      const p = posture.lineupPosture(lg, { myTeamId: me, week });
      if (p.error) return { error: p.error };
      if (!finite(p.my_projection) || !finite(p.my_sd)) return { error: 'no projection or spread' };
      const z = 1.2816;
      return { floor: Math.max(0, p.my_projection - z * p.my_sd), median: p.my_projection, ceiling: p.my_projection + z * p.my_sd };
    }),
  ];

  // H: which "checked out" signals are applied. checkedOutFactor is gated by the
  // activity flag or preview in THIS process's environment; the loop is started by
  // the same run.sh as the server, so the two agree unless someone set one by hand.
  snap.checked_out = (() => {
    const factorOn = process.env[pricing.ACTIVITY_FLAG] === '1' || preview.previewUnconfirmed();
    let engineOn = false;
    try {
      // #216's engine_state; only the live lane reaches a page (shadow is graded, not served).
      engineOn = !!db.prepare(`SELECT 1 FROM engine_state
        WHERE field = 'activity.manager' AND league_id = ? AND lane = 'live' LIMIT 1`).get(Number(lg.id));
    } catch (e) {
      // No engine yet is a real "off". A different schema is not: say so on the row.
      if (!/no such table/i.test(String(e?.message))) return { error: `engine_state unreadable: ${errorText(e)}` };
    }
    return { signals: [
      { id: 'checked_out_factor', label: 'checkedOutFactor (counterparty pricing)', on: factorOn },
      { id: 'activity_manager', label: 'activity.manager (engine)', on: engineOn },
    ] };
  })();

  // Source ages: the league's ESPN sync and the two NFL feeds every number reads.
  const job = name => scheduler.JOBS[name]?.maxAgeMinutes ?? 60;
  const lastOk = name => db.prepare(`SELECT last_run_at FROM sync_log WHERE job = ? AND last_status IN ('ok','partial')`).get(name)?.last_run_at ?? null;
  snap.sources = [
    { id: 'league_sync', label: 'League sync', as_of: lg.fetched_at ?? null, max_age_minutes: 3 * job('league_rosters'),
      pages: ['Every league page'] },
    { id: 'nfl_injuries', label: 'NFL injury reports', as_of: lastOk('nfl_injuries'), max_age_minutes: 3 * job('nfl_injuries'),
      pages: ['Start/Sit', 'Trade cards', 'Title odds'] },
    { id: 'nfl_lines', label: 'NFL scores and lines', as_of: lastOk('nfl_lines'), max_age_minutes: 3 * job('nfl_lines'),
      pages: ['Start/Sit', 'Current week'] },
  ];
  snap.collected_at = new Date(now).toISOString();
  return snap;
}

function pickWeek(r) {
  if (r.error) return { error: r.error };
  return { week: r.week };
}

/**
 * The refresh-loop entry: audit every synced league whose sync changed since its
 * last audit (or whose last audit is older than `maxAgeMinutes`), write its rows.
 * `memo` is the loop's own Map, kept across ticks.
 */
export async function runNumberAudit({ collect = collectLeagueSnapshot, now = () => Date.now(), log = console.log,
  database = db, memo = new Map(), maxAgeMinutes = 60, leagues = null } = {}) {
  if (!numberAuditTableExists(database)) {
    log('number_audit: table missing (the web server applies migration 077 on its next start); skipped');
    return { skipped: 'table_missing' };
  }
  const list = leagues ?? database.prepare('SELECT * FROM leagues WHERE payload IS NOT NULL ORDER BY id').all();
  const done = [], failed = [];
  for (const lg of list) {
    const last = memo.get(lg.id);
    if (last && last.fetched_at === lg.fetched_at && now() - last.at < maxAgeMinutes * 60_000) continue;
    const t0 = now();
    let snap;
    try { snap = await collect(lg, { now: t0 }); } catch (e) {
      // One league's failure must not hide the others; it is logged and retried next tick.
      log(`number_audit: league ${lg.id} FAILED ${errorText(e)}`);
      failed.push({ league_id: lg.id, error: errorText(e) });
      continue;
    }
    const auditRows = evaluateSnapshot(snap, { now: t0 });
    writeAuditRows(lg.id, auditRows, { asOf: new Date(t0).toISOString(), database });
    memo.set(lg.id, { fetched_at: lg.fetched_at, at: t0 });
    const broken = auditRows.filter(r => r.status === 'broken').length;
    const warn = auditRows.filter(r => r.status === 'warn').length;
    done.push({ league_id: lg.id, broken, warn });
    log(`number_audit: league ${lg.id} ${broken} broken, ${warn} warn (${now() - t0} ms)`);
  }
  return { audited: done, failed, skipped_fresh: list.length - done.length - failed.length };
}
