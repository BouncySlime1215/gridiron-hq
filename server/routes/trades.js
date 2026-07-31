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
  findTrades, offerFor, selfScout, playerOutlook, evaluate,
  assetUniverse, loadRosters, lineupSlots, bestLineup, resolvePlayer
} from '../services/trade-engine.js';
import { dvpTable, relevantSplits, matchupModel } from '../services/matchups.js';
import { deriveFormat } from '../services/format.js';

const r = Router();

/** `?exclude=id1,id2` -> a Set of numeric player ids, or null when empty. */
function excludeSet(req) {
  const raw = String(req.query.exclude ?? '').trim();
  if (!raw) return null;
  const ids = raw.split(',').map(Number).filter(Number.isFinite);
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

    const msg = await callClaude({
      feature: 'trade-explain',
      maxTokens: 900,
      prompt: `You are helping a manager send a fantasy football trade in a ${lg.team_count ?? 12}-team league.

The analysis is already done — do not re-argue the numbers, just use them.
${fmtSide(d.me)}
${fmtSide(d.them)}
Fairness on market price: ${d.fairness}. Both sides improve: ${d.mutual ? 'yes' : 'no'}.
${d.me.playoff_ppg_delta != null ? `My weeks 15-17 lineup changes by ${d.me.playoff_ppg_delta} ppg.` : ''}

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
