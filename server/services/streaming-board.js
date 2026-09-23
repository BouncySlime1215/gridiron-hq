/**
 * The defense streaming board (WV-01, plan item B5).
 *
 * Every defense with a game this week, ranked by the market's implied team total
 * for the offense it faces, lowest first; free agents only; the implied-point
 * edge over the defense you hold; and one add suggestion that fits the roster.
 *
 * Why this ranking. The skill study measured +1.94 fantasy points per DEF
 * swap-week [1.88, 2.01] (by-NFL-week interval [1.38, 2.55]) and +0.45 points per
 * implied point of edge, with no gain from chasing last week's points
 * (gridiron-local rnd/skill/waivers.md:204, :489). The history check in
 * docs/evidence/streaming-def-history.mjs replays THIS function on 2022-2025
 * (docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md).
 *
 * One producer per number. The line is read through gamescript.js#linesFor, the
 * only reader of game_lines used here; the implied total is the stored
 * `implied_points` (written by gamescript.js with total/2 - spread/2), recomputed
 * with the same formula from the frozen close (`closing_spread`/`closing_total`,
 * written only before kickoff by gamescript.js closeStmt) when there is one, so a
 * game already under way is ranked on its last pre-kickoff line and not on an
 * in-game number. No points projection is made here: the board shows the market
 * number and the edge, nothing else.
 *
 * Kickers are not streamed (+0.35 a swap, interval includes 0). QB/TE are not
 * streamed here: the study's skeptic found those swaps are reactions to last
 * week's points, not matchup streams (waivers.md:501).
 */
import { linesFor } from './gamescript.js';
import { PRO_TEAM } from './espn-draft.js';
import { canonicalTeamCode } from './team-codes.js';
import { nflKickoffDate } from './date-util.js';

/** ESPN ids: defaultPositionId and lineup slot for D/ST, the IR slot, the bench. */
const DST_POSITION = 16;
const DST_SLOT = 16;
const IR_SLOT = 21;

/**
 * The smallest edge, in implied points, worth a roster move. At zero edge the
 * study's swaps lost 0.11 points and each implied point added 0.453
 * (waivers.md:498), so one implied point is roughly where a swap stops being
 * noise. Chosen, not fitted (guess).
 */
export const MIN_EDGE = 1;

const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** A team's implied points from one game_lines row: the frozen close when present. */
function impliedFrom(row) {
  if (row.closing_spread != null && row.closing_total != null) {
    return { implied: row.closing_total / 2 - row.closing_spread / 2, basis: 'close' };
  }
  if (row.implied_points != null) return { implied: row.implied_points, basis: 'latest' };
  if (row.spread != null && row.total != null) return { implied: row.total / 2 - row.spread / 2, basis: 'latest' };
  return { implied: null, basis: null };
}

function kickoffOf(row) {
  if (!row?.gameday) return null;
  return nflKickoffDate(row.gameday, row.gametime || '23:59');
}

/**
 * Rank every defense with a game by the implied total of the offense it faces.
 * `lines` is one week of game_lines rows (linesFor(season, week)). A team with no
 * row is on bye and is not ranked. A defense whose opponent has no priced line is
 * ranked last with `opp_implied: null`, never as a zero.
 */
export function rankDefenses(lines, { now = new Date() } = {}) {
  const byTeam = new Map(lines.map(r => [canonicalTeamCode(r.team), r]));
  const out = [];
  for (const [team, row] of byTeam) {
    const opponent = canonicalTeamCode(row.opponent);
    const oppRow = byTeam.get(opponent);
    let { implied, basis } = oppRow ? impliedFrom(oppRow) : { implied: null, basis: null };
    // The opponent's row is missing but this side's is priced: the total minus
    // this side's share is the same number.
    if (implied == null) {
      const mine = impliedFrom(row);
      const total = row.closing_total ?? row.total;
      if (mine.implied != null && total != null) { implied = total - mine.implied; basis = mine.basis; }
    }
    const kickoff = kickoffOf(row);
    out.push({
      team, opponent, home: row.home == null ? null : !!row.home,
      opp_implied: r2(implied), line_basis: basis,
      kickoff: kickoff ? kickoff.toISOString() : null,
      locked: kickoff ? kickoff.getTime() <= now.getTime() : false,
    });
  }
  out.sort((a, b) => (a.opp_implied ?? Infinity) - (b.opp_implied ?? Infinity) || a.team.localeCompare(b.team));
  return out.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The league's roster rules, from the ESPN settings in the synced payload. */
function rosterRules(lg, payload) {
  const rs = payload?.settings?.rosterSettings ?? {};
  const counts = rs.lineupSlotCounts ?? {};
  const slots = lg.roster_positions ? JSON.parse(lg.roster_positions) : [];
  const startsDef = Number(counts[DST_SLOT] ?? 0) > 0 || slots.includes('DEF');
  // Roster size: every slot but IR. Unknown when the payload has no slot counts.
  const size = Object.keys(counts).length
    ? Object.entries(counts).reduce((s, [k, v]) => s + (Number(k) === IR_SLOT ? 0 : Number(v) || 0), 0)
    : null;
  const lim = rs.positionLimits?.[DST_POSITION];
  const defMax = lim == null || Number(lim) < 0 ? null : Number(lim);
  return { startsDef, size, defMax };
}

/**
 * The streaming board for one team in one league-week.
 *
 * Free agents are derived by subtraction, the waiver wire's rule
 * (waiver-wire.js#rosteredNames): every defense with a game that no roster in the
 * league holds. Defenses whose game has kicked off are not offered.
 */
export function streamingBoard(lg, { myTeamId = null, season, week, now = new Date(), limit = 5 } = {}) {
  const base = { season, week, position: 'DEF', candidates: [], my_defenses: [], suggestion: { action: null, why: null } };
  if (!lg?.payload) return { ...base, error: 'league not synced' };
  const payload = JSON.parse(lg.payload);
  const rules = rosterRules(lg, payload);
  base.roster_rules = { starts_defense: rules.startsDef, roster_size: rules.size, def_max: rules.defMax };
  base.espn_add_url = lg.platform === 'espn' && lg.league_id
    ? `https://fantasy.espn.com/football/players/add?leagueId=${encodeURIComponent(lg.league_id)}` : null;
  if (!rules.startsDef) return { ...base, note: 'This league does not start a defense, so there is nothing to stream.' };

  const ranked = rankDefenses(linesFor(season, week), { now });
  if (!ranked.length) {
    return { ...base, note: `No betting lines are stored for week ${week} yet, so defenses were not ranked. That is missing data, not a finding.` };
  }
  const byTeam = new Map(ranked.map(r => [r.team, r]));

  const rosterId = String(myTeamId ?? lg.my_team_id);
  const heldBy = new Map();
  let myEntries = [];
  for (const t of payload.teams ?? []) {
    const entries = t.roster?.entries ?? [];
    if (String(t.id) === rosterId) myEntries = entries;
    for (const e of entries) {
      const p = e.playerPoolEntry?.player;
      if (p?.defaultPositionId !== DST_POSITION) continue;
      const code = canonicalTeamCode(PRO_TEAM[p.proTeamId]);
      if (code) heldBy.set(code, String(t.id));
    }
  }

  const mine = myEntries
    .map(e => e.playerPoolEntry?.player)
    .filter(p => p?.defaultPositionId === DST_POSITION)
    .map(p => canonicalTeamCode(PRO_TEAM[p.proTeamId]))
    .filter(Boolean)
    .map(team => {
      const r = byTeam.get(team);
      return r ? { team, opponent: r.opponent, opp_implied: r.opp_implied, locked: r.locked, on_bye: false, rank: r.rank }
        : { team, opponent: null, opp_implied: null, locked: false, on_bye: true, rank: null };
    });
  // The drop, if I stream: an unlocked defense of mine, bye first, else the worst matchup.
  const droppable = mine.filter(d => !d.locked)
    .sort((a, b) => (b.on_bye - a.on_bye) || (b.opp_implied ?? Infinity) - (a.opp_implied ?? Infinity));
  const drop = droppable[0] ?? null;

  const free = ranked.filter(r => !heldBy.has(r.team) && !r.locked && r.opp_implied != null);
  const edgeOver = c => (drop && drop.opp_implied != null ? r2(drop.opp_implied - c.opp_implied) : null);
  const candidates = free.slice(0, limit).map(c => ({ ...c, edge: edgeOver(c) }));
  const best = candidates[0] ?? null;

  const rosterCount = myEntries.filter(e => e.lineupSlotId !== IR_SLOT).length;
  let suggestion;
  if (!best) {
    suggestion = { action: null, why: 'No free-agent defense with an unlocked game this week.' };
  } else if (mine.length && !drop) {
    suggestion = { action: null, why: 'Your defense has already started this week, so it cannot be swapped.' };
  } else if (drop) {
    if (drop.on_bye) {
      suggestion = { action: 'swap', add: best, drop, edge: null,
        why: `${drop.team} is on bye; ${best.team} faces ${best.opponent}, implied ${best.opp_implied} points.` };
    } else if (best.edge >= MIN_EDGE) {
      suggestion = { action: 'swap', add: best, drop, edge: best.edge,
        why: `${best.team} faces ${best.opponent} (implied ${best.opp_implied}); ${drop.team} faces ${drop.opponent} (implied ${drop.opp_implied}): ${best.edge} implied points easier.` };
    } else {
      suggestion = { action: 'hold', add: null, drop: null, edge: best.edge,
        why: `No free agent beats ${drop.team}'s matchup by ${MIN_EDGE} implied point or more.` };
    }
  } else if (rules.size != null && rosterCount >= rules.size) {
    suggestion = { action: null, add: best, drop: null, edge: null,
      why: `You have no defense and your roster is full (${rosterCount} of ${rules.size}); drop a bench player to add ${best.team}.` };
  } else if (rules.defMax != null && mine.length >= rules.defMax) {
    suggestion = { action: null, add: best, drop: null, edge: null, why: 'You are at the league\'s D/ST limit.' };
  } else {
    suggestion = { action: 'add', add: best, drop: null, edge: null,
      why: `You have no defense and an open roster spot; ${best.team} faces ${best.opponent}, implied ${best.opp_implied} points.` };
  }

  return {
    ...base,
    candidates,
    my_defenses: mine,
    suggestion,
    free_agent_defenses: free.length,
    min_edge: MIN_EDGE,
    note: `Defenses ranked by the betting market's implied points for the offense they face (the last line before kickoff). Edge = implied points easier than your defense's matchup.`,
  };
}
