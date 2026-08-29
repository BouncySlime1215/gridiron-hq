/**
 * What a team actually does, derived from play-by-play instead of asserted.
 *
 * The X's & O's page has always shown a depth chart and a written paragraph.
 * Underneath it sits 5,278 team-weeks of play-by-play with 183 features each,
 * which the page never touched. So the scheme claims on that page were prose —
 * plausible, unfalsifiable, and quietly going stale the moment a coordinator
 * changed.
 *
 * This replaces assertion with measurement. Every tendency below is a team's
 * own rate compared to the league in the same season, expressed as a percentile
 * and a plain sentence, so a claim like "they throw early and often" becomes
 * "62% early-down pass rate, 9 points above league average, 4th of 32" — a
 * statement you can check.
 *
 * DESIGN NOTE — why percentile rather than raw rate: a raw 58% pass rate means
 * nothing without knowing that the league sits at 54%. Every number here is
 * relative to the same season, which also makes it robust to league-wide drift
 * (the NFL passes more than it did in 2015, and a fixed threshold would quietly
 * label every modern offence "pass-heavy").
 */
import { rows } from '../db/index.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;

/**
 * The tendencies worth showing, chosen because each one distinguishes teams
 * from each other. A stat every team posts the same number on is not an
 * identity marker however interesting it sounds.
 *
 * `higher` names the direction that gets the positive-sounding label, so the
 * copy reads correctly for stats where low is good (sack rate allowed).
 */
const TENDENCIES = [
  // Already stored in percentage points (pass rate minus expected pass rate,
  // x100), so it must NOT be scaled again — doing so reported a 3.9pp lean as
  // "392.6pp", which is not a number football produces.
  { key: 'off_proe', group: 'Identity', label: 'Pass rate over expected',
    high: 'throws more than the situation calls for', low: 'runs more than the situation calls for',
    unit: 'pp', scale: 1 },
  { key: 'off_neutral_pass_rate', group: 'Identity', label: 'Pass rate, neutral script',
    high: 'pass-first by choice, not by score', low: 'run-first even when the game is close',
    unit: '%', scale: 100 },
  { key: 'off_early_down_pass_rate', group: 'Identity', label: 'Early-down pass rate',
    high: 'throws on early downs', low: 'establishes the run early', unit: '%', scale: 100 },
  { key: 'off_no_huddle_rate', group: 'Tempo', label: 'No-huddle rate',
    high: 'plays fast', low: 'huddles up', unit: '%', scale: 100 },
  { key: 'off_seconds_per_drive', group: 'Tempo', label: 'Seconds per drive',
    high: 'long, methodical drives', low: 'quick strikes', unit: 's', scale: 1 },
  { key: 'off_shotgun_rate', group: 'Tempo', label: 'Shotgun rate',
    high: 'lives in shotgun', low: 'plays under centre', unit: '%', scale: 100 },
  { key: 'off_adot', group: 'Passing shape', label: 'Average depth of target',
    high: 'pushes the ball downfield', low: 'works underneath', unit: 'yds', scale: 1 },
  { key: 'off_deep_attempt_rate', group: 'Passing shape', label: 'Deep attempt rate',
    high: 'takes shots', low: 'rarely goes deep', unit: '%', scale: 100 },
  { key: 'off_yac_over_expected', group: 'Passing shape', label: 'YAC over expected',
    high: 'creates after the catch', low: 'wins at the catch point', unit: 'yds', scale: 1 },
  { key: 'off_explosive_play_rate', group: 'Explosiveness', label: 'Explosive play rate',
    high: 'hits big plays', low: 'grinds it out', unit: '%', scale: 100 },
  { key: 'off_epa_per_play', group: 'Efficiency', label: 'EPA per play',
    high: 'efficient offence', low: 'inefficient offence', unit: '', scale: 1 },
  { key: 'off_success_rate', group: 'Efficiency', label: 'Success rate',
    high: 'stays on schedule', low: 'plays behind the sticks', unit: '%', scale: 100 },
  { key: 'off_red_zone_td_rate', group: 'Situational', label: 'Red-zone TD rate',
    high: 'finishes drives', low: 'settles for field goals', unit: '%', scale: 100 },
  { key: 'off_third_down_rate', group: 'Situational', label: 'Third-down conversion',
    high: 'converts on third down', low: 'stalls on third down', unit: '%', scale: 100 },
  { key: 'off_sack_rate', group: 'Protection', label: 'Sack rate allowed',
    high: 'quarterback under pressure', low: 'protects the passer', unit: '%', scale: 100, lowIsGood: true },
  { key: 'off_three_and_out_rate', group: 'Situational', label: 'Three-and-out rate',
    high: 'drives stall early', low: 'sustains drives', unit: '%', scale: 100, lowIsGood: true },

  { key: 'def_epa_per_play', group: 'Defence', label: 'EPA allowed per play',
    high: 'gives up efficient offence', low: 'suffocating', unit: '', scale: 1, lowIsGood: true },
  { key: 'def_havoc_rate', group: 'Defence', label: 'Havoc rate',
    high: 'disruptive front', low: 'passive front', unit: '%', scale: 100 },
  { key: 'def_explosive_play_rate', group: 'Defence', label: 'Explosive plays allowed',
    high: 'gives up chunks', low: 'keeps everything in front', unit: '%', scale: 100, lowIsGood: true },
  { key: 'def_red_zone_td_rate', group: 'Defence', label: 'Red-zone TD rate allowed',
    high: 'bends and breaks', low: 'stiffens inside the 20', unit: '%', scale: 100, lowIsGood: true }
];

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/** Team-week feature rows for one season, parsed once and reused. */
function seasonFeatures(season) {
  return rows(`SELECT team, week, features FROM nfl_team_week_features WHERE season = ?`, season)
    .map(r => { try { return { team: r.team, week: r.week, f: JSON.parse(r.features) }; }
      catch { return null; } })
    .filter(Boolean);
}

/**
 * Measured identity for one team, every number stated against the league in the
 * same season.
 */
export function teamTendencies(abbr, { season = SEASON } = {}) {
  const team = String(abbr).toUpperCase();
  let all = seasonFeatures(season);
  let usedSeason = season;

  // The current season has no games until it starts. Falling back to the most
  // recent season WITH data is better than an empty page, but it must be
  // labelled — a 2025 tendency shown as if it were 2026 is a lie of omission.
  if (!all.length) {
    const latest = rows(`SELECT MAX(season) AS s FROM nfl_team_week_features`)[0]?.s;
    if (!latest) return { error: 'no play-by-play features have been synced' };
    usedSeason = latest;
    all = seasonFeatures(latest);
  }

  const mine = all.filter(r => r.team === team);
  if (!mine.length) return { error: `no play-by-play weeks stored for ${team} in ${usedSeason}` };

  // Per-team season means, so a team is compared to other TEAMS rather than to
  // a pool of individual weeks (which would let one team's 17 games dominate).
  const teamMeans = new Map();
  for (const r of all) {
    if (!teamMeans.has(r.team)) teamMeans.set(r.team, []);
    teamMeans.get(r.team).push(r.f);
  }
  const meanOf = (list, key) => {
    const vals = list.map(f => f[key]).filter(v => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const out = [];
  for (const t of TENDENCIES) {
    const value = meanOf(mine.map(r => r.f), t.key);
    if (value == null) continue;

    const leagueValues = [...teamMeans.entries()]
      .map(([tm, list]) => ({ team: tm, v: meanOf(list, t.key) }))
      .filter(x => x.v != null);
    if (leagueValues.length < 8) continue;

    const leagueMean = leagueValues.reduce((s, x) => s + x.v, 0) / leagueValues.length;
    const sorted = [...leagueValues].sort((a, b) => a.v - b.v);
    const rankAsc = sorted.findIndex(x => x.team === team) + 1;
    const n = sorted.length;
    // Rank is always reported so that 1 = best, which means flipping it for
    // stats where a low number is the good outcome.
    const rank = t.lowIsGood ? rankAsc : n - rankAsc + 1;
    const percentile = (n - rankAsc) / (n - 1);

    const delta = value - leagueMean;
    const notable = Math.abs(percentile - 0.5) >= 0.25;   // top or bottom quartile

    out.push({
      key: t.key, group: t.group, label: t.label,
      value: r2(value * t.scale), league_mean: r2(leagueMean * t.scale),
      delta: r2(delta * t.scale), unit: t.unit,
      rank, of: n, percentile: r2(percentile),
      notable,
      // The sentence a reader can check, rather than a bare number.
      reads_as: notable
        ? (delta > 0 ? t.high : t.low)
        : 'roughly league average'
    });
  }

  // The identity markers: the handful of things this team does most unlike
  // everyone else. That is what a film-room summary actually is.
  const identity = out.filter(x => x.notable)
    .sort((a, b) => Math.abs(b.percentile - 0.5) - Math.abs(a.percentile - 0.5))
    .slice(0, 6);

  const groups = {};
  for (const x of out) (groups[x.group] ??= []).push(x);

  return {
    team, season: usedSeason,
    is_prior_season: usedSeason !== season,
    weeks_measured: mine.length,
    teams_compared: [...teamMeans.keys()].length,
    identity, groups,
    note: usedSeason !== season
      ? `No ${season} play-by-play yet — these are measured ${usedSeason} tendencies, shown so the page is not empty.`
      : `Measured from ${mine.length} team-weeks of play-by-play, compared to every other team in ${usedSeason}.`
  };
}
