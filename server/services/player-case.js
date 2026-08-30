/**
 * The football case for one player this week.
 *
 * The fantasy pages have been shallow in a specific, fixable way: they showed a
 * number and one derived sentence. "Start him, he is 0.31 points ahead of your
 * bench" is true, useless, and indistinguishable from every other row. Nobody
 * decides anything from it, and it hides the fact that the projection behind it
 * has no idea who is throwing the ball.
 *
 * Meanwhile a whole football layer was built for the betting side and never
 * pointed at fantasy: quarterback replacement value, injuries weighted by actual
 * usage share, defensive weakness by position, coaching tendencies measured from
 * play-calling, roster continuity, weather, usage trends, touchdown luck. All of
 * it bears directly on whether to start a receiver.
 *
 * This assembles the case. Each factor is a real measurement with a direction
 * and a magnitude, and the output is ordered by how much each one actually moves
 * the decision — so the leading line is the reason, not a restatement of the
 * projection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT KEEPS THIS FROM BECOMING NOISE
 *
 * A factor is only reported when it clears a threshold that makes it worth a
 * sentence. Every player has a quarterback, an opponent and a weather forecast;
 * almost none of those are worth mentioning in a given week. A page that lists
 * six factors per player has taught the reader to skim all six, which is the
 * same as showing none.
 */
import { row } from '../db/index.js';
import {
  quarterbackPicture, availabilityPicture, coachingProfile,
  defensiveWeakness, weatherPicture
} from './football-context.js';
import { playerTrends } from './weekly-trends.js';
import { regressionCandidates } from './td-regression.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** Positions a factor is allowed to speak about. */
const TOUCHES = {
  qb_room: ['QB', 'WR', 'TE', 'RB'],
  opponent: ['QB', 'RB', 'WR', 'TE'],
  pace: ['QB', 'RB', 'WR', 'TE'],
  pass_lean: ['QB', 'WR', 'TE'],
  run_lean: ['RB'],
  wind: ['QB', 'WR', 'TE'],
  teammate_out: ['WR', 'TE', 'RB'],
  usage_trend: ['WR', 'TE', 'RB'],
  td_luck: ['QB', 'RB', 'WR', 'TE']
};

/**
 * Build the case.
 *
 * @param player  { name, position, team_abbr, id }
 * @param season/week  the week being decided
 */
export function playerCase(player, season, week, { regression = null } = {}) {
  if (!player?.team_abbr || !player?.position) {
    return { factors: [], headline: null, insufficient: true };
  }
  const team = player.team_abbr;
  const pos = player.position;
  const factors = [];

  const game = row(
    `SELECT opponent, home, spread, total, implied_points FROM game_lines
     WHERE season = ? AND week = ? AND team = ?`, season, week, team);
  const opponent = game?.opponent ?? null;

  /* ---------------------------------------------------- who is throwing */
  if (TOUCHES.qb_room.includes(pos)) {
    let qb;
    try { qb = quarterbackPicture(team, season, week); } catch { qb = null; }
    if (qb && !qb.insufficient) {
      const isThisPlayer = norm(qb.starter?.name) === norm(player.name)
        || sameName(qb.starter?.name, player.name);
      // A downgrade matters to the pass catchers, and to the quarterback himself
      // only in the sense that he may not play.
      if (Math.abs(qb.downgrade_points ?? 0) >= 1.5 && !isThisPlayer) {
        factors.push({
          kind: 'qb_room', weight: Math.abs(qb.downgrade_points) / 3,
          direction: 'negative',
          headline: `${team}'s quarterback situation is a problem`,
          detail: `${qb.starter?.name} is ${qb.starter_injury?.status ?? 'in doubt'} and the drop to ` +
            `${qb.backup?.name ?? 'a replacement'} is worth about ${Math.abs(qb.downgrade_points)} ` +
            `points of offence. ${pos === 'QB' ? 'That is this player.' : 'Pass catchers absorb most of that.'}`
        });
      } else if (isThisPlayer && qb.miss_probability > 0.25) {
        factors.push({
          kind: 'qb_room', weight: qb.miss_probability, direction: 'negative',
          headline: `${player.name} may not play`,
          detail: `Listed ${qb.starter_injury?.status ?? 'on the report'} with a ` +
            `${Math.round(qb.miss_probability * 100)}% chance of missing.`
        });
      }
    }
  }

  /* ------------------------------------------------- the defence he faces */
  if (opponent && TOUCHES.opponent.includes(pos)) {
    let dvp;
    try { dvp = defensiveWeakness(opponent); } catch { dvp = null; }
    const mine = dvp?.by_position?.find(d => d.position === pos);
    if (mine?.rank != null && mine.of) {
      const pct = mine.rank / mine.of;
      // Only the ends of the distribution are worth a sentence.
      if (pct <= 0.28) {
        factors.push({
          kind: 'opponent', weight: (0.28 - pct) * 3, direction: 'positive',
          headline: `${opponent} cannot cover ${pos}s`,
          detail: `They have allowed the ${ordinal(mine.rank)} most points to ${pos}s this season. ` +
            'Defensive rankings go stale by November, so this is measured on the weeks played.'
        });
      } else if (pct >= 0.78) {
        factors.push({
          kind: 'opponent', weight: (pct - 0.78) * 3, direction: 'negative',
          headline: `${opponent} is tough on ${pos}s`,
          detail: `Only the ${ordinal(mine.of - mine.rank + 1)} most generous against ${pos}s.`
        });
      }
    }
  }

  /* ------------------------------------ how his own staff calls the game */
  let coach;
  try { coach = coachingProfile(team, season, week); } catch { coach = null; }
  if (coach && !coach.insufficient) {
    const passTrait = coach.traits?.find(t => t.metric === 'off_proe');
    const paceTrait = coach.traits?.find(t => t.metric === 'off_seconds_per_drive');
    if (passTrait && TOUCHES.pass_lean.includes(pos)) {
      const helps = passTrait.percentile >= 0.75;
      factors.push({
        kind: 'pass_lean', weight: Math.abs(passTrait.percentile - 0.5) * 1.4,
        direction: helps ? 'positive' : 'negative',
        headline: helps ? `${team} throws more than the situation calls for`
          : `${team} runs more than the situation calls for`,
        detail: `${coach.coach ?? 'The staff'} ${passTrait.strength} ${passTrait.trait}. Measured from ` +
          'what they have actually called this season, not from reputation.'
      });
    }
    if (passTrait && TOUCHES.run_lean.includes(pos)) {
      const helps = passTrait.percentile <= 0.25;
      factors.push({
        kind: 'run_lean', weight: Math.abs(passTrait.percentile - 0.5) * 1.4,
        direction: helps ? 'positive' : 'negative',
        headline: helps ? `${team} leans on the run` : `${team} is pass-first`,
        detail: `${coach.coach ?? 'The staff'} ${passTrait.strength} ${passTrait.trait}, which ` +
          `${helps ? 'adds carries' : 'costs carries'}.`
      });
    }
    if (paceTrait && paceTrait.percentile >= 0.75 && TOUCHES.pace.includes(pos)) {
      factors.push({
        kind: 'pace', weight: 0.5, direction: 'positive',
        headline: `${team} plays fast`,
        detail: 'More possessions means more snaps for everyone on the field.'
      });
    }
  }

  /* ------------------------------------------ who else on his team is out */
  if (TOUCHES.teammate_out.includes(pos)) {
    let avail;
    try { avail = availabilityPicture(team, season, week); } catch { avail = null; }
    const outMates = (avail?.injury_report ?? [])
      .filter(i => !sameName(i.name, player.name) && (i.expected_usage_lost ?? 0) >= 0.05
        && sharesTargets(i.position, pos));
    if (outMates.length) {
      const freed = outMates.reduce((s, i) => s + i.expected_usage_lost, 0);
      factors.push({
        kind: 'teammate_out', weight: freed * 4, direction: 'positive',
        headline: `${Math.round(freed * 100)}% of the offence is in doubt around him`,
        detail: `${outMates.map(i => `${i.name} (${i.report_status ?? 'on the report'})`).join(', ')}. ` +
          'Touches do not vanish — they move to whoever is healthy.'
      });
    }
  }

  /* --------------------------------------------------- weather that matters */
  if (TOUCHES.wind.includes(pos)) {
    let w;
    try { w = weatherPicture(season, week, team); } catch { w = null; }
    if (w && !w.indoors && Number.isFinite(w.wind) && w.wind >= 15) {
      factors.push({
        kind: 'wind', weight: (w.wind - 15) / 10 + 0.6, direction: 'negative',
        headline: `${w.wind} mph wind`,
        detail: 'Above about 15 mph passing volume and deep accuracy both fall away. It is the one ' +
          'weather variable with a large, repeatable effect, and it hurts a boundary receiver far ' +
          'more than a back.'
      });
    }
  }

  /* ----------------------------------------------------- his own trajectory */
  if (player.id && TOUCHES.usage_trend.includes(pos)) {
    let t;
    try { t = playerTrends(player.id, season, { throughWeek: week, lookback: 3 }); } catch { t = null; }
    const share = t?.trends?.find(x => x.metric === 'target_share' || x.metric === 'wopr');
    if (share) {
      const up = share.direction === 'up';
      factors.push({
        kind: 'usage_trend', weight: Math.min(1.5, Math.abs(share.effect_size) / 2),
        direction: up ? 'positive' : 'negative',
        headline: up ? 'His role is growing' : 'His role is shrinking',
        detail: `${share.label} moved ${share.baseline} to ${share.recent} over the last three games ` +
          `(p = ${share.p}). Usage is trended rather than points because points are mostly ` +
          'touchdowns and revert, while share is a decision the staff keeps making.'
      });
    }
  }

  /* ------------------------------------------------------- touchdown luck */
  const reg = regression ?? safeRegression(season);
  if (reg && TOUCHES.td_luck.includes(pos)) {
    const hot = reg.negative?.find(p => sameName(p.name, player.name));
    const cold = reg.positive?.find(p => sameName(p.name, player.name));
    if (hot) {
      factors.push({
        kind: 'td_luck', weight: Math.min(1.2, Math.abs(hot.ppg_swing) / 2), direction: 'negative',
        headline: 'Scoring above what his chances support',
        detail: `${hot.actual} touchdowns on ${hot.expected} expected. Touchdown rate is the least ` +
          'stable number in football and it does not carry.'
      });
    } else if (cold) {
      factors.push({
        kind: 'td_luck', weight: Math.min(1.2, Math.abs(cold.ppg_swing) / 2), direction: 'positive',
        headline: 'Due to score',
        detail: `${cold.actual} touchdowns on ${cold.expected} expected from real opportunity. The ` +
          'chances have been there; the finishes have not, and that closes.'
      });
    }
  }

  factors.sort((a, b) => b.weight - a.weight);
  const positive = factors.filter(f => f.direction === 'positive');
  const negative = factors.filter(f => f.direction === 'negative');
  const net = positive.reduce((s, f) => s + f.weight, 0) - negative.reduce((s, f) => s + f.weight, 0);

  return {
    player: player.name, position: pos, team, opponent,
    game: game ? { spread: game.spread, total: game.total, implied_points: game.implied_points,
      home: !!game.home } : null,
    factors: factors.slice(0, 4),
    positive_count: positive.length,
    negative_count: negative.length,
    net_lean: r2(net),
    // The leading line is the reason, not a restatement of the projection.
    headline: factors[0]?.headline ?? null,
    verdict: !factors.length ? 'Nothing about this matchup stands out either way.'
      : net > 0.8 ? 'The football points his way this week.'
        : net < -0.8 ? 'The football points against him this week.'
          : 'The football cuts both ways here.',
    note: 'Factors are only listed when they clear a threshold worth a sentence. Every player has a ' +
      'quarterback, an opponent and a forecast; almost none of those are worth mentioning in a ' +
      'given week, and a page that lists six per player teaches the reader to skim all six.'
  };
}

/** Regression board, fetched once and reused across a lineup. */
let _regCache = null;
function safeRegression(season) {
  if (_regCache?.season === season) return _regCache.value;
  let value = null;
  try {
    const r = regressionCandidates({ season });
    if (!r.error) value = { positive: r.positive_regression, negative: r.negative_regression };
  } catch { value = null; }
  _regCache = { season, value };
  return value;
}
export function clearPlayerCaseCache() { _regCache = null; }

/** "J.Winston" and "Jameis Winston" are one player; last name + initial. */
function sameName(a, b) {
  const key = n => {
    const parts = String(n ?? '').replace(/[.]/g, '. ').split(/\s+/).filter(Boolean);
    if (parts.length < 2) return norm(n);
    return `${parts[0].replace(/[^A-Za-z]/g, '').charAt(0)}${parts[parts.length - 1].replace(/[^A-Za-z]/g, '')}`.toLowerCase();
  };
  return !!a && !!b && key(a) === key(b);
}

/** Does an injured teammate's absence free targets this player can absorb? */
function sharesTargets(injuredPos, playerPos) {
  const pass = ['WR', 'TE', 'RB'];
  return pass.includes(injuredPos) && pass.includes(playerPos);
}

const ordinal = n => {
  if (n == null) return '';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};
