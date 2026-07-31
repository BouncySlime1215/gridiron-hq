/**
 * Availability and depth-chart cascades.
 *
 * Two questions that only make sense together:
 *
 *   1. How likely is this player to miss time?
 *   2. When he does, where do his touches actually go?
 *
 * The second is what makes handcuffs and contingent value computable instead of
 * folklore. Touches don't evaporate when a starter sits — a specific teammate absorbs
 * them, and how much he absorbs is measurable from games the starter actually missed.
 *
 * The cascade is estimated empirically: for every player, split his team's weeks into
 * ones where the starter played and ones where he didn't, and compare the backup's
 * usage across the two. That is a direct measurement of the handoff, rather than an
 * assumption that the next man on a depth chart inherits everything.
 */
import { rows } from '../db/index.js';
import { shrink, mean } from './stats-util.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SKILL = ['QB', 'RB', 'WR', 'TE'];
// A starter has to have missed this many games for the split to mean anything.
const MIN_MISSED = 3;
// Who can inherit whose workload. Receivers and tight ends share a target pool; backs
// share carries; quarterbacks are a closed shop.
const INHERITS = { QB: ['QB'], RB: ['RB'], WR: ['WR', 'TE'], TE: ['TE', 'WR'] };

/* ------------------------------------------------------------ availability */

/**
 * Probability a player is available in a given week.
 *
 * Built from observed games-played rate rather than from injury reports, because the
 * app has no live injury feed and a player's own history is the better base rate
 * anyway. The current injury flag, when set, applies a penalty on top.
 */
export function availability({ through = SEASON - 1 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, COUNT(*) AS games, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')
                    GROUP BY u.player_id, u.season`, through);
  const flagged = new Set(rows(`SELECT player_id FROM player_metrics WHERE source='injury_flag' AND value > 0`)
    .map(r => r.player_id));

  const byPlayer = new Map();
  for (const r of log) {
    const a = byPlayer.get(r.player_id) ?? { seasons: 0, games: 0, position: r.position };
    a.seasons++; a.games += r.games;
    byPlayer.set(r.player_id, a);
  }

  // Position base rates — running backs miss more time than anyone, and it is not close.
  const posRate = {};
  for (const pos of SKILL) {
    const list = [...byPlayer.values()].filter(a => a.position === pos);
    posRate[pos] = list.length ? mean(list.map(a => a.games / (a.seasons * 17))) : 0.75;
  }

  const out = new Map();
  for (const [pid, a] of byPlayer) {
    const observed = a.games / (a.seasons * 17);
    const rate = shrink(observed, posRate[a.position] ?? 0.75, a.seasons, 1.2);
    // A live injury designation is worth roughly a fifth of a season of doubt.
    const penalty = flagged.has(pid) ? 0.82 : 1;
    out.set(pid, {
      player_id: pid, position: a.position,
      available: +Math.max(0.05, Math.min(0.99, rate * penalty)).toFixed(3),
      observed_rate: +observed.toFixed(3),
      seasons: a.seasons,
      flagged: flagged.has(pid)
    });
  }
  return out;
}

/* --------------------------------------------------------------- cascade */

/**
 * Who absorbs a player's workload when he sits.
 *
 * @returns Map<player_id, { beneficiaries: [{ player_id, name, share_gain, ... }] }>
 */
export function cascades({ through = SEASON - 1, minGames = 6 } = {}) {
  const log = rows(`SELECT u.player_id, u.season, u.week, u.team, u.targets, u.carries, u.attempts,
                           p.name, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season <= ? AND u.season >= ? AND u.team IS NOT NULL
                      AND p.position IN ('QB','RB','WR','TE')`, through, through - 2);

  // Index by team-week so "did he play" is answerable.
  const teamWeeks = new Map();     // `${team}|${season}|${week}` -> [rows]
  const playerTeams = new Map();   // player -> Set of `${team}|${season}`
  for (const u of log) {
    const k = `${u.team}|${u.season}|${u.week}`;
    (teamWeeks.get(k) ?? teamWeeks.set(k, []).get(k)).push(u);
    const pk = `${u.team}|${u.season}`;
    (playerTeams.get(u.player_id) ?? playerTeams.set(u.player_id, new Set()).get(u.player_id)).add(pk);
  }

  // All weeks a team appeared, so absence is detectable as a missing row.
  const teamAllWeeks = new Map();  // `${team}|${season}` -> Set(week)
  for (const k of teamWeeks.keys()) {
    const [team, season, week] = k.split('|');
    const tk = `${team}|${season}`;
    (teamAllWeeks.get(tk) ?? teamAllWeeks.set(tk, new Set()).get(tk)).add(Number(week));
  }

  const opportunity = u => (u.targets ?? 0) + (u.carries ?? 0) + (u.attempts ?? 0);
  const out = new Map();

  for (const [starterId, teamKeys] of playerTeams) {
    const withStarter = new Map();   // teammate id -> { n, opp }
    const withoutStarter = new Map();
    let missed = 0, played = 0, starterOpp = 0;
    let starterName = null, starterPos = null, starterTeam = null;

    for (const tk of teamKeys) {
      const [team, season] = tk.split('|');
      const weeks = teamAllWeeks.get(tk);
      if (!weeks) continue;

      // Only the span he was actually on this roster counts. Treating every week with
      // no row as an absence would score the weeks before he was signed and after he
      // was traded as "games he missed", which manufactures cascades between players
      // who were never teammates.
      const appearances = [...weeks].filter(w =>
        (teamWeeks.get(`${team}|${season}|${w}`) ?? []).some(u => u.player_id === starterId));
      if (!appearances.length) continue;
      const first = Math.min(...appearances), last = Math.max(...appearances);

      for (const week of weeks) {
        if (week < first || week > last) continue;
        const list = teamWeeks.get(`${team}|${season}|${week}`) ?? [];
        const starter = list.find(u => u.player_id === starterId);
        if (starter) {
          starterName ??= starter.name; starterPos ??= starter.position; starterTeam = team;
          starterOpp += opportunity(starter);
        }
        const bucket = starter ? withStarter : withoutStarter;
        if (starter) played++; else missed++;
        for (const u of list) {
          if (u.player_id === starterId) continue;
          const b = bucket.get(u.player_id) ?? { n: 0, opp: 0, name: u.name, position: u.position };
          b.n++; b.opp += opportunity(u);
          bucket.set(u.player_id, b);
        }
      }
    }

    if (missed < MIN_MISSED || played < minGames || !starterName) continue;
    // Only real contributors have a workload worth inheriting.
    if (starterOpp / played < 6) continue;

    const beneficiaries = [];
    for (const [mateId, without] of withoutStarter) {
      const with_ = withStarter.get(mateId);
      if (!with_ || with_.n < 3 || without.n < MIN_MISSED) continue;
      // Touches only transfer within a position group. A receiver missing does not hand
      // carries to a running back, and it certainly does not hand pass attempts to the
      // backup quarterback — that pattern is roster churn showing through, not football.
      if (!INHERITS[starterPos]?.includes(without.position)) continue;
      const base = with_.opp / with_.n;
      const boosted = without.opp / without.n;
      if (base <= 0.5 && boosted <= 0.5) continue;
      const gain = boosted - base;
      // Shrink the multiplier toward "no change" — a three-game split is thin evidence.
      const ratio = base > 0 ? shrink(boosted / base, 1, without.n, 4) : 1;
      if (ratio <= 1.03) continue;
      beneficiaries.push({
        player_id: mateId, name: without.name, position: without.position,
        base_opportunity: +base.toFixed(2),
        opportunity_without: +boosted.toFixed(2),
        gain: +gain.toFixed(2),
        multiplier: +ratio.toFixed(3),
        games_observed: without.n
      });
    }
    if (!beneficiaries.length) continue;
    beneficiaries.sort((a, b) => b.gain - a.gain);
    out.set(starterId, {
      player_id: starterId, name: starterName, position: starterPos, team: starterTeam,
      games_missed: missed, games_played: played,
      beneficiaries: beneficiaries.slice(0, 4)
    });
  }
  return out;
}

/**
 * Contingent value: how much a player is worth *because of* who he backs up.
 *
 * A backup with no path to touches is worth nothing; one snap away from twenty carries
 * is worth a great deal, and the difference is invisible to any market value or
 * projection that only prices expected usage.
 */
export function handcuffValue({ through = SEASON - 1 } = {}) {
  const casc = cascades({ through });
  const avail = availability({ through });
  const byBackup = new Map();

  // Opportunity is not comparable across positions — a pass attempt is worth a fraction
  // of a PPR target. Without converting to points the list is just "backup quarterbacks",
  // because they inherit forty attempts while a backup back inherits ten carries.
  const ppo = {};
  for (const r of rows(`SELECT p.position,
                               SUM(COALESCE(u.passing_yards,0))*0.04 + SUM(COALESCE(u.passing_tds,0))*4
                             + SUM(COALESCE(u.rushing_yards,0))*0.1 + SUM(COALESCE(u.rushing_tds,0))*6
                             + SUM(COALESCE(u.receptions,0)) + SUM(COALESCE(u.receiving_yards,0))*0.1
                             + SUM(COALESCE(u.receiving_tds,0))*6 AS pts,
                               SUM(COALESCE(u.attempts,0)+COALESCE(u.carries,0)+COALESCE(u.targets,0)) AS opp
                        FROM player_week_usage u JOIN players p ON p.id = u.player_id
                        WHERE u.season <= ? GROUP BY p.position`, through)) {
    ppo[r.position] = r.opp > 0 ? r.pts / r.opp : 0.5;
  }

  for (const c of casc.values()) {
    const starterAvail = avail.get(c.player_id)?.available ?? 0.8;
    const missRate = 1 - starterAvail;
    for (const b of c.beneficiaries) {
      const entry = byBackup.get(b.player_id) ?? {
        player_id: b.player_id, name: b.name, position: b.position, paths: []
      };
      entry.paths.push({
        starter: c.name, starter_id: c.player_id,
        starter_miss_rate: +missRate.toFixed(3),
        opportunity_gain: b.gain,
        multiplier: b.multiplier,
        // Expected extra opportunity per game across the season, and the same figure
        // converted to fantasy points so positions can be ranked against each other.
        expected_gain: +(missRate * b.gain).toFixed(2),
        expected_points: +(missRate * b.gain * (ppo[b.position] ?? 0.5)).toFixed(2)
      });
      byBackup.set(b.player_id, entry);
    }
  }
  for (const e of byBackup.values()) {
    e.paths.sort((a, b) => b.expected_points - a.expected_points);
    e.contingent_score = +e.paths.reduce((s, p) => s + p.expected_points, 0).toFixed(2);
  }
  return [...byBackup.values()].sort((a, b) => b.contingent_score - a.contingent_score);
}
