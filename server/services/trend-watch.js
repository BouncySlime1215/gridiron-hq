/**
 * Trends that find you, rather than trends you go looking for.
 *
 * `weekly-trends.js` answers "has this team changed" when asked about a team.
 * That is the wrong shape for the actual job: nobody wants to interrogate
 * thirty-two offences every Tuesday, and the value in a trend is highest in the
 * days after it emerges and roughly zero once the box scores have caught up and
 * the league has repriced. A tool you have to remember to consult delivers the
 * information exactly when it is worthless.
 *
 * So this watches instead. It sweeps every team and every relevant player,
 * records what it finds with the week it was first seen, and — the part that
 * matters — reports the DIFFERENCE against the last sweep:
 *
 *    NEW       first appeared this week. This is the alert. It is the only
 *              moment the information is worth anything, because the market
 *              prices on box scores and box scores have not happened yet.
 *    ONGOING   still true, already known, already priced. Kept for context and
 *              deliberately not alerted on twice.
 *    FADED     was significant and no longer is. Just as actionable as a new
 *              one and never reported anywhere: it is the signal to stop acting
 *              on a read you made three weeks ago.
 *
 * A trend reported every week forever is indistinguishable from wallpaper, which
 * is why the diff is the product here and the scan is only the mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE STATE IS PERSISTED RATHER THAN RECOMPUTED
 *
 * "New since last week" cannot be derived from this week's data alone — it
 * requires knowing what was true when nobody was looking. Recomputing last
 * week's answer from today's database is not the same thing either, because the
 * lookback window slides: a trend computed over weeks 6-8 last Tuesday is not
 * the trend computed over weeks 7-9 today. The only honest way to know what is
 * new is to have written down what was old.
 */
import { rows, row, run } from '../db/index.js';
import { teamTrends, playerTrends, TRACKED } from './weekly-trends.js';


run(`CREATE TABLE IF NOT EXISTS trend_findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT NOT NULL,        -- 'team' | 'player'
  subject       TEXT NOT NULL,        -- team abbr or player id
  subject_name  TEXT,
  metric        TEXT NOT NULL,
  season        INTEGER NOT NULL,
  through_week  INTEGER NOT NULL,
  lookback      INTEGER NOT NULL,
  direction     TEXT,
  baseline      REAL,
  recent        REAL,
  effect_size   REAL,
  p_value       REAL,
  favourable    INTEGER,
  first_seen_week INTEGER,
  last_seen_week  INTEGER,
  status        TEXT,                 -- 'active' | 'faded'
  detected_at   TEXT NOT NULL
)`);
run(`CREATE UNIQUE INDEX IF NOT EXISTS trend_findings_unique
     ON trend_findings (subject_type, subject, metric, season, lookback)`);
run(`CREATE INDEX IF NOT EXISTS trend_findings_week
     ON trend_findings (season, through_week, status)`);

/**
 * Sweep the league and record what changed since the last sweep.
 *
 * Idempotent within a week: running it twice on the same data produces the same
 * classification, because "new" is defined against the stored first-seen week
 * rather than against whether a row was inserted by this particular call.
 */
export function scanTrends({ season, throughWeek, lookback = 3, playerIds = [] } = {}) {
  const target = resolveWindow(season, throughWeek);
  if (target.error) return target;
  const { season: yr, through: wk } = target;

  const seenNow = new Set();
  const found = [];

  const teams = rows(
    `SELECT DISTINCT team FROM nfl_team_week_features WHERE season = ?`, yr).map(r => r.team);
  for (const team of teams) {
    const t = teamTrends(team, yr, { throughWeek: wk, lookback });
    if (t.insufficient) continue;
    for (const tr of t.trends) {
      seenNow.add(key('team', team, tr.metric));
      found.push({
        subject_type: 'team', subject: team, subject_name: team,
        metric: tr.metric, label: tr.label,
        direction: tr.direction, baseline: tr.baseline, recent: tr.recent,
        effect_size: tr.effect_size, p_value: tr.p, favourable: tr.favourable ? 1 : 0,
        what_it_means: tr.what_it_means, helps: tr.helps
      });
    }
  }

  for (const pid of playerIds) {
    let pt;
    try { pt = playerTrends(pid, yr, { throughWeek: wk, lookback }); } catch { continue; }
    if (pt?.insufficient) continue;
    for (const tr of pt.trends ?? []) {
      seenNow.add(key('player', pid, tr.metric));
      found.push({
        subject_type: 'player', subject: String(pid), subject_name: null,
        metric: tr.metric, label: tr.label,
        direction: tr.direction, baseline: tr.baseline, recent: tr.recent,
        effect_size: tr.effect_size, p_value: tr.p, favourable: tr.direction === 'up' ? 1 : 0,
        what_it_means: null, helps: tr.helps
      });
    }
  }

  // What we knew before this sweep.
  const previous = new Map(
    rows(`SELECT * FROM trend_findings WHERE season = ? AND lookback = ?`, yr, lookback)
      .map(r => [key(r.subject_type, r.subject, r.metric), r]));

  const now = new Date().toISOString();
  const isNew = [], ongoing = [], faded = [];

  for (const f of found) {
    const k = key(f.subject_type, f.subject, f.metric);
    const prior = previous.get(k);
    // First seen is sticky: a trend that has been true for three weeks is not
    // "new" merely because this is the first sweep that stored it in this run.
    const firstWeek = prior?.status === 'active' ? (prior.first_seen_week ?? wk) : wk;
    // "New" means no sweep had recorded this before, or it had faded and come
    // back. `previous` is read before any write in this run, so it genuinely
    // describes the world before this sweep.
    //
    // It deliberately does NOT include `first_seen_week === wk`, which was the
    // first attempt and is self-fulfilling: the sweep writes first_seen_week=wk,
    // so re-running within the same week re-flagged all thirteen findings as new
    // every time. An alert that fires again on every refresh is an alert nobody
    // reads.
    const fresh = !prior || prior.status === 'faded';

    run(`INSERT INTO trend_findings
         (subject_type, subject, subject_name, metric, season, through_week, lookback,
          direction, baseline, recent, effect_size, p_value, favourable,
          first_seen_week, last_seen_week, status, detected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)
         ON CONFLICT(subject_type, subject, metric, season, lookback) DO UPDATE SET
           through_week = excluded.through_week, direction = excluded.direction,
           baseline = excluded.baseline, recent = excluded.recent,
           effect_size = excluded.effect_size, p_value = excluded.p_value,
           favourable = excluded.favourable, last_seen_week = excluded.last_seen_week,
           first_seen_week = excluded.first_seen_week,
           status = 'active', detected_at = excluded.detected_at`,
    f.subject_type, f.subject, f.subject_name, f.metric, yr, wk, lookback,
    f.direction, f.baseline, f.recent, f.effect_size, f.p_value, f.favourable,
    firstWeek, wk, now);

    const enriched = { ...f, first_seen_week: firstWeek, weeks_running: wk - firstWeek + 1 };
    (fresh ? isNew : ongoing).push(enriched);
  }

  // Anything previously active that this sweep did not reproduce has faded.
  for (const [k, prior] of previous) {
    if (seenNow.has(k) || prior.status !== 'active') continue;
    run(`UPDATE trend_findings SET status = 'faded', detected_at = ?
         WHERE subject_type = ? AND subject = ? AND metric = ? AND season = ? AND lookback = ?`,
    now, prior.subject_type, prior.subject, prior.metric, yr, lookback);
    faded.push({
      subject_type: prior.subject_type, subject: prior.subject, metric: prior.metric,
      label: labelFor(prior.metric),
      was: { baseline: prior.baseline, recent: prior.recent, effect_size: prior.effect_size },
      ran_for_weeks: (prior.last_seen_week ?? wk) - (prior.first_seen_week ?? wk) + 1,
      reading: `${prior.subject}'s ${labelFor(prior.metric)} is no longer moving by more than noise. ` +
        'Whatever you did on the back of it, stop doing it for that reason.'
    });
  }

  return {
    season: yr, through_week: wk, lookback,
    scanned: { teams: teams.length, players: playerIds.length },
    new: isNew.sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size)),
    ongoing: ongoing.sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size)),
    faded,
    counts: { new: isNew.length, ongoing: ongoing.length, faded: faded.length },
    note: isNew.length
      ? `${isNew.length} trend${isNew.length === 1 ? '' : 's'} emerged this week. Those are the ones ` +
        'worth acting on — an ongoing trend has already been priced by everyone reading box scores.'
      : 'Nothing new emerged this week. Ongoing trends are listed for context but they are no longer ' +
        'an edge; the league has had the same weeks of evidence you have.'
  };
}

/**
 * Conflicting signals on one team, surfaced rather than averaged.
 *
 * A real case from the first run: Kansas City simultaneously sped up (more
 * possessions, good for everyone) and got worse at throwing (bad for the
 * receivers). Both are significant and they point opposite ways. Presenting them
 * as separate confident recommendations reads as the tool contradicting itself,
 * and quietly averaging them into one score would destroy the only interesting
 * thing about the situation.
 */
export function conflicts(season, throughWeek, lookback = 3) {
  const active = rows(
    `SELECT * FROM trend_findings
     WHERE season = ? AND lookback = ? AND status = 'active' AND subject_type = 'team'`,
    season, lookback);
  const byTeam = new Map();
  for (const f of active) {
    if (!byTeam.has(f.subject)) byTeam.set(f.subject, []);
    byTeam.get(f.subject).push(f);
  }
  const out = [];
  for (const [team, list] of byTeam) {
    const good = list.filter(f => f.favourable);
    const bad = list.filter(f => !f.favourable);
    if (!good.length || !bad.length) continue;
    out.push({
      team,
      favourable: good.map(f => ({ metric: f.metric, label: labelFor(f.metric), effect_size: f.effect_size })),
      unfavourable: bad.map(f => ({ metric: f.metric, label: labelFor(f.metric), effect_size: f.effect_size })),
      reading: `${team} has moved in both directions at once — ${labelFor(good[0].metric)} up, ` +
        `${labelFor(bad[0].metric)} down. That is a real situation rather than a contradiction, and ` +
        'it usually means volume is up while efficiency is down. Volume is the more durable of the ' +
        'two for fantasy purposes, but this is a case to look at the player rather than the team.'
    });
  }
  return { season, through_week: throughWeek, conflicts: out };
}

/** The stored picture without running a sweep. */
export function trendHistory({ season = null, lookback = 3, limit = 100 } = {}) {
  const yr = season ?? row(`SELECT MAX(season) AS s FROM trend_findings`)?.s;
  if (!yr) return { findings: [], note: 'No sweep has been run yet. POST /trends/scan to run one.' };
  const all = rows(
    `SELECT * FROM trend_findings WHERE season = ? AND lookback = ?
     ORDER BY status, ABS(effect_size) DESC LIMIT ?`, yr, lookback, limit);
  return {
    season: yr, lookback,
    active: all.filter(f => f.status === 'active').map(decorate),
    faded: all.filter(f => f.status === 'faded').map(decorate),
    counts: {
      active: all.filter(f => f.status === 'active').length,
      faded: all.filter(f => f.status === 'faded').length
    }
  };
}

const decorate = f => ({
  ...f, label: labelFor(f.metric),
  weeks_running: (f.last_seen_week ?? 0) - (f.first_seen_week ?? 0) + 1
});

function labelFor(metric) {
  return TRACKED.find(t => t.key === metric)?.label ?? metric.replace(/_/g, ' ');
}

const key = (type, subject, metric) => `${type}|${subject}|${metric}`;

/** The most recent week with enough data behind it to trend against. */
function resolveWindow(season, throughWeek) {
  const latest = row(`SELECT MAX(season) AS s FROM nfl_team_week_features`)?.s;
  const yr = season ?? latest;
  if (!yr) return { error: 'no weekly team features on record' };
  const wk = throughWeek ?? row(
    `SELECT MAX(week) AS w FROM nfl_team_week_features WHERE season = ?`, yr)?.w;
  if (!wk) return { error: `no weeks on record for ${yr}` };
  return { season: yr, through: wk };
}
