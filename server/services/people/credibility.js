/**
 * CRED-01: per-manager credibility. Do this person's words turn into actions?
 *
 * For every statement type x manager x window (7d / 21d): follow-through rate =
 * P(matching action within the window) / the same manager's base rate for that
 * action, shrunk toward the league-pooled lift. That ratio is the WEIGHT a
 * statement of that type from that manager gets downstream (counterpart model,
 * suggested targets, Coach). One producer: this file (FIELD-REGISTRY.md
 * `people.credibility`).
 *
 * The follow-through counts are a port of the PEOPLE-LAB method (R&D,
 * rnd/meta/people-lab-code analyze.py M1 + M4), which is what the proven
 * numbers came from:
 *   - own-player talk (SHOP, FRUSTRATED, UNTOUCHABLE, HYPE about his own
 *     player): did that player leave his roster in the window, vs every other
 *     player on his roster at that moment?
 *   - WANT_PLAYER (a player he does not own): did he acquire that player, vs
 *     every other player on another roster at that moment? (17x, the M4 signal)
 *   - HYPE about a player he does not own: acquired or in a proposal.
 *   - WANT_POS: was his next acquisition at that position, vs his other
 *     acquisitions (league's when he has fewer than 5)?
 *
 * AS-OF. Every run is stamped with `as_of` = the latest statement / action at
 * or before the requested cut. Only statements and actions at or before it are
 * read, and a statement counts only once its whole window has elapsed by then,
 * so a backtest reading the row for time T never sees anything after T.
 *
 * STATUS / WEIGHT (what a consumer multiplies by):
 *   unknown        no statement of that type from him: weight null. A quiet
 *                  manager is unknown, never neutral.
 *   proven         the league-pooled lift clears the lab's bar (n >= 10,
 *                  >= 3 managers, clustered 95% CI excludes 1) and an exact
 *                  binomial test on the pooled counts (p < 0.05): weight =
 *                  his shrunk lift.
 *   manager_split  league not proven, but his own record is (n >= 8,
 *                  exact binomial p < 0.05 against his base rate): weight =
 *                  his shrunk lift. This is the "credible for one roster,
 *                  noise for another" SHOP case.
 *   noise          neither: weight 1 (the statement moves nothing).
 * A type that stops following through drops out of `proven` on the next run.
 *
 * Labels only. Nothing here reads or stores message text; statements arrive as
 * (speaker roster, time, type, player ids, position) tuples.
 */

export const METHOD_VERSION = 'cred-01.v1';
export const WINDOWS_DAYS = [7, 21];
/** Pseudo-statements of league-level evidence each manager's rate is pulled toward. */
export const PRIOR_STRENGTH = 10;
export const BOOTSTRAP_DRAWS = 2000;
const BOOTSTRAP_SEED = 20260923;
const DAY_MS = 86_400_000;

/**
 * Statement types this producer grades, and the action each one predicts.
 * `label` is the PEOPLE-LAB statement label it is built from; `own` filters on
 * the label's `own` flag (1 = about his own player) where the lab did.
 */
export const STATEMENT_TYPES = {
  WANT_PLAYER: { label: 'WANT_PLAYER', subject: 'other', outcome: 'acquired' },
  SHOP: { label: 'SHOP', subject: 'own', outcome: 'left_roster' },
  FRUSTRATED: { label: 'FRUSTRATED', subject: 'own', outcome: 'left_roster' },
  UNTOUCHABLE: { label: 'UNTOUCHABLE', subject: 'own', outcome: 'left_roster' },
  HYPE_OWN: { label: 'HYPE', subject: 'own', outcome: 'left_roster', skipOwn: 0 },
  HYPE_OTHER: { label: 'HYPE', subject: 'other', outcome: 'acquired_or_proposed', skipOwn: 1 },
  WANT_POS: { label: 'WANT_POS', subject: 'pos', outcome: 'next_acquisition_at_pos' },
};

/** ESPN / chat timestamps, read the way the lab read them: first 19 chars, as UTC, second precision. */
export function parseTs(s) {
  if (s == null || s === '') return null;
  const ms = Date.parse(`${String(s).replace(/Z$/, '').slice(0, 19)}Z`);
  return Number.isFinite(ms) ? ms : null;
}
const iso = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';

// ---------------------------------------------------------------- actions

function sortStable(moves) { return moves.sort((a, b) => a.t - b.t); }

/** Rosters (team -> Set(player)) after replaying every move at or before `when`. `moves` sorted by t. */
export function rosterAt(moves, when) {
  const r = new Map();
  for (const m of moves) {
    if (m.t > when) break;
    if (m.from) r.get(m.from)?.delete(m.player);
    if (m.to) { if (!r.has(m.to)) r.set(m.to, new Set()); r.get(m.to).add(m.player); }
  }
  return r;
}

/**
 * Moves, proposals and the players whose moves could not be reconstructed,
 * from raw ESPN transactions (a port of the lab's actions.py#build).
 * `txRows` = league_transactions_raw rows for one league-season in table order;
 * `latestSnapshot` = Map(player -> team) from the latest roster snapshot.
 */
export function buildActions(txRows, latestSnapshot = new Map()) {
  const rows = txRows.map(r => ({ ...r, items: JSON.parse(r.items_json || '[]'), pa: parseTs(r.proposed_at), pr: parseTs(r.processed_at) }));
  const moves = [];
  const proposals = new Map();
  const seenExec = new Set();
  const tradeKey = items => JSON.stringify(items.map(i => [i.playerId, i.fromTeamId, i.toTeamId])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
  const pushItems = (t, items) => {
    for (const it of items) {
      if (it.type === 'TRADE') moves.push({ t, player: it.playerId, from: it.fromTeamId, to: it.toTeamId, kind: 'trade' });
      else if (it.type === 'DROP') moves.push({ t, player: it.playerId, from: it.fromTeamId, to: 0, kind: 'drop' });
      else if (it.type === 'ADD') moves.push({ t, player: it.playerId, from: 0, to: it.toTeamId, kind: 'add' });
    }
  };
  for (const r of rows) {
    const t = r.pa;
    if (r.type === 'DRAFT') {
      for (const it of r.items) moves.push({ t, player: it.playerId, from: 0, to: it.toTeamId, kind: 'draft' });
    } else if ((r.type === 'FREEAGENT' || r.type === 'WAIVER') && r.status === 'EXECUTED') {
      for (const it of r.items) {
        if (it.type === 'ADD') moves.push({ t: r.pr ?? t, player: it.playerId, from: 0, to: it.toTeamId, kind: 'add' });
        else if (it.type === 'DROP') moves.push({ t: r.pr ?? t, player: it.playerId, from: it.fromTeamId, to: 0, kind: 'drop' });
      }
    } else if (r.type === 'TRADE_ACCEPT' && (r.status === 'EXECUTED' || r.status === 'PENDING') && r.items.length) {
      const key = tradeKey(r.items);
      if (!seenExec.has(key)) { seenExec.add(key); pushItems(r.pr ?? t, r.items); }
    } else if (r.type === 'TRADE_PROPOSAL') {
      const tr = r.items.filter(i => i.type === 'TRADE');
      const teams = new Set(tr.flatMap(i => [i.fromTeamId, i.toTeamId]));
      const other = [...teams].filter(x => x !== r.team_id);
      proposals.set(r.tx_id, {
        tx: r.tx_id, t, proposer: r.team_id, counter: other.length === 1 ? other[0] : null,
        incoming: new Set(tr.filter(i => i.toTeamId === r.team_id).map(i => i.playerId)),
        outgoing: new Set(tr.filter(i => i.fromTeamId === r.team_id).map(i => i.playerId)),
      });
    }
  }
  // Proposals accepted (and not cancelled, not vetoed) execute with the proposal's items.
  const byRel = new Map();
  for (const r of rows) if (r.related_tx_id) { if (!byRel.has(r.related_tx_id)) byRel.set(r.related_tx_id, []); byRel.get(r.related_tx_id).push(r); }
  const proposalItems = new Map(rows.filter(r => r.type === 'TRADE_PROPOSAL').map(r => [r.tx_id, r.items]));
  for (const [rel, rs] of byRel) {
    const acc = rs.filter(r => r.type === 'TRADE_ACCEPT');
    if (!acc.length || rs.some(r => r.type === 'TRADE_ACCEPT' && r.status === 'CANCELED')) continue;
    const vetoes = rs.filter(r => r.type === 'TRADE_VETO').length;
    const upholds = rs.filter(r => r.type === 'TRADE_UPHOLD').length;
    if (vetoes > upholds) continue;
    let items = acc.find(r => r.items.length)?.items ?? proposalItems.get(rel) ?? [];
    items = items.filter(i => i.type === 'TRADE' || i.type === 'DROP' || i.type === 'ADD');
    if (!items.length) continue;
    const key = tradeKey(items.filter(i => i.type === 'TRADE'));
    if (seenExec.has(key)) continue;
    seenExec.add(key);
    const te = Math.max(...rs.filter(r => r.type === 'TRADE_UPHOLD' || r.type === 'TRADE_ACCEPT').map(r => r.pr ?? r.pa));
    pushItems(te, items);
  }
  sortStable(moves);
  // ESPN's activity feed drops some accept rows. A player whose replayed owner
  // disagrees with the latest snapshot is moved at the latest matching proposal
  // (a lower bound on the time); with no matching proposal he is excluded.
  const unknown = new Set();
  const inferred = [];
  const own = new Map();
  for (const [tm, ps] of rosterAt(moves, Infinity)) for (const p of ps) own.set(p, tm);
  // No snapshot means nothing to reconcile against (not "every player vanished").
  for (const pl of latestSnapshot.size ? new Set([...latestSnapshot.keys(), ...own.keys()]) : []) {
    const f = own.get(pl) ?? 0, to = latestSnapshot.get(pl) ?? 0;
    if (f === to) continue;
    const cands = rows.filter(r => r.type === 'TRADE_PROPOSAL')
      .filter(r => r.items.some(i => i.type === 'TRADE' && i.playerId === pl && i.fromTeamId === f && i.toTeamId === to))
      .map(r => r.pa).sort((a, b) => a - b);
    if (cands.length && f && to) { moves.push({ t: cands.at(-1), player: pl, from: f, to, kind: 'trade' }); inferred.push(pl); }
    else unknown.add(pl);
  }
  sortStable(moves);
  const replyTimes = rows.filter(r => r.related_tx_id && ['TRADE_ACCEPT', 'TRADE_DECLINE', 'TRADE_VETO'].includes(r.type)).map(r => r.pa);
  const drafts = moves.filter(m => m.kind === 'draft').map(m => m.t);
  return {
    moves, proposals: [...proposals.values()], unknown, inferred,
    // The lab's cut: the draft's minute (ESPN stamps every pick with one time, seconds after talk about it starts).
    leagueStart: drafts.length ? Math.floor(Math.min(...drafts) / 60_000) * 60_000 : null,
    dataEnd: Math.max(...moves.map(m => m.t), ...[...proposals.values()].map(p => p.t), ...replyTimes),
  };
}

/** The same actions as they were known at `asOf` (ms). */
export function actionsAsOf(actions, asOf) {
  if (asOf == null || asOf >= actions.dataEnd) return actions;
  const moves = actions.moves.filter(m => m.t <= asOf);
  const proposals = actions.proposals.filter(p => p.t <= asOf);
  return { ...actions, moves, proposals, dataEnd: Math.max(...moves.map(m => m.t), ...proposals.map(p => p.t)) };
}

// ---------------------------------------------------------------- follow-through counts

/**
 * Per statement type x window x speaker: [hits, n, base_hits, base_n] plus the
 * statement count (the lab's `n`, which counts every graded player mention).
 * `statements`: [{ spk, t (ms), type (lab label), players?, pos?, own? }].
 */
export function followThrough(statements, actions, { windowsDays = WINDOWS_DAYS, excludeSpeakers = [], asOf = null } = {}) {
  const a = actionsAsOf(actions, asOf);
  const end = a.dataEnd;
  const start = a.leagueStart ?? -Infinity;
  const skip = new Set(excludeSpeakers.map(Number));
  const stmts = statements.filter(s => s.t <= end && s.t >= start && !skip.has(Number(s.spk)));
  const { moves, proposals, unknown } = a;
  const posOf = a.positions ?? new Map();
  const ownerCache = new Map();
  const ownerAt = t => {
    if (!ownerCache.has(t)) {
      const r = rosterAt(moves, t); const o = new Map();
      for (const [tm, ps] of r) for (const p of ps) o.set(p, tm);
      ownerCache.set(t, { r, o });
    }
    return ownerCache.get(t);
  };
  const leftRoster = (p, team, t0, t1) => moves.some(m => m.t > t0 && m.t <= t1 && m.player === p && m.from === team);
  const acquired = (team, t0, t1) => moves.filter(m => m.t > t0 && m.t <= t1 && m.to === team && (m.kind === 'add' || m.kind === 'trade'));
  const proposedIncoming = (team, t0, t1) => {
    const inc = new Set();
    for (const p of proposals) {
      if (!(p.t > t0 && p.t <= t1)) continue;
      if (p.proposer === team) for (const x of p.incoming) inc.add(x);
      else if (p.counter === team) for (const x of p.outgoing) inc.add(x);
    }
    return inc;
  };
  const posMatch = (pl, want) => {
    const pp = posOf.get(pl);
    if (want === 'FLEX') return ['RB', 'WR', 'TE'].includes(pp);
    if (want === 'DST') return ['DEF', 'DST', 'D/ST'].includes(pp);
    return pp === want;
  };
  const allAcq = new Map();
  for (const m of moves) if ((m.kind === 'add' || m.kind === 'trade') && m.to) {
    if (!allAcq.has(m.to)) allAcq.set(m.to, []); allAcq.get(m.to).push(m);
  }

  const out = {};
  for (const [type, spec] of Object.entries(STATEMENT_TYPES)) {
    out[type] = {};
    for (const wd of windowsDays) {
      const W = wd * DAY_MS;
      const groups = new Map();
      let n = 0;
      const g = spk => { if (!groups.has(spk)) groups.set(spk, [0, 0, 0, 0]); return groups.get(spk); };
      for (const s of stmts) {
        if (s.type !== spec.label || s.t + W > end) continue;
        if (spec.skipOwn != null && s.own === spec.skipOwn) continue;
        const t0 = s.t, t1 = s.t + W;
        if (spec.subject === 'own') {
          const { r, o } = ownerAt(s.t);
          for (const p of s.players ?? []) {
            if (o.get(p) !== s.spk || unknown.has(p)) continue;
            n += 1; const x = g(s.spk);
            x[0] += leftRoster(p, s.spk, t0, t1) ? 1 : 0; x[1] += 1;
            const others = [...(r.get(s.spk) ?? [])].filter(q => q !== p && !unknown.has(q));
            x[2] += others.filter(q => leftRoster(q, s.spk, t0, t1)).length; x[3] += others.length;
          }
        } else if (spec.subject === 'other') {
          const { r, o } = ownerAt(s.t);
          const hit = new Set(acquired(s.spk, t0, t1).map(m => m.player));
          if (spec.outcome === 'acquired_or_proposed') for (const x of proposedIncoming(s.spk, t0, t1)) hit.add(x);
          const cand = [];
          for (const [tm, ps] of r) if (tm !== s.spk) for (const q of ps) if (!unknown.has(q)) cand.push(q);
          const candHits = cand.filter(q => hit.has(q)).length;
          for (const p of s.players ?? []) {
            if (o.get(p) === s.spk || unknown.has(p)) continue;
            n += 1; const x = g(s.spk);
            const self = hit.has(p) ? 1 : 0;
            // Baseline = every player on another roster; p's own hit is left out of the numerator (the lab's convention).
            x[0] += self; x[1] += 1;
            x[2] += candHits - (cand.includes(p) ? self : 0); x[3] += cand.length;
          }
        } else if (spec.subject === 'pos') {
          if (!s.pos) continue;
          const mine = allAcq.get(s.spk) ?? [];
          const ev = mine.filter(m => m.t > t0 && m.t <= t1).sort((a1, b1) => a1.t - b1.t || a1.player - b1.player);
          if (!ev.length) continue;
          const hit = posMatch(ev[0].player, s.pos);
          let other = mine.filter(m => !(m.t > t0 && m.t <= t1)).map(m => m.player);
          if (other.length < 5) other = [...allAcq.values()].flat().filter(m => !(m.t > t0 && m.t <= t1)).map(m => m.player);
          const base = other.filter(q => posMatch(q, s.pos)).length / Math.max(other.length, 1);
          n += 1; const x = g(s.spk);
          x[0] += hit ? 1 : 0; x[1] += 1; x[2] += base; x[3] += 1;
        }
      }
      out[type][wd] = { n, groups };
    }
  }
  return { asOf: end, counts: out };
}

// ---------------------------------------------------------------- statistics

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** numpy-style linear-interpolated percentile. */
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function pooledLift(arr) {
  let ns = 0, ds = 0, nb = 0, db = 0;
  for (const [a, b, c, d] of arr) { ns += a; ds += b; nb += c; db += d; }
  const rs = ns / Math.max(ds, 1e-9), rb = nb / Math.max(db, 1e-9);
  return { rate: rs, base: rb, lift: rb > 0 ? rs / rb : NaN };
}

/** League-pooled lift with a manager-clustered bootstrap 95% CI (the lab's clustered_ratio). */
export function clusteredLift(groups, { draws = BOOTSTRAP_DRAWS, seed = BOOTSTRAP_SEED } = {}) {
  const arr = [...groups.values()];
  const point = pooledLift(arr);
  const rnd = mulberry32(seed);
  const boots = [];
  for (let i = 0; i < draws; i++) {
    const sample = arr.map(() => arr[Math.floor(rnd() * arr.length)]);
    const { lift } = pooledLift(sample);
    if (Number.isFinite(lift)) boots.push(lift);
  }
  boots.sort((x, y) => x - y);
  return { ...point, ci: boots.length ? [percentile(boots, 0.025), percentile(boots, 0.975)] : null };
}

/** Exact two-sided binomial p (sum of outcomes no likelier than the observed one). */
export function binomialTwoSided(k, n, p) {
  if (n <= 0) return 1;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  const pmf = new Array(n + 1);
  let logC = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    pmf[i] = Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  const obs = pmf[Math.round(k)] * (1 + 1e-7);
  return Math.min(1, pmf.reduce((acc, v) => acc + (v <= obs ? v : 0), 0));
}

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/**
 * Rows for one (type, window): a league row (roster_id '*') plus one row per
 * roster in `rosters`, each manager's statement rate shrunk toward his own
 * base rate x the league lift with PRIOR_STRENGTH pseudo-statements.
 */
export function shrinkGroup(type, windowDays, { n, groups }, rosters, { priorStrength = PRIOR_STRENGTH } = {}) {
  const spec = STATEMENT_TYPES[type];
  const withData = new Map([...groups].filter(([, v]) => v[1] > 0 || v[3] > 0));
  const speakers = [...withData].filter(([, v]) => v[1] > 0).length;
  const league = withData.size ? clusteredLift(withData) : { rate: NaN, base: NaN, lift: NaN, ci: null };
  // The lab's bar, plus an exact test on the pooled counts: with few clusters and zero hits
  // the bootstrap CI collapses to [0, 0] and would "prove" a lift of 0 from 11 statements.
  const totHits = [...withData.values()].reduce((acc, v) => acc + v[0], 0);
  const totN = [...withData.values()].reduce((acc, v) => acc + v[1], 0);
  const pooledP = Number.isFinite(league.base) && league.base > 0 ? binomialTwoSided(totHits, totN, Math.min(league.base, 1)) : null;
  const proven = n >= 10 && speakers >= 3 && league.ci != null && (league.ci[0] > 1 || league.ci[1] < 1)
    && pooledP != null && pooledP < 0.05;
  const leagueLift = Number.isFinite(league.lift) ? league.lift : 1;
  const common = {
    stmt_type: type, window_days: windowDays, outcome: spec.outcome,
    league_lift: r4(league.lift), league_ci_lo: r4(league.ci?.[0]), league_ci_hi: r4(league.ci?.[1]),
    league_n: n, league_managers: speakers,
  };
  const out = [{
    ...common, roster_id: '*', n_statements: n,
    hits: r4(totHits), base_hits: null, base_n: null,
    rate: r4(league.rate), base_rate: r4(league.base), lift_raw: r4(league.lift), lift_shrunk: r4(league.lift),
    p_value: r4(pooledP), status: speakers === 0 ? 'unknown' : proven ? 'proven' : 'noise',
    weight: speakers === 0 ? null : proven ? r4(league.lift) : 1,
  }];
  for (const roster of rosters) {
    const v = groups.get(roster) ?? [0, 0, 0, 0];
    const [hits, cnt, bh, bn] = v;
    if (cnt === 0) {
      out.push({ ...common, roster_id: String(roster), n_statements: 0, hits: 0, base_hits: r4(bh), base_n: r4(bn),
        rate: null, base_rate: bn > 0 ? r4(bh / bn) : null, lift_raw: null, lift_shrunk: null,
        p_value: null, status: 'unknown', weight: null });
      continue;
    }
    const ownBase = bn > 0 ? bh / bn : 0;
    const base = ownBase > 0 ? ownBase : (Number.isFinite(league.base) && league.base > 0 ? league.base : null);
    const rate = hits / cnt;
    let liftShrunk = null, liftRaw = null, p = null;
    if (base != null) {
      const prior = Math.min(1, base * leagueLift);
      liftShrunk = ((hits + priorStrength * prior) / (cnt + priorStrength)) / base;
      liftRaw = rate / base;
      p = binomialTwoSided(hits, cnt, Math.min(base, 1));
    }
    const split = !proven && cnt >= 8 && p != null && p < 0.05;
    const status = proven ? 'proven' : split ? 'manager_split' : 'noise';
    out.push({ ...common, roster_id: String(roster), n_statements: cnt, hits: r4(hits), base_hits: r4(bh), base_n: r4(bn),
      rate: r4(rate), base_rate: r4(base), lift_raw: r4(liftRaw), lift_shrunk: r4(liftShrunk), p_value: r4(p), status,
      weight: status === 'noise' ? 1 : r4(liftShrunk) });
  }
  return out;
}

/** Every row for one run. `rosters` = the managers to report on (Nick's own roster excluded by the caller). */
export function computeCredibility(statements, actions, { rosters, excludeSpeakers = [], asOf = null, windowsDays = WINDOWS_DAYS } = {}) {
  const ft = followThrough(statements, actions, { windowsDays, excludeSpeakers, asOf });
  const rows = [];
  for (const [type, byWindow] of Object.entries(ft.counts)) {
    for (const wd of windowsDays) rows.push(...shrinkGroup(type, wd, byWindow[wd], rosters));
  }
  return { as_of: iso(ft.asOf), method_version: METHOD_VERSION, rows };
}

// ---------------------------------------------------------------- storage + readers

const COLS = ['league_id', 'as_of', 'method_version', 'roster_id', 'stmt_type', 'window_days', 'outcome',
  'n_statements', 'hits', 'base_hits', 'base_n', 'rate', 'base_rate', 'lift_raw', 'lift_shrunk',
  'league_lift', 'league_ci_lo', 'league_ci_hi', 'league_n', 'league_managers', 'p_value', 'status', 'weight', 'computed_at'];

/** Upsert one run's rows (idempotent for the same as_of + method). Returns the row count. */
export function storeCredibility(database, leagueId, run, { computedAt = new Date().toISOString() } = {}) {
  const stmt = database.prepare(`INSERT INTO people_credibility (${COLS.join(', ')})
    VALUES (${COLS.map(() => '?').join(', ')})
    ON CONFLICT (league_id, as_of, method_version, roster_id, stmt_type, window_days) DO UPDATE SET
    ${COLS.slice(6).map(c => `${c} = excluded.${c}`).join(', ')}`);
  database.exec('BEGIN');
  try {
    for (const r of run.rows) {
      const v = { ...r, league_id: Number(leagueId), as_of: run.as_of, method_version: run.method_version, computed_at: computedAt };
      stmt.run(...COLS.map(c => v[c] ?? null));
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return run.rows.length;
}

/**
 * The credibility table as known at `asOf` (default: latest): the newest run
 * with as_of <= asOf. Shape: { as_of, method_version, league: {type: {window: row}},
 * rosters: {roster_id: {type: {window: row}}} }, or null when nothing is stored.
 */
export function readCredibility(database, leagueId, { asOf = null, methodVersion = METHOD_VERSION } = {}) {
  const head = database.prepare(`SELECT MAX(as_of) AS as_of FROM people_credibility
      WHERE league_id = ? AND method_version = ? AND (? IS NULL OR as_of <= ?)`)
    .get(Number(leagueId), methodVersion, asOf, asOf);
  if (!head?.as_of) return null;
  const rows = database.prepare(`SELECT * FROM people_credibility WHERE league_id = ? AND method_version = ? AND as_of = ?`)
    .all(Number(leagueId), methodVersion, head.as_of);
  const out = { as_of: head.as_of, method_version: methodVersion, league: {}, rosters: {} };
  for (const r of rows) {
    const bucket = r.roster_id === '*' ? out.league : (out.rosters[r.roster_id] ??= {});
    (bucket[r.stmt_type] ??= {})[r.window_days] = { ...r };
  }
  return out;
}

/**
 * The weight one statement type from one manager carries (1 = moves nothing),
 * or null when he has never made that kind of statement (unknown, not neutral).
 */
export function statementWeight(credibility, rosterId, type, { windowDays = 7 } = {}) {
  const row = credibility?.rosters?.[String(rosterId)]?.[type]?.[windowDays];
  return row?.weight ?? null;
}

// ---------------------------------------------------------------- loaders (live DB / chat DB / label files)

/** Raw transactions + latest snapshot + positions for one league-season. */
export function loadActions(database, leagueId, season) {
  const txRows = database.prepare(`SELECT type, status, proposed_at, processed_at, team_id, tx_id, related_tx_id, items_json
      FROM league_transactions_raw WHERE league_id = ? AND season = ?`).all(Number(leagueId), Number(season));
  const snap = new Map();
  for (const r of database.prepare(`SELECT team_id, espn_player_id FROM league_roster_snapshots
      WHERE league_id = ? AND season = ? AND on_roster = 1 AND scoring_period_id =
        (SELECT MAX(scoring_period_id) FROM league_roster_snapshots WHERE league_id = ? AND season = ?)`)
    .all(Number(leagueId), Number(season), Number(leagueId), Number(season))) snap.set(r.espn_player_id, r.team_id);
  const actions = buildActions(txRows, snap);
  const positions = new Map();
  for (const r of database.prepare('SELECT espn_player_id, position FROM league_roster_snapshots WHERE league_id = ?').all(Number(leagueId))) positions.set(r.espn_player_id, r.position);
  for (const r of database.prepare('SELECT espn_id, position FROM players WHERE espn_id IS NOT NULL').all()) {
    const id = Number(r.espn_id);
    if (!positions.has(id)) positions.set(id, r.position);
  }
  actions.positions = positions;
  return actions;
}

/**
 * Statements from PEOPLE-LAB label records ({msg_id, type, players, pos, own,
 * style, reaction, league_ref}) joined to the chat DB for speaker + time only.
 * `speakerOf(name, isFromMe)` maps a chat sender to a roster id (or null).
 * Records about another league (league_ref 'other') are dropped, duplicates
 * collapsed, as the lab did.
 */
export function statementsFromLabels(labelRecords, chatDb, speakerOf) {
  const meta = new Map();
  for (const m of chatDb.prepare(`SELECT msg_id, name, is_from_me, ts_utc FROM messages
      WHERE ts_utc >= '2026-07-01' AND is_tapback = 0`).all()) {
    meta.set(Number(m.msg_id), { spk: speakerOf(m.name, m.is_from_me === 1), t: parseTs(m.ts_utc) });
  }
  const seen = new Set();
  const out = [];
  for (const r of labelRecords) {
    const m = meta.get(Number(r.msg_id));
    if (!m) continue;
    const key = JSON.stringify([r.msg_id, r.type, r.players ?? [], r.pos ?? null, r.style ?? null, r.reaction ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.spk == null || r.league_ref === 'other') continue;
    out.push({ spk: m.spk, t: m.t, type: r.type, players: r.players ?? [], pos: r.pos ?? null, own: r.own ?? null });
  }
  return out;
}

/**
 * The `credibility(rosterId, type)` function PULSE-01's statementWeight takes
 * (server/services/people/pulse.js on #316): { lift, n, basis } for a manager
 * with a graded record, null when he is unknown for that type (PULSE then
 * falls back to its pooled priors). HYPE is split by subject here, so a bare
 * 'HYPE' is null: the caller cannot say which half it means.
 */
export function pulseCredibility(credibility, { windowDays = 7 } = {}) {
  return (rosterId, type) => {
    const row = credibility?.rosters?.[String(rosterId)]?.[type]?.[windowDays];
    if (!row || row.status === 'unknown' || row.weight == null) return null;
    return { lift: row.weight, n: row.n_statements,
      basis: `${row.status}, ${row.n_statements} statement(s), ${windowDays}d, as of ${credibility.as_of}` };
  };
}
