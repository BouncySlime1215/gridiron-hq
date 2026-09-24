/**
 * CHESS-01a: title-odds chess. Search short paths of moves (trade, then claim,
 * then flip) for the one that raises MY title odds most in expectation, where a
 * single best offer cannot.
 *
 * findTradeSequences' two-step greedy takes today's #1 idea and looks once more.
 * This searches instead: from today's rosters it generates three kinds of move,
 *
 *   - trade  1-for-1 or 2-for-1 (I give two, get one, which frees a roster spot),
 *   - claim  a free agent, dropping my lowest-value player if the roster is full,
 *   - flip   a trade whose give includes a player an earlier step brought in,
 *
 * and keeps a beam of the best partial paths, depth 3 by default.
 *
 * Scoring. Every node is the league's rosters after its whole path, rescored in
 * ONE season-sim world (tradeImpactWorld, the RL-19-2 fast rescore, same seed
 * and run count as every other title-odds surface) via rosterImpact. So a path
 * and a single offer are paired on the same simulated football, and the gap
 * between them carries a paired SE.
 *
 * Pricing. A trade or flip step carries today's P(accept): the midpoint of
 * acceptanceBand on that partner's counterparty read of that package, as it
 * reads today (no re-read of a hypothetical future roster). A claim carries
 * p = 1 with `p_basis: 'not_modelled'`, because rival claims are not modelled
 * here. The expected gain of a path assumes you stop at the first refusal and
 * keep what you already did:
 *
 *   EV = sum_k  P(reach k) x (delta_k - delta_{k-1}),  P(reach k) = p_1 x ... x p_k
 *
 * and paths rank on EV. A step expands only when its P(accept) is at least
 * `minPAccept`.
 *
 * Nothing here is fitted. Depth, beam width, per-node shortlist, node budget,
 * the value band and the P(accept) floor are declared defaults (CHESS_DEFAULTS).
 *
 * Default off. GRIDIRON_CHESS_ENABLED=1 turns it on; so does preview mode
 * (preview-mode.js), in which case the block carries `preview: true`.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';
import { acceptanceBand } from './trade-acceptance.js';
import { readDeal } from './counterparty-pricing.js';

export const CHESS_ENV = 'GRIDIRON_CHESS_ENABLED';
export const CHESS_OFF_REASON = 'Title-odds chess (CHESS-01a) is default-off: it is measured on a fixture '
  + 'league only, and has not beaten single trades in the replay test (CHESS-01-b) yet.';

/** Declared, not fitted. */
export const CHESS_DEFAULTS = Object.freeze({
  depth: 3,          // moves per path
  beamWidth: 6,      // partial paths kept per level
  perNode: 10,       // candidates per node that get a real rescore
  nodeBudget: 150,   // rescores per search, all levels together
  givePool: 8,       // my players (by market value) that may appear in a 2-for-1 give
  wireLimit: 10,     // free agents simulated in the world and offered as claims
  minPAccept: 0.15,  // a trade step below this is not expanded
  valueBand: [-12, 18], // their market-value gain, %, the finder's band (title-mutual.js)
  limit: 10,         // paths returned
});

/** Read per call, like every preview-converted site, so a test can flip it. */
export function chessMode() {
  if (process.env[CHESS_ENV] === '1') return { on: true, preview: false };
  if (previewUnconfirmed()) return { on: true, preview: true };
  return { on: false, preview: false };
}

/**
 * The acceptance band refuses a deal that has not passed an edge test. A chess
 * step is not judged alone: the path's own title-odds gain is its edge, and a
 * path that does not raise my odds ranks below one that does. So the band is
 * asked with that stated, never with a fabricated lineup edge.
 */
const PATH_EDGE = Object.freeze({ passes: true, failed: [], basis: 'chess_path_title_odds' });

const byValue = info => (a, b) => (info(b)?.value ?? 0) - (info(a)?.value ?? 0) || a - b;

/** Their market-value gain on a package, %: what they receive against what they give. */
export function theirValuePct(give, get, info) {
  const sum = ids => ids.reduce((s, id) => s + (info(id)?.value ?? 0), 0);
  const out = sum(get);
  return out > 0 ? +(((sum(give) - out) / out) * 100).toFixed(1) : null;
}

/** Every move from one node, before the proxy shortlist. Deterministic order. */
export function generateMoves(node, ctx, opts = CHESS_DEFAULTS) {
  const { myTeamId, info, excludeIds = new Set(), blockedPartners = new Set(), wire = [] } = ctx;
  const me = String(myTeamId);
  const mine = node.rosters.get(me) ?? [];
  const sortV = byValue(info);
  const tradable = mine.filter(id => !excludeIds.has(id)).sort(sortV);
  const givePool = tradable.slice(0, opts.givePool);
  const [lo, hi] = opts.valueBand;
  const moves = [];

  const gives = [...tradable.map(id => [id])];
  for (let i = 0; i < givePool.length; i++) {
    for (let j = i + 1; j < givePool.length; j++) gives.push([givePool[i], givePool[j]]);
  }
  const partners = [...node.rosters.keys()].filter(id => id !== me && !blockedPartners.has(id)).sort();
  for (const partner of partners) {
    const theirs = [...node.rosters.get(partner)].sort(sortV);
    for (const give of gives) {
      // An acquired player is never sent straight back to the team it came from.
      if (give.some(id => node.source.get(id) === partner)) continue;
      for (const get of theirs) {
        const pct = theirValuePct(give, [get], info);
        if (pct == null || pct < lo || pct > hi) continue;
        moves.push({ kind: give.some(id => node.source.has(id)) ? 'flip' : 'trade',
          shape: `${give.length}-for-1`, partner_id: partner, give, get: [get], their_value_pct: pct });
      }
    }
  }

  const rostered = new Set([...node.rosters.values()].flat());
  // Today's roster size is the cap: a 2-for-1 earlier in the path frees a spot a claim can fill.
  const cap = ctx.rosterCap ?? ctx.today?.get(me)?.length ?? mine.length;
  const droppable = mine.filter(id => !excludeIds.has(id)).sort(sortV).reverse();
  for (const add of wire) {
    if (rostered.has(add)) continue;
    const drop = mine.length >= cap ? droppable.find(id => id !== add) ?? null : null;
    if (mine.length >= cap && drop == null) continue;
    moves.push({ kind: 'claim', shape: drop == null ? 'add' : 'add/drop', claim: add, drop });
  }
  return moves;
}

/** A node's rosters after one move. A 2-for-1 partner drops his lowest-value other player. */
export function applyMove(node, move, ctx) {
  const me = String(ctx.myTeamId);
  const rosters = new Map(node.rosters);
  const source = new Map(node.source);
  let theirDrop = null;
  if (move.kind === 'claim') {
    rosters.set(me, [...rosters.get(me).filter(id => id !== move.drop), move.claim]);
    source.set(move.claim, 'wire');
  } else {
    const give = new Set(move.give), get = new Set(move.get);
    rosters.set(me, [...rosters.get(me).filter(id => !give.has(id)), ...move.get]);
    let theirs = [...rosters.get(move.partner_id).filter(id => !get.has(id)), ...move.give];
    if (move.give.length > move.get.length) {
      const cap = ctx.today?.get(move.partner_id)?.length ?? node.rosters.get(move.partner_id).length;
      if (theirs.length > cap) {
        theirDrop = theirs.filter(id => !give.has(id)).sort(byValue(ctx.info)).at(-1) ?? null;
        theirs = theirs.filter(id => id !== theirDrop);
      }
    }
    rosters.set(move.partner_id, theirs);
    for (const id of move.get) source.set(id, move.partner_id);
    for (const id of move.give) source.delete(id);
  }
  return { rosters, source, their_drop: theirDrop };
}

/** Only the rosters that differ from today, as rosterImpact takes them. */
function changed(rosters, today) {
  const out = new Map();
  for (const [id, ids] of rosters) {
    const was = today.get(id) ?? [];
    if (ids.length !== was.length || ids.some(p => !was.includes(p))) out.set(id, ids);
  }
  return out;
}

const signature = rosters => [...rosters].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([id, ids]) => `${id}:${[...ids].sort((x, y) => x - y).join(',')}`).join('|');

/**
 * The beam search itself. Everything league-specific comes in through `ctx`:
 *
 *   myTeamId, today (Map roster_id -> ids), info(id) -> { value, position, name },
 *   wire (free-agent ids), excludeIds, blockedPartners,
 *   score(changedRosters) -> { title_delta, title_delta_se, title_delta_clears_noise, title_runs } | { error },
 *   proxy(myIds) -> number (cheap; shortlist only),
 *   pAccept({ partner_id, give, get }) -> { p, basis } (p null: refused, never expanded),
 *   pairedSe(runsA, runsB) -> SE of mean(b - a), or null.
 */
export function chessSearch(ctx, overrides = {}) {
  const opts = { ...CHESS_DEFAULTS, ...overrides };
  const me = String(ctx.myTeamId);
  const root = { rosters: ctx.today, source: new Map(), steps: [], reach: 1, ev: 0, delta: 0, runs: null };
  const seen = new Set([signature(ctx.today)]);
  const stats = { generated: 0, priced_out: 0, nodes_scored: 0, errors: 0, budget_hit: false, first_error: null };
  const all = [];
  let beam = [root];

  for (let depth = 1; depth <= opts.depth && beam.length; depth++) {
    const children = [];
    for (const node of beam) {
      const base = ctx.proxy(node.rosters.get(me));
      const moves = generateMoves(node, ctx, opts);
      stats.generated += moves.length;
      const shortlist = moves
        .map(m => ({ m, next: applyMove(node, m, ctx) }))
        .filter(({ next }) => !seen.has(signature(next.rosters)))
        .map(x => ({ ...x, gain: ctx.proxy(x.next.rosters.get(me)) - base }))
        .sort((a, b) => b.gain - a.gain || signature(a.next.rosters).localeCompare(signature(b.next.rosters)));

      let taken = 0;
      for (const { m, next } of shortlist) {
        if (taken >= opts.perNode) break;
        if (stats.nodes_scored + stats.errors >= opts.nodeBudget) { stats.budget_hit = true; break; }
        const sig = signature(next.rosters);
        if (seen.has(sig)) continue;
        const price = m.kind === 'claim' ? { p: 1, basis: 'not_modelled' } : ctx.pAccept(m);
        if (price.p == null || price.p < opts.minPAccept) { stats.priced_out++; continue; }
        seen.add(sig);
        taken++;
        const s = ctx.score(changed(next.rosters, ctx.today));
        if (s.error) { stats.errors++; stats.first_error ??= s.error; continue; }
        stats.nodes_scored++;
        const reach = node.reach * price.p;
        const step = { n: depth, kind: m.kind, shape: m.shape,
          ...(m.kind === 'claim' ? { claim: m.claim, drop: m.drop }
            : { partner_id: m.partner_id, give: m.give, get: m.get, their_value_pct: m.their_value_pct,
              their_drop: next.their_drop }),
          p_accept: +price.p.toFixed(3), p_basis: price.basis,
          title_delta_after: s.title_delta, title_delta_se: s.title_delta_se,
          step_gain: +(s.title_delta - node.delta).toFixed(4) };
        const child = { rosters: next.rosters, source: next.source, steps: [...node.steps, step],
          reach, ev: node.ev + reach * (s.title_delta - node.delta), delta: s.title_delta,
          se: s.title_delta_se, clears: s.title_delta_clears_noise === true, runs: s.title_runs ?? null };
        children.push(child);
        all.push(child);
      }
    }
    beam = children.sort(rank).slice(0, opts.beamWidth);
  }

  const ranked = all.sort(rank);
  const bestSingle = ranked.find(n => n.steps.length === 1) ?? null;
  const shape = n => ({
    steps: n.steps,
    moves: n.steps.length,
    p_complete: +n.reach.toFixed(4),
    expected_title_delta: +n.ev.toFixed(4),
    full_title_delta: n.delta,
    full_title_delta_se: n.se,
    full_clears_noise: n.clears,
    vs_best_single: bestSingle && n !== bestSingle ? {
      expected_title_delta: +(n.ev - bestSingle.ev).toFixed(4),
      full_title_delta: +(n.delta - bestSingle.delta).toFixed(4),
      full_title_delta_se: n.runs && bestSingle.runs ? ctx.pairedSe(bestSingle.runs, n.runs) : null,
    } : null,
  });
  return { ...stats, depth: opts.depth, beam_width: opts.beamWidth, per_node: opts.perNode,
    node_budget: opts.nodeBudget, min_p_accept: opts.minPAccept,
    best_single: bestSingle ? shape(bestSingle) : null,
    paths: ranked.slice(0, opts.limit).map(shape) };
}

/** EV first, then the full-path delta, then fewer moves, then a stable key. */
function rank(a, b) {
  return b.ev - a.ev || b.delta - a.delta || a.steps.length - b.steps.length
    || signature(a.rosters).localeCompare(signature(b.rosters));
}

/**
 * Today's P(accept) for a package: the acceptance band's midpoint on this
 * partner's counterparty read of it. With no counterparty data the band says
 * so (`basis: 'no_information'`) and its midpoint is the declared start point.
 */
export function todaysPAccept(counterparties, player) {
  return ({ partner_id, give, get }) => {
    const cp = counterparties.get(String(partner_id)) ?? null;
    const theirGive = get.map(player).filter(Boolean), theirGet = give.map(player).filter(Boolean);
    const counterparty = cp
      ? { ...readDeal({ theirGive, theirGet, managerProfile: cp }), counterparty_data: true }
      : { receptiveness: 1, perception_delta: null, perception_informed: false, counterparty_data: false };
    const out = acceptanceBand({ counterparty, edge: PATH_EDGE, profile: cp?.negotiation ?? null });
    return { p: out.band?.mid ?? null, basis: out.basis };
  };
}

/**
 * The engine entry: one world, one search. `sim` is season-sim's
 * { tradeImpactWorld, rosterImpact, expectedLineupTotal, pairedTitleSe }, handed
 * in by the caller so this module never imports the simulator itself.
 *
 * A failure is reported, never swallowed: a world that cannot be built sets
 * `status: 'failed'` with the simulator's own error.
 */
export function titleChess(lg, { myTeamId, teams, assets, wire = [], counterparties = new Map(),
  excludeIds = null, blockedPartners = new Set(), mode, sim, options = {} }) {
  const opts = { ...CHESS_DEFAULTS, ...options };
  const base = { status: 'on', ...(mode.preview ? previewFields(CHESS_OFF_REASON) : {}) };
  const wireIds = [...wire].sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.id - b.id)
    .slice(0, opts.wireLimit).map(p => p.id);
  const world = sim.tradeImpactWorld(lg, { universe: wireIds });
  if (world.fail) return { ...base, status: 'failed', error: world.fail.error ?? 'season sim unavailable', paths: [] };

  const player = id => assets.get(Number(id)) ?? world.prep.assets.get(Number(id)) ?? null;
  const today = new Map(teams.map(t => [String(t.roster_id), t.players.map(p => p.id)]));
  const out = chessSearch({
    myTeamId, today, wire: wireIds, info: player,
    excludeIds: new Set([...(excludeIds ?? [])].map(Number)),
    blockedPartners: new Set([...blockedPartners].map(String)),
    score: rosters => {
      const r = sim.rosterImpact(world, { myTeamId, rosters });
      return r.error ? r : { ...r.me, title_runs: r.title_runs };
    },
    proxy: ids => sim.expectedLineupTotal(world, ids),
    pAccept: todaysPAccept(counterparties, player),
    pairedSe: sim.pairedTitleSe,
  }, opts);
  const name = id => player(id)?.name ?? String(id);
  for (const path of [out.best_single, ...out.paths].filter(Boolean)) {
    for (const s of path.steps) {
      if (s.give) { s.give_names = s.give.map(name); s.get_names = s.get.map(name); }
      if (s.claim != null) { s.claim_name = name(s.claim); s.drop_name = s.drop == null ? null : name(s.drop); }
    }
  }
  return { ...base, runs: world.runs, seed: world.key.seed, from_week: world.key.fromWeek, wire: wireIds,
    rival_claims: 'not_modelled', deadline: 'not_modelled', ...out };
}
