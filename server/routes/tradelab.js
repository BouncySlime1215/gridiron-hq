import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import { vorBoard, volatility } from './edge.js';
import { deriveFormat } from '../services/format.js';
import { pickInventory } from '../services/picks.js';
import { dynastyAgeAdjustment } from '../services/dynasty-age-curve.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

const SKILL = ['QB', 'RB', 'WR', 'TE'];
const WEAK = 0.80, STRONG = 1.15;
// How a flex slot actually splits across positions in practice.
const FLEX_SPLIT = { RB: 0.4, WR: 0.5, TE: 0.1 };

/* ------------------------------------------------------------------ rosters */
function leagueRosters(lg, formatKey, { isDynasty = formatKey.startsWith('dyn_') } = {}) {
  const payload = JSON.parse(lg.payload);
  const norm = s => (s ?? '').toLowerCase().replace(/[.'’-]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();

  const board = new Map(vorBoard(lg.team_count || 12).map(p => [p.id, p]));
  const vol = volatility();
  // Format-matched market prices, so a superflex QB is valued as a superflex QB.
  const market = new Map(rows('SELECT player_id, value, age, trend30, pos_rank FROM dynasty_values WHERE format_key = ?', formatKey)
    .map(d => [d.player_id, d]));
  // One query instead of per-player lookups inside enrich().
  const ageByPlayer = new Map(rows(`SELECT p.id, rp.age FROM players p
                                    JOIN roster_players rp ON rp.espn_id = p.espn_id
                                    WHERE rp.age IS NOT NULL`).map(x => [x.id, x.age]));
  const byKey = new Map(), bySleeper = new Map(), byEspn = new Map();
  for (const p of rows('SELECT id, name, position, sleeper_id, espn_id, gsis_id FROM players')) {
    byKey.set(`${norm(p.name)}|${p.position}`, p);
    if (p.sleeper_id) bySleeper.set(String(p.sleeper_id), p);
    if (p.espn_id) byEspn.set(String(p.espn_id), p);
  }
  const enrich = p => {
    const v = board.get(p.id);
    const w = vol.get(p.id);
    const m = market.get(p.id);
    // Additive, inspectable age-curve decay (4for4 2025 "Production Curves")
    // layered on top of the raw FantasyCalc dynasty price — see
    // dynasty-age-curve.js. `value` below is untouched market pass-through.
    const dynastyAge = isDynasty && m?.value != null
      ? dynastyAgeAdjustment({
          position: p.position, rawValue: m.value, gsisId: p.gsis_id,
          rosterSnapshotAge: ageByPlayer.get(p.id) ?? m.age ?? null
        })
      : null;
    return {
      id: p.id, name: p.name, position: p.position,
      vor: v?.vor ?? 0, proj: v?.proj ?? 0, adp: v?.adp ?? null,
      value: m?.value ?? 0, trend30: m?.trend30 ?? null, pos_rank: m?.pos_rank ?? null,
      // FantasyCalc carries age for nearly every player; the ESPN roster table is a fallback.
      age: m?.age ?? ageByPlayer.get(p.id) ?? null,
      dynasty_value_raw: dynastyAge?.raw_value ?? null,
      dynasty_value_age_adjusted: dynastyAge?.adjusted_value ?? null,
      dynasty_age_decay: dynastyAge ? {
        multiplier: dynastyAge.multiplier, age: dynastyAge.age, age_source: dynastyAge.age_source,
        source: dynastyAge.source ?? null
      } : null,
      boom: w?.boom_rate ?? null, consistency: w?.consistency ?? null
    };
  };

  const out = [];
  if (lg.platform === 'sleeper') {
    const users = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
    for (const ro of payload.rosters ?? []) {
      const players = (ro.players ?? []).map(sid => bySleeper.get(String(sid))).filter(Boolean).map(enrich);
      const u = users[ro.owner_id];
      // Prefer the team name managers actually set; fall back to their username.
      const owner = u?.metadata?.team_name || u?.display_name || `Team ${ro.roster_id}`;
      out.push({ roster_id: ro.roster_id, owner, players });
    }
  } else {
    for (const t of payload.teams ?? []) {
      const players = (t.roster?.entries ?? []).map(e => {
        const pl = e.playerPoolEntry?.player;
        if (!pl) return null;
        const pos = ({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' })[pl.defaultPositionId] ?? '';
        return byEspn.get(String(pl.id)) ?? byKey.get(`${norm(pl.fullName)}|${pos}`);
      }).filter(Boolean).map(enrich);
      const label = t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`;
      out.push({ roster_id: t.id, owner: label, players });
    }
  }
  return out;
}

/* ------------------------------------- needs / surplus / contention window */
/**
 * Andrew's model, ported: needs and surplus are value-based (starter value vs
 * the league average at that position), not body-count based. Contention window
 * then classifies each team on a capital x core-age grid.
 */
export function analyzeLeague(lg) {
  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions) : ['QB','RB','RB','WR','WR','TE','FLEX'];
  const perTeam = Object.fromEntries(SKILL.map(p => [p, rp.filter(x => x === p).length]));
  const flex = rp.filter(x => ['FLEX', 'REC_FLEX', 'WRRB_FLEX'].includes(x)).length;
  perTeam.QB += rp.filter(x => x === 'SUPER_FLEX').length;
  for (const [pos, share] of Object.entries(FLEX_SPLIT)) perTeam[pos] += flex * share;

  const { formatKey, isDynasty } = deriveFormat(lg);
  const teams = leagueRosters(lg, formatKey, { isDynasty });
  const inventory = pickInventory(lg, formatKey);

  // Leaguewide startable cutoff per position, e.g. 12 teams x 2.8 RB starters -> RB34.
  const teamCount = lg.team_count || 12;
  const replRank = Object.fromEntries(SKILL.map(p => [p, Math.max(1, Math.round(perTeam[p] * teamCount))]));

  for (const t of teams) {
    const inv = inventory.get(String(t.roster_id));
    t.picks = inv?.picks ?? [];
    t.picks_value = inv?.picks_value ?? 0;
    t.positions = {};
    for (const pos of SKILL) {
      const list = t.players.filter(p => p.position === pos).sort((a, b) => b.vor - a.vor);
      const slots = Math.max(1, Math.ceil(perTeam[pos] - 0.001));
      const starters = list.slice(0, slots);
      const depth = list.slice(slots);
      t.positions[pos] = {
        starters, depth,
        starter_value: starters.reduce((s, p) => s + Math.max(0, p.vor), 0),
        // Bench players who are still real assets. Tested on positional market rank
        // (within ~2x the startable cutoff) rather than VOR > 0: a bench player sits
        // behind better players by definition, so his VOR is almost always <= 0, and
        // filtering on that made surplus — and therefore trade partners — never appear.
        tradeable: depth.filter(p => p.pos_rank != null && p.pos_rank <= replRank[pos] * 2)
      };
    }
    // Two currencies, deliberately kept separate because they answer different questions
    // and are on different scales:
    //   capital        = VOR (projected points over replacement) — "will this help me win"
    //   market_capital = FantasyCalc price + draft picks          — "what is this worth in trade"
    // Only market units can express a draft pick, so the contention window below is
    // computed on market_capital; needs/surplus stay on VOR.
    t.capital = t.players.reduce((s, p) => s + Math.max(0, p.vor), 0);
    t.players_value = t.players.reduce((s, p) => s + Math.max(0, p.value), 0);
    t.market_capital = t.players_value + t.picks_value;
    const aged = t.players.filter(p => p.age && p.value > 0);
    const w = aged.reduce((s, p) => s + p.value, 0);
    t.core_age = w ? +(aged.reduce((s, p) => s + p.age * p.value, 0) / w).toFixed(1) : null;
  }

  const avg = {};
  for (const pos of SKILL) avg[pos] = teams.reduce((s, t) => s + t.positions[pos].starter_value, 0) / (teams.length || 1);

  for (const t of teams) {
    t.needs = []; t.surplus = [];
    for (const pos of SKILL) {
      const p = t.positions[pos];
      const ratio = p.starter_value / (avg[pos] || 1);
      p.ratio = +ratio.toFixed(2);
      if (ratio < WEAK) {
        p.status = 'need';
        t.needs.push({ position: pos, ratio: p.ratio, gap: Math.round(avg[pos] - p.starter_value) });
      } else if (ratio > STRONG && p.tradeable.length) {
        p.status = 'surplus';
        // Priced in market units — VOR is <= 0 for bench players and would sort wrongly.
        t.surplus.push({ position: pos, ratio: p.ratio, players: p.tradeable,
                         value: Math.round(p.tradeable.reduce((s, x) => s + Math.max(0, x.value), 0)) });
      } else p.status = 'ok';
    }
    t.needs.sort((a, b) => a.ratio - b.ratio);
    t.surplus.sort((a, b) => b.value - a.value);
  }

  // Contention window on the market-capital x core-age grid. Market capital (not VOR)
  // because draft picks are a large share of dynasty capital and only exist as prices.
  const caps = teams.map(t => t.market_capital).sort((a, b) => a - b);
  const median = caps.length % 2 ? caps[(caps.length - 1) / 2]
    : (caps[caps.length / 2 - 1] + caps[caps.length / 2]) / 2 || 1;
  const YOUNG = 25.5, OLD = 27.5;
  for (const t of teams) {
    const comp = t.market_capital / (median || 1);
    t.competitiveness = +comp.toFixed(2);
    const strong = comp >= 1.05, weak = comp <= 0.95;
    const young = t.core_age != null && t.core_age <= YOUNG;
    const old = t.core_age != null && t.core_age >= OLD;
    const [label, stance] =
      strong && old ? ['Win-now', 'Window is closing — spend youth and depth on proven help now.']
      : strong && young ? ['Juggernaut', 'Strong and young — hold the core, buy only at the margins.']
      : weak && young ? ['Rebuild', 'Ascending — accumulate youth, sell aging vets while they hold value.']
      : weak && old ? ['Reset', 'Weak and aging — sell everything with value for youth.']
      : strong ? ['Contender', 'Above average — target the upgrade that pushes you over the top.']
      : weak ? ['Retool', 'Below average — move stagnant assets for upside.']
      : ['Balanced', 'Middle of the pack — trade on value, no forced direction.'];
    t.window = { label, stance };
  }
  return { teams, averages: avg, per_team: perTeam, format_key: formatKey, is_dynasty: isDynasty };
}

r.get('/:leagueId/analysis', (req, res) => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
  if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });
  const a = analyzeLeague(lg);
  if (!a.teams.some(t => t.players.length)) {
    return res.json({ empty: true, message: 'No rostered players matched — this league likely has not drafted yet.' });
  }
  res.json({ league: { id: lg.id, name: lg.name, my_team_id: lg.my_team_id }, ...a });
});

/* -------------------------------------------------- trade matchmaking */
/** Rank every rival by two-way fit: their surplus at my needs, and vice versa. */
r.get('/:leagueId/partners', (req, res) => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
  if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });
  const { teams } = analyzeLeague(lg);
  const meId = String(req.query.team_id ?? lg.my_team_id ?? teams[0]?.roster_id);
  const me = teams.find(t => String(t.roster_id) === meId);
  if (!me) return res.status(404).json({ error: 'your team not found in this league' });

  const myNeeds = new Set(me.needs.map(n => n.position));
  const mySurplus = Object.fromEntries(me.surplus.map(s => [s.position, s]));

  const matches = [];
  for (const other of teams) {
    if (String(other.roster_id) === meId) continue;
    const theirSurplus = Object.fromEntries(other.surplus.map(s => [s.position, s]));
    const theirNeeds = new Set(other.needs.map(n => n.position));

    const theySend = [...myNeeds].filter(p => theirSurplus[p]).map(p => theirSurplus[p]);
    const iSend = [...theirNeeds].filter(p => mySurplus[p]).map(p => mySurplus[p]);
    if (!theySend.length && !iSend.length) continue;

    const twoWay = theySend.length > 0 && iSend.length > 0;
    const fill = theySend.reduce((s, x) => s + x.value, 0);
    const give = iSend.reduce((s, x) => s + x.value, 0);
    let score = fill + give;
    if (twoWay) score = Math.round(score * 1.5);   // mutual fit is worth a premium

    matches.push({
      roster_id: other.roster_id, owner: other.owner,
      window: other.window, competitiveness: other.competitiveness, core_age: other.core_age,
      two_way: twoWay,
      they_send: theySend, i_send: iSend,
      their_needs: other.needs.map(n => n.position),
      their_surplus: other.surplus.map(s => s.position),
      picks: other.picks, picks_value: other.picks_value,
      market_capital: other.market_capital,
      need_fill_value: Math.round(fill), score: Math.round(score)
    });
  }
  matches.sort((a, b) => (b.two_way ? 1 : 0) - (a.two_way ? 1 : 0) || b.score - a.score);
  res.json({
    me: {
      roster_id: me.roster_id, owner: me.owner, window: me.window,
      needs: me.needs, surplus: me.surplus,
      picks: me.picks, picks_value: me.picks_value, market_capital: me.market_capital
    },
    matches
  });
});

/* -------------------------------------------- AI offer ladder + pitch */
r.post('/:leagueId/pitch', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
    if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });
    const { teams } = analyzeLeague(lg);
    const meId = String(req.body?.my_team_id ?? lg.my_team_id ?? teams[0]?.roster_id);
    const me = teams.find(t => String(t.roster_id) === meId);
    const them = teams.find(t => String(t.roster_id) === String(req.body?.target_id));
    if (!me || !them) return res.status(400).json({ error: 'both teams required' });

    const fmt = t => SKILL.map(pos => {
      const p = t.positions[pos];
      return `${pos} (${p.status}, ${p.ratio}x league avg): ` +
        [...p.starters, ...p.depth].slice(0, 5)
          .map(x => `${x.name} [VOR ${x.vor}, price ${x.value}${x.age ? `, ${x.age}yo` : ''}]`).join(', ');
    }).join('\n');
    const fmtPicks = t => t.picks.length
      ? t.picks.map(p => `${p.label}${p.from ? ` (via ${p.from})` : ''} [${p.value}]`).join(', ')
      : 'none';

    const taxi = JSON.parse(lg.payload).league?.settings?.taxi_slots ?? 0;

    const msg = await callClaude({
      feature: 'trade-pitch',
      maxTokens: 1500,
      prompt: `You are negotiating a fantasy football trade in a ${lg.team_count ?? 12}-team ${lg.league_type ?? 'redraft'} league.
Each player carries two numbers: VOR (projected points above replacement — will he help me win) and price (FantasyCalc market trade value — what the market pays). Draft picks are priced in the same market units as "price".
Taxi squad: ${taxi ? `${taxi} slots (rookies can be stashed off the active roster)` : 'NONE — every rookie occupies an active roster spot, so picks are worth slightly less here'}.

MY TEAM (${me.owner}) — window: ${me.window.label}. ${me.window.stance}
${fmt(me)}
My needs: ${me.needs.map(n => `${n.position} (gap ${n.gap})`).join(', ') || 'none'}
My surplus: ${me.surplus.map(s => s.position).join(', ') || 'none'}
My draft picks: ${fmtPicks(me)}

THEIR TEAM (${them.owner}) — window: ${them.window.label}. ${them.window.stance}
${fmt(them)}
Their needs: ${them.needs.map(n => `${n.position} (gap ${n.gap})`).join(', ') || 'none'}
Their surplus: ${them.surplus.map(s => s.position).join(', ') || 'none'}
Their draft picks: ${fmtPicks(them)}

Build a negotiation ladder that exploits the fit between our windows and positional needs. Only use players and picks actually listed above. Keep the deal roughly balanced on price or slightly in my favour, and make each rung something they would plausibly accept given their window. Draft picks are legitimate trade pieces — a rebuilder will usually prefer picks and youth, a contender proven production.

Respond with ONLY JSON:
{"anchor":{"i_give":["Player or pick"],"i_get":["Player or pick"],"why":"one sentence"},
 "fair":{"i_give":["Player or pick"],"i_get":["Player or pick"],"why":"one sentence"},
 "walk_away":"the line past which I should decline, one sentence",
 "pitch":"a short message I can paste to them — friendly, frames the deal around THEIR need, no fake urgency, 3-4 sentences",
 "read":"2-3 sentences on their likely counter and how to respond"}`
    });
    res.json(parseJson(msg));
  } catch (e) { next(e); }
});

/* ------------------------------------- Sleeper trending adds/drops */
db.exec(`CREATE TABLE IF NOT EXISTS trending_players (
  player_id INTEGER PRIMARY KEY, kind TEXT, count INTEGER, fetched_at TEXT
)`);

r.post('/trending/sync', async (req, res, next) => {
  try {
    let total = 0;
    for (const kind of ['add', 'drop']) {
      const resp = await fetch(`https://api.sleeper.app/v1/players/nfl/trending/${kind}?lookback_hours=24&limit=40`,
        { headers: { Accept: 'application/json' } });
      if (!resp.ok) continue;
      for (const t of await resp.json()) {
        const p = row('SELECT id FROM players WHERE sleeper_id = ?', String(t.player_id));
        if (!p) continue;
        run(`INSERT INTO trending_players (player_id, kind, count, fetched_at)
             VALUES (?,?,?,datetime('now'))
             ON CONFLICT(player_id) DO UPDATE SET kind=excluded.kind, count=excluded.count, fetched_at=excluded.fetched_at`,
          p.id, kind, t.count ?? 0);
        total++;
      }
    }
    res.json({ ok: true, matched: total });
  } catch (e) { next(e); }
});

r.get('/trending', (req, res) => {
  res.json(rows(`SELECT tp.kind, tp.count, p.id AS player_id, p.name, p.position, p.espn_id, p.sleeper_id,
                        t.abbr AS team_abbr, s.fantasy_points AS proj
                 FROM trending_players tp
                 JOIN players p ON p.id = tp.player_id
                 LEFT JOIN nfl_teams t ON t.id = p.team_id
                 LEFT JOIN player_season_stats s ON s.player_id = p.id AND s.season = ? AND s.kind='projected'
                 ORDER BY tp.kind, tp.count DESC`, SEASON));
});

export default r;
