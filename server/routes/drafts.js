import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { computeConsensus } from './aggregates.js';

const r = Router();

function snakeSlot(pickNumber, teamCount) {
  const round = Math.ceil(pickNumber / teamCount);
  const posInRound = ((pickNumber - 1) % teamCount) + 1;
  return round % 2 === 1 ? posInRound : teamCount - posInRound + 1;
}

// --- CPU opponent brain for mock drafts ---------------------------------
// Market value comes from the platform consensus (FFC ADP + Sleeper); the
// user's own ranking set fills gaps. CPU teams draft best-available in their
// range with weighted randomness, roster-need logic, and run-chasing.

const ROSTER_CAPS = { QB: 2, RB: 7, WR: 7, TE: 2, K: 1 };

function buildMarketPool(draft) {
  const taken = new Set(rows('SELECT player_id FROM draft_picks WHERE draft_id = ?', draft.id).map(p => p.player_id));
  const pool = new Map(); // player_id -> {id, position, market}
  computeConsensus().forEach((p, i) => {
    if (!taken.has(p.id) && !pool.has(p.id)) pool.set(p.id, { id: p.id, position: p.position, market: i + 1 });
  });
  if (draft.ranking_set_id) {
    for (const e of rows(`SELECT re.player_id AS id, re.rank, p.position FROM ranking_entries re
                          JOIN players p ON p.id = re.player_id WHERE re.set_id = ?`, draft.ranking_set_id)) {
      if (taken.has(e.id)) continue;
      const existing = pool.get(e.id);
      if (existing) existing.market = Math.min(existing.market, e.rank);
      else pool.set(e.id, { id: e.id, position: e.position, market: e.rank + 15 });
    }
  }
  return [...pool.values()];
}

function cpuPick(draft, slot, pool, allPicks) {
  const round = Math.ceil((allPicks.length + 1) / draft.team_count);
  const myPos = {};
  for (const p of allPicks.filter(p => p.team_slot === slot)) myPos[p.position] = (myPos[p.position] ?? 0) + 1;

  const needsOk = c => {
    const have = myPos[c.position] ?? 0;
    if (have >= (ROSTER_CAPS[c.position] ?? 3)) return false;
    if (c.position === 'K' && round < draft.rounds - 1) return false;
    if (c.position === 'QB' && have >= 1 && round < draft.rounds - 4) return false;
    if (c.position === 'TE' && have >= 1 && round < draft.rounds - 4) return false;
    return true;
  };

  // forced needs at the end of the draft
  if (round >= draft.rounds && !myPos.K) {
    const k = pool.filter(c => c.position === 'K').sort((a, b) => a.market - b.market)[0];
    if (k) return k;
  }
  if (round >= draft.rounds - 1 && !myPos.QB) {
    const qb = pool.filter(c => c.position === 'QB').sort((a, b) => a.market - b.market)[0];
    if (qb) return qb;
  }

  // recent positional run → CPUs chase it a little
  const recent = allPicks.slice(-5).map(p => p.position);
  const runBoost = pos => (recent.filter(x => x === pos).length >= 3 ? 4 : 0);

  const jitter = 3 + round * 0.8; // later rounds get sloppier, like real drafts
  const scored = pool
    .filter(needsOk)
    .map(c => ({ ...c, eff: c.market - runBoost(c.position) + (Math.random() * 2 - 1) * jitter }))
    .sort((a, b) => a.eff - b.eff);
  const candidates = scored.length ? scored : [...pool].sort((a, b) => a.market - b.market);
  if (candidates.length === 0) return null;

  // weighted choice among the top of the range
  const weights = [0.40, 0.24, 0.15, 0.10, 0.07, 0.04];
  let roll = Math.random(), idx = 0;
  for (let i = 0; i < Math.min(weights.length, candidates.length); i++) {
    roll -= weights[i];
    if (roll <= 0) { idx = i; break; }
  }
  return candidates[Math.min(idx, candidates.length - 1)];
}

r.get('/', (req, res) => {
  res.json(rows(`SELECT d.*, rs.name AS ranking_set_name,
                 (SELECT COUNT(*) FROM draft_picks dp WHERE dp.draft_id = d.id) AS picks_made
                 FROM drafts d LEFT JOIN ranking_sets rs ON rs.id = d.ranking_set_id
                 ORDER BY d.created_at DESC`));
});

r.post('/', (req, res) => {
  const { name, type = 'mock', team_count = 12, rounds = 16, my_slot = 1, ranking_set_id = null } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, ranking_set_id)
       VALUES (?,?,?,?,?,?)`, name, type, team_count, rounds, my_slot, ranking_set_id);
  res.json(row('SELECT * FROM drafts WHERE id = last_insert_rowid()'));
});

r.delete('/:id', (req, res) => {
  run('DELETE FROM drafts WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.get('/:id', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  const picks = rows(`SELECT dp.*, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr, t.primary_color
                      FROM draft_picks dp
                      JOIN players p ON p.id = dp.player_id
                      LEFT JOIN nfl_teams t ON t.id = p.team_id
                      WHERE dp.draft_id = ? ORDER BY dp.pick_number`, draft.id);
  let available = [];
  if (draft.ranking_set_id) {
    available = rows(`SELECT re.rank, re.tier, re.note, p.id AS player_id, p.name, p.position, p.espn_id, p.sleeper_id,
                             t.abbr AS team_abbr, t.primary_color
                      FROM ranking_entries re
                      JOIN players p ON p.id = re.player_id
                      LEFT JOIN nfl_teams t ON t.id = p.team_id
                      WHERE re.set_id = ?
                        AND p.id NOT IN (SELECT player_id FROM draft_picks WHERE draft_id = ?)
                      ORDER BY re.rank`, draft.ranking_set_id, draft.id);
  }
  // Beyond the user's board, fall back to platform-consensus market ranks so
  // deep drafts never run out of pickable players.
  const seen = new Set(available.map(a => a.player_id));
  const taken = new Set(picks.map(p => p.player_id));
  const boardMax = available.length ? Math.max(...available.map(a => a.rank)) : 0;
  let overflow = 0;
  for (const c of computeConsensus()) {
    if (seen.has(c.id) || taken.has(c.id)) continue;
    overflow++;
    available.push({ rank: boardMax + overflow, tier: 6, note: null, player_id: c.id,
      name: c.name, position: c.position, team_abbr: c.team_abbr, primary_color: c.primary_color });
  }
  res.json({ ...draft, picks, available });
});

r.post('/:id/picks', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  const { player_id } = req.body;
  const pickNumber = (row('SELECT COALESCE(MAX(pick_number),0) AS m FROM draft_picks WHERE draft_id = ?', draft.id).m) + 1;
  // snake order
  const round = Math.ceil(pickNumber / draft.team_count);
  const posInRound = ((pickNumber - 1) % draft.team_count) + 1;
  const teamSlot = round % 2 === 1 ? posInRound : draft.team_count - posInRound + 1;
  try {
    run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,?,?,?)',
      draft.id, pickNumber, teamSlot, player_id);
  } catch (e) {
    return res.status(400).json({ error: 'player already drafted' });
  }
  res.json({ ok: true, pick_number: pickNumber, team_slot: teamSlot });
});

// CPU teams pick until it's my turn again (or the draft ends). Mock drafts only.
r.post('/:id/simulate', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  if (draft.type !== 'mock') return res.status(400).json({ error: 'simulation is for mock drafts only' });

  const totalPicks = draft.team_count * draft.rounds;
  const made = [];
  let pool = buildMarketPool(draft);

  for (;;) {
    const allPicks = rows('SELECT pick_number, team_slot, player_id, (SELECT position FROM players WHERE id = player_id) AS position FROM draft_picks WHERE draft_id = ? ORDER BY pick_number', draft.id);
    const nextPick = allPicks.length + 1;
    if (nextPick > totalPicks) break;
    const slot = snakeSlot(nextPick, draft.team_count);
    if (slot === draft.my_slot) break;
    const choice = cpuPick(draft, slot, pool, allPicks);
    if (!choice) break;
    run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id) VALUES (?,?,?,?)',
      draft.id, nextPick, slot, choice.id);
    pool = pool.filter(c => c.id !== choice.id);
    made.push({ pick_number: nextPick, team_slot: slot, player_id: choice.id });
  }
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
  res.json({ ok: true, cpu_picks: made.length, draft_complete: count >= totalPicks });
});

r.delete('/:id/picks/last', (req, res) => {
  run(`DELETE FROM draft_picks WHERE draft_id = ? AND pick_number =
       (SELECT MAX(pick_number) FROM draft_picks WHERE draft_id = ?)`,
    req.params.id, req.params.id);
  res.json({ ok: true });
});

export default r;
