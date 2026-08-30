/**
 * Trade engine API.
 *
 * Every route here answers without an API key — the analysis is deterministic. The
 * one exception is /explain, which hands a fully-scored deal to Claude purely to
 * write the negotiation copy; the numbers are already decided before it is called.
 */
import { Router } from 'express';
import { row, rows } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import {
  findTrades, offerFor, offerForMany, selfScout, playerOutlook, evaluate,
  assetUniverse, loadRosters, lineupSlots, bestLineup, resolvePlayer, lineupDiff
} from '../services/trade-engine.js';
import { dvpTable, relevantSplits, matchupModel } from '../services/matchups.js';
import { deriveFormat } from '../services/format.js';
import { newsOpportunities } from '../services/news-lag-trader.js';
import { brainState, brainPlan, managerProfiles, setManagerProfile } from '../services/league-brain.js';
import { waiverUpgrades, sellHigh, freeAgents } from '../services/waiver-brain.js';
import { byeOutlook, byePatches, fragility } from '../services/roster-risk.js';
import { positionLiquidity } from '../services/position-liquidity.js';
import { trendExploits } from '../services/trend-exploits.js';
import { teamTrends, playerTrends } from '../services/weekly-trends.js';
import { scanTrends, conflicts, trendHistory } from '../services/trend-watch.js';
import { regressionCandidates, regressionForLeague, touchdownRates } from '../services/td-regression.js';
import { ceilingLineup } from '../services/ceiling-lineup.js';
import { titleOddsTrades } from '../services/title-odds-trades.js';
import { weekPostmortem } from '../services/week-postmortem.js';

const r = Router();

/**
 * `?ids=1,2,3` -> a numeric array, empty when the param is absent.
 *
 * The obvious version — `String(x ?? '').split(',').map(Number).filter(Number.isFinite)`
 * — is wrong, because ''.split(',') is [''] and Number('') is 0, not NaN. An
 * absent parameter therefore parsed as the id list [0], which silently became
 * "player 0 was started" in the post-mortem (attributing a 0-point lineup) and
 * "one pick has been made" in the draft simulator (shifting every pick by one).
 */
const idList = raw => String(raw ?? '').split(',')
  .map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);

/** `?exclude=id1,id2` -> a Set of numeric player ids, or null when empty. */
function excludeSet(req) {
  const raw = String(req.query.exclude ?? '').trim();
  if (!raw) return null;
  const ids = idList(raw);
  return ids.length ? new Set(ids) : null;
}

/** Shared preamble: every route needs a synced league. */
function league(req, res) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
  if (!lg) { res.status(404).json({ error: 'league not found' }); return null; }
  if (!lg.payload) { res.status(400).json({ error: 'league not synced yet — sync it on the My Leagues page' }); return null; }
  return lg;
}

/* ------------------------------------------------------------ self scouting */
r.get('/:leagueId/scout', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(selfScout(lg, req.query.team_id));
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- the brain */

/** Where you stand: rank, holes, and which hole is worth paying to fix. */
r.get('/:leagueId/brain/state', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(brainState(lg.id, req.query.team_id ?? null));
  } catch (e) { next(e); }
});

/**
 * The plan: ranked by acceptance probability times gain, not by gain.
 *
 * See league-brain.js — a deal nobody signs is worth nothing, and sorting by
 * how much a trade helps you is sorting by how unacceptable it is.
 */
r.get('/:leagueId/brain/plan', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(brainPlan(lg.id, {
      myTeamId: req.query.team_id ?? null,
      limit: Math.min(20, Number(req.query.limit) || 8)
    }));
  } catch (e) { next(e); }
});

/**
 * Free agents who would crack your lineup.
 *
 * Separate from the plan because it answers on its own: a waiver claim needs no
 * counterparty, so it is the one move available every week regardless of who is
 * talking to you.
 */
r.get('/:leagueId/brain/waivers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(waiverUpgrades(lg.id, {
      myTeamId: req.query.team_id ?? null,
      limit: Math.min(25, Number(req.query.limit) || 10)
    }));
  } catch (e) { next(e); }
});

/** Players priced above their own position's production curve. */
r.get('/:leagueId/brain/sell-high', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(sellHigh(lg.id, {
      myTeamId: req.query.team_id ?? null,
      limit: Math.min(15, Number(req.query.limit) || 5)
    }));
  } catch (e) { next(e); }
});

/** The unrostered pool, ranked on the horizon that matters this week. */
r.get('/:leagueId/brain/free-agents', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const list = freeAgents(lg, { limit: Math.min(200, Number(req.query.limit) || 60) });
    res.json({ count: list.length, players: list });
  } catch (e) { next(e); }
});

/** Which future weeks already cost you points, and who on the wire fixes them. */
r.get('/:leagueId/brain/bye-risk', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(byePatches(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/** Where one injury ends the season, weighted by how often each player misses time. */
r.get('/:leagueId/brain/fragility', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(fragility(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/** What the other rosters can actually spare, position by position. */
r.get('/:leagueId/brain/liquidity', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(positionLiquidity(lg.id, { myTeamId: req.query.team_id ?? null }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ weekly trends */

/**
 * What has changed lately, crossed against what you can do about it.
 *
 * The statistics live in weekly-trends.js and refuse to say anything that does
 * not clear a corrected significance bar; this is the join onto your roster,
 * the wire, and the schedule.
 */
r.get('/:leagueId/trends', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(trendExploits(lg.id, {
      myTeamId: req.query.team_id ?? null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** One team's trajectory across its recent games. */
r.get('/trends/team/:team', (req, res, next) => {
  try {
    const season = Number(req.query.season) || null;
    const latest = season ?? row('SELECT MAX(season) AS s FROM nfl_team_week_features')?.s;
    res.json(teamTrends(String(req.params.team).toUpperCase(), latest, {
      throughWeek: Number(req.query.week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** One player's usage trajectory — share rather than points, on purpose. */
r.get('/trends/player/:playerId', (req, res, next) => {
  try {
    const latest = Number(req.query.season) || row('SELECT MAX(season) AS s FROM player_week_usage')?.s;
    res.json(playerTrends(Number(req.params.playerId), latest, {
      throughWeek: Number(req.query.week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.query.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/**
 * Sweep every offence and report the DIFFERENCE against the last sweep.
 *
 * The diff is the product: a trend reported every week forever is wallpaper.
 * New ones are the alert, faded ones are the signal to stop acting on an old
 * read, and ongoing ones are context the league has already priced.
 */
r.post('/trends/scan', (req, res, next) => {
  try {
    res.json(scanTrends({
      season: Number(req.body?.season) || null,
      throughWeek: Number(req.body?.through_week) || null,
      lookback: Math.max(2, Math.min(6, Number(req.body?.lookback) || 3))
    }));
  } catch (e) { next(e); }
});

/** The stored picture, without running a sweep. */
r.get('/trends/watch', (req, res, next) => {
  try {
    const lookback = Math.max(2, Math.min(6, Number(req.query.lookback) || 3));
    const history = trendHistory({ season: Number(req.query.season) || null, lookback });
    res.json({
      ...history,
      conflicts: history.season ? conflicts(history.season, null, lookback).conflicts : []
    });
  } catch (e) { next(e); }
});

/**
 * Touchdown luck, and who it is about to stop favouring.
 *
 * Touchdown rate is the least stable number in football while target share is
 * among the most stable, so the gap between a player's touchdowns and his
 * opportunities is the most reliable inefficiency in the sport.
 */
r.get('/:leagueId/regression', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(regressionForLeague(lg.id, {
      myTeamId: req.query.team_id ?? null,
      season: Number(req.query.season) || null,
      throughWeek: Number(req.query.week) || null
    }));
  } catch (e) { next(e); }
});

/** The league-wide board, without a roster join. */
r.get('/regression/board', (req, res, next) => {
  try {
    res.json(regressionCandidates({
      season: Number(req.query.season) || null,
      throughWeek: Number(req.query.week) || null,
      minOpportunities: Math.max(5, Math.min(200, Number(req.query.min_opportunities) || 20))
    }));
  } catch (e) { next(e); }
});

/** The fitted conversion rates themselves, per position group. */
r.get('/regression/rates', (_req, res, next) => {
  try { res.json(touchdownRates()); } catch (e) { next(e); }
});

/** Who will actually trade with you. Read, and write. */
r.get('/:leagueId/brain/managers', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(managerProfiles(lg.id));
  } catch (e) { next(e); }
});

r.post('/:leagueId/brain/managers/:rosterId', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const out = setManagerProfile(lg.id, req.params.rosterId, {
      tradeability: req.body?.tradeability,
      notes: req.body?.notes ?? null,
      owner: req.body?.owner ?? null
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * News the league has not reacted to yet, turned into actions.
 *
 * The only surface in this app where we hold a structural advantage over our
 * opponents rather than a hoped-for one — this pipeline runs on a timer and
 * your leaguemates do not.
 */
r.get('/:leagueId/news-edge', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(newsOpportunities(lg.id, {
      myTeamId: req.query.team_id,
      hours: Math.min(24 * 21, Number(req.query.hours) || 72)
    }));
  } catch (e) { next(e); }
});

/**
 * The lineup built for the outcome you need rather than the highest average.
 *
 * `objective=mean` reproduces the classic optimiser so the two can be compared
 * on identical draws — which is the entire point of the feature.
 */
r.get('/:leagueId/ceiling-lineup', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(ceilingLineup(lg.id, {
      teamId: req.query.team_id,
      week: Math.min(18, Math.max(1, Number(req.query.week) || 1)),
      objective: req.query.objective === 'mean' ? 'mean' : 'ceiling',
      target: req.query.target ? Number(req.query.target) : null,
      trials: Math.min(8000, Number(req.query.trials) || 3000)
    }));
  } catch (e) { next(e); }
});

/**
 * Trades ranked by championship odds instead of points. Cached and slow on a
 * cold call — each shortlisted deal is a paired season simulation.
 */
r.get('/:leagueId/title-trades', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(titleOddsTrades(lg.id, {
      teamId: req.query.team_id,
      shortlist: Math.min(12, Math.max(3, Number(req.query.shortlist) || 6)),
      runs: Math.min(2000, Number(req.query.runs) || 800)
    }));
  } catch (e) { next(e); }
});

/**
 * Was I wrong, or unlucky? Separates decision cost from projection error from
 * variance for a completed week.
 */
r.get('/:leagueId/postmortem', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const lineup = idList(req.query.lineup);
    res.json(weekPostmortem(lg.id, {
      teamId: req.query.team_id,
      season: Number(req.query.season) || undefined,
      week: Math.min(18, Math.max(1, Number(req.query.week) || 1)),
      lineup: lineup.length ? lineup : null
    }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ decision inbox */
/**
 * "What should I actually do today" — the Dashboard's Phase 1 flagship item
 * from the platform audit. Deliberately not a new analysis engine: every
 * signal here is something the app already computes (selfScout's prioritized
 * fixes, findTrades' real mutual-win deals, news_items' importance flag) —
 * this just merges them into one ranked queue instead of leaving them
 * scattered across three separate pages the user has to remember to check.
 */
r.get('/:leagueId/inbox', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const teamId = req.query.team_id;
    const items = [];

    const scout = selfScout(lg, teamId);
    if (!scout.error) {
      for (const f of scout.fixes.slice(0, 3)) {
        items.push({
          type: 'roster', priority: f.priority, title: f.issue, action: f.action,
          link: '/my-team'
        });
      }

      // MAJOR news about a team any of my rostered players actually plays for —
      // not a global news skim, scoped to what could move my own lineup.
      const myTeamAbbrs = [...new Set(scout.lineup.slots.map(s => s.player?.team_abbr).filter(Boolean)
        .concat(scout.lineup.bench.map(p => p.team_abbr).filter(Boolean)))];
      if (myTeamAbbrs.length) {
        const placeholders = myTeamAbbrs.map(() => '?').join(',');
        const news = rows(`SELECT n.headline, n.fantasy_impact, n.date, t.abbr AS team_abbr
                           FROM news_items n JOIN nfl_teams t ON t.id = n.team_id
                           WHERE n.importance = 3 AND t.abbr IN (${placeholders})
                             AND n.date >= date('now', '-7 days')
                           ORDER BY n.date DESC LIMIT 3`, ...myTeamAbbrs);
        for (const n of news) {
          items.push({
            type: 'news', priority: 'high',
            title: n.headline, action: n.fantasy_impact || `Major ${n.team_abbr} news this week — check the impact.`,
            link: `/teams/${n.team_abbr}`
          });
        }
      }
    }

    // One real, mutual-win trade if one exists — not the whole board, just
    // "here's a deal actually worth looking at today."
    if (teamId) {
      const trades = findTrades(lg, { myTeamId: teamId, requireMutual: true, limit: 5 });
      const best = (trades.deals ?? []).find(d => d.mutual);
      if (best) {
        items.push({
          type: 'trade', priority: 'medium',
          title: `${best.partner} would plausibly take a deal that helps both lineups`,
          action: `${best.i_give.map(p => p.name).join(' + ')} for ${best.i_get.map(p => p.name).join(' + ')}`,
          link: '/trade-lab'
        });
      }
    }

    const rank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2));
    res.json({ items: items.slice(0, 6) });
  } catch (e) { next(e); }
});

/* --------------------------------------------------- submitted vs. recommended */
r.get('/:leagueId/lineup-diff', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(lineupDiff(lg, req.query.team_id));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ trade finder */
r.get('/:leagueId/find', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(findTrades(lg, {
      myTeamId: req.query.team_id,
      maxPerSide: Math.min(3, Number(req.query.max_per_side) || 2),
      // Off by default in the UI's "aggressive" mode: deals that only help me are
      // still worth seeing, they just need a better sales pitch.
      requireMutual: req.query.mutual !== '0',
      limit: Math.min(50, Number(req.query.limit) || 20),
      targetId: req.query.target_id || null,
      excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------------- "what do I offer for X" */
r.get('/:leagueId/offer', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!req.query.player_id) return res.status(400).json({ error: 'player_id required' });
    res.json(offerFor(lg, {
      myTeamId: req.query.team_id, targetId: req.query.player_id, excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------- "what do I offer for THEM" */
r.get('/:leagueId/offer-many', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const raw = String(req.query.player_ids ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'player_ids required (comma-separated)' });
    res.json(offerForMany(lg, {
      myTeamId: req.query.team_id, targetIds: raw.split(',').map(Number).filter(Number.isFinite),
      excludeIds: excludeSet(req)
    }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- manual mock trade builder */
/**
 * Score an arbitrary two-sided package. This is the "build your own trade and see
 * who wins" path — the same evaluator the finder uses, driven by hand.
 */
r.post('/:leagueId/evaluate', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const { formatKey } = deriveFormat(lg);
    const assets = assetUniverse(lg, formatKey);
    const teams = loadRosters(lg, assets);
    const slots = lineupSlots(lg);

    const meId = String(req.body?.my_team_id ?? lg.my_team_id ?? teams[0]?.roster_id);
    const me = teams.find(t => t.roster_id === meId);
    const pick = ids => (ids ?? []).map(id => resolvePlayer(id, assets, teams)).filter(Boolean);
    const gives = pick(req.body?.give);
    const gets = pick(req.body?.get);
    if (!me) return res.status(400).json({ error: 'your team not found' });
    if (!gives.length && !gets.length) return res.status(400).json({ error: 'pick at least one player on each side' });

    // Infer the counterparty from whoever owns the incoming players, unless told.
    const them = req.body?.their_team_id
      ? teams.find(t => t.roster_id === String(req.body.their_team_id))
      : teams.find(t => t.roster_id !== meId && gets.some(g => t.players.some(p => p.id === g.id)));
    if (!them) return res.status(400).json({ error: 'could not work out who you are trading with — pass their_team_id' });

    res.json({ ...evaluate({ team: me, gives }, { team: them, gives: gets }, slots), slots });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------- rosters for the UI */
r.get('/:leagueId/rosters', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    const { formatKey } = deriveFormat(lg);
    const assets = assetUniverse(lg, formatKey);
    const teams = loadRosters(lg, assets);
    const slots = lineupSlots(lg);
    res.json({
      my_team_id: lg.my_team_id,
      model_context: assets.context,
      slots,
      teams: teams.map(t => {
        const line = bestLineup(t.players, slots);
        const starters = new Set(line.slots.map(s => s.player?.id).filter(Boolean));
        return {
          roster_id: t.roster_id, owner: t.owner, lineup_ppg: line.points,
          players: t.players
            .map(p => ({
              id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
              espn_id: p.espn_id, sleeper_id: p.sleeper_id,
              value: p.value, proj: p.proj, ppg: p.ppg, adj_ppg: p.adj_ppg,
              age: p.age, bye: p.bye, injury: p.injury, sos: p.sos, playoff_sos: p.playoff_sos,
              starter: starters.has(p.id)
            }))
            .sort((a, b) => Number(b.starter) - Number(a.starter) || b.adj_ppg - a.adj_ppg)
        };
      })
    });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- player deep dive */
r.get('/:leagueId/player/:id', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    res.json(playerOutlook(lg, req.params.id));
  } catch (e) { next(e); }
});

/* -------------------------------------------------- defense-vs-position table */
r.get('/dvp', (req, res, next) => {
  try {
    const pos = String(req.query.position ?? 'WR').toUpperCase();
    if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) return res.status(400).json({ error: 'position must be QB/RB/WR/TE' });
    res.json({ position: pos, seasons: matchupModel().seasons, table: dvpTable(pos) });
  } catch (e) { next(e); }
});

/** Opponent-history splits for one player: "when he plays X he usually does Y". */
r.get('/splits/:playerId', (req, res, next) => {
  try {
    const p = row(`SELECT p.id, p.name, p.position, t.abbr FROM players p
                   LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, req.params.playerId);
    if (!p) return res.status(404).json({ error: 'player not found' });
    res.json({ ...p, ...relevantSplits(p.id, p.abbr, 5) });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- AI sense check */
/**
 * An independent read on a deal the deterministic engine already scored — not a
 * pitch, a second opinion. The lineup/value math is real, but it can't see things
 * like "three of these five guys are all hurt" or "the reason their VOR is thin at
 * this spot is he's on a bye the same week two of my other guys are" — the kind of
 * thing a person actually trading would notice on sight. Claude is told the full
 * deal (every field the engine computed, not just a summary) and instructed to
 * work only from that data, so this can disagree with the engine's own verdict
 * when the numbers miss something real, but can't invent a fact that isn't there.
 */
r.post('/:leagueId/sense-check', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const lg = league(req, res); if (!lg) return;
    const d = req.body?.deal;
    if (!d?.me || !d?.them) return res.status(400).json({ error: 'deal required' });

    const fmtPlayer = p => `${p.name} (${p.position}${p.team_abbr ? ` ${p.team_abbr}` : ''}) — ` +
      `proj ${p.proj ?? '?'} pts, ${p.adj_ppg ?? '?'} adj ppg, market value ${p.value ?? '?'}` +
      `${p.age != null ? `, age ${p.age}` : ''}${p.bye ? `, bye week ${p.bye}` : ''}` +
      `${p.injury ? ', INJURY FLAG' : ''}${p.floor != null ? `, floor/ceiling ${p.floor}/${p.ceiling}` : ''}` +
      `${p.consistency != null ? `, consistency ${p.consistency}` : ''}` +
      `${p.playoff_sos != null ? `, weeks 15-17 matchup mult ${p.playoff_sos}` : ''}`;

    const fmtSide = (label, s) => `${label} (${s.owner}):
  Sends: ${s.gives.length ? s.gives.map(fmtPlayer).join('\n    ') : 'nothing'}
  Receives: ${s.gets.length ? s.gets.map(fmtPlayer).join('\n    ') : 'nothing'}
  Starting lineup: ${s.lineup_before} -> ${s.lineup_after} ppg (${s.ppg_delta > 0 ? '+' : ''}${s.ppg_delta}/wk, ${s.season_delta > 0 ? '+' : ''}${s.season_delta} over the season)
  Weeks 15-17 lineup: ${s.playoff_ppg_delta > 0 ? '+' : ''}${s.playoff_ppg_delta ?? '?'} ppg
  Market value: ${s.value_delta > 0 ? '+' : ''}${s.value_delta}
  Weekly floor/ceiling shift: ${s.floor_delta ?? '?'}/${s.ceiling_delta ?? '?'}
  ${s.new_holes?.length ? `Leaves an unfilled starting slot at: ${s.new_holes.join(', ')}` : 'Fills every starting slot'}`;

    const msg = await callClaude({
      feature: 'trade-sense-check',
      maxTokens: 1100,
      prompt: `You are an experienced fantasy football manager giving a second opinion on a trade someone is
considering. A deterministic engine already scored it on lineup points and market value — your job is
to sanity-check that math against things a person would actually notice, not to re-derive the numbers.

THE DEAL

${fmtSide('MY SIDE', d.me)}

${fmtSide('THEIR SIDE', d.them)}

Engine's read: fairness "${d.fairness}", both lineups improve: ${d.mutual ? 'yes' : 'no'}, deal considered plausible: ${d.plausible ? 'yes' : 'no'}.
${d.red_flags?.length ? `Engine already flagged: ${d.red_flags.join('; ')}.` : 'Engine raised no roster-fit flags.'}
${d.their_window ? `Their team's situation: ${d.their_window.label} — ${d.their_window.stance}` : ''}

Look specifically for things the lineup/value math cannot see on its own:
- Bye-week collisions between the players changing hands and each other (not the rest of either
  roster — you don't have that).
- Injury-flagged players stacked on one side, or an injury flag on the single biggest piece of a deal.
- Age or workload concerns severe enough to matter beyond what "market value" already prices in.
- Whether this trade actually matches the "their team's situation" framing above, or contradicts it
  (e.g. a supposed rebuilder taking on an older proven vet instead of youth).
- Anything about the engine's own verdict that doesn't hold up once you look at who's actually moving.

Work ONLY from the data given above — never invent a stat, injury, or fact not listed. If you have
nothing real to flag in a category, say so plainly rather than manufacturing a concern.

Respond with ONLY JSON:
{"verdict":"one of: sound / worth a second look / risky / lopsided",
 "headline":"one sentence — your overall take, independent of the engine's verdict",
 "concerns":["0-4 short, specific, concrete concerns grounded in the data above — omit entirely if none"],
 "agrees_with_engine": true or false,
 "why": "2-3 sentences on why you agree or disagree with the engine's plausibility call"}`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- AI negotiation copy */
/**
 * Turn a scored deal into something you can actually send. The maths is done and
 * passed in — Claude only writes the pitch, the counter-read, and the walk-away line.
 */
r.post('/:leagueId/explain', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const lg = league(req, res); if (!lg) return;
    const d = req.body?.deal;
    if (!d?.me || !d?.them) return res.status(400).json({ error: 'deal required' });

    const fmtSide = s => `${s.owner}: sends ${s.gives.map(p => p.name).join(' + ') || 'nothing'}; ` +
      `lineup ${s.lineup_before} -> ${s.lineup_after} ppg (${s.ppg_delta > 0 ? '+' : ''}${s.ppg_delta}), ` +
      `market value ${s.value_delta > 0 ? '+' : ''}${s.value_delta}`;

    // Untouchables never enter the search that produced this deal, but the pitch is
    // free-text — without telling the model who is off-limits, a "sweeten it with one
    // more piece" suggestion in the counter-read could name exactly the player you
    // marked protected.
    const untouchables = Array.isArray(req.body?.untouchables) ? req.body.untouchables.filter(Boolean) : [];

    const msg = await callClaude({
      feature: 'trade-explain',
      maxTokens: 900,
      prompt: `You are helping a manager send a fantasy football trade in a ${lg.team_count ?? 12}-team league.

The analysis is already done — do not re-argue the numbers, just use them.
${fmtSide(d.me)}
${fmtSide(d.them)}
Fairness on market price: ${d.fairness}. Both sides improve: ${d.mutual ? 'yes' : 'no'}.
${d.me.playoff_ppg_delta != null ? `My weeks 15-17 lineup changes by ${d.me.playoff_ppg_delta} ppg.` : ''}
${untouchables.length ? `Untouchable — never suggest offering these, not even as a sweetener: ${untouchables.join(', ')}.` : ''}

Write the negotiation. Frame it around what THEY get, never mention that you ran an analysis, no fake urgency, no flattery. If the deal is lopsided in my favour, the pitch still has to sound reasonable to them.

Respond with ONLY JSON:
{"pitch":"3-4 sentence message I can paste to them",
 "their_counter":"the counter they are most likely to send, and how I should respond, 2 sentences",
 "walk_away":"one sentence — the point at which I decline",
 "risk":"one sentence — the single way this deal goes badly for me"}`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

export default r;
