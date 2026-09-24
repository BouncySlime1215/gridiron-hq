/**
 * TELLS-01a: the tell library. Computes the Tells Factory's tells for every roster of a
 * league from engine_events, as of a timestamp.
 *
 * It is a line-for-line port of the generator in scripts/rnd/tells-factory.py
 * (`build_arm_a` for this-season tells, `build_prev_season` for arm B prior-season tells).
 * test/tells-library.test.js pins every template to the Python values on a 3-team synthetic
 * fixture (test/fixtures/tells-golden-values.json, written by `tells-factory.py --golden`).
 *
 * Input: engine_events-shaped rows { event_type, as_of, league_id, team_id, payload }.
 *   - TELL_EVENT_TYPES.transaction ('league.transaction'), payload
 *       { week, type: 'free_agent'|'waiver'|'trade', status: 'complete'|'failed',
 *         roster_ids, adds: {playerId: rosterId}, drops: {playerId: rosterId},
 *         bid, picks (count of draft picks moved), latency_ms }
 *     The event's as_of is the moment the move was made (the generator's created_ms).
 *   - TELL_EVENT_TYPES.teamWeek ('league.team_week'), team_id = roster, payload
 *       { week, points, opp (opponent roster or null), starters ('0' = empty slot), players }
 *     The event's as_of is when that week's lineup and result became final.
 * An adapter that turns ESPN / Sleeper streams into these two types is TELLS-01b's job; the
 * types are not registered with the engine registry by this module.
 *
 * As-of safety: every event with as_of later than `asOf` is dropped before anything is
 * computed, so an event one second after `asOf` cannot change a tell. Pure: no I/O, no writes.
 */

export const TELL_EVENT_TYPES = Object.freeze({ transaction: 'league.transaction', teamWeek: 'league.team_week' });
export const LIBRARY_VERSION = 'tells-01a.1'; // = FACTORY_VERSION of the generator it ports

const FAMS_BASE = ['ADD_FA', 'CLAIM_WON', 'CLAIM_FAIL', 'CLAIM_ALL', 'DROP', 'ADD_ANY'];
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
export const ALL_FAMS = [...FAMS_BASE.flatMap(f => ['ALL', ...POSITIONS].map(p => `${f}:${p}`)), 'TRADE:ALL'].sort();
export const WIN = { w13: [1, 2, 3], w46: [4, 5, 6], w16: [1, 2, 3, 4, 5, 6] };
const EVENT_STATS = ['night', 'sun', 'montue', 'wedthu', 'frisat', 'medhour', 'burst'];
const CLAIM_STATS = ['loglat', 'lastlat', 'bid', 'prem'];
export const LINEUP_STATS = ['lu_changed', 'lu_empty', 'lu_kdef_stream', 'ro_QB', 'ro_RB', 'ro_WR', 'ro_TE', 'ro_K',
  'ro_DEF', 'ro_bench'];
export const PREV_TELLS = ['n_trades', 'n_trade_partners', 'trades_with_picks', 'uneven_trades', 'players_recv',
  'players_sent', 'n_start_trade', 'trades_early', 'trades_late', 'any_trade', 'n_adds', 'n_fail_claims', 'win_pct',
  'drops'];

/** Every candidate tell id the factory screens (1,504 arm A + 14 arm B), in a stable order. */
export const TELL_IDS = Object.freeze([
  ...Object.keys(WIN).flatMap(w => ALL_FAMS.flatMap(f => [
    ...['rate', 'active', ...EVENT_STATS].map(s => `${f}|${s}|${w}`),
    ...(f.startsWith('CLAIM') ? CLAIM_STATS.map(s => `${f}|${s}|${w}`) : []),
  ])),
  ...ALL_FAMS.map(f => `${f}|afterloss|w26`),
  ...Object.keys(WIN).flatMap(w => LINEUP_STATS.map(s => `LINEUP|${s}|${w}`)),
  ...['recv', 'sent', 'uneven', 'picks'].map(s => `TRADESHAPE|${s}|w16`),
  ...['ALL', ...POSITIONS].flatMap(p => ['tenure', 'origshare'].map(s => `DROPTEN:${p}|${s}|w16`)),
  ...PREV_TELLS.map(s => `PREV|${s}`),
]);

// ------------------------------------------------------------------ small numeric helpers (pandas semantics)
const isNum = v => typeof v === 'number' && !Number.isNaN(v);
function mean(xs) {
  let s = 0; let n = 0;
  for (const x of xs) if (isNum(x)) { s += x; n += 1; }
  return n ? s / n : NaN;
}
function median(xs) {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const toNum = v => (v == null || v === '' ? NaN : Number(v));
const out = v => (isNum(v) ? v : null);

/** The generator's position rule (tells-factory.py pos_fn): letters only = a team defense. */
export function positionOf(positions) {
  return pid => {
    const s = String(pid);
    if (/^\p{L}+$/u.test(s)) return 'DEF';
    const p = positions instanceof Map ? positions.get(s) : positions?.[s];
    if (POSITIONS.includes(p)) return p;
    if (p === 'PK') return 'K';
    return null;
  };
}

/** Fixed UTC-4 clock, as the generator (prereg honesty note). Monday = 0. */
function etHourDow(ms) {
  const et = ms / 1000 - 4 * 3600;
  const r = ((et % 86400) + 86400) % 86400;
  return { hour: r / 3600, dow: ((Math.floor(et / 86400) + 3) % 7 + 7) % 7 };
}

// ------------------------------------------------------------------ engine_events -> canonical records
function normTime(t) {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`tells: "${t}" is not a timestamp`);
  return ms;
}

/**
 * Split engine events into the generator's canonical records, keeping only events with
 * as_of <= asOf. `asOf` is required: a read with no cutoff can see the future.
 */
export function canonicalRecords(events, { asOf }) {
  if (asOf == null) throw new Error('tells: asOf is required');
  const cut = normTime(asOf);
  const tx = []; const tw = [];
  for (const e of events ?? []) {
    const t = normTime(e.as_of);
    if (t > cut) continue;
    const p = e.payload ?? {};
    if (e.event_type === TELL_EVENT_TYPES.transaction) {
      tx.push({ lg: e.league_id, week: Number(p.week), type: p.type, status: p.status, roster_ids: p.roster_ids ?? [],
        adds: p.adds ?? {}, drops: p.drops ?? {}, bid: toNum(p.bid), picks: p.picks ?? 0, ms: t, lat: toNum(p.latency_ms) });
    } else if (e.event_type === TELL_EVENT_TYPES.teamWeek) {
      tw.push({ lg: e.league_id, roster: Number(e.team_id), week: Number(p.week), points: toNum(p.points),
        opp: p.opp == null ? null : Number(p.opp), st: p.starters ?? [], pl: p.players ?? [] });
    }
  }
  return { tx, tw };
}

// ------------------------------------------------------------------ generator pieces (tells-factory.py)
/** events_from_tx: move events (one per player moved) and trade sides. */
function eventsFromTx(tx, pos) {
  const ev = []; const trades = [];
  for (const r of tx) {
    const adds = r.adds ?? {}; const drops = r.drops ?? {};
    if (r.type === 'trade') {
      if (r.status !== 'complete') continue;
      for (const rid of r.roster_ids ?? []) {
        const nr = Object.values(adds).filter(v => v === rid).length;
        const ns = Object.values(drops).filter(v => v === rid).length;
        trades.push({ lg: r.lg, roster: rid, week: r.week, nr, ns, picks: (r.picks ?? 0) > 0 ? 1 : 0, ms: r.ms,
          partners: (r.roster_ids ?? []).filter(x => x !== rid) });
      }
      continue;
    }
    const lat = r.type === 'waiver' ? toNum(r.lat) : NaN;
    const bid = r.type === 'waiver' ? toNum(r.bid) : NaN;
    let famAdd;
    if (r.type === 'free_agent' && r.status === 'complete') famAdd = 'ADD_FA';
    else if (r.type === 'waiver' && r.status === 'complete') famAdd = 'CLAIM_WON';
    else if (r.type === 'waiver' && r.status === 'failed') famAdd = 'CLAIM_FAIL';
    else continue;
    for (const [p, rid] of Object.entries(adds)) {
      ev.push({ lg: r.lg, roster: rid, week: r.week, fam: famAdd, pos: pos(p), ms: r.ms, lat, bid, player: String(p) });
    }
    if (famAdd !== 'CLAIM_FAIL') {
      for (const [p, rid] of Object.entries(drops)) {
        ev.push({ lg: r.lg, roster: rid, week: r.week, fam: 'DROP', pos: pos(p), ms: r.ms, lat, bid: NaN, player: String(p) });
      }
    }
  }
  return { ev, trades };
}

/** expand_events: bid premium, clock, union families, position split. */
function expandEvents(ev, trades) {
  const bids = new Map();
  for (const e of ev) {
    if (e.fam !== 'CLAIM_WON' && e.fam !== 'CLAIM_FAIL') continue;
    const k = `${e.lg}|${e.week}|${e.player}`;
    if (!bids.has(k)) bids.set(k, []);
    bids.get(k).push(e.bid);
  }
  const base = ev.map(e => {
    const med = bids.has(`${e.lg}|${e.week}|${e.player}`) ? median(bids.get(`${e.lg}|${e.week}|${e.player}`)) : NaN;
    const prem = e.fam !== 'DROP' && med > 0 && isNum(e.bid) ? Math.log1p(e.bid) - Math.log1p(med) : NaN;
    return { ...e, prem, ...etHourDow(e.ms), lat_h: e.lat / 3.6e6 };
  });
  const all = [
    ...base,
    ...base.filter(e => e.fam === 'ADD_FA' || e.fam === 'CLAIM_WON').map(e => ({ ...e, fam: 'ADD_ANY' })),
    ...base.filter(e => e.fam === 'CLAIM_WON' || e.fam === 'CLAIM_FAIL').map(e => ({ ...e, fam: 'CLAIM_ALL' })),
  ];
  const outEv = [];
  for (const e of all) {
    outEv.push({ ...e, fam: `${e.fam}:ALL` });
    if (e.pos) outEv.push({ ...e, fam: `${e.fam}:${e.pos}` });
  }
  for (const t of trades) {
    outEv.push({ lg: t.lg, roster: t.roster, week: t.week, fam: 'TRADE:ALL', ...etHourDow(t.ms), lat_h: NaN, bid: NaN,
      prem: NaN, player: null });
  }
  return outEv;
}

/** lineup_frame: win/loss vs the opponent's same-week points, lineup and roster shape. */
function lineupFrame(tw, pos) {
  const pts = new Map(tw.map(r => [`${r.lg}|${r.week}|${r.roster}`, r.points]));
  const rows = tw.map(r => {
    const opp = r.opp == null ? undefined : pts.get(`${r.lg}|${r.week}|${r.opp}`);
    const oppPts = opp === undefined ? NaN : opp;
    return { ...r, win: isNum(oppPts) ? (r.points > oppPts ? 1 : 0) : NaN,
      loss: isNum(oppPts) ? (r.points < oppPts ? 1 : 0) : NaN };
  }).sort((a, b) => (a.lg < b.lg ? -1 : a.lg > b.lg ? 1 : a.roster - b.roster || a.week - b.week));
  const kd = s => s.filter(x => x !== '0' && ['K', 'DEF'].includes(pos(x))).map(String).sort().join('\u0000');
  let prev = null;
  for (const r of rows) {
    const p = prev && prev.lg === r.lg && prev.roster === r.roster ? prev : null;
    if (p) {
      const b = new Set(p.st);
      r.lu_changed = new Set(r.st.filter(x => !b.has(x))).size;
      r.lu_kdef_stream = kd(r.st) !== kd(p.st) ? 1 : 0;
    } else {
      r.lu_changed = NaN;
      r.lu_kdef_stream = NaN;
    }
    r.lu_empty = r.st.filter(x => x === '0').length;
    for (const P of POSITIONS) r[`ro_${P}`] = r.pl.filter(x => pos(x) === P).length;
    r.ro_bench = r.pl.length - r.st.filter(x => x !== '0').length;
    prev = r;
  }
  return rows;
}

const groupBy = (xs, key) => {
  const m = new Map();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

/** build_arm_a's X columns (the candidate windows only) for every roster of one league. */
function armATells(tx, tw, pos) {
  const { ev: rawEv, trades } = eventsFromTx(tx, pos);
  const ev = expandEvents(rawEv, trades);
  const lu = lineupFrame(tw, pos);
  const rosters = [...new Set(tw.map(r => r.roster))].sort((a, b) => a - b);
  const early = ev.filter(e => e.week <= 6).map(e => ({
    ...e, night: e.hour < 6 ? 1 : 0, sun: e.dow === 6 ? 1 : 0, montue: e.dow <= 1 ? 1 : 0,
    wedthu: e.dow === 2 || e.dow === 3 ? 1 : 0, frisat: e.dow === 4 || e.dow === 5 ? 1 : 0,
    lastlat: isNum(e.lat_h) ? (e.lat_h < 1 ? 1 : 0) : NaN,
    loglat: isNum(e.lat_h) ? Math.log1p(Math.max(e.lat_h, 0)) : NaN,
  }));
  const byRosterFam = groupBy(early, e => `${e.roster}|${e.fam}`);
  const res = new Map(rosters.map(r => [r, {}]));
  for (const rid of rosters) {
    const o = res.get(rid);
    for (const f of ALL_FAMS) {
      const evs = byRosterFam.get(`${rid}|${f}`) ?? [];
      for (const [w, wks] of Object.entries(WIN)) {
        const sub = evs.filter(e => wks.includes(e.week));
        const counts = [...groupBy(sub, e => e.week).values()].map(g => g.length);
        const sum = counts.reduce((a, b) => a + b, 0);
        o[`${f}|rate|${w}`] = sub.length / wks.length;
        o[`${f}|active|${w}`] = counts.length / wks.length;
        if (!sub.length) continue; // stats undefined: no events in this window
        for (const s of ['night', 'sun', 'montue', 'wedthu', 'frisat']) o[`${f}|${s}|${w}`] = mean(sub.map(e => e[s]));
        o[`${f}|medhour|${w}`] = median(sub.map(e => e.hour));
        o[`${f}|burst|${w}`] = sum >= 2 ? Math.max(...counts) / sum : NaN;
        if (f.startsWith('CLAIM')) {
          o[`${f}|loglat|${w}`] = median(sub.map(e => e.loglat));
          o[`${f}|lastlat|${w}`] = mean(sub.map(e => e.lastlat));
          o[`${f}|bid|${w}`] = median(sub.map(e => e.bid));
          o[`${f}|prem|${w}`] = median(sub.map(e => e.prem));
        }
      }
    }
  }
  // afterloss (w26): events in week t+1 after a loss minus after a win in week t, t+1 in 2..6
  const luBy = groupBy(lu, r => r.roster);
  for (const rid of rosters) {
    const grid = (luBy.get(rid) ?? []).map(r => ({ week: r.week + 1, win: r.win, loss: r.loss }))
      .filter(g => g.week >= 2 && g.week <= 6);
    for (const f of ALL_FAMS) {
      const evs = byRosterFam.get(`${rid}|${f}`) ?? [];
      const c = wk => evs.filter(e => e.week === wk).length;
      const al = mean(grid.filter(g => g.loss === 1).map(g => c(g.week)));
      const aw = mean(grid.filter(g => g.win === 1).map(g => c(g.week)));
      res.get(rid)[`${f}|afterloss|w26`] = al - aw;
    }
  }
  for (const rid of rosters) {
    const rows = (luBy.get(rid) ?? []).filter(r => r.week <= 6);
    const o = res.get(rid);
    for (const [w, wks] of Object.entries(WIN)) {
      const sub = rows.filter(r => wks.includes(r.week));
      for (const s of LINEUP_STATS) o[`LINEUP|${s}|${w}`] = mean(sub.map(r => r[s]));
    }
    const t6 = trades.filter(t => t.roster === rid && WIN.w16.includes(t.week));
    o['TRADESHAPE|recv|w16'] = mean(t6.map(t => t.nr));
    o['TRADESHAPE|sent|w16'] = mean(t6.map(t => t.ns));
    o['TRADESHAPE|uneven|w16'] = mean(t6.map(t => (t.nr !== t.ns ? 1 : 0)));
    o['TRADESHAPE|picks|w16'] = mean(t6.map(t => t.picks));
    const firstAdd = new Map();
    for (const e of byRosterFam.get(`${rid}|ADD_ANY:ALL`) ?? []) {
      firstAdd.set(e.player, Math.min(firstAdd.get(e.player) ?? Infinity, e.week));
    }
    for (const P of ['ALL', ...POSITIONS]) {
      const drops = (byRosterFam.get(`${rid}|DROP:${P}`) ?? []).filter(e => WIN.w16.includes(e.week));
      const ten = drops.map(e => {
        const aw = firstAdd.get(e.player);
        return aw !== undefined && aw <= e.week ? e.week - aw : NaN;
      });
      o[`DROPTEN:${P}|tenure|w16`] = median(ten);
      o[`DROPTEN:${P}|origshare|w16`] = mean(drops.map(e => (firstAdd.has(e.player) ? 0 : 1)));
    }
  }
  return res;
}

/** build_prev_season: prior-season trade tells per roster, regular season (week < playoff start). */
function prevSeasonTells(tx, tw, pos, playoffWeekStart) {
  const pws = Number(playoffWeekStart ?? 15);
  const { ev: ev0, trades: tr0 } = eventsFromTx(tx, pos);
  const lu = lineupFrame(tw, pos).filter(r => r.week < pws);
  const trades = tr0.filter(t => t.week < pws);
  const ev = ev0.filter(e => e.week < pws);
  const acq = new Map();
  for (const r of tx) {
    if (r.type !== 'trade' || r.status !== 'complete' || r.week >= pws) continue;
    for (const [p, rid] of Object.entries(r.adds ?? {})) {
      const k = `${rid}|${p}`;
      acq.set(k, Math.min(acq.get(k) ?? 99, r.week));
    }
  }
  const res = new Map();
  for (const rid of [...new Set(lu.map(r => r.roster))].sort((a, b) => a - b)) {
    const t = trades.filter(x => x.roster === rid);
    const e = ev.filter(x => x.roster === rid);
    const rows = lu.filter(r => r.roster === rid);
    const o = {
      n_trades: t.length,
      n_trade_partners: new Set(t.flatMap(x => x.partners)).size,
      trades_with_picks: t.reduce((a, x) => a + x.picks, 0),
      uneven_trades: t.filter(x => x.nr !== x.ns).length,
      players_recv: t.reduce((a, x) => a + x.nr, 0),
      players_sent: t.reduce((a, x) => a + x.ns, 0),
      trades_early: t.filter(x => x.week <= 6).length,
      trades_late: t.filter(x => x.week >= 7).length,
      any_trade: t.length > 0 ? 1 : 0,
      n_adds: e.filter(x => x.fam === 'ADD_FA' || x.fam === 'CLAIM_WON').length,
      n_fail_claims: e.filter(x => x.fam === 'CLAIM_FAIL').length,
      drops: e.filter(x => x.fam === 'DROP').length,
      win_pct: mean(rows.map(r => r.win)),
      n_start_trade: rows.reduce((a, r) => a + r.st.filter(x => x !== '0'
        && (acq.get(`${rid}|${x}`) ?? 99) < r.week).length, 0),
    };
    res.set(rid, Object.fromEntries(PREV_TELLS.map(k => [`PREV|${k}`, o[k]])));
  }
  return res;
}

// ------------------------------------------------------------------ public API
/**
 * Every candidate tell for every roster of `leagueId`, as of `asOf`.
 * @param events   engine_events rows (any leagues; other leagues are ignored)
 * @param opts.asOf required cutoff (ISO, epoch ms or Date); later events are dropped
 * @param opts.leagueId the league whose rosters are scored (this season)
 * @param opts.previous { leagueId, playoffWeekStart } for arm B prior-season tells, or null
 * @param opts.positions { playerId: position } (or a Map); letters-only ids are defenses
 * @returns Map<rosterId, { [tellId]: number|null }> over TELL_IDS (null = undefined, e.g. no events)
 */
export function computeAllTells(events, { asOf, leagueId, previous = null, positions = {} } = {}) {
  const pos = positionOf(positions);
  const { tx, tw } = canonicalRecords(events, { asOf });
  const cur = armATells(tx.filter(r => r.lg === leagueId), tw.filter(r => r.lg === leagueId), pos);
  const prev = previous?.leagueId != null
    ? prevSeasonTells(tx.filter(r => r.lg === previous.leagueId), tw.filter(r => r.lg === previous.leagueId), pos,
      previous.playoffWeekStart)
    : new Map();
  const outMap = new Map();
  for (const [rid, vals] of cur) {
    const p = prev.get(rid) ?? {};
    outMap.set(rid, Object.fromEntries(TELL_IDS.map(id => [id, out(id.startsWith('PREV|') ? p[id] : vals[id])])));
  }
  return outMap;
}

/**
 * The surviving tells only: `ids` (default: the screen's `confirmed` tells, see
 * survivingTellIds) for every roster of `leagueId`, as of `asOf`.
 */
export function computeTells(events, { ids, ...opts } = {}) {
  const want = ids ?? [];
  const all = computeAllTells(events, opts);
  const res = new Map();
  for (const [rid, vals] of all) res.set(rid, Object.fromEntries(want.map(id => [id, vals[id] ?? null])));
  return res;
}

/** Tell ids the screen artifact lets the library serve: `confirmed`, plus `lead` when asked. */
export function survivingTellIds(screen, { includeLeads = false } = {}) {
  return [...new Set(screen.tells.filter(t => t.verdict === 'confirmed' || (includeLeads && t.verdict === 'lead'))
    .map(t => t.id))];
}

/** Weeks of a tell's window observed as of the data (the n of the EB shrinkage). */
export function windowWeeks(id) {
  const w = id.split('|')[2];
  if (w === 'w26') return [2, 3, 4, 5, 6];
  return WIN[w] ?? null;
}
