import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { computeConsensus } from './aggregates.js';
import { statsMap } from './stats.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import { ensureLiveDraft, syncLiveDraft } from '../services/espn-draft.js';
import { boardState, rankTargets, dossiersFor } from '../services/draft-assist.js';

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

const ROSTER_CAPS = { QB: 2, RB: 7, WR: 7, TE: 2, K: 1, DEF: 1 };

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
  // Kickers and team defenses have no ADP/market data from any source, so they
  // never appear in the consensus. Append them at a late market rank so they are
  // draftable in the last rounds instead of silently missing.
  const tail = pool.size + 50;
  for (const p of rows(`SELECT id, position FROM players
                        WHERE position IN ('K','DEF') AND fantasy_relevant = 1`)) {
    if (taken.has(p.id) || pool.has(p.id)) continue;
    pool.set(p.id, { id: p.id, position: p.position, market: tail });
  }
  // Final safety net: computeConsensus() only returns players with synced FFC/Sleeper
  // market data, so on a fresh install where that sync hasn't run yet (or failed),
  // the pool above can come up short of what a real draft needs — a 12-team/16-round
  // draft is 192 picks. Every fantasy_relevant player who still isn't in the pool
  // goes in here, ordered by projected points where we have it, so the draft can
  // never exhaust its player pool regardless of what's synced.
  const sm = statsMap();
  const leftover = rows(`SELECT id, position FROM players WHERE fantasy_relevant = 1`)
    .filter(p => !taken.has(p.id) && !pool.has(p.id))
    .sort((a, b) => (sm.get(b.id)?.projected_points ?? 0) - (sm.get(a.id)?.projected_points ?? 0));
  leftover.forEach((p, i) => pool.set(p.id, { id: p.id, position: p.position, market: tail + 50 + i }));
  return [...pool.values()];
}

const ROSTER_TARGET = { QB: 1, RB: 5, WR: 5, TE: 1, K: 1, DEF: 1 };

/** Human-readable, varied justification for a CPU pick. */
function explainPick(choice, ctx) {
  const { round, myPos, candidates, runPos, tierTop } = ctx;
  const have = myPos[choice.position] ?? 0;
  const bestOverall = candidates[0];
  const reach = choice.market - (bestOverall?.market ?? choice.market);
  const opts = [];

  if (round === 1 && choice.market <= 2) {
    opts.push(`consensus 1.01-caliber — every outlet has him top-2`, `no-brainer at the top of the board`);
  }
  if (reach <= 0.5) {
    opts.push(`best player available (market #${Math.round(choice.market)})`,
              `cleanly BPA here`, `top of the board, no reason to get cute`);
  } else if (reach > 8) {
    opts.push(`a reach — clearly targeting ${choice.position} over value`,
              `going off-board for a positional want at ${choice.position}`);
  } else {
    opts.push(`slight reach for ${choice.position} over pure value`,
              `value + need overlap at ${choice.position}`);
  }
  if (runPos === choice.position) {
    opts.push(`chasing the ${choice.position} run — ${choice.position}s flying off the board`,
              `didn't want to be last one out on the ${choice.position} run`);
  }
  if (have === 0 && ['RB', 'WR', 'QB', 'TE'].includes(choice.position) && round > 2) {
    opts.push(`still had zero ${choice.position}s rostered`, `filling an empty ${choice.position} slot`);
  }
  if (have >= 3 && ['RB', 'WR'].includes(choice.position)) {
    opts.push(`doubling down on ${choice.position} depth`, `hoarding ${choice.position}s at this point`);
  }
  if (choice.position === 'K') opts.push(`kicker, last round, as it should be`);
  if (choice.position === 'QB' && round >= draftLateRounds(ctx)) opts.push(`finally grabbing a QB late`);
  if (tierTop) opts.push(`last man in his tier — grabbed him before the drop-off`);

  return opts[Math.floor(Math.random() * opts.length)];
}
const draftLateRounds = ctx => Math.max(1, ctx.rounds - 4);

function cpuPick(draft, slot, pool, allPicks) {
  const round = Math.ceil((allPicks.length + 1) / draft.team_count);
  const myPos = {};
  for (const p of allPicks.filter(p => p.team_slot === slot)) myPos[p.position] = (myPos[p.position] ?? 0) + 1;

  const needsOk = c => {
    const have = myPos[c.position] ?? 0;
    if (have >= (ROSTER_CAPS[c.position] ?? 3)) return false;
    if (c.position === 'K' && round < draft.rounds - 1) return false;
    if (c.position === 'DEF' && round < draft.rounds - 2) return false;
    if (c.position === 'QB' && have >= 1 && round < draft.rounds - 4) return false;
    if (c.position === 'TE' && have >= 1 && round < draft.rounds - 4) return false;
    return true;
  };

  const mk = (c, reason) => ({ ...c, reason });

  // forced needs at the end of the draft
  if (round >= draft.rounds && !myPos.K) {
    const k = pool.filter(c => c.position === 'K').sort((a, b) => a.market - b.market)[0];
    if (k) return mk(k, 'kicker in the final round, as it should be');
  }
  if (round >= draft.rounds - 1 && !myPos.DEF) {
    const def = pool.filter(c => c.position === 'DEF').sort((a, b) => a.market - b.market)[0];
    if (def) return mk(def, 'streaming a defense late');
  }
  if (round >= draft.rounds - 1 && !myPos.QB) {
    const qb = pool.filter(c => c.position === 'QB').sort((a, b) => a.market - b.market)[0];
    if (qb) return mk(qb, 'had to have a starting QB — took the last decent one');
  }

  // recent positional run → CPUs chase it a little
  const recent = allPicks.slice(-5).map(p => p.position);
  const runPos = ['QB', 'RB', 'WR', 'TE'].find(p => recent.filter(x => x === p).length >= 3) ?? null;
  const runBoost = pos => (pos === runPos ? 4 : 0);
  // mild pull toward filling out a real starting lineup
  const needBoost = c => {
    const have = myPos[c.position] ?? 0;
    const want = ROSTER_TARGET[c.position] ?? 0;
    return have < want ? 2.5 : 0;
  };

  // At the very top of the draft the market is nearly unanimous, so keep 1.01
  // honest: only the true consensus top tier is in play. Noise grows by round.
  const jitter = round === 1 ? 1.2 : 3 + round * 0.8;

  const scored = pool
    .filter(needsOk)
    .map(c => ({ ...c, eff: c.market - runBoost(c.position) - needBoost(c) + (Math.random() * 2 - 1) * jitter }))
    .sort((a, b) => a.eff - b.eff);
  const candidates = scored.length ? scored : [...pool].sort((a, b) => a.market - b.market);
  if (candidates.length === 0) return null;

  // Pick 1 overall: the field is realistically two players, so choose between them.
  if (allPicks.length === 0) {
    const top2 = [...pool].sort((a, b) => a.market - b.market).slice(0, 2);
    const pick = top2[Math.random() < 0.55 ? 0 : 1] ?? candidates[0];
    return mk(pick, 'consensus 1.01 — the board is really just two names here');
  }

  // Weighted choice among the top of the range. Early rounds are near-chalk in
  // real drafts (elite players don't slide), so concentrate the weight up top and
  // loosen it as the draft goes on.
  const WEIGHTS_BY_ROUND = {
    1: [0.80, 0.14, 0.06],
    2: [0.66, 0.20, 0.09, 0.05],
    3: [0.55, 0.22, 0.12, 0.07, 0.04]
  };
  const weights = WEIGHTS_BY_ROUND[round] ?? [0.40, 0.24, 0.15, 0.10, 0.07, 0.04];
  let roll = Math.random(), idx = 0;
  for (let i = 0; i < Math.min(weights.length, candidates.length); i++) {
    roll -= weights[i];
    if (roll <= 0) { idx = i; break; }
  }
  const choice = candidates[Math.min(idx, candidates.length - 1)];
  const tierTop = candidates.filter(c => c.position === choice.position)
    .findIndex(c => c.id === choice.id) === 0;
  return mk(choice, explainPick(choice, { round, rounds: draft.rounds, myPos, candidates, runPos, tierTop }));
}

r.get('/', (req, res) => {
  res.json(rows(`SELECT d.*, rs.name AS ranking_set_name,
                 (SELECT COUNT(*) FROM draft_picks dp WHERE dp.draft_id = d.id) AS picks_made
                 FROM drafts d LEFT JOIN ranking_sets rs ON rs.id = d.ranking_set_id
                 ORDER BY d.created_at DESC`));
});

r.post('/', (req, res) => {
  const { name, type = 'mock', team_count = 12, rounds = 16, my_slot = 1, ranking_set_id = null, pick_seconds = 90 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, ranking_set_id, pick_seconds)
       VALUES (?,?,?,?,?,?,?)`, name, type, team_count, rounds, my_slot, ranking_set_id, pick_seconds);
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
  // computeConsensus() only returns players with synced FFC/Sleeper market data —
  // K/DEF never have any, and on a fresh/offline install nothing might yet. Anyone
  // still fantasy_relevant and not yet listed goes in last, so this board (like
  // buildMarketPool's CPU pool) can never come up short of what a real draft needs.
  for (const p of rows(`SELECT p.id AS player_id, p.name, p.position, t.abbr AS team_abbr, t.primary_color
                        FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id
                        WHERE p.fantasy_relevant = 1`)) {
    if (seen.has(p.player_id) || taken.has(p.player_id)) continue;
    overflow++;
    available.push({ rank: boardMax + overflow, tier: 6, note: null, ...p });
  }
  const sm = statsMap();
  const withStats = p => {
    const st = sm.get(p.player_id ?? p.id);
    return st ? { ...p, projected_points: st.projected_points ?? null,
                  last_season_points: st.last_season_points ?? null,
                  projected_pos_rank: st.projected_pos_rank ?? null } : p;
  };
  res.json({ ...draft, picks: picks.map(withStats), available: available.map(withStats) });
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

/** Make exactly one CPU pick (drives the pick-by-pick animation). */
r.post('/:id/cpu-pick', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  if (draft.type !== 'mock') return res.status(400).json({ error: 'simulation is for mock drafts only' });

  const totalPicks = draft.team_count * draft.rounds;
  const allPicks = rows(`SELECT pick_number, team_slot, player_id,
                           (SELECT position FROM players WHERE id = player_id) AS position
                         FROM draft_picks WHERE draft_id = ? ORDER BY pick_number`, draft.id);
  const nextPick = allPicks.length + 1;
  if (nextPick > totalPicks) return res.json({ done: true, reason: 'draft complete' });

  const slot = snakeSlot(nextPick, draft.team_count);
  if (slot === draft.my_slot) return res.json({ done: true, on_the_clock: true, pick_number: nextPick });

  const pool = buildMarketPool(draft);
  const choice = cpuPick(draft, slot, pool, allPicks);
  if (!choice) return res.json({ done: true, reason: 'no players left' });

  run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, reason) VALUES (?,?,?,?,?)',
    draft.id, nextPick, slot, choice.id, choice.reason ?? null);

  const p = row(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr, t.primary_color
                 FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, choice.id);
  res.json({
    done: false,
    pick: { pick_number: nextPick, team_slot: slot, round: Math.ceil(nextPick / draft.team_count),
            reason: choice.reason, market_rank: Math.round(choice.market), ...p }
  });
});

// Run CPU picks until it's my turn (used for skip / catch-up).
r.post('/:id/simulate', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  if (draft.type !== 'mock') return res.status(400).json({ error: 'simulation is for mock drafts only' });

  const totalPicks = draft.team_count * draft.rounds;
  const made = [];
  let pool = buildMarketPool(draft);

  for (;;) {
    const allPicks = rows(`SELECT pick_number, team_slot, player_id,
                             (SELECT position FROM players WHERE id = player_id) AS position
                           FROM draft_picks WHERE draft_id = ? ORDER BY pick_number`, draft.id);
    const nextPick = allPicks.length + 1;
    if (nextPick > totalPicks) break;
    const slot = snakeSlot(nextPick, draft.team_count);
    if (slot === draft.my_slot) break;
    const choice = cpuPick(draft, slot, pool, allPicks);
    if (!choice) break;
    run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, reason) VALUES (?,?,?,?,?)',
      draft.id, nextPick, slot, choice.id, choice.reason ?? null);
    pool = pool.filter(c => c.id !== choice.id);
    made.push({ pick_number: nextPick, team_slot: slot, player_id: choice.id });
  }
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
  res.json({ ok: true, cpu_picks: made.length, draft_complete: count >= totalPicks });
});

/** Run the entire remaining draft, auto-picking for me from the recommendation. */
r.post('/:id/sim-to-end', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  const total = draft.team_count * draft.rounds;
  let guard = 0;
  while (guard++ < total + 5) {
    const allPicks = rows(`SELECT pick_number, team_slot, player_id,
                             (SELECT position FROM players WHERE id = player_id) AS position
                           FROM draft_picks WHERE draft_id = ? ORDER BY pick_number`, draft.id);
    const nextPick = allPicks.length + 1;
    if (nextPick > total) break;
    const slot = snakeSlot(nextPick, draft.team_count);
    const pool = buildMarketPool(draft);
    const choice = cpuPick(draft, slot, pool, allPicks);
    if (!choice) break;
    run('INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, reason) VALUES (?,?,?,?,?)',
      draft.id, nextPick, slot, choice.id,
      slot === draft.my_slot ? 'auto-picked to finish the draft' : (choice.reason ?? null));
  }
  const made = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
  res.json({ ok: true, picks: made, complete: made >= total });
});

/** What should I take right now? Value + roster need, with a reason. */
r.get('/:id/recommendation', (req, res) => {
  const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  const allPicks = rows(`SELECT pick_number, team_slot, player_id,
                           (SELECT position FROM players WHERE id = player_id) AS position
                         FROM draft_picks WHERE draft_id = ? ORDER BY pick_number`, draft.id);
  const nextPick = allPicks.length + 1;
  const round = Math.ceil(nextPick / draft.team_count);
  const mine = allPicks.filter(p => p.team_slot === draft.my_slot);
  const myPos = {};
  for (const p of mine) myPos[p.position] = (myPos[p.position] ?? 0) + 1;

  const pool = buildMarketPool(draft).sort((a, b) => a.market - b.market);
  const byId = new Map(rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr
                             FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id`).map(p => [p.id, p]));

  const scored = pool.slice(0, 40).map(c => {
    const have = myPos[c.position] ?? 0;
    const want = ROSTER_TARGET[c.position] ?? 0;
    let bonus = 0;
    const notes = [];
    if (have < want) { bonus += 6; notes.push(`you have ${have} ${c.position}${have === 1 ? '' : 's'}`); }
    if (c.position === 'QB' && have >= 1 && round < draft.rounds - 3) { bonus -= 25; notes.push('already have a QB'); }
    if (c.position === 'TE' && have >= 1 && round < draft.rounds - 3) { bonus -= 20; notes.push('already have a TE'); }
    if (c.position === 'K' && round < draft.rounds - 1) { bonus -= 60; notes.push('way too early for a kicker'); }
    return { ...c, score: -c.market + bonus, notes };
  }).sort((a, b) => b.score - a.score);

  const sm2 = statsMap();
  const top = scored.slice(0, 5).map(c => {
    const p = byId.get(c.id) ?? {};
    const st = sm2.get(c.id);
    return { player_id: c.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
             espn_id: p.espn_id, sleeper_id: p.sleeper_id,
             market_rank: Math.round(c.market), notes: c.notes,
             projected_points: st?.projected_points ?? null,
             projected_pos_rank: st?.projected_pos_rank ?? null,
             last_season_points: st?.last_season_points ?? null };
  });
  const best = top[0];
  res.json({
    pick_number: nextPick, round,
    my_roster: myPos,
    recommendation: best ? {
      ...best,
      why: best.notes.length
        ? `Best value on the board (market #${best.market_rank}) and ${best.notes.join('; ')}.`
        : `Best value on the board (market #${best.market_rank}).`
    } : null,
    alternatives: top.slice(1)
  });
});

r.delete('/:id/picks/last', (req, res) => {
  run(`DELETE FROM draft_picks WHERE draft_id = ? AND pick_number =
       (SELECT MAX(pick_number) FROM draft_picks WHERE draft_id = ?)`,
    req.params.id, req.params.id);
  res.json({ ok: true });
});


/** Stored draft grade — generated once, viewable any time after. */
r.get('/:id/grade', (req, res) => {
  const g = row('SELECT grade, summary, strengths, weaknesses, best_pick, reach, generated_at FROM draft_grades WHERE draft_id = ?', req.params.id);
  res.json(g ? {
    ...g,
    strengths: g.strengths ? JSON.parse(g.strengths) : [],
    weaknesses: g.weaknesses ? JSON.parse(g.weaknesses) : []
  } : null);
});

r.post('/:id/grade', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const draft = row('SELECT * FROM drafts WHERE id = ?', req.params.id);
    if (!draft) return res.status(404).json({ error: 'draft not found' });

    const sm = statsMap();
    const mine = rows(`SELECT dp.pick_number, p.id, p.name, p.position, t.abbr AS team_abbr
                       FROM draft_picks dp JOIN players p ON p.id = dp.player_id
                       LEFT JOIN nfl_teams t ON t.id = p.team_id
                       WHERE dp.draft_id = ? AND dp.team_slot = ? ORDER BY dp.pick_number`,
      draft.id, draft.my_slot);
    if (!mine.length) return res.status(400).json({ error: 'No picks on your team yet.' });

    const roster = mine.map(p => {
      const st = sm.get(p.id);
      const rd = Math.ceil(p.pick_number / draft.team_count);
      return `Rd${rd} (pick ${p.pick_number}) ${p.position} ${p.name} (${p.team_abbr ?? 'FA'})`
        + (st?.projected_points != null ? ` — proj ${Math.round(st.projected_points)} pts, ${p.position}${st.projected_pos_rank ?? '?'}` : '');
    }).join('\n');

    const msg = await callClaude({
      feature: 'draft-grade',
      maxTokens: 1200,
      prompt: `Grade this 2026 fantasy football draft roster. ${draft.team_count}-team ${draft.rounds}-round league, I picked from slot ${draft.my_slot}.

MY ROSTER (in draft order, with ESPN season projections):
${roster}

Judge roster construction: positional balance, whether I got value relative to where players went, starting-lineup strength, bye/injury risk concentration, and whether I waited too long or reached at any position.

Respond with ONLY JSON:
{"grade":"A+|A|A-|B+|B|B-|C+|C|C-|D|F",
 "summary":"3-4 sentences, specific, naming actual players",
 "strengths":["short point naming players", "..."],
 "weaknesses":["short point naming players", "..."],
 "best_pick":"Player Name — one sentence why",
 "reach":"Player Name — one sentence why, or 'none' if every pick was defensible"}`
    });
    const out = parseJson(msg);
    run(`INSERT INTO draft_grades (draft_id, grade, summary, strengths, weaknesses, best_pick, reach, generated_at)
         VALUES (?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(draft_id) DO UPDATE SET grade=excluded.grade, summary=excluded.summary,
           strengths=excluded.strengths, weaknesses=excluded.weaknesses, best_pick=excluded.best_pick,
           reach=excluded.reach, generated_at=excluded.generated_at`,
      draft.id, out.grade, out.summary, JSON.stringify(out.strengths ?? []),
      JSON.stringify(out.weaknesses ?? []), out.best_pick ?? null, out.reach ?? null);
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ live draft */

/**
 * Link a connected ESPN league's draft and mirror it locally.
 *
 * Safe to call repeatedly — the draft row is keyed on the league and season, so the
 * user can hit "connect" before the draft, during it, or after a browser refresh and
 * always land in the same draft room.
 */
r.post('/live/link', async (req, res, next) => {
  try {
    const leagueRowId = req.body?.league_row_id ?? req.body?.league_id;
    if (!leagueRowId) return res.status(400).json({ error: 'league_row_id required' });
    const out = await ensureLiveDraft(leagueRowId);
    // Pull whatever has already happened, so a mid-draft connect catches up instantly.
    const sync = await syncLiveDraft(out.draft_id).catch(e => ({ error: e.message }));
    res.json({ ...out, sync });
  } catch (e) { next(e); }
});

/** Poll ESPN for new picks. Cheap; the draft room calls this on a timer. */
r.post('/:id/sync', async (req, res, next) => {
  try { res.json(await syncLiveDraft(req.params.id)); }
  catch (e) { next(e); }
});

/**
 * Everything needed to make the pick on the clock: roster needs against this league's
 * lineup, positional scarcity before the next turn, runs, tier cliffs, and a ranked
 * shortlist. Deterministic and instant — no API key involved.
 */
r.get('/:id/assist', (req, res, next) => {
  try {
    const state = boardState(req.params.id);
    res.json({ ...state, targets: rankTargets(state, Number(req.query.limit) || 8) });
  } catch (e) { next(e); }
});

/**
 * Claude's read on the same board.
 *
 * Cached per pick number: during a live draft this gets called every time the board
 * moves, and re-billing a fresh call for an unchanged board would be both slow and
 * wasteful. `?refresh=1` forces a new one.
 */
r.get('/:id/advice', async (req, res, next) => {
  try {
    const state = boardState(req.params.id);
    const pickNo = state.on_the_clock.pick_number ?? 0;
    if (!req.query.refresh) {
      const hit = row('SELECT payload FROM draft_advice WHERE draft_id = ? AND pick_number = ?',
        req.params.id, pickNo);
      if (hit) return res.json({ ...JSON.parse(hit.payload), cached: true });
    }
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }

    const targets = rankTargets(state, 12);
    const { my_team, positions, on_the_clock, runs, draft } = state;

    const rosterLine = my_team.picks.length
      ? my_team.picks.map(p => `Rd${Math.ceil(p.pick_number / draft.team_count)} ${p.position} ${p.name} (${p.team_abbr ?? 'FA'})`).join(', ')
      : '(empty — this is my first pick)';
    const needLine = Object.entries(my_team.needs.starters)
      .filter(([, n]) => n > 0).map(([pos, n]) => `${pos} x${n}`).join(', ') || 'starting lineup is full';
    // Full scouting dossiers for the realistic shortlist — camp reporting, health,
    // experience and real production, so the read is grounded in this season's data
    // rather than in a player's reputation.
    const shortlist = dossiersFor(targets.slice(0, 6).map(t => t.player_id));
    const rankOf = new Map(targets.map(t => [t.player_id, t]));
    const boardLine = shortlist.map(dsr => {
      const t = rankOf.get(dsr.player_id) ?? {};
      const bits = [
        `${dsr.name} — ${dsr.position}, ${dsr.team ?? 'FA'}, board #${t.board_rank}, bye ${dsr.bye_week ?? '?'}`,
        dsr.rookie ? '  ROOKIE (no NFL snaps)'
          : `  ${dsr.experience_years ?? '?'} yrs in the league${dsr.draft_capital ? `, drafted ${dsr.draft_capital}` : ''}${dsr.pro_bowls ? `, ${dsr.pro_bowls}x Pro Bowl` : ''}${dsr.all_pro ? `, ${dsr.all_pro}x first-team All-Pro` : ''}`,
        dsr.projected_points != null
          ? `  2026 projection: ${Math.round(dsr.projected_points)} pts${dsr.projected_line ? ` (${dsr.projected_line})` : ''}`
          : '  2026 projection: none',
        dsr.last_season
          ? `  2025 actual: ${dsr.last_season.points} pts${dsr.last_season.games ? ` in ${dsr.last_season.games} games` : ''}${dsr.last_season.line ? ` (${dsr.last_season.line})` : ''}`
          : '  2025 actual: no meaningful production',
        dsr.prior_season ? `  2024 actual: ${dsr.prior_season.points} pts` : null,
        dsr.injury_flag ? '  FLAGGED as an injury risk by the market' : null,
        dsr.injury_report ? `  Injury report: ${dsr.injury_report}` : null,
        dsr.camp_news.length
          ? dsr.camp_news.map(n => `  Camp (${n.date}): ${n.headline} — ${n.note}`).join('\n')
          : '  Camp: nothing reported on him this summer',
        t.gone_by_next != null ? `  ${Math.round(t.gone_by_next * 100)}% chance he is gone before my next pick` : null
      ].filter(Boolean).join('\n');
      return bits;
    }).join('\n\n');

    const posLine = ['QB', 'RB', 'WR', 'TE'].map(pos => {
      const p = positions[pos] ?? {};
      return `${pos}: rostered ${p.rostered ?? 0}, starters still needed ${p.starters_needed ?? 0}, `
        + `best available ${p.best ?? '—'}, likely still there next turn ${p.fallback ?? '—'}`
        + (p.cost_of_waiting != null ? `, waiting costs ~${Math.round(p.cost_of_waiting)} pts` : '');
    }).join('\n');

    const msg = await callClaude({
      feature: 'draft-advice',
      maxTokens: 3000,
      prompt: `You are advising me live, on the clock, in a ${draft.team_count}-team PPR fantasy football draft. Be decisive and brief — I have ${draft.pick_seconds ?? 90} seconds.

SITUATION
Pick ${on_the_clock.pick_number} overall (round ${on_the_clock.round}), I draft from slot ${draft.my_slot}.
My next picks after this one: ${on_the_clock.my_upcoming_picks.slice(1).join(', ') || 'none'}.
Starting lineup this league requires: ${Object.entries(draft.roster_slots).map(([k, v]) => `${v} ${k}`).join(', ')}.

MY ROSTER SO FAR
${rosterLine}
Starting slots still unfilled: ${needLine}

POSITION READ
${posLine}
${runs.length ? `Active runs: ${runs.map(x => `${x.taken} ${x.position}s in the last ${x.of} picks`).join('; ')}` : 'No positional run in progress.'}

BEST AVAILABLE — scouting dossiers, in my model's order
${boardLine}

Work only from the players and the data above; do not bring in anyone already off the board, and do not assert anything the dossier does not support. Where the data is silent on a player, say so rather than filling the gap.

Respond with ONLY JSON:
{"pick":"the one player I should take right now",
 "why":"two sentences max — cite my roster hole or the scarcity, concretely",
 "players":[
   {"name":"...",
    "pros":"2-3 sentences: what makes him worth the pick — last season's production, the projected role, pedigree, situation",
    "cons":"2-3 sentences: the real risk — injury, camp reporting, age or inexperience, competition for touches, a bad projection relative to cost",
    "camp":"one line on how camp has gone for him, or 'nothing reported' if the dossier is silent",
    "status":"healthy | injury risk | rookie | bounce-back | ageing — whichever single label fits best",
    "verdict":"take | fine here | let him go"}
 ],
 "position_priority":"which positions to attack over my next 2-3 picks, and why, in one sentence",
 "next_turn_outlook":"one sentence on what should still be there at my next pick"}

Give a "players" entry for every player in the dossier list above, in the same order.`
    });
    const out = parseJson(msg);
    const payload = { ...out, pick_number: pickNo, generated_at: new Date().toISOString() };
    run(`INSERT INTO draft_advice (draft_id, pick_number, payload) VALUES (?,?,?)
         ON CONFLICT(draft_id, pick_number) DO UPDATE SET payload = excluded.payload,
           created_at = datetime('now')`,
      Number(req.params.id), pickNo, JSON.stringify(payload));
    res.json(payload);
  } catch (e) { next(e); }
});

export default r;
