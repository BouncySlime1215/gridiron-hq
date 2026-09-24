/**
 * PROJ-04-a Monday Autopsy: the pure part. Splits one player-week's miss
 * (actual - projection) into links, grades each start/sit call as decision or
 * luck, and writes the plain-English lines. No database here; monday-autopsy.js
 * loads the inputs and stores the result.
 *
 * THE SPLIT. A player's points are rebuilt from a chain state
 *
 *   team pass attempts A, team carries C, team targets per pass attempt tr,
 *   player shares (targets st, carries sc, pass attempts sa),
 *   efficiency (catch rate, yards per target / carry / attempt, int rate),
 *   TD rates (per target, per carry, per attempt)
 *
 * starting from the projected state and swapping in the actual value of one link
 * at a time, in a fixed order. Each link's points are the change that swap made,
 * so the links telescope: their sum is exactly E(actual state) - E(projected state).
 *
 *   script      pass rate moved to actual at projected plays (the pass/run mix the
 *               game forced; the Vegas miss rides along in `detail`)
 *   volume      team plays and target rate moved to actual
 *   share       player shares moved to what he would have had over a full game
 *   exit        full-game shares moved to actual (non-zero only on a snap collapse)
 *   efficiency  catch rate and yards per opportunity moved to actual
 *   td          TD rates moved to actual
 *
 * Three more links close the identity to the served number and the scored one:
 *
 *   news_missed the share link, moved here when a role or availability signal was
 *               published after our snapshot and before kickoff (we had it, and
 *               did not use it)
 *   blend       E(projected state) - served projection: what the weekly blend
 *               served that the chain does not explain
 *   other       actual points - E(actual state): fumbles, two-point tries, any
 *               scoring the chain does not carry
 *
 * So actual - projection = sum of every link, to floating-point error. That is
 * the RED identity (1e-9) in test/proj-04a-monday-autopsy.test.js.
 */
import { PPR } from './scoring.js';

export const LINKS = Object.freeze(['script', 'volume', 'share', 'exit', 'efficiency', 'td',
  'news_missed', 'blend', 'other']);

/**
 * Outcome luck (1) vs knowable at decision time (0). A TD-only miss is therefore
 * 100% luck. share, news_missed and blend are the projection's own reads.
 */
export const IS_LUCK = Object.freeze({ script: 1, volume: 1, share: 0, exit: 1, efficiency: 1, td: 1,
  news_missed: 0, blend: 0, other: 1 });

/** Snap share below this fraction of his prior average reads as an in-game exit. */
export const EXIT_SNAP_RATIO = 0.5;
/** ...and only for a player who normally plays at least this share of snaps. */
export const EXIT_MIN_PRIOR_SHARE = 0.4;
/** Cap on the full-game scale-up, so a one-snap exit cannot invent a 40-target game. */
const EXIT_MAX_SCALE = 5;

const n = v => (Number.isFinite(v) ? v : 0);
const div = (a, b, fallback) => (b > 0 ? a / b : fallback);

/** Points of a chain state under a scoring table (PPR keys, as scoring.js). */
export function chainPoints(s, scoring = PPR) {
  const targets = s.st * s.A * s.tr, carries = s.sc * s.C, attempts = s.sa * s.A;
  return targets * (s.catchRate * scoring.rec + s.ypt * scoring.rec_yd + s.recTd * scoring.rec_td)
    + carries * (s.ypc * scoring.rush_yd + s.rushTd * scoring.rush_td)
    + attempts * (s.ypa * scoring.pass_yd + s.passTd * scoring.pass_td + s.intRate * scoring.pass_int);
}

/**
 * The projected chain state from PROJ-02-a `links` (projections.js#attachChain),
 * served values. Returns null when the links cannot express the projection.
 */
export function stateFromLinks(links) {
  const plays = links?.plays?.value, passRate = links?.pass_rate?.value;
  const tr = links?.plays?.team?.target_rate;
  if (!(plays > 0) || !Number.isFinite(passRate) || !(tr > 0)) return null;
  const A = plays * passRate, C = plays * (1 - passRate);
  const e = links.eff ?? {}, t = links.td ?? {};
  return {
    A, C, tr,
    st: div(n(links.volume?.targets?.value), A * tr, 0),
    sc: div(n(links.volume?.carries?.value), C, 0),
    sa: div(n(links.volume?.attempts), A, 0),
    catchRate: n(e.catch_rate), ypt: n(e.yards_per_target), ypc: n(e.yards_per_carry),
    ypa: n(e.yards_per_attempt), intRate: n(e.int_rate),
    recTd: n(t.rec_td_rate), rushTd: n(t.rush_td_rate), passTd: n(t.pass_td_rate)
  };
}

/**
 * A chain state from box-score totals: `player` and `team` are sums of
 * player_week_usage columns (per game when `games` > 1, the ratios are the same).
 * `fallback` supplies a rate whose denominator is zero (no targets, no carries).
 */
export function stateFromUsage(player, team, fallback = null) {
  const A = n(team.attempts), C = n(team.carries), T = n(team.targets);
  const pt = n(player.targets), pc = n(player.carries), pa = n(player.attempts);
  const f = fallback ?? {};
  return {
    A, C, tr: div(T, A, f.tr ?? 0),
    st: div(pt, T, 0), sc: div(pc, C, 0), sa: div(pa, A, 0),
    catchRate: div(n(player.receptions), pt, f.catchRate ?? 0),
    ypt: div(n(player.receiving_yards), pt, f.ypt ?? 0),
    ypc: div(n(player.rushing_yards), pc, f.ypc ?? 0),
    ypa: div(n(player.passing_yards), pa, f.ypa ?? 0),
    intRate: div(n(player.interceptions), pa, f.intRate ?? 0),
    recTd: div(n(player.receiving_tds), pt, f.recTd ?? 0),
    rushTd: div(n(player.rushing_tds), pc, f.rushTd ?? 0),
    passTd: div(n(player.passing_tds), pa, f.passTd ?? 0)
  };
}

/**
 * Split one player-week.
 *
 * @param input.projection  the served projection (weekly_prediction_snapshots.prediction)
 * @param input.actual      the scored actual
 * @param input.projected   projected chain state (stateFromLinks, or a prior-weeks
 *                          stateFromUsage), or null when there is no basis
 * @param input.actualState actual chain state (stateFromUsage of this week)
 * @param input.snaps       { share, prior } offense snap shares, either may be null
 * @param input.newsMissed  signals published after our snapshot and before kickoff
 * @returns {{ links: Object<string, number>, exit: object, basisOk: boolean }}
 */
export function splitMiss({ projection, actual, projected, actualState, snaps = null, newsMissed = [],
  scoring = PPR }) {
  const links = Object.fromEntries(LINKS.map(l => [l, 0]));
  const exit = exitRead(snaps);
  if (!projected || !actualState) {
    // No chain basis: the whole miss is the blend's, stated rather than spread.
    links.blend = actual - projection;
    return { links, exit, basisOk: false };
  }
  const steps = [];
  let s = { ...projected };
  const e0 = chainPoints(s, scoring);
  const swap = (link, patch) => {
    const before = chainPoints(s, scoring);
    s = { ...s, ...patch };
    links[link] += chainPoints(s, scoring) - before;
    steps.push(link);
  };
  const a = actualState;
  const plays = projected.A + projected.C;
  const passRate = a.A + a.C > 0 ? a.A / (a.A + a.C) : div(projected.A, plays, 0);
  swap('script', { A: plays * passRate, C: plays * (1 - passRate) });
  swap('volume', { A: a.A, C: a.C, tr: a.tr });
  const k = exit.detected ? exit.scale : 1;
  swap('share', { st: Math.min(1, a.st * k), sc: Math.min(1, a.sc * k), sa: Math.min(1, a.sa * k) });
  swap('exit', { st: a.st, sc: a.sc, sa: a.sa });
  swap('efficiency', { catchRate: a.catchRate, ypt: a.ypt, ypc: a.ypc, ypa: a.ypa, intRate: a.intRate });
  swap('td', { recTd: a.recTd, rushTd: a.rushTd, passTd: a.passTd });
  const e6 = chainPoints(s, scoring);
  if (newsMissed.length) { links.news_missed = links.share; links.share = 0; }
  links.blend = e0 - projection;
  links.other = actual - e6;
  return { links, exit, basisOk: true };
}

/** Whether the snap line reads as an in-game exit, and the full-game scale if so. */
export function exitRead(snaps) {
  const share = snaps?.share, prior = snaps?.prior;
  if (!Number.isFinite(share) || !Number.isFinite(prior)) return { modelled: false, detected: false, scale: 1 };
  const detected = prior >= EXIT_MIN_PRIOR_SHARE && share > 0 && share < EXIT_SNAP_RATIO * prior;
  return { modelled: true, detected, scale: detected ? Math.min(EXIT_MAX_SCALE, prior / share) : 1 };
}

/** Which source's projection sat closer to the actual: 'ours', 'espn', 'tie', or null. */
export function sourceRight(ours, espn, actual) {
  if (!Number.isFinite(espn) || !Number.isFinite(ours) || !Number.isFinite(actual)) return null;
  const d = Math.abs(ours - actual) - Math.abs(espn - actual);
  if (Math.abs(d) < 1e-9) return 'tie';
  return d < 0 ? 'ours' : 'espn';
}

const fmt = v => {
  const r = Math.round(Math.abs(v) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/** The label a link prints with: "6 from targets", "5 TD luck". */
function linkPhrase(link, pts, channel) {
  const v = fmt(pts);
  switch (link) {
    case 'share': return `${v} from ${channel}`;
    case 'td': return `${v} TD luck`;
    case 'script': return `${v} game script`;
    case 'volume': return `${v} team volume`;
    case 'exit': return `${v} in-game exit`;
    case 'efficiency': return `${v} efficiency`;
    case 'news_missed': return `${v} news we missed`;
    case 'blend': return `${v} blend`;
    default: return `${v} other scoring`;
  }
}

/**
 * The one plain line: "Missed X by 11: 6 from targets, 5 TD luck". Links pushing the
 * same way as the miss are listed, largest first (at most three, each at least 0.5);
 * a link pushing back by at least 1 is named after a semicolon.
 */
export function playerLine(name, miss, links, { channel = 'share' } = {}) {
  if (Math.abs(miss) < 0.05) return `${name} landed on his projection.`;
  const head = `${miss < 0 ? 'Missed' : 'Beat'} ${name} by ${fmt(miss)}`;
  const entries = Object.entries(links);
  const withMiss = entries.filter(([, p]) => Math.sign(p) === Math.sign(miss) && Math.abs(p) >= 0.5)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3);
  const against = entries.filter(([, p]) => Math.sign(p) === -Math.sign(miss) && Math.abs(p) >= 1)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
  let line = withMiss.length ? `${head}: ${withMiss.map(([l, p]) => linkPhrase(l, p, channel)).join(', ')}` : head;
  if (against) line += `; ${linkPhrase(against[0], against[1], channel)} went the other way`;
  return line;
}

/** Which opportunity the share link is about, for the line. */
export function shareChannel(state) {
  if (!state) return 'share';
  const t = state.st * state.A * state.tr, c = state.sc * state.C, p = state.sa * state.A;
  if (p >= t && p >= c) return 'pass attempts';
  return t >= c ? 'targets' : 'carries';
}

const luckSum = links => Object.entries(links).reduce((s, [l, p]) => s + (IS_LUCK[l] ? p : 0), 0);

/**
 * One start/sit call: started S over benched B (same position), each
 * { id, name, projection, actual, links }. Decision quality is whether we started
 * the higher projection; outcome luck is the share of a reversal the luck links
 * explain.
 */
export function gradeCall(S, B) {
  const projGap = S.projection - B.projection, actGap = S.actual - B.actual;
  const base = { started: S.id, benched: B.id, proj_gap: projGap, actual_gap: actGap };
  if (projGap < 0) {
    return { ...base, decision: 'wrong', outcome: actGap >= 0 ? 'lucky' : 'lost',
      verdict: actGap >= 0 ? 'lucky: started the lower projection and it worked' : 'wrong call: started the lower projection' };
  }
  if (actGap >= 0) return { ...base, decision: 'right', outcome: 'won', verdict: 'right call' };
  // Reversal: how far the result moved against the projected order.
  const reversal = (B.actual - B.projection) - (S.actual - S.projection);
  const luck = luckSum(B.links) - luckSum(S.links);
  const luckShare = reversal > 0 ? luck / reversal : 0;
  return { ...base, decision: 'right', outcome: 'lost', luck_share: luckShare,
    verdict: luckShare >= 0.5 ? 'right call, unlucky' : 'model miss: the projection was wrong for a knowable reason' };
}

/**
 * Every call on one roster: each started player against the highest-projected
 * benched player at his position (FLEX calls are graded at the position level).
 */
export function gradeCalls(started, bench) {
  const calls = [];
  for (const S of started) {
    const B = bench.filter(b => b.position === S.position)
      .sort((x, y) => y.projection - x.projection)[0];
    if (B) calls.push({ ...gradeCall(S, B), started_name: S.name, benched_name: B.name });
  }
  return calls;
}

/** The week in a few plain sentences. */
export function weekSummary({ week, started, calls, linksError = null }) {
  const proj = started.reduce((s, p) => s + p.projection, 0);
  const act = started.reduce((s, p) => s + p.actual, 0);
  const totals = Object.fromEntries(LINKS.map(l => [l, started.reduce((s, p) => s + (p.links[l] ?? 0), 0)]));
  const top = Object.entries(totals).filter(([, v]) => Math.abs(v) >= 0.5)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3)
    .map(([l, v]) => `${l.replace('_', ' ')} ${v < 0 ? '-' : '+'}${fmt(v)}`);
  const luck = started.reduce((s, p) => s + luckSum(p.links), 0);
  const parts = [`Week ${week}: ${started.length} starters scored ${fmt(act)} against ${fmt(proj)} projected `
    + `(${act - proj < 0 ? '-' : '+'}${fmt(act - proj)}; luck ${luck < 0 ? '-' : '+'}${fmt(luck)}, `
    + `the rest ${act - proj - luck < 0 ? '-' : '+'}${fmt(act - proj - luck)}).`];
  if (top.length) parts.push(`Biggest links: ${top.join(', ')}.`);
  const against = calls.filter(c => c.outcome === 'lost' || c.outcome === 'lucky');
  if (calls.length) {
    parts.push(against.length
      ? `${calls.length} start/sit calls, ${against.length} went against the projected order: `
        + against.map(c => `${c.started_name} over ${c.benched_name} (${c.verdict})`).join('; ') + '.'
      : `${calls.length} start/sit calls, all held.`);
  }
  const worst = [...started].sort((x, y) => (x.actual - x.projection) - (y.actual - y.projection))[0];
  if (worst) parts.push(worst.line);
  if (linksError) parts.push(`Projection links unavailable (${linksError}); split built from prior weeks.`);
  return { text: parts.join(' '), totals, projected: proj, actual: act, luck };
}
