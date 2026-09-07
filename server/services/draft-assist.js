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
import { readFileSync } from 'node:fs';
import { rows, row } from '../db/index.js';
import { computeConsensus } from '../routes/aggregates.js';
import { statsMap } from '../routes/stats.js';
import { slotForPick, myUpcomingPicks } from './espn-draft.js';
import { weeklyProjectionFor } from './fantasy-coordinator.js';
import { tradeWeekContext } from './trade-engine.js';
import { deriveFormat } from './format.js';
import { cfbdSignalFor } from './cfbd.js';
import { buildProjections } from './projections.js';
import { offseasonContextFor } from './nfl-offseason-change.js';
import { canonicalTeamCode } from './team-codes.js';
import { RECOMMENDED_MODEL_BLEND_WEIGHT } from './preseason-model.js';

/**
 * Who changed teams and how much opportunity opened up where they landed
 * (nfl-offseason-change.js — validated: MAE 3.202→3.169, CI [-0.064,-0.0008]
 * on 2025 weeks 2-5). A mover into a crowded room (low vacated share) keeps
 * a median 74-82% of his prior opportunity; a mover into real vacated share
 * does not need the discount. Built once per process.
 */
let offseasonCache = null;
function offseasonContext(season) {
  if (!offseasonCache || offseasonCache.season !== season) {
    try {
      const raw = offseasonContextFor(season);
      // nflverse and this DB disagree on some team codes (LA vs LAR is the
      // known one) — compare canonical codes so a team that only renamed
      // itself in the data doesn't read as a real trade.
      const fixed = new Map();
      for (const [id, c] of raw) {
        const reallyMoved = c.changed_team && canonicalTeamCode(c.prior_team) !== canonicalTeamCode(c.current_team);
        fixed.set(id, reallyMoved === c.changed_team ? c : { ...c, changed_team: reallyMoved });
      }
      offseasonCache = { season, data: fixed };
    } catch { offseasonCache = { season, data: new Map() }; }
  }
  return offseasonCache.data;
}
const MOVER_RETENTION = { QB: 0.85, RB: 0.78, WR: 0.74, TE: 0.82 };

/**
 * Our own season projection (projections.js — volume × efficiency with
 * availability modelled as share of team games; 2025 held-out: MAE 42.9 /
 * Spearman 0.776 vs 47.0 / 0.754 for last-season points) as a second opinion
 * next to ESPN's line. It runs ~19% below ESPN across the board because it
 * prices missed games and ESPN assumes 17 healthy ones, so what carries
 * information is each player's disagreement RELATIVE to that league-wide
 * gap — Rashee Rice at −47% when the board averages −19% is a real read on
 * availability; −19% on its own is not.
 *
 * Blend weight backtested 2026-09-06 on 2025 held out, top-150 by preseason
 * expert consensus (n=118), Spearman with actual season points: consensus
 * alone 0.399, our model alone 0.417, rank-blend 0.437 at w=0.3, 0.440 at 0.5,
 * 0.446 at 0.7 (scratchpad/blend-backtest.mjs). One season of evidence, so
 * 0.4 was shipped first — inside the range that helped, short of the peak.
 *
 * Re-run 2026-09-07 with 3 held-out seasons (2023-2025) instead of 1, market
 * curve standing in for ESPN's points: 0.2 is the only weight beating w=0 on
 * MAE in 2 of 3 seasons at both top-150 and top-200, keeping most of the TE
 * gain while halving 0.4's damage to QB/RB. No weight is significant on any
 * season (0/3 paired bootstrap) — see preseason-model.js's
 * RECOMMENDED_MODEL_BLEND_WEIGHT and docs/PRESEASON_MODEL.md "v2" for the
 * full table. Imported rather than redefined so the two files can't drift.
 *
 * Built once per process (~0.7s) on the first board read.
 */
const MODEL_BLEND_WEIGHT = RECOMMENDED_MODEL_BLEND_WEIGHT;
let modelProjections = null;
function modelPointsMap() {
  if (!modelProjections) {
    try { modelProjections = buildProjections({ through: SEASON - 1 }); }
    catch { modelProjections = new Map(); }
  }
  return modelProjections;
}

// Tested and declined 2026-09-06: boom-bust.js#predictRankGap as a per-player
// nudge. Its walk-forward win over "ADP is right" (MAE 34.5 vs 43.6) is
// entirely rank mean-reversion — a rank-only GBM scores 33.7/35.4 on
// 2024/2025 against the full model's 34.6/34.5, and the residual the player
// features add has Spearman −0.03..+0.04 against the actual residual in the
// draftable top 60. Nothing there to rank a pick on.

/** Positions that can fill a FLEX slot in a standard league. */
export const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

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
  // Fitted 2026-09-06 on the 262 market-ranked picks from the two real 2026
  // drafts mirrored in this DB (DMV, Transfer Portal), by log-loss over 13
  // horizons, and checked leave-one-draft-out: 0.166 vs 0.182 and 0.159 vs
  // 0.177 for the old hand-set curve on the held-out draft. Two findings:
  // the spread was too wide (a=3,b=0.16 → 2.5,0.08), and from about market
  // rank 80 on, players go EARLIER than their rank — late-round reaches —
  // by roughly a quarter of the distance past 80.
  // Refit 2026-09-06 (later the same day) once ESPN's own ADP entered the
  // consensus the ranks come from (n=280): a=1.5-2, b=0.10, shift 0.15-0.25
  // past rank 100 on both leave-one-draft-out folds; 0.163 vs 0.167 and
  // 0.149 vs 0.150 log-loss against the previous parameters.
  const centre = marketRank > 100 ? marketRank - 0.2 * (marketRank - 100) : marketRank;
  const spread = Math.max(1.5, 2 + marketRank * 0.10);
  return 1 / (1 + Math.exp(-(pickNumber - centre) / spread));
}

/**
 * Replacement level: the player you could get for free once every team has a
 * starter (plus the bench the league actually carries) at this position.
 *
 * Value over this baseline is what makes an 8-team league different from a
 * 12-team one — with 8 teams the 9th QB is still good, so a QB's edge over him
 * is small and the elite RB/WR edge over the 20th RB/WR is enormous. Demand
 * shrinks as the league drafts the position, so the baseline is taken from the
 * players still available rather than from a season-long list.
 */
const BENCH_DEMAND = { QB: 0.4, RB: 1.0, WR: 1.0, TE: 0.3, K: 0, DEF: 0 };
export function replacementLevel(availableAtPos, pos, slots, teams, takenAtPos = 0) {
  const flexShare = FLEX_ELIGIBLE.includes(pos) ? ((slots.FLEX ?? 0) + (slots.OP ?? 0)) / FLEX_ELIGIBLE.length : 0;
  const leagueDemand = teams * ((slots[pos] ?? 0) + flexShare + (BENCH_DEMAND[pos] ?? 0));
  const remaining = Math.max(1, Math.round(leagueDemand - takenAtPos));
  const projected = availableAtPos.filter(p => p.projected_points != null);
  if (!projected.length) return { points: null, name: null, index: remaining };
  const pick = projected[Math.min(remaining, projected.length) - 1];
  return { points: +pick.projected_points.toFixed(1), name: pick.name, index: remaining };
}

/**
 * Expected projection of the best player still available at a position when
 * pick P comes around, under the same survival model goneBy() encodes: walk
 * the position in projection order, and each player is "the best left" with
 * the probability he survived times the probability everyone better did not.
 *
 * This replaces a static "Nth by market" baseline, which contradicted the
 * survival model: it said the 27th WR (177 pts) was free, while goneBy said
 * a 225-pt WR is what actually sits there at pick 63 — inflating every WR's
 * value over replacement by ~48 points and every QB's by ~45.
 */
export function expectedBest(list, P) {
  const l = list.filter(p => p.projected_points != null).sort((a, b) => b.projected_points - a.projected_points);
  let pNone = 1, e = 0, top = null;
  for (const p of l) {
    const s = 1 - goneBy(p.market_rank, P);
    e += pNone * s * p.projected_points;
    if (!top && s >= 0.5) top = p;
    pNone *= 1 - s;
    if (pNone < 1e-4) break;
  }
  return { points: l.length ? +e.toFixed(1) : null, likely: top ?? l[l.length - 1] ?? null };
}

/**
 * Bye week per team, by abbreviation, from the schedule: the one week in 1..18
 * a team has no game. `players.bye_week` was never written (NULL for every
 * row), so every dossier said "bye ?" until this.
 */
const byeCache = new Map();
export function byeWeeks(season) {
  if (byeCache.has(season)) return byeCache.get(season);
  const out = new Map();
  const weeks = {};
  for (const r of rows(`SELECT t.abbr, g.week FROM schedule_games g JOIN nfl_teams t ON t.id = g.team_id WHERE g.season = ?`, season)) {
    (weeks[r.abbr] ??= new Set()).add(r.week);
  }
  for (const [abbr, set] of Object.entries(weeks)) {
    if (set.size < 15) continue;                         // partial schedule: don't guess
    const maxWeek = Math.max(...set);
    for (let w = 1; w <= maxWeek; w++) if (!set.has(w)) { out.set(abbr, w); break; }
  }
  byeCache.set(season, out);
  return out;
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
               bye_week: p.bye_week ?? byeWeeks(draft.season ?? SEASON).get(p.team_abbr) ?? null,
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
export function rosterNeeds(counts, slots, teams = 12) {
  // A backup QB is a 12-team habit: with 8 teams there are 16+ starting QBs
  // on waivers all year, so the bench target for QB is zero there.
  const benchTarget = { ...BENCH_TARGET, QB: teams >= 12 ? 1 : 0 };
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
  for (const [pos, extra] of Object.entries(benchTarget)) {
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

/**
 * Best-ball detection for the league behind a live draft (mock drafts, which
 * have no league_row_id, are never best-ball). Format-conditional logic below
 * is gated on this rather than duplicating deriveFormat()'s own field-reading.
 */
function formatForDraft(draft) {
  if (!draft.league_row_id) return { isBestBall: false };
  const lg = row('SELECT * FROM leagues WHERE id = ?', draft.league_row_id);
  return lg ? deriveFormat(lg) : { isBestBall: false };
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
export function boardState(draftId, teamSlot = null, { poolLimit = 120 } = {}) {
  const persistedDraft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  const draft = persistedDraft && { ...persistedDraft, my_slot: teamSlot ?? persistedDraft.my_slot };
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
  const needs = rosterNeeds(mine.counts, slots, draft.team_count);
  const upcoming = myUpcomingPicks(nextPick, draft.my_slot, draft.team_count, draft.rounds, 4);
  const myNext = upcoming[0] ?? null;
  const myAfter = upcoming.find(p => p !== myNext) ?? null;
  const myPicksAll = myUpcomingPicks(nextPick, draft.my_slot, draft.team_count, draft.rounds, draft.rounds + 1);

  // Snake pair: from slot 2 the picks come 15/18, 31/34, 47/50 — when the
  // next-but-one pick is only 2-3 picks after the next, the two are ONE
  // decision made against the long wait after them. So the horizon for "who
  // survives" is the pick after the pair, and the pair is ordered by who is
  // gone in the 2-3 picks between (gone_by_pair). Without this the first pick
  // of a pair saw a 3-pick horizon, nobody was "gone", and the board fell back
  // to raw value — which is how a QB won pick 15.
  const paired = myNext != null && myAfter != null && myAfter - myNext <= 3;
  const pairHorizon = paired ? (myPicksAll.find(p => p > myAfter) ?? myAfter) : myAfter;

  // The pick at which every team has filled its starting lineup — the honest
  // "free agent" baseline lives there, not at an arbitrary depth count.
  const starterSlots = Object.entries(slots).filter(([k]) => !['K', 'DEF'].includes(k)).reduce((s, [, v]) => s + v, 0);
  const pFill = myPicksAll.find(p => p >= draft.team_count * starterSlots) ?? myPicksAll[myPicksAll.length - 1] ?? nextPick;

  // Every other team's roster is on the board pick by pick, so "will he be
  // there at my next turn" can look at who actually picks in between and
  // what they still need. goneBy() is calibrated on average teams; here the
  // horizon it is asked about is stretched or shrunk by how much more or less
  // interested the intervening teams are in a position than the league
  // average — a QB is far safer to wait on once six of eight teams have one.
  const countsBySlot = {};
  for (const p of allPicks) ((countsBySlot[p.team_slot] ??= {})[p.position] = (countsBySlot[p.team_slot]?.[p.position] ?? 0) + 1);
  const needsBySlot = {};
  for (let s = 1; s <= draft.team_count; s++) needsBySlot[s] = rosterNeeds(countsBySlot[s] ?? {}, slots, draft.team_count);
  const interest = (slot, pos) => {
    const n = needsBySlot[slot];
    if ((n.starters[pos] ?? 0) > 0) return 1;
    if (FLEX_ELIGIBLE.includes(pos) && (n.starters.FLEX ?? 0) > 0) return 0.9;
    if ((n.depth[pos] ?? 0) > 0) return 0.6;
    if (pos === 'K' || pos === 'DEF') return 0.05;
    return ['QB', 'TE'].includes(pos) ? 0.12 : 0.35;
  };
  const picksBetween = (from, to) => {
    const out = [];
    for (let n = from; n < to; n++) { const s = slotForPick(n, draft.team_count); if (s !== draft.my_slot) out.push({ pick: n, slot: s }); }
    return out;
  };
  // Effective horizon per position for "gone by the pick after my next turn
  // (or after the pair)": the calendar horizon stretched or shrunk by how much
  // the intervening teams want the position relative to the league average.
  const horizonFor = {};
  const between = pairHorizon ? picksBetween(nextPick, pairHorizon) : [];
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    if (!pairHorizon || !between.length) { horizonFor[pos] = pairHorizon; continue; }
    const league = Object.keys(needsBySlot).filter(s => Number(s) !== draft.my_slot)
      .reduce((s, slot) => s + interest(Number(slot), pos), 0) / Math.max(1, draft.team_count - 1);
    const ahead = between.reduce((s, x) => s + interest(x.slot, pos), 0) / between.length;
    const ratio = Math.max(0.4, Math.min(1.5, ahead / Math.max(0.05, league)));
    horizonFor[pos] = nextPick + (pairHorizon - nextPick) * ratio;
  }
  // Draft pedigree and depth-chart slot for the late-round terms in rankTargets.
  const pedigree = new Map(rows(`SELECT name, draft_year, draft_round FROM player_accolades WHERE draft_year IS NOT NULL`).map(r => [r.name, r]));
  const slotCode = new Map(rows(`SELECT id, slot_code FROM players WHERE slot_code IS NOT NULL`).map(r => [r.id, r.slot_code]));
  const byes = byeWeeks(draft.season ?? SEASON);
  const teamName = slot => {
    try { const po = draft.pick_order ? JSON.parse(draft.pick_order) : null; const espnId = po?.order?.[slot - 1]; return po?.team_names?.[espnId] ?? `Team ${slot}`; }
    catch { return `Team ${slot}`; }
  };
  const picksBeforeMyTurn = (myNext ? picksBetween(nextPick, myNext) : []).map(x => ({
    pick: x.pick, slot: x.slot, team: teamName(x.slot),
    needs: Object.entries(needsBySlot[x.slot].starters).filter(([, n]) => n > 0).map(([pos, n]) => n > 1 ? `${pos}×${n}` : pos)
  }));

  const sm = statsMap();
  const consensus = computeConsensus();
  const ours = modelPointsMap();
  // League-wide ratio of our model to ESPN over the draftable pool, so a
  // player's disagreement is read against the board, not against 17 games.
  const ratios = consensus.slice(0, 150).map(p => {
    const e = sm.get(p.id)?.projected_points, o = ours.get(p.id)?.points;
    return e > 0 && o > 0 ? o / e : null;
  }).filter(x => x != null);
  const modelScale = ratios.length >= 30 ? ratios.reduce((s, x) => s + x, 0) / ratios.length : null;

  const available = consensus
    .filter(p => !taken.has(p.id))
    .map((p, i) => {
      const st = sm.get(p.id);
      const espnPts = st?.projected_points ?? null;
      const modelPts = ours.get(p.id)?.points ?? null;
      // Relative disagreement: +0.10 means our model likes him 10% more than
      // it likes the board on average; clipped so one number cannot own a pick.
      const modelRel = espnPts > 0 && modelPts > 0 && modelScale
        ? Math.max(-0.35, Math.min(0.35, modelPts / (espnPts * modelScale) - 1)) : null;
      const projected = espnPts == null ? null
        : modelRel == null ? espnPts
        : +(espnPts * (1 + MODEL_BLEND_WEIGHT * modelRel)).toFixed(1);
      return {
        player_id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
        espn_id: p.espn_id, sleeper_id: p.sleeper_id,
        market_rank: Math.round(p.consensus),
        board_rank: i + 1,
        adp: p.ffc_adp ?? null,
        espn_adp: p.espn_adp ?? null,
        espn_injury_status: p.espn_injury_status ?? null,
        injury_flag: p.injury_flag ?? null,
        // ESPN's season line, nudged by our model's relative read (see MODEL_BLEND_WEIGHT).
        projected_points: projected,
        espn_points: espnPts,
        model_points: modelPts == null ? null : Math.round(modelPts),
        model_rel: modelRel == null ? null : +modelRel.toFixed(2),
        projected_pos_rank: st?.projected_pos_rank ?? null,
        last_season_points: st?.last_season_points ?? null,
        bye_week: byes.get(p.team_abbr) ?? null,
        slot_code: slotCode.get(p.id) ?? null,
        draft_year: pedigree.get(p.name)?.draft_year ?? null,
        draft_round: pedigree.get(p.name)?.draft_round ?? null,
        moved: offseasonContext(draft.season ?? SEASON).get(p.id)?.changed_team ?? null,
        moved_vacated_share: offseasonContext(draft.season ?? SEASON).get(p.id)?.new_team_vacated_target_share ?? null,
        // Odds this player is gone before the pick after my next turn (after the pair, when paired).
        gone_by_next: pairHorizon ? +goneBy(p.consensus, horizonFor[p.position] ?? pairHorizon).toFixed(2) : null,
        // When my next two picks are back to back: odds he is gone in the picks between them.
        gone_by_pair: paired ? +goneBy(p.consensus, myAfter).toFixed(2) : null
      };
    });

  // Kickers/defenses have no ADP/market data, so computeConsensus() never includes
  // them — without this, rankTargets/the AI advisor could never see or recommend a
  // K or DEF for the entire draft. Also covers the broader case: computeConsensus()
  // needs a live FFC/Sleeper sync to return anything at all, so on a fresh/offline
  // install this is what stops the pool from running dry regardless of position.
  const tailBase = available.length + 50;
  let tailN = 0;
  const seenIds = new Set(available.map(p => p.player_id));
  for (const p of rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id
                        WHERE p.fantasy_relevant = 1`)) {
    if (taken.has(p.id) || seenIds.has(p.id)) continue;
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
  const takenByPos = {};
  for (const p of allPicks) takenByPos[p.position] = (takenByPos[p.position] ?? 0) + 1;

  const positions = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
    const list = byPos[pos] ?? [];
    if (!list.length) { positions[pos] = { available: 0 }; continue; }
    const best = [...list].sort((a, b) => (b.projected_points ?? -1) - (a.projected_points ?? -1))[0];
    // Who I would get instead if I wait: the EXPECTED best projection still
    // there at the horizon under the survival model, not the first survivor in
    // market order (which once named a 187-pt RB while a 239-pt one was
    // expected to be there, tripling the urgency on the pick in hand).
    const projectedList = list.filter(p => p.projected_points != null);
    const H = horizonFor[pos] ?? pairHorizon;
    const survivors = H ? projectedList.filter(p => goneBy(p.market_rank, H) < 0.5) : projectedList;
    const eb = H ? expectedBest(list, H) : { points: null, likely: null };
    const fallback = eb.likely ?? projectedList[projectedList.length - 1] ?? list[list.length - 1];
    const bestPts = best?.projected_points ?? 0;
    const fallbackPts = eb.points ?? fallback?.projected_points ?? 0;
    // Baseline: what is expected to be free once every lineup is full (or at
    // the horizon, whichever is later). K/DEF keep the simple depth count —
    // nobody drafts them until the end and their ranks carry no survival info.
    const replacement = (pos === 'K' || pos === 'DEF')
      ? replacementLevel(list, pos, slots, draft.team_count, takenByPos[pos] ?? 0)
      : (() => { const r = expectedBest(list, Math.max(pFill, H ?? 0)); return { points: r.points, name: r.likely?.name ?? null }; })();
    positions[pos] = {
      available: list.length,
      best: best?.name ?? null,
      best_player_id: best?.player_id ?? null,
      // top of the position likely to survive to the user's next-but-one pick
      fallback: fallback?.name ?? null,
      fallback_player_id: fallback?.player_id ?? null,
      fallback_points: fallbackPts || null,
      expected_survivors: survivors.length,
      // points of production surrendered by waiting one full turn
      cost_of_waiting: bestPts && fallbackPts ? +(bestPts - fallbackPts).toFixed(1) : null,
      // what a freely available starter at this position projects to once the
      // league has filled its lineups — the baseline every pick is measured against
      replacement_points: replacement.points,
      replacement: replacement.name,
      taken_league_wide: takenByPos[pos] ?? 0,
      starters_needed: needs.starters[pos] ?? 0,
      depth_needed: needs.depth[pos] ?? 0,
      rostered: mine.counts[pos] ?? 0
    };
  }

  // Tier cliff: the biggest projection drop-off inside the next few players available
  // at each position, which is where "take him now or take the tier below" lives.
  // In PROJECTION order — the market-ordered version compared non-neighbours
  // and once found a kicker "cliff". `above` is who sits on the good side of
  // it, and `survivors_at_horizon` how many of them the survival model
  // expects to still be there at my next turn: 0 means take the last of the
  // tier now or lose the tier.
  for (const pos of Object.keys(positions)) {
    const list = (byPos[pos] ?? []).filter(p => p.projected_points != null)
      .sort((a, b) => b.projected_points - a.projected_points).slice(0, 8);
    let cliff = null;
    for (let i = 0; i < list.length - 1; i++) {
      const drop = list[i].projected_points - list[i + 1].projected_points;
      if (!cliff || drop > cliff.drop) cliff = { after: list[i].name, drop: +drop.toFixed(1), depth: i + 1 };
    }
    if (cliff) {
      const H = horizonFor[pos] ?? pairHorizon;
      const above = list.slice(0, cliff.depth);
      cliff.above = above.map(p => p.player_id);
      cliff.survivors_at_horizon = H ? above.filter(p => goneBy(p.market_rank, H) < 0.5).length : above.length;
    }
    positions[pos].tier_cliff = cliff;
  }

  return {
    draft: {
      id: draft.id, name: draft.name, type: draft.type, team_count: draft.team_count,
      rounds: draft.rounds, my_slot: draft.my_slot, pick_seconds: draft.pick_seconds,
      status: draft.status, last_synced_at: draft.last_synced_at, draft_at: draft.draft_at,
      espn_league_id: draft.espn_league_id, league_row_id: draft.league_row_id,
      roster_slots: slots, pick_order: draft.pick_order ? JSON.parse(draft.pick_order) : null,
      is_best_ball: formatForDraft(draft).isBestBall
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
    // Kickers and defenses live past any sensible cutoff by market rank, but
    // the K/DEF filters and the lookahead's final rounds need them on the board.
    available: [...available.slice(0, poolLimit),
      ...available.slice(poolLimit).filter(p => p.position === 'K' || p.position === 'DEF').slice(0, 40)],
    recent_picks: allPicks.slice(-12).reverse(),
    // Who picks between now and my turn, and the starting slots they still have open.
    picks_before_my_turn: picksBeforeMyTurn,
    // Every team's roster as position counts (the lookahead simulator starts from this).
    team_counts: countsBySlot,
    team_needs: Object.fromEntries(Object.entries(needsBySlot).map(([s, n]) => [s, {
      team: teamName(Number(s)),
      needs: Object.entries(n.starters).filter(([, c]) => c > 0).map(([pos, c]) => c > 1 ? `${pos}×${c}` : pos)
    }]))
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
  const isBestBall = Boolean(state.draft.is_best_ball);

  // Best-ball roster construction: no in-season lineup management means a bad
  // early bet can't be corrected by benching/streaming later, which is exactly
  // why Zero-RB/Anchor-RB (fade RB in the first few rounds) and QB+pass-catcher
  // stacking measurably raise tournament advance rates specifically in this
  // format (4for4 / RotoWire / DraftSharks best-ball strategy research) even
  // though neither is a redraft-optimal pattern. Precomputed once per call,
  // not per player, since it only depends on the roster already drafted.
  const myPassCatcherTeams = isBestBall
    ? new Set(my_team.picks.filter(x => ['WR', 'TE'].includes(x.position)).map(x => x.team_abbr))
    : null;

  const flexOpen = (my_team.needs?.starters?.FLEX ?? 0) > 0;
  const teams = state.draft.team_count ?? 12;
  // Bench value scales with league depth: with 8 teams the waiver wire holds
  // starters, so a bench edge is worth a third of a starter's, not half.
  const depthW = 0.5 * Math.min(1, teams / 12);

  // Candidates: the top of the market, plus the top of each position by
  // projection (ADP-arbitrage names the market slice hides), plus K/DEF in the
  // last two rounds when a slot is open — before this, K/DEF could never be
  // recommended and finished the simulated draft empty.
  const byProj = (a, b) => (b.projected_points ?? -1) - (a.projected_points ?? -1);
  // K/DEF are candidates only when a slot is open and the end is near — a
  // second kicker is never a pick, whatever his ADP says.
  const kdWanted = pos => roundsLeft <= 2 && (my_team.needs?.starters?.[pos] ?? 0) > 0;
  const pool = new Map(state.available.slice(0, 60).filter(p => !['K', 'DEF'].includes(p.position) || kdWanted(p.position)).map(p => [p.player_id, p]));
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    state.available.filter(p => p.position === pos && p.projected_points != null).sort(byProj).slice(0, 12).forEach(p => pool.set(p.player_id, p));
  }
  for (const pos of ['K', 'DEF']) {
    if (kdWanted(pos)) state.available.filter(p => p.position === pos).sort(byProj).slice(0, 3).forEach(p => pool.set(p.player_id, p));
  }

  return [...pool.values()].map(p => {
    const pos = positions[p.position] ?? {};
    const reasons = [];

    // How much this roster can actually use another player at the position.
    // A second QB/TE in a one-QB/one-TE league sits on the bench all year.
    const startsHere = pos.starters_needed > 0 || (flexOpen && FLEX_ELIGIBLE.includes(p.position));
    // A bench player only cashes his edge on bye weeks and injuries; a third
    // RB/WR beyond the bench the league carries, less again; a backup QB/TE in
    // a one-QB/one-TE league, almost nothing. (The lookahead simulator exposed
    // the old weights drafting three QBs in a one-QB league.)
    const needWeight = startsHere ? 1
      : pos.depth_needed > 0 ? (['QB', 'TE'].includes(p.position) ? 0.4 * depthW : p.position === 'RB' ? depthW + 0.05 : depthW)
      : ['QB', 'TE'].includes(p.position) ? 0.03 : 0.2;

    // Points over the replacement-level starter at his position — the unit
    // every other term below is expressed in, so a 40-point RB edge and a
    // 12-point QB edge compare directly instead of through market rank.
    const proj = p.projected_points;
    const vorp = proj != null && pos.replacement_points != null ? proj - pos.replacement_points : null;
    // A player is worth P(the roster uses him) × his edge over the free agent —
    // never less than zero, because the waiver wire is always there. Scaling a
    // NEGATIVE edge by need made a third QB the "least bad" late pick and the
    // simulator drafted five of them; and a starter slot late is measured
    // against what survives to that pick, so its edge is already honest.
    // `usability` is a small tie-break so a usable bench body beats a useless
    // one when both are below the line.
    // Historical realization for this position at this point of the draft
    // (see realizationFor): what slots like his actually paid out, 2021–2025.
    const realized = realizationFor(p.position, p.market_rank);
    let score = vorp != null
      ? Math.max(0, vorp) * needWeight * realized + (startsHere ? 0 : needWeight * 5)
      // No projection (deep sleepers, K/DEF): fall back to the market's opinion on the same scale.
      : Math.max(0, 40 - p.board_rank) * 0.5 * needWeight;
    if (vorp != null && vorp > 0) reasons.push(`+${Math.round(vorp)} pts over a replacement ${p.position}`);
    // Team change is information, not a score term. The offseason model
    // (docs/OFFSEASON_MODEL.md, walk-forward 2023-25) found movers keep ×0.82
    // of prior opportunity — but the "into a crowded room" interaction this
    // block used to price does NOT exist (team change × vacated share 1.059,
    // CI straddling 1, replicated in rookies), and the mover effect is not
    // additive over a projection that already knows the season-T depth chart,
    // which ESPN's does. So: surface it, don't double-count it.
    if (p.moved && vorp != null && vorp > 0) {
      reasons.push(`changed teams this offseason (movers keep ~${Math.round((MOVER_RETENTION[p.position] ?? 0.8) * 100)}% of prior opportunity on average)`);
    }
    if (vorp != null && vorp > 0 && Math.abs(realized - 1) >= 0.12) {
      reasons.push(realized < 1
        ? `history: ${p.position}s drafted here delivered ~${Math.round(realized * 100)}% of their slot (2021-25)`
        : `history: ${p.position}s drafted here over-delivered (2021-25)`);
    }
    // Rookie WRs in the draftable pool beat their slot by +17 pts on average
    // vs −26 for veteran WRs, hit 64% vs 37% (n=28/278, t=3.4, ≥50% in every
    // season). No such edge exists for rookie RBs, so this is WR-only.
    if (p.position === 'WR' && p.draft_year === SEASON && (p.market_rank ?? 999) <= 150 && (startsHere || pos.depth_needed > 0)) {
      score += 8;
      reasons.push('rookie WR — historically under-ranked by the market');
    }

    if (pos.starters_needed > 0) {
      score += 4;
      reasons.push(`fills a starting ${p.position} slot`);
    } else if (startsHere) {
      score += 2;
      reasons.push('fills your FLEX');
    } else if (['QB', 'TE'].includes(p.position) && pos.depth_needed <= 0) {
      reasons.push(`already have your ${p.position}`);
    }

    // Scarcity: what waiting actually costs is the gap to who is expected to
    // survive to the horizon, and it only costs anything if this player is
    // likely gone by then.
    const gap = proj != null && pos.fallback_points != null ? Math.max(0, proj - pos.fallback_points) : 0;
    if (startsHere || pos.depth_needed > 0) {
      const urgency = (p.gone_by_next ?? 0.5) * gap * 0.5;
      if (urgency > 0) score += urgency;
      if (p.gone_by_next > 0.6) reasons.push(`${Math.round(p.gone_by_next * 100)}% gone by your next turn`);
      // Back-to-back picks: of the two players I want, take first the one who
      // will not survive the 2-3 picks between them.
      if (p.gone_by_pair != null && gap > 0) {
        score += 0.3 * gap * p.gone_by_pair;
        if (p.gone_by_pair > 0.5) reasons.push(`take him with the first of your two picks — ${Math.round(p.gone_by_pair * 100)}% gone in between`);
      }
    }
    if (pos.cost_of_waiting != null && pos.cost_of_waiting > 15 && p.board_rank <= 12) {
      reasons.push(`waiting a turn at ${p.position} costs ~${Math.round(pos.cost_of_waiting)} pts`);
    }

    // Last man on the good side of a tier cliff, with none of that tier
    // expected to survive to my next turn: the tier is now or never.
    const cliff = pos.tier_cliff;
    if (cliff?.above?.includes(p.player_id) && cliff.survivors_at_horizon < 1 && cliff.drop >= 10 && (startsHere || pos.depth_needed > 0)) {
      score += Math.min(15, 0.5 * cliff.drop);
      reasons.push(`last of his tier — ${Math.round(cliff.drop)}-pt drop after ${cliff.after}`);
    }

    // The market as a prior: projections are one source, and a player the whole
    // market has 30 spots lower usually has a reason. Mild, capped so a deep
    // ADP-arbitrage name is not buried, and zero for K/DEF whose ranks are noise.
    score -= 0.4 * (['K', 'DEF'].includes(p.position) ? 0 : Math.min(p.board_rank, 60));

    // Handcuff: with seven bench spots and starters on waivers, the backup to
    // my own workhorse is the best expected-value bench RB there is.
    if (p.position === 'RB' && p.slot_code === 'RB2' && round >= 8) {
      const rb1 = my_team.picks.find(x => x.position === 'RB' && x.team_abbr === p.team_abbr && (x.projected_points ?? 0) >= 220);
      if (rb1 && pos.replacement_points != null) {
        score += 0.3 * Math.max(0, rb1.projected_points - pos.replacement_points);
        reasons.push(`handcuff to your ${rb1.name}`);
      }
    }

    // Late bench picks are ceiling bets, not median bets: a day-one/two rookie
    // or a player our model likes more than ESPN does beats a veteran with a
    // +3 median edge and no upside.
    if (!startsHere && round >= 9) {
      if (p.draft_year === SEASON && p.draft_round != null && p.draft_round <= 2) { score += 8; reasons.push('day-1/2 rookie — ceiling bet'); }
      else if (p.draft_year === SEASON && p.draft_round != null && p.draft_round <= 4) { score += 4; reasons.push('rookie with draft capital'); }
      if (p.model_rel != null && p.model_rel >= 0.15) score += 4;
    }

    // Same bye as a starter I already have at the position: mild, 8-team byes are survivable.
    if (startsHere && p.bye_week) {
      const clash = my_team.picks.find(x => x.position === p.position && x.bye_week === p.bye_week);
      if (clash) { score -= 1.5; reasons.push(`same bye (wk ${p.bye_week}) as your ${clash.name}`); }
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

    // ESPN's own injury tag is the real one (Q / D2D / OUT / IR); the Sleeper
    // flag is binary and fires on half the board. Score off ESPN's when present.
    const espnInj = p.espn_injury_status && p.espn_injury_status !== 'ACTIVE' ? p.espn_injury_status : null;
    if (espnInj) {
      const hit = espnInj === 'INJURY_RESERVE' || espnInj === 'OUT' ? 25 : espnInj === 'DAY_TO_DAY' ? 3 : 6;
      score -= hit;
      reasons.push(`ESPN lists him ${espnInj.replace('_', ' ').toLowerCase()}`);
    } else if (p.injury_flag && !p.espn_injury_status) { score -= 4; reasons.push('carrying an injury flag'); }

    // Where our season model and ESPN disagree by a lot, say so — the blend
    // already moved the number; this is the why.
    if (p.model_rel != null && Math.abs(p.model_rel) >= 0.15) {
      reasons.push(p.model_rel > 0
        ? `our model likes him ${Math.round(p.model_rel * 100)}% more than ESPN does`
        : `our model has him ${Math.round(-p.model_rel * 100)}% under ESPN's line (games/role risk)`);
    }

    if (isBestBall) {
      // Zero-RB / Anchor-RB: deprioritize (not exclude) early-round RBs relative
      // to how this same function ranks them for redraft. Tapers to nothing by
      // round 5 — this is about fading the RB2/RB3 "safe" template pick, not
      // punishing a clear first-round workhorse.
      if (p.position === 'RB' && round <= 4) {
        const fade = 5 * (5 - round);
        score -= fade;
        reasons.push(`best-ball: Zero-RB/Anchor-RB fades an early RB (-${fade})`);
      }
      // Stack bonus: a QB scores better when his own pass-catchers are already
      // on the roster, or still sitting on the board to be paired with him —
      // stacking measurably raises tournament advance rates in formats with no
      // in-season lineup management to hedge a bad pairing.
      if (p.position === 'QB') {
        const alreadyStacked = myPassCatcherTeams.has(p.team_abbr);
        const stackAvailable = !alreadyStacked && state.available
          .some(a => a.team_abbr === p.team_abbr && ['WR', 'TE'].includes(a.position));
        if (alreadyStacked || stackAvailable) {
          score += 5;
          reasons.push(alreadyStacked
            ? 'best-ball: stack bonus — his pass-catcher is already on your roster'
            : 'best-ball: stack bonus — his pass-catcher is still on the board');
        }
      }
    }

    return { ...p, score: +score.toFixed(2), vorp: vorp == null ? null : +vorp.toFixed(1), reasons };
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
  // Current season only: a "Questionable, wk 18" line from last year read as a live
  // injury in the prompt and the advisor was flagging healthy players over it.
  const report = row(`SELECT season, week, report_status, practice_status, injury FROM nfl_injuries
                      WHERE full_name = ? AND season = ? ORDER BY week DESC LIMIT 1`, p.name, SEASON);

  // Camp reporting: the freshest items naming this player, on his own team's feed or
  // the league-wide one. Trimmed hard — this goes into a prompt on a 90-second clock.
  const news = rows(`SELECT date, headline, body, fantasy_impact, importance FROM news_items
                     WHERE headline LIKE ? OR body LIKE ?
                     ORDER BY date DESC, importance DESC LIMIT 3`, `%${p.name}%`, `%${p.name}%`);

  // --- enrichments the stats audit (2026-09-06) found already in the DB but unused ---
  const dyn = row(`SELECT age FROM dynasty_values WHERE player_id = ? AND age IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`, playerId);
  const gsis = row(`SELECT gsis_id FROM players WHERE id = ?`, playerId)?.gsis_id;
  // 2025 actual vs expected fantasy points (ffopportunity): TD/efficiency luck that regresses.
  // Guarded by name: the audit found players.gsis_id wrong for some rows
  // (Noah Gray carrying Kelce's id), which would credit one man's luck to another.
  const luckRow = gsis ? row(`SELECT SUM(actual_fantasy_points) AS actual, SUM(expected_fantasy_points) AS expected, COUNT(*) AS games, MIN(player_name) AS nm
                             FROM nfl_ffopportunity_weekly WHERE player_gsis_id = ? AND season = ?`, gsis, SEASON - 1) : null;
  const sameName = (a, b) => { const n = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, ''); const x = n(a), y = n(b); return x && y && (x === y || x.endsWith(y.slice(-6)) || y.endsWith(x.slice(-6))); };
  const luck = luckRow?.games && sameName(luckRow.nm, p.name) ? luckRow : null;
  // Weekly shape of last season: ppg, how often he was a real starter, the floor.
  const weekly = rows(`SELECT fantasy_points FROM player_gamelog WHERE player_id = ? AND season = ? ORDER BY week`, playerId, SEASON - 1)
    .map(r => r.fantasy_points).filter(v => v != null);
  const weeklyLine = weekly.length >= 6 ? {
    games: weekly.length,
    ppg: +(weekly.reduce((s, v) => s + v, 0) / weekly.length).toFixed(1),
    starts_15plus: weekly.filter(v => v >= 15).length,
    floor: +Math.min(...weekly).toFixed(1),
    ceiling: +Math.max(...weekly).toFixed(1)
  } : null;
  // His offense, as the market prices it: season-mean implied team total and its rank.
  const implied = p.team_abbr ? row(`SELECT AVG(implied_points) AS avg FROM game_lines WHERE season = ? AND team = ? AND source = 'espn'`, SEASON, p.team_abbr)?.avg : null;
  const impliedRank = implied != null ? row(`SELECT COUNT(*) + 1 AS r FROM (SELECT team, AVG(implied_points) AS a FROM game_lines WHERE season = ? AND source = 'espn' GROUP BY team) WHERE a > ?`, SEASON, implied)?.r : null;
  // ESPN roster snapshot: status and depth-chart slot as of the latest capture.
  const snap = row(`SELECT status, depth_slot, depth_order, captured_at FROM nfl_roster_snapshots
                    WHERE (espn_id = (SELECT espn_id FROM players WHERE id = ?) OR player_id = ?) AND source = 'espn_roster'
                    ORDER BY captured_at DESC LIMIT 1`, playerId, playerId);

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
    player_id: p.id, name: p.name, position: p.position, team: p.team_abbr,
    bye_week: p.bye_week ?? byeWeeks(SEASON).get(p.team_abbr) ?? null,
    experience_years: experience,
    rookie: experience === 0,
    draft_capital: acc?.draft_year
      ? `${acc.draft_year} round ${acc.draft_round ?? '?'}${acc.draft_pick ? `, pick ${acc.draft_pick}` : ''}`
      : null,
    pro_bowls: acc?.pro_bowls ?? 0,
    all_pro: acc?.first_team_all_pro ?? 0,
    // Additive rookie-evaluation input alongside the combine/draft-capital data
    // above (never a replacement) — his final college season's CFBD usage share
    // and opponent-adjusted PPA (see cfbd.js). Null whenever CFBD_API_KEY was
    // never configured or he simply wasn't in that season's sync, same
    // graceful-no-op convention as every other optional-key feed here.
    college_signal: (experience === 0 && acc?.draft_year)
      ? cfbdSignalFor(p.name, acc.draft_year - 1)
      : null,
    projected_points: projected?.fantasy_points ?? null,
    projected_line: line(projected?.raw),
    // The coordinator's validated week-1 number — additive alongside the
    // season-long ESPN projection above, not a replacement: the coordinator
    // is only proven at weekly grain (see trade-engine.js), not for a
    // season-long total, so board rank/rankTargets stay on projected_points.
    week1_projection: (() => { try { return weeklyProjectionFor(playerId, tradeWeekContext()); } catch { return null; } })(),
    last_season: lastYear ? { points: Math.round(lastYear.fantasy_points), games: lastYear.games, line: line(lastYear.raw) } : null,
    prior_season: priorYear ? { points: Math.round(priorYear.fantasy_points), games: priorYear.games } : null,
    injury_flag: injury?.value ?? null,
    injury_report: report?.injury
      ? `${report.injury}${report.report_status ? ` — ${report.report_status}` : ''}${report.practice_status ? ` (${report.practice_status})` : ''} [${report.season} wk ${report.week}]`
      : null,
    camp_news: news.map(n => ({ date: n.date, headline: n.headline, note: (n.fantasy_impact ?? n.body ?? '').slice(0, 260) })),
    analysts: analystNotes()[p.name] ?? null,
    team_change: (() => { const c = offseasonContext(SEASON).get(playerId); return c?.changed_team ? { from: c.prior_team, to: c.current_team, vacated_target_share: c.new_team_vacated_target_share } : null; })(),
    age: dyn?.age ?? null,
    luck_last_season: luck?.games ? { actual: Math.round(luck.actual), expected: Math.round(luck.expected), diff: Math.round(luck.actual - luck.expected), games: luck.games } : null,
    weekly_last_season: weeklyLine,
    offense: implied != null ? { implied_points: +implied.toFixed(1), rank: impliedRank } : null,
    roster_snapshot: snap ? { status: snap.status, depth: snap.depth_slot ? `${snap.depth_slot}${snap.depth_order ? ` #${snap.depth_order}` : ''}` : null, as_of: snap.captured_at } : null
  };
}

/**
 * What the analysts are saying: dated, attributed takes compiled from the
 * major outlets (FantasyPros, ESPN, Yahoo, CBS, PFF, ETR…) into
 * server/data/analyst-notes-<season>.json, keyed by player name exactly as in
 * `players`. Refreshed by hand before a draft; absent file = no notes, never
 * a fabricated one.
 */
let analystCache = null;
export function analystNotes(season = SEASON) {
  if (analystCache && analystCache.season === season) return analystCache.data;
  let data = {};
  try {
    const p = new URL(`../data/analyst-notes-${season}.json`, import.meta.url);
    data = JSON.parse(readFileSync(p, 'utf8'));
  } catch { data = {}; }
  analystCache = { season, data };
  return data;
}

/**
 * What preseason rank actually delivered, 2021–2025 (docs/DRAFT_AUDIT_2021_2025.md):
 * the fraction of a draft slot's value over replacement that players at each
 * position × overall-rank tier realized, from 2,182 matched player-seasons
 * with actuals validated against ESPN (r=0.9987). Tiers with n<25 are shrunk
 * toward 1, and the result is capped, so a thin cell can lean the board but
 * never own it. The headline: RBs drafted 13–36 overall realized ~1.0 of their
 * slot, WRs there ~0.5–0.75 (t=3.4 over 5 seasons); round 1 is a coin flip.
 */
let auditCache = null;
export function auditSignals(season = SEASON) {
  if (auditCache && auditCache.season === season) return auditCache.data;
  let data = null;
  try { data = JSON.parse(readFileSync(new URL(`../data/draft-audit-signals-${season}.json`, import.meta.url), 'utf8')); }
  catch { data = null; }
  auditCache = { season, data };
  return data;
}
const TIER_OF = rank => rank <= 12 ? '1-12' : rank <= 24 ? '13-24' : rank <= 36 ? '25-36' : rank <= 60 ? '37-60' : rank <= 100 ? '61-100' : '101-150';
export function realizationFor(position, marketRank, season = SEASON) {
  const cell = auditSignals(season)?.realization?.[position]?.[TIER_OF(marketRank ?? 999)];
  const m = cell?.multiplier;
  if (m == null || !Number.isFinite(m)) return 1;
  const shrink = Math.min(1, (cell.n ?? 0) / 30);
  return Math.max(0.6, Math.min(1.3, 1 + (m - 1) * shrink));
}

/**
 * Evidence layers being built alongside this file (2026-09-07): multi-season
 * career lines + streaks, the walk-forward-validated preseason projection
 * with its drivers, and the offseason-changes adjustment. Each is loaded
 * lazily and defensively — a missing or failing module degrades to "no
 * evidence", never to a broken board — so the draft room can ship before
 * every model lands and light up as each one does.
 */
const evidenceModules = {};
async function evidence(name) {
  if (name in evidenceModules) return evidenceModules[name];
  try { evidenceModules[name] = await import(`./${name}.js`); }
  catch { evidenceModules[name] = null; }
  return evidenceModules[name];
}

/** Attach career / preseason / offseason evidence to ranked targets (or any player rows). */
export async function enrichWithEvidence(players, season = SEASON) {
  const [career, preseason, offseason] = await Promise.all([evidence('player-career'), evidence('preseason-model'), evidence('offseason-model')]);
  return players.map(p => {
    const out = { ...p };
    try { if (career?.careerLine) out.career = career.careerLine(p.player_id, { season }); } catch { out.career = null; }
    try { if (preseason?.preseasonProjection) out.preseason = preseason.preseasonProjection(p.player_id, season); } catch { out.preseason = null; }
    try { if (offseason?.offseasonAdjustment) out.offseason = offseason.offseasonAdjustment(p.player_id, season); } catch { out.offseason = null; }
    return out;
  });
}

/**
 * The one-line, number-first case for a player, for the advisor and the UI:
 * "1,000+ rec yds in 3 straight seasons · top-12 WR 3 of 4 years". Built from
 * whichever evidence layers are present.
 */
export function evidenceHeadline(p) {
  const bits = [];
  if (p.career?.headline) bits.push(p.career.headline);
  else if (p.career?.streaks?.length) {
    const s = p.career.streaks[0];
    bits.push(`${s.threshold.toLocaleString()}+ ${s.stat.replace('_', ' ')} × ${s.seasons} straight`);
  }
  if (p.preseason?.drivers?.length) bits.push(p.preseason.drivers[0]);
  if (p.offseason?.drivers?.length && Math.abs((p.offseason.opportunity_multiplier ?? 1) - 1) >= 0.08) bits.push(p.offseason.drivers[0]);
  return bits.join(' · ') || null;
}

/**
 * Prompt lines for one player's evidence layers — the season-by-season
 * record the advisor is required to argue from. Numbers, not adjectives.
 */
export function evidenceLines(p) {
  const out = [];
  const c = p.career;
  if (c?.seasons?.length) {
    const fmt = s => {
      const pos = p.position;
      const core = pos === 'QB'
        ? `${s.pass_yds ?? '-'} pass yds / ${s.pass_td ?? '-'} TD / ${s.int ?? '-'} INT, rush ${s.rush_yds ?? '-'}/${s.rush_td ?? '-'}`
        : pos === 'RB'
          ? `${s.rush_att ?? '-'} car / ${s.rush_yds ?? '-'} yds / ${s.rush_td ?? '-'} TD, ${s.targets ?? '-'} tgt / ${s.rec ?? '-'} rec / ${s.rec_yds ?? '-'} yds`
          : `${s.targets ?? '-'} tgt / ${s.rec ?? '-'} rec / ${s.rec_yds ?? '-'} yds / ${s.rec_td ?? '-'} TD`;
      return `    ${s.season}: ${s.games} g, ${Math.round(s.ppr_points)} pts (${s.ppg} ppg), ${pos}${s.pos_rank ?? '?'} — ${core}`;
    };
    out.push(`  Season-by-season (real, ${c.window?.from ?? ''}-${c.window?.to ?? ''}):\n${c.seasons.slice(0, 5).map(fmt).join('\n')}`);
    if (c.headline) out.push(`  Record: ${c.headline}`);
    const streaks = (c.streaks ?? []).filter(s => s.streak >= 2).slice(0, 4)
      .map(s => `${s.threshold.toLocaleString()}+ ${s.stat.replace('_', ' ')} in ${s.streak} straight`);
    if (streaks.length) out.push(`  Streaks: ${streaks.join('; ')}`);
    if (c.consistency?.seasons_counted >= 2) {
      out.push(`  Consistency: top-12 finish ${c.consistency.seasons_top12}/${c.consistency.seasons_counted} seasons, top-24 ${c.consistency.seasons_top24}/${c.consistency.seasons_counted}, games ${c.consistency.min_games}-${c.consistency.max_games}, year-to-year swing ±${Math.round((c.consistency.cv_points ?? 0) * 100)}%`);
    }
    if (c.trend?.role_yoy) out.push(`  Role trend: ${c.trend.role_yoy}${c.trend.ppg_yoy_pct != null ? `, ppg ${c.trend.ppg_yoy_pct > 0 ? '+' : ''}${c.trend.ppg_yoy_pct}% YoY` : ''}`);
  } else if (c && c.seasons?.length === 0) {
    out.push('  Season-by-season: no NFL seasons on record (rookie or unlinked)');
  }
  const pre = p.preseason;
  if (pre?.points != null) {
    out.push(`  Our preseason model: ${Math.round(pre.points)} pts (range ${Math.round(pre.p20 ?? pre.points)}-${Math.round(pre.p80 ?? pre.points)}, ${pre.expected_games ?? '?'} expected games)${pre.drivers?.length ? ` — drivers: ${pre.drivers.slice(0, 4).join('; ')}` : ''}`);
  }
  const off = p.offseason;
  if (off && (off.drivers?.length || Math.abs((off.opportunity_multiplier ?? 1) - 1) >= 0.05)) {
    out.push(`  Offseason changes: opportunity ×${(off.opportunity_multiplier ?? 1).toFixed(2)} (${off.confidence ?? 'n/a'} confidence)${off.drivers?.length ? ` — ${off.drivers.slice(0, 4).join('; ')}` : ''}`);
  }
  return out;
}

export const STAT_ROOTED_INSTRUCTIONS = `HOW TO ARGUE
Every recommendation must be rooted in the season-by-season record above, in this order of evidence: (1) multi-season production streaks and positional finishes, (2) role and opportunity (targets/carries, and any offseason change to them), (3) this year's projection and its drivers, (4) health and camp reporting, (5) analyst opinion last. Lead the "why" with a concrete number — "1,000+ receiving yards in 5 straight seasons and a top-12 finish every year", "185 targets last year, up 6%", "missed 13 games in 2024 then played 17 in 2025" — never with an adjective. If a player has no NFL record (rookie), say so and argue only from draft capital, the room he lands in, and camp. If two players are close, say which number decides it. Do not cite a stat that is not in the dossier.`;

/** Dossiers for a shortlist, in board order. */
export const dossiersFor = (playerIds) => playerIds.map(playerDossier).filter(Boolean);
