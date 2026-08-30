/**
 * The football behind a pick, rather than the arithmetic in front of it.
 *
 * Reading a reasoning trace out loud made something obvious that was hard to see
 * in the code: the model is nineteen statistical estimators arguing about a
 * number, and the only sentences in the whole explanation with any football in
 * them were the ones describing context the model never read. That is a fair
 * criticism of the model and it is also a gap in what gets shown — a person
 * deciding whether to trust a pick wants to know who is hurt, who the defence
 * cannot cover, whether the coach throws, and whether the wind is up.
 *
 * This assembles that. Everything is CUTOFF-SAFE — injuries, usage and
 * tendencies are read from weeks strictly before the target — so the same
 * assembly can feed a blind replay without leaking the result.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COACHING, WITHOUT PRETENDING TO KNOW A COACH
 *
 * There is a name in the database and almost nothing else — no scheme labels, no
 * tendencies, no history beyond games coached. Writing "Andy Reid is aggressive"
 * from a name would be reciting received opinion and calling it analysis.
 *
 * What IS measurable is what a staff actually does: pass rate over expected,
 * seconds per drive, no-huddle rate, fourth-down aggression. Those are the
 * coaching decisions, observed rather than attributed, and they are exactly what
 * a bettor means by "this coach will throw here". So the coaching section is
 * derived from play-calling and the name is a label on it, not a source.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON INJURY REPORTS
 *
 * `report_status` is the official designation and `practice_status` is the more
 * informative field, because a Questionable who practised fully on Friday plays
 * about 95% of the time and one who did not practise at all plays rarely. Both
 * are reported; the practice column is the one that carries the signal.
 */
import { rows, row } from '../db/index.js';
import { dvpFor } from './matchups.js';
import { coachFor } from './nfl-coaches.js';
import { mapIds } from './player-ids.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const SKILL = ['QB', 'RB', 'WR', 'TE'];

/**
 * How likely a player on the injury report is to actually play.
 *
 * The rates are the well-established ones from public injury-report studies and
 * they are stated here rather than fitted, because this database holds only
 * 17,595 injury rows against no reliable "did he play" join — fitting on that
 * would produce a worse number with a more impressive provenance.
 */
const PLAY_ODDS = {
  out: 0.0, doubtful: 0.06, questionable: 0.72, probable: 0.95, null: 1.0
};
const PRACTICE_ADJUST = {
  dnp: -0.35, limited: -0.08, full: 0.20, null: 0
};

function playProbability(reportStatus, practiceStatus) {
  const s = String(reportStatus ?? '').toLowerCase();
  const base = s.includes('out') ? PLAY_ODDS.out
    : s.includes('doubt') ? PLAY_ODDS.doubtful
      : s.includes('question') ? PLAY_ODDS.questionable
        : s.includes('prob') ? PLAY_ODDS.probable
          : PLAY_ODDS.null;
  if (base === 0 || base === 1) return base;
  const p = String(practiceStatus ?? '').toLowerCase();
  const adj = p.includes('did not') || p === 'dnp' ? PRACTICE_ADJUST.dnp
    : p.includes('limited') ? PRACTICE_ADJUST.limited
      : p.includes('full') ? PRACTICE_ADJUST.full
        : 0;
  return Math.max(0, Math.min(1, base + adj));
}

/**
 * Who matters on this roster, and who is not right.
 *
 * "Matters" is measured by usage share in the weeks before this one rather than
 * by name recognition or depth chart, because usage is the thing that turns into
 * points and a depth chart is a guess about it.
 */
export function availabilityPicture(team, season, week, { lookback = 4 } = {}) {
  const usage = rows(
    `SELECT player_id, position, SUM(targets) targets, SUM(carries) carries,
            AVG(target_share) target_share, COUNT(*) games
     FROM player_week_usage
     WHERE team = ? AND season = ? AND week < ? AND week >= ?
     GROUP BY player_id, position`,
    team, season, week, Math.max(1, week - lookback));

  const totalTouch = usage.reduce((s, u) => s + (u.targets ?? 0) + (u.carries ?? 0), 0) || 1;

  // Usage keys on the internal integer id; the injury report keys on GSIS. They
  // do not join, and joining them raw returns no rows and no error — which is
  // exactly what happened here first time round: every player's usage share came
  // back zero, every injury scored as costing nothing, and the summary read
  // "close to healthy on offence" with the team's leading receiver listed out.
  // Routed through the id bridge instead.
  const gsisOf = mapIds(usage.map(u => u.player_id), { from: 'internal', to: 'gsis' });
  const byGsis = new Map();
  for (const u of usage) {
    const g = gsisOf.map.get(u.player_id);
    if (g) byGsis.set(String(g), u);
  }

  // The injury report for the target week is legitimately available before
  // kickoff — it is published Wednesday through Friday — so unlike outcomes it
  // is not a leak.
  const injuries = rows(
    `SELECT gsis_id, full_name, position, report_status, practice_status, injury
     FROM nfl_injuries WHERE team = ? AND season = ? AND week = ?`,
    team, season, week);

  const flagged = injuries.map(i => {
    const u = byGsis.get(String(i.gsis_id));
    const touches = (u?.targets ?? 0) + (u?.carries ?? 0);
    const share = r3(touches / totalTouch);
    const plays = playProbability(i.report_status, i.practice_status);
    return {
      name: i.full_name, position: i.position,
      report_status: i.report_status, practice_status: i.practice_status,
      injury: i.injury,
      usage_share: share, touches_per_game: u?.games ? r2(touches / u.games) : null,
      play_probability: r2(plays),
      // The number that decides whether this matters: a star at 50% is a bigger
      // problem than a backup who is definitely out.
      expected_usage_lost: r2(share * (1 - plays))
    };
  }).filter(x => SKILL.includes(x.position) || x.position === 'QB')
    .sort((a, b) => (b.expected_usage_lost ?? 0) - (a.expected_usage_lost ?? 0));

  const totalLost = r3(flagged.reduce((s, f) => s + (f.expected_usage_lost ?? 0), 0));

  return {
    team, season, week,
    injury_report: flagged.slice(0, 8),
    usage_share_at_risk: totalLost,
    // Surfaced rather than assumed. A resolution rate that quietly falls is the
    // shape this bug had, and it raised no error either time.
    id_resolution_rate: gsisOf.rate,
    // Said in words because a share is abstract and "a fifth of their offence"
    // is not.
    reading: totalLost >= 0.20
      ? `About ${Math.round(totalLost * 100)}% of ${team}'s recent touches belong to players who may not play.`
      : totalLost >= 0.08
        ? `${team} is carrying a modest injury burden — roughly ${Math.round(totalLost * 100)}% of ` +
          'recent touches are in doubt.'
        : `${team} is close to healthy on offence.`,
    caveat: 'Play probabilities come from published report-status base rates adjusted by Friday ' +
      'practice, not fitted here — this database has injury designations but no reliable record of ' +
      'who actually dressed, and fitting on that would give a worse number better provenance.'
  };
}

/**
 * What this staff actually does, observed rather than attributed.
 *
 * League percentiles, so "0.02 pass rate over expected" becomes "throws more
 * than three quarters of the league in neutral situations", which is the form
 * the number is useful in.
 */
export function coachingProfile(team, season, week) {
  const feats = rows(
    `SELECT team, features FROM nfl_team_week_features WHERE season = ? AND week < ?`,
    season, week);
  if (feats.length < 32) {
    return { team, insufficient: true,
      note: 'Not enough completed weeks this season to establish tendencies.' };
  }

  const byTeam = new Map();
  for (const f of feats) {
    const x = JSON.parse(f.features);
    if (!byTeam.has(f.team)) byTeam.set(f.team, []);
    byTeam.get(f.team).push(x);
  }
  const meanOf = (list, key) => {
    const v = list.map(x => x[key]).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  const TRAITS = [
    { key: 'off_proe', label: 'passes more than the situation calls for',
      inverse: 'runs more than the situation calls for', unit: 'pct' },
    { key: 'off_seconds_per_drive', label: 'plays slowly', inverse: 'plays fast', unit: 'sec', flip: true },
    { key: 'off_no_huddle_rate', label: 'uses no-huddle', inverse: 'huddles up', unit: 'pct' },
    { key: 'off_fourth_down_rate', label: 'goes for it on fourth down',
      inverse: 'punts and kicks', unit: 'pct' },
    { key: 'off_deep_attempt_rate', label: 'throws deep', inverse: 'keeps it short', unit: 'pct' }
  ];

  const mine = byTeam.get(team);
  if (!mine?.length) return { team, insufficient: true, note: 'No completed weeks for this team.' };

  const traits = [];
  for (const t of TRAITS) {
    const v = meanOf(mine, t.key);
    if (v == null) continue;
    const all = [...byTeam.values()].map(l => meanOf(l, t.key)).filter(Number.isFinite).sort((a, b) => a - b);
    if (all.length < 16) continue;
    let pct = all.filter(x => x < v).length / all.length;
    // Lower is "faster" for seconds per drive, so the percentile has to invert
    // or the label reads backwards.
    if (t.flip) pct = 1 - pct;
    if (pct >= 0.75 || pct <= 0.25) {
      traits.push({
        metric: t.key, value: r3(v), percentile: r3(pct),
        trait: pct >= 0.75 ? t.label : t.inverse,
        strength: pct >= 0.9 || pct <= 0.1 ? 'strongly' : 'somewhat'
      });
    }
  }

  const coach = coachFor(team, season);
  return {
    team, season, through_week: week,
    coach: coach?.coach ?? coach ?? null,
    traits,
    reading: traits.length
      ? `${team} ${traits.slice(0, 3).map(t => `${t.strength} ${t.trait}`).join(', ')}.`
      : `${team}'s play-calling sits mid-pack on every tendency measured.`,
    caveat: 'Derived from what this staff has actually called this season, not from a coach\'s ' +
      'reputation. The name is a label on the measurement, not the source of it.'
  };
}

/**
 * Which positions this defence has been giving up points to.
 *
 * `dvpFor` already computes it; nothing in the betting reasoning ever called it,
 * so a pick could be made against a defence that cannot cover tight ends without
 * that ever appearing in the explanation.
 */
export function defensiveWeakness(opponent) {
  const out = [];
  for (const pos of SKILL) {
    let d;
    try { d = dvpFor(opponent, pos); } catch { continue; }
    if (!d || d.rank == null) continue;
    out.push({ position: pos, rank: d.rank, of: d.of ?? 32,
      points_allowed: d.points ?? d.ppg ?? null });
  }
  const sorted = out.slice().sort((a, b) => a.rank - b.rank);
  return {
    opponent,
    by_position: out,
    // Rank 1 means most points allowed in this table's convention; both ends are
    // reported so the caller does not have to guess which way it runs.
    softest: sorted[0] ?? null,
    toughest: sorted[sorted.length - 1] ?? null,
    reading: sorted.length
      ? `${opponent} has been softest against ${sorted[0].position}s (${ordinal(sorted[0].rank)} most ` +
        `points allowed) and toughest against ${sorted[sorted.length - 1].position}s.`
      : null
  };
}

/** Weather, and only when it actually changes football. */
export function weatherPicture(season, week, team) {
  const g = row(
    `SELECT roof, temp, wind, surface, gametime FROM game_lines
     WHERE season = ? AND week = ? AND team = ?`, season, week, team);
  if (!g) return { insufficient: true, notes: [] };
  const indoors = g.roof === 'dome' || g.roof === 'closed';
  const notes = [];
  if (indoors) {
    notes.push('Indoors, so weather is not a factor.');
  } else {
    if (Number.isFinite(g.wind) && g.wind >= 15) {
      notes.push(`${g.wind} mph wind. Above about 15 mph passing volume and deep accuracy both fall ` +
        'away, and it is the one weather variable with a large, repeatable effect.');
    }
    if (Number.isFinite(g.temp) && g.temp <= 25) {
      notes.push(`${g.temp}°F. Cold suppresses scoring modestly — much less than most people assume, ` +
        'and far less than wind.');
    }
    if (!notes.length) notes.push('Outdoors with nothing severe forecast.');
  }
  return { roof: g.roof, indoors, temp: g.temp, wind: g.wind, surface: g.surface, notes };
}

/**
 * Everything football about one matchup, in one call.
 *
 * Assembled here so a consumer cannot accidentally read one of these without the
 * cutoff applied — the same reasoning as spreadContext.
 */
export function footballContext(season, week, home, away) {
  return {
    season, week, home, away,
    cutoff: `usage and tendencies from weeks 1..${week - 1}; injury report is pre-kickoff and not a leak`,
    home_availability: availabilityPicture(home, season, week),
    away_availability: availabilityPicture(away, season, week),
    home_coaching: coachingProfile(home, season, week),
    away_coaching: coachingProfile(away, season, week),
    home_faces: defensiveWeakness(away),
    away_faces: defensiveWeakness(home),
    weather: weatherPicture(season, week, home)
  };
}

const ordinal = n => {
  if (n == null) return '';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};
