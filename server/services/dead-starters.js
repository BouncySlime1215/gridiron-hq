/**
 * The dead-starter guard (SS-01, plan item B11): who is SET IN A STARTING SLOT on the
 * platform and will score zero this week, and who on the bench should start instead.
 *
 * The skill-split study (rnd/skill/SKILL-REPORT.md:57, Sleeper public leagues, several
 * seasons) found that starting players who are Out, Doubtful, on IR, on bye or inactive
 * costs about 2.8 points a team-week and is most of the repeatable lineup loss. Before
 * this module nothing on the Start/Sit page looked at the lineup actually submitted:
 * `lineupCall().warnings` describes the RECOMMENDED lineup, and the two existing
 * definitions of a dead starter were narrower and disagreed:
 *   - trade-engine.js#lineupDiff `flagged_starters`: season-ending list or IR only;
 *   - manager-signals.js#rosterSignals `lineup_dead_starters`: ESPN OUT / IR / DOUBTFUL.
 * `deadReason()` is the union of both plus bye and gameday inactive, and
 * manager-signals.js reads its ESPN status set from `DEAD_ESPN_STATUS` here.
 *
 * Suggestion only. Nothing is written to the platform (applying a swap waits on Nick's
 * N12); `applied: false` says so on the payload.
 *
 * Kickoff: `gameCutoff()` (game-cutoff.js, the one cutoff representation). A starter
 * whose game has started is locked and is not flagged; a bench player whose game has
 * started is not offered. FOLLOW-UP SS-01-F2: when RL-4-2 (#171, lineup-lock.js
 * `rosterLocks()`) merges, read its lock (which also honours ESPN's own `lineupLocked`
 * flag) instead of comparing kickoff times here.
 *
 * Gameday inactives: `inactive` is a hook. Main has no in-week inactive source (the
 * nflverse weekly roster lands after the week), so the default reports
 * `covered: false`; RL-3-2's live-inactive-monitor.js is meant to fill it.
 */
import { gameCutoff } from './game-cutoff.js';
import { SLOT_NAME } from './espn-draft.js';

/** ESPN injuryStatus values under which a starter is dead, and the reason each maps to. */
export const DEAD_ESPN_STATUS = Object.freeze({ INJURY_RESERVE: 'ir', OUT: 'out', DOUBTFUL: 'doubtful' });
/** nfl_injuries.report_status values (the week's official report) that are dead. */
const DEAD_REPORT_STATUS = Object.freeze({ out: 'out', doubtful: 'doubtful' });

/** The inactive hook's default until RL-3-2 lands. */
export const NO_LIVE_INACTIVES = Object.freeze({
  covered: false, source: null, ids: new Set(),
  reason: 'no in-week gameday inactive source yet: RL-3-2 (live-inactive-monitor.js) has not landed, ' +
    'and the nflverse weekly roster is published after the week'
});

const BENCH_SLOT = 20, IR_SLOT = 21;
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

const SENTENCE = {
  ir: 'is on injured reserve',
  out_for_season: 'is flagged out for the season or released',
  out: 'is listed Out',
  doubtful: 'is listed Doubtful',
  bye: 'is on bye this week',
  inactive: 'is on the gameday inactive list'
};

/**
 * Why this player will score zero this week, or null. First match wins, most certain first.
 * @param p        a priced player (available, bye, injury_status = nfl_injuries.report_status)
 * @param espnStatus the platform's injuryStatus for him (ESPN payload), or null
 */
export function deadReason(p, { week, espnStatus = null, inactive = NO_LIVE_INACTIVES }) {
  if (espnStatus === 'INJURY_RESERVE') return { reason: 'ir', source: 'espn' };
  if (p.available === false) return { reason: 'out_for_season', source: 'season_ending_list' };
  const espn = DEAD_ESPN_STATUS[espnStatus];
  const report = DEAD_REPORT_STATUS[String(p.injury_status ?? '').toLowerCase()];
  if (espn === 'out' || report === 'out') return { reason: 'out', source: espn === 'out' ? 'espn' : 'injury_report' };
  if (espn === 'doubtful' || report === 'doubtful') {
    return { reason: 'doubtful', source: espn === 'doubtful' ? 'espn' : 'injury_report' };
  }
  if (week != null && p.bye === week) return { reason: 'bye', source: 'schedule' };
  if (inactive?.covered && inactive.ids?.has(p.id)) return { reason: 'inactive', source: inactive.source };
  return null;
}

/**
 * The guard for one roster.
 *
 * @param lg        the leagues row (platform, payload)
 * @param rosterId  the team's id as loadRosters() reports it
 * @param players   that roster's players (id, name, position, team_abbr, espn_id, bye,
 *                  available, injury_status), IR included
 * @param weekPoints Map<player id, Start/Sit week_points> (lineup-brain.js#startSitWeekPoints)
 * @param accepts   (slot, position) => boolean, the solver's slot rule
 */
export function deadStarters(lg, rosterId, players, {
  season, week, weekPoints, accepts, now = Date.now(), inactive = NO_LIVE_INACTIVES, kickoffOf = null
}) {
  const inactiveSource = { covered: !!inactive?.covered, source: inactive?.source ?? null, reason: inactive?.reason ?? null };
  const base = { applied: false, season, week, kickoff_basis: 'game_cutoff', inactive_source: inactiveSource };
  if (lg?.platform !== 'espn') {
    return { ...base, covered: false, starters_checked: 0, unmatched_starters: 0, items: [],
      reason: 'the submitted lineup is read from ESPN only; this league is not checked' };
  }
  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload;
  const team = (payload?.teams ?? []).find(t => String(t.id) === String(rosterId));
  const cutoffs = new Map();
  const kickoff = abbr => {
    if (!abbr) return null;
    if (!cutoffs.has(abbr)) cutoffs.set(abbr, (kickoffOf ?? (t => gameCutoff(season, week, t)))(abbr));
    return cutoffs.get(abbr);
  };
  const started = abbr => { const k = kickoff(abbr); return k != null && Date.parse(k) <= now; };

  const starters = [], bench = [];
  let unmatched = 0;
  for (const e of team?.roster?.entries ?? []) {
    const pl = e.playerPoolEntry?.player;
    if (!pl) continue;
    const slotId = Number(e.lineupSlotId);
    if (slotId === IR_SLOT) continue;
    // Matched the way loadRosters() put him on the roster: ESPN id first, then name.
    const p = players.find(x => x.espn_id != null && String(x.espn_id) === String(pl.id))
      ?? players.find(x => norm(x.name) === norm(pl.fullName));
    if (!p) { if (slotId !== BENCH_SLOT) unmatched++; continue; }
    const row = { p, slot: SLOT_NAME[slotId] ?? `slot ${slotId}`,
      dead: deadReason(p, { week, espnStatus: pl.injuryStatus ?? null, inactive }) };
    (slotId === BENCH_SLOT ? bench : starters).push(row);
  }

  const candidates = bench
    .filter(b => !b.dead && !started(b.p.team_abbr) && (weekPoints.get(b.p.id) ?? 0) > 0)
    .sort((a, b) => weekPoints.get(b.p.id) - weekPoints.get(a.p.id));
  const flex = s => ['FLEX', 'OP', 'SUPERFLEX', 'W/R/T', 'W/R', 'W/T'].includes(s);
  // Fixed-position slots choose first, so a FLEX never takes the only back an RB slot could use.
  const dead = starters.filter(s => s.dead && !started(s.p.team_abbr))
    .sort((a, b) => Number(flex(a.slot)) - Number(flex(b.slot)));
  const used = new Set();
  const items = dead.map(s => {
    const pick = candidates.find(c => !used.has(c.p.id) && accepts(s.slot, c.p.position));
    if (pick) used.add(pick.p.id);
    return {
      slot: s.slot,
      player: { id: s.p.id, name: s.p.name, position: s.p.position, team_abbr: s.p.team_abbr },
      reason: s.dead.reason, source: s.dead.source,
      kickoff: kickoff(s.p.team_abbr),
      replacement: pick ? { id: pick.p.id, name: pick.p.name, position: pick.p.position,
        team_abbr: pick.p.team_abbr, week_points: weekPoints.get(pick.p.id) } : null,
      why: `${s.p.name} (${s.slot}) ${SENTENCE[s.dead.reason]}.` + (pick
        ? ` Start ${pick.p.name} instead (${weekPoints.get(pick.p.id)} projected).`
        : ' No healthy bench player who can fill this slot has a projection; look at the waiver wire.')
    };
  });
  return { ...base, covered: true, starters_checked: starters.length, unmatched_starters: unmatched, items };
}
