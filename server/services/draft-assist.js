/**
 * Live-draft assistant.
 *
 * Everything here is deterministic and instant — the AI layer in `/advice` sits on top
 * of this and explains it, but it must never be in the way of a pick. With 90 seconds
 * on the clock the numbers have to be on screen before Claude has finished a sentence.
 *
 * The two questions this answers that a static cheat sheet cannot:
 *   1. What does MY roster still need, against THIS league's starting lineup?
 *   2. Who will still be there at my next pick, and who definitely won't?
 */
import { rows, row } from '../db/index.js';
import { computeConsensus } from '../routes/aggregates.js';
import { statsMap } from '../routes/stats.js';
import { slotForPick, myUpcomingPicks } from './espn-draft.js';

/** Positions that can fill a FLEX slot in a standard league. */
const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

/**
 * How many of each position a full roster wants.
 * Starters come from the league's own lineup settings; the bench targets are the
 * conventional shape of a winning redraft roster rather than anything ESPN tells us.
 */
const BENCH_TARGET = { QB: 1, RB: 3, WR: 3, TE: 0, K: 0, DEF: 0 };

/**
 * Probability a player is gone before a given pick.
 *
 * Draft position is noisy — a player with an ADP of 30 goes anywhere from the low 20s
 * to the mid 40s — so this is a logistic on the gap between their market rank and the
 * pick in question, not a hard cutoff. The spread widens later in the draft because
 * consensus falls apart once you get past the top ~60 players.
 */
export function goneBy(marketRank, pickNumber) {
  if (marketRank == null) return 0.5;
  const spread = Math.max(4, 3 + marketRank * 0.16);
  return 1 / (1 + Math.exp(-(pickNumber - marketRank) / spread));
}

/** Roster the user has actually drafted, counted by position. */
function myRoster(draft) {
  const sm = statsMap();
  const picks = rows(`SELECT dp.pick_number, p.id, p.name, p.position, p.bye_week,
                             p.espn_id, p.sleeper_id, t.abbr AS team_abbr
                      FROM draft_picks dp JOIN players p ON p.id = dp.player_id
                      LEFT JOIN nfl_teams t ON t.id = p.team_id
                      WHERE dp.draft_id = ? AND dp.team_slot = ? ORDER BY dp.pick_number`,
    draft.id, draft.my_slot).map(p => {
      const st = sm.get(p.id);
      return { ...p, player_id: p.id,
               projected_points: st?.projected_points ?? null,
               projected_pos_rank: st?.projected_pos_rank ?? null };
    });
  const counts = {};
  for (const p of picks) counts[p.position] = (counts[p.position] ?? 0) + 1;
  return { picks, counts };
}

/**
 * Unfilled starting slots, flex included.
 *
 * Flex is only "needed" once the dedicated RB/WR/TE slots are full, otherwise a team
 * with one RB reads as needing both an RB and a flex, and double-counts the same hole.
 */
export function rosterNeeds(counts, slots) {
  const need = {};
  const spare = { RB: 0, WR: 0, TE: 0 };
  for (const [pos, want] of Object.entries(slots)) {
    if (pos === 'FLEX' || pos === 'OP') continue;
    const have = counts[pos] ?? 0;
    need[pos] = Math.max(0, want - have);
    if (FLEX_ELIGIBLE.includes(pos)) spare[pos] = Math.max(0, have - want);
  }
  const flexWanted = (slots.FLEX ?? 0) + (slots.OP ?? 0);
  const flexFilled = Math.min(flexWanted, spare.RB + spare.WR + spare.TE);
  need.FLEX = Math.max(0, flexWanted - flexFilled);

  // Depth beyond the starting lineup — what's left to fill out a real bench.
  const depth = {};
  for (const [pos, extra] of Object.entries(BENCH_TARGET)) {
    const starters = slots[pos] ?? 0;
    depth[pos] = Math.max(0, starters + extra - (counts[pos] ?? 0) - (need[pos] ?? 0) * 0);
  }
  return { starters: need, depth };
}


/**
 * Sort a drafted roster into this league's actual starting lineup, plus the bench.
 *
 * Dedicated slots are filled first and flex last, from whoever is left — greedy is
 * optimal here because flex eligibility is a superset of the dedicated slots, so no
 * player pulled into flex could have scored more in a slot he was passed over for.
 * Ordering is by projection, falling back to draft order when a player has none
 * (kickers and defenses usually do not).
 */
export function buildLineup(picks, slots) {
  const pool = [...picks].sort((a, b) =>
    (b.projected_points ?? -1) - (a.projected_points ?? -1) || a.pick_number - b.pick_number);
  const used = new Set();
  const starters = [];

  const take = (pos, label) => {
    const p = pool.find(x => !used.has(x.player_id) && x.position === pos);
    if (p) used.add(p.player_id);
    starters.push({ slot: label, player: p ?? null });
  };

  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
    for (let i = 0; i < (slots[pos] ?? 0); i++) {
      take(pos, (slots[pos] ?? 0) > 1 ? `${pos}${i + 1}` : pos);
    }
  }
  for (let i = 0; i < ((slots.FLEX ?? 0) + (slots.OP ?? 0)); i++) {
    const p = pool.find(x => !used.has(x.player_id) && FLEX_ELIGIBLE.includes(x.position));
    if (p) used.add(p.player_id);
    starters.push({ slot: 'FLEX', player: p ?? null });
  }

  const bench = pool.filter(p => !used.has(p.player_id));
  const projectedTotal = starters.reduce((s, x) => s + (x.player?.projected_points ?? 0), 0);
  return {
    starters,
    bench,
    filled: starters.filter(s => s.player).length,
    slots_total: starters.length,
    projected_total: projectedTotal ? Math.round(projectedTotal) : null
  };
}

/** Positional run detection over the last N picks. */
function positionalRuns(allPicks, window = 10) {
  const recent = allPicks.slice(-window);
  const counts = {};
  for (const p of recent) counts[p.position] = (counts[p.position] ?? 0) + 1;
  return Object.entries(counts)
    .filter(([pos, n]) => ['QB', 'RB', 'WR', 'TE'].includes(pos) && n >= Math.max(3, window * 0.4))
    .map(([pos, n]) => ({ position: pos, taken: n, of: recent.length }))
    .sort((a, b) => b.taken - a.taken);
}

/**
 * Full board read for the pick that is currently on the clock.
 *
 * `urgency` is the number that actually drives decisions: how much value at a position
 * evaporates between this pick and the next one the user owns. A position where the
 * top 3 will all be gone is one to take now, even if a different position is a bigger
 * hole on paper.
 */
export function boardState(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });

  const slots = draft.roster_slots ? JSON.parse(draft.roster_slots)
    : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1 };
  const allPicks = rows(`SELECT dp.pick_number, dp.team_slot, p.id, p.name, p.position,
                                p.espn_id, p.sleeper_id, t.abbr AS team_abbr
                         FROM draft_picks dp JOIN players p ON p.id = dp.player_id
                         LEFT JOIN nfl_teams t ON t.id = p.team_id
                         WHERE dp.draft_id = ? ORDER BY dp.pick_number`, draftId);
  const taken = new Set(allPicks.map(p => p.id));

  const nextPick = allPicks.length + 1;
  const total = draft.team_count * draft.rounds;
  const round = Math.ceil(nextPick / draft.team_count);
  const mine = myRoster(draft);
  const needs = rosterNeeds(mine.counts, slots);
  const upcoming = myUpcomingPicks(nextPick, draft.my_slot, draft.team_count, draft.rounds, 4);
  const myNext = upcoming[0] ?? null;
  const myAfter = upcoming.find(p => p !== myNext) ?? null;

  const sm = statsMap();
  const available = computeConsensus()
    .filter(p => !taken.has(p.id))
    .map((p, i) => {
      const st = sm.get(p.id);
      return {
        player_id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
        espn_id: p.espn_id, sleeper_id: p.sleeper_id,
        market_rank: Math.round(p.consensus),
        board_rank: i + 1,
        adp: p.ffc_adp ?? null,
        injury_flag: p.injury_flag ?? null,
        projected_points: st?.projected_points ?? null,
        projected_pos_rank: st?.projected_pos_rank ?? null,
        last_season_points: st?.last_season_points ?? null,
        // Odds this player is gone before the user's pick after this one.
        gone_by_next: myAfter ? +goneBy(p.consensus, myAfter).toFixed(2) : null
      };
    });

  // Kickers and defenses have no ADP/market data, so computeConsensus() never
  // includes them — without this, rankTargets/the AI advisor could never see or
  // recommend a K or DEF for the entire draft. Tail-inject them at a late market
  // rank, same idiom as the mock-draft CPU pool in routes/drafts.js.
  const tailBase = available.length + 50;
  let tailN = 0;
  for (const p of rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id
                        WHERE p.position IN ('K','DEF') AND p.fantasy_relevant = 1`)) {
    if (taken.has(p.id)) continue;
    tailN++;
    available.push({
      player_id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      espn_id: p.espn_id, sleeper_id: p.sleeper_id,
      market_rank: tailBase + tailN, board_rank: available.length + tailN,
      adp: null, injury_flag: null, projected_points: null, projected_pos_rank: null,
      last_season_points: null, gone_by_next: null
    });
  }

  // Value over the replacement the user would get at their NEXT turn at that position —
  // the honest measure of what waiting costs, rather than value over a season-long
  // baseline that ignores when the picks actually happen.
  const byPos = {};
  for (const p of available) (byPos[p.position] ??= []).push(p);

  const positions = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
    const list = byPos[pos] ?? [];
    if (!list.length) { positions[pos] = { available: 0 }; continue; }
    const best = list[0];
    // Expected survivors at this position by the user's following pick.
    const survivors = myAfter ? list.filter(p => goneBy(p.market_rank, myAfter) < 0.5) : list;
    const fallback = survivors[0] ?? list[list.length - 1];
    const bestPts = best.projected_points ?? 0;
    const fallbackPts = fallback?.projected_points ?? 0;
    positions[pos] = {
      available: list.length,
      best: best.name,
      best_player_id: best.player_id,
      // top of the position likely to survive to the user's next-but-one pick
      fallback: fallback?.name ?? null,
      fallback_player_id: fallback?.player_id ?? null,
      expected_survivors: survivors.length,
      // points of production surrendered by waiting one full turn
      cost_of_waiting: bestPts && fallbackPts ? +(bestPts - fallbackPts).toFixed(1) : null,
      starters_needed: needs.starters[pos] ?? 0,
      depth_needed: needs.depth[pos] ?? 0,
      rostered: mine.counts[pos] ?? 0
    };
  }

  // Tier cliff: the biggest projection drop-off inside the next few players available
  // at each position, which is where "take him now or take the tier below" lives.
  for (const pos of Object.keys(positions)) {
    const list = (byPos[pos] ?? []).filter(p => p.projected_points != null).slice(0, 8);
    let cliff = null;
    for (let i = 0; i < list.length - 1; i++) {
      const drop = list[i].projected_points - list[i + 1].projected_points;
      if (!cliff || drop > cliff.drop) cliff = { after: list[i].name, drop: +drop.toFixed(1), depth: i + 1 };
    }
    positions[pos].tier_cliff = cliff;
  }

  return {
    draft: {
      id: draft.id, name: draft.name, type: draft.type, team_count: draft.team_count,
      rounds: draft.rounds, my_slot: draft.my_slot, pick_seconds: draft.pick_seconds,
      status: draft.status, last_synced_at: draft.last_synced_at, draft_at: draft.draft_at,
      espn_league_id: draft.espn_league_id, league_row_id: draft.league_row_id,
      roster_slots: slots, pick_order: draft.pick_order ? JSON.parse(draft.pick_order) : null
    },
    on_the_clock: {
      pick_number: nextPick <= total ? nextPick : null,
      round,
      slot: nextPick <= total ? slotForPick(nextPick, draft.team_count) : null,
      my_turn: nextPick <= total && slotForPick(nextPick, draft.team_count) === draft.my_slot,
      picks_until_my_turn: myNext ? myNext - nextPick : null,
      my_upcoming_picks: upcoming,
      complete: nextPick > total
    },
    my_team: { picks: mine.picks, counts: mine.counts, needs, lineup: buildLineup(mine.picks, slots) },
    runs: positionalRuns(allPicks),
    positions,
    // The board itself, trimmed — the UI paginates, and the AI prompt only needs the top.
    available: available.slice(0, 120),
    recent_picks: allPicks.slice(-12).reverse()
  };
}

/**
 * Ranked shortlist for the current pick: market value, weighted by what the roster
 * actually needs and by what will not survive the round trip to the next pick.
 */
export function rankTargets(state, limit = 8) {
  const { on_the_clock, my_team, positions } = state;
  const round = on_the_clock.round;
  const roundsLeft = state.draft.rounds - round + 1;

  return state.available.slice(0, 60).map(p => {
    const pos = positions[p.position] ?? {};
    const reasons = [];
    let score = -p.board_rank;

    if (pos.starters_needed > 0) {
      score += 8 + pos.starters_needed * 2;
      reasons.push(`fills a starting ${p.position} slot`);
    } else if (pos.depth_needed > 0) {
      score += 2;
    } else if (['QB', 'TE'].includes(p.position)) {
      score -= 22;
      reasons.push(`already have your ${p.position}`);
    }

    // Scarcity: taking a player who won't survive the turn is worth real points.
    if (p.gone_by_next != null && p.gone_by_next > 0.6 && (pos.starters_needed > 0 || pos.depth_needed > 0)) {
      score += 6 * p.gone_by_next;
      reasons.push(`${Math.round(p.gone_by_next * 100)}% gone by your next pick`);
    }
    if (pos.cost_of_waiting != null && pos.cost_of_waiting > 15 && p.board_rank <= 12) {
      reasons.push(`waiting a turn at ${p.position} costs ~${Math.round(pos.cost_of_waiting)} pts`);
    }

    // Kicker and defense are streamed; drafting either before the last two rounds is
    // simply worse than the alternative, whatever the board says.
    if (p.position === 'K' && roundsLeft > 1) { score -= 80; reasons.push('far too early for a kicker'); }
    if (p.position === 'DEF' && roundsLeft > 2) { score -= 60; reasons.push('stream a defense at the end'); }

    // A run at a position means the next tier disappears faster than ADP implies.
    const run = state.runs.find(r => r.position === p.position);
    if (run && (pos.starters_needed > 0 || pos.depth_needed > 0)) {
      score += 3;
      reasons.push(`${run.taken} ${p.position}s in the last ${run.of} picks`);
    }

    if (p.injury_flag) { score -= 4; reasons.push('carrying an injury flag'); }

    return { ...p, score: +score.toFixed(2), reasons };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ---------------------------------------------------------------- dossiers */

const SEASON = Number(process.env.NFL_SEASON) || new Date().getFullYear();

/**
 * Everything worth knowing about one player before you spend a pick on him.
 *
 * The point is to ground the AI in this league's actual data rather than let it recall
 * a player's reputation: last season's real production, this season's projected stat
 * line, draft pedigree (which is also how we know who is a rookie), injury status, and
 * whatever camp reporting has come in. Camp news is stored per team rather than per
 * player, so players are matched by name against the headline and body — imperfect for
 * common surnames, which is why the full name is required rather than the last name.
 */
export function playerDossier(playerId) {
  const p = row(`SELECT p.id, p.name, p.position, p.bye_week, t.abbr AS team_abbr, t.name AS team_name
                 FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, playerId);
  if (!p) return null;

  const seasons = rows(`SELECT season, kind, fantasy_points, games, raw FROM player_season_stats
                        WHERE player_id = ? ORDER BY season DESC`, playerId);
  const projected = seasons.find(s => s.kind === 'projected' && s.season === SEASON);
  const lastYear = seasons.find(s => s.kind === 'actual' && s.season === SEASON - 1);
  const priorYear = seasons.find(s => s.kind === 'actual' && s.season === SEASON - 2);

  const acc = row(`SELECT draft_year, draft_round, draft_pick, pro_bowls, first_team_all_pro, all_rookie
                   FROM player_accolades WHERE name = ? LIMIT 1`, p.name);
  const experience = acc?.draft_year ? SEASON - acc.draft_year : null;

  const injury = row(`SELECT value FROM player_metrics WHERE player_id = ? AND source = 'injury_flag'`, playerId);
  // Most recent injury report for this player, from the league-wide feed.
  const report = row(`SELECT season, week, report_status, practice_status, injury FROM nfl_injuries
                      WHERE full_name = ? ORDER BY season DESC, week DESC LIMIT 1`, p.name);

  // Camp reporting: the freshest items naming this player, on his own team's feed or
  // the league-wide one. Trimmed hard — this goes into a prompt on a 90-second clock.
  const news = rows(`SELECT date, headline, body, fantasy_impact, importance FROM news_items
                     WHERE headline LIKE ? OR body LIKE ?
                     ORDER BY date DESC, importance DESC LIMIT 3`, `%${p.name}%`, `%${p.name}%`);

  const line = raw => {
    if (!raw) return null;
    try {
      const r = JSON.parse(raw);
      const bits = [];
      if (r.rushAtt) bits.push(`${Math.round(r.rushAtt)} carries / ${Math.round(r.rushYds)} yds / ${r.rushTD?.toFixed(1)} TD`);
      if (r.targets) bits.push(`${Math.round(r.targets)} tgt / ${Math.round(r.rec)} rec / ${Math.round(r.recYds)} yds / ${r.recTD?.toFixed(1)} TD`);
      if (r.passYds) bits.push(`${Math.round(r.passYds)} pass yds / ${r.passTD?.toFixed(1)} TD / ${r.int?.toFixed(1)} INT`);
      return bits.join(', ') || null;
    } catch { return null; }
  };

  return {
    player_id: p.id, name: p.name, position: p.position, team: p.team_abbr, bye_week: p.bye_week,
    experience_years: experience,
    rookie: experience === 0,
    draft_capital: acc?.draft_year
      ? `${acc.draft_year} round ${acc.draft_round ?? '?'}${acc.draft_pick ? `, pick ${acc.draft_pick}` : ''}`
      : null,
    pro_bowls: acc?.pro_bowls ?? 0,
    all_pro: acc?.first_team_all_pro ?? 0,
    projected_points: projected?.fantasy_points ?? null,
    projected_line: line(projected?.raw),
    last_season: lastYear ? { points: Math.round(lastYear.fantasy_points), games: lastYear.games, line: line(lastYear.raw) } : null,
    prior_season: priorYear ? { points: Math.round(priorYear.fantasy_points), games: priorYear.games } : null,
    injury_flag: injury?.value ?? null,
    injury_report: report?.injury
      ? `${report.injury}${report.report_status ? ` — ${report.report_status}` : ''}${report.practice_status ? ` (${report.practice_status})` : ''} [${report.season} wk ${report.week}]`
      : null,
    camp_news: news.map(n => ({ date: n.date, headline: n.headline, note: (n.fantasy_impact ?? n.body ?? '').slice(0, 260) }))
  };
}

/** Dossiers for a shortlist, in board order. */
export const dossiersFor = (playerIds) => playerIds.map(playerDossier).filter(Boolean);
