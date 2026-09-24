/**
 * HIS-SCREEN (WAR-ROOM-UI.md v3, new mode 2): any offer, shown the way the
 * partner sees it.
 *
 *   roster     his roster before and after, with what leaves and what arrives
 *   value view each player priced HIS way next to ours (his clone:
 *              counterparty-pricing.js#playerValuation), and the package as his
 *              clone reads it (readDeal: their_perceived_give / _get)
 *   gives up   what he sends, his value and ours
 *   title odds his title-odds change from the one paired season sim
 *              (season-sim.js#tradeImpact, `them`), with its SE and 2-SE check
 *   fair       the "fair on his screen" badge: his clone's % (what he gets minus
 *              what he gives, over what he gives) inside the finder's window
 *              (paths.js SCREEN_WINDOW). No clone for him -> `unknown`, never a
 *              badge computed on OUR market values and labelled as his.
 *
 * buildHisScreen is pure (tests hand in fixtures); hisScreenFor reads the DB and
 * the sim for one league. Default-off behind GRIDIRON_HIS_SCREEN; preview mode
 * (preview-mode.js) turns it on locally and the response then says so.
 *
 * Every number is a typed field ({ status: ok | unknown, value?, reason?, source })
 * in the warroom-plans/1 style (view.js), so a missing read is a sentence.
 */
import { screenPct, SCREEN_WINDOW, NOISE_K } from './paths.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const HIS_SCREEN_ENV = 'GRIDIRON_HIS_SCREEN';
export const HIS_SCREEN_OFF_REASON =
  'His screen is default-off, unconfirmed forward: its fair badge reads his clone\'s value view '
  + '(counterparty-pricing.js#readDeal), and no graded check (E1/E2) has confirmed that view predicts his answer yet. '
  + `Set ${HIS_SCREEN_ENV}=1 to switch it on.`;

const fin = v => typeof v === 'number' && Number.isFinite(v);
const ok = (value, source, meta = {}) => ({ status: 'ok', value, source, ...meta });
const unknown = (reason, source) => ({ status: 'unknown', source, reason });
const ids = a => (a ?? []).map(String);
const sum = (list, f) => list.reduce((s, x) => s + (f(x) ?? 0), 0);

/** Site flag, read per call. `enabled` from the caller wins; preview turns an unset site flag on. */
export function hisScreenGate(enabled) {
  if (enabled !== undefined) return { on: !!enabled, preview: false };
  if (process.env[HIS_SCREEN_ENV] === '1') return { on: true, preview: false };
  const preview = previewUnconfirmed();
  return { on: preview, preview };
}

/**
 * The badge, from his clone's package read. pct: his % (null when he gives nothing of value).
 *   fair  inside the window        short  below it (he feels he loses)
 *   rich  above it (you overpay)   unknown no clone / no price
 */
export function fairBadge(pct, { clone = true, window = SCREEN_WINDOW } = {}) {
  const src = 'clone.price';
  if (!clone) return unknown('No clone of this manager (no counterparty read for his roster), so his screen cannot be priced his way.', src);
  if (!fin(pct)) return unknown('He gives nothing with a market value, so there is no % on his screen.', src);
  const verdict = pct < window.low ? 'short' : pct > window.high ? 'rich' : 'fair';
  const s = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  const text = verdict === 'fair' ? `Fair on his screen (${s}; window ${window.low}% to +${window.high}%).`
    : verdict === 'short' ? `Short on his screen (${s}): he reads it as losing more than ${-window.low}%.`
      : `Rich on his screen (${s}): you give him more than +${window.high}% on his own values.`;
  return ok({ verdict, pct, window: { ...window }, text }, src);
}

/** His title-odds change as a typed field, from tradeImpact's `them` block. */
export function titleField(impact) {
  const src = 'sim.title';
  if (!impact) return unknown('The season sim was not run for this offer.', src);
  if (impact.error) return unknown(`The season sim could not score this offer: ${impact.error}.`, src);
  const t = impact.them ?? {};
  if (!fin(t.title_before) || !fin(t.title_after)) return unknown('The season sim returned no title odds for his team.', src);
  const delta = fin(t.title_delta) ? t.title_delta : t.title_after - t.title_before;
  const out = ok({ before: t.title_before, after: t.title_after, delta }, src, { unit: 'title_odds' });
  if (fin(t.title_delta_se) && t.title_delta_se >= 0) {
    out.se = t.title_delta_se;
    out.clears_2se = t.title_delta_se > 0 && Math.abs(delta) > NOISE_K * t.title_delta_se;
  }
  return out;
}

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST'];
const posRank = p => { const i = POS_ORDER.indexOf(String(p)); return i < 0 ? POS_ORDER.length : i; };

/**
 * offer: Nick's side { partner, give, get } (give = what Nick sends = what HE receives).
 * hisRoster: his player ids today. players: Map id -> { name, position, value, ros_ppg }.
 * clone: null, or { deal: readDeal(...) result, perPlayer: Map id -> playerValuation result, needs? }.
 * impact: tradeImpact result (or { error }) or null.
 */
export function buildHisScreen({ offer, hisRoster, players, clone = null, impact = null }) {
  const P = id => players.get(String(id)) ?? players.get(Number(id)) ?? null;
  const arriving = ids(offer.give), leaving = ids(offer.get);
  const before = ids(hisRoster);
  const missing = leaving.filter(id => !before.includes(id));
  if (missing.length) {
    return { partner: String(offer.partner), error: `not on his roster: ${missing.join(', ')}` };
  }
  const needs = new Set((clone?.needs ?? []).map(String));
  const row = (id, tag) => {
    const p = P(id) ?? {};
    const v = clone?.perPlayer?.get(String(id)) ?? null;
    const ours = Math.max(0, Number(p.value) || 0);
    return {
      id: String(id), name: p.name ?? `player ${id}`, position: p.position ?? null,
      ros_ppg: fin(p.ros_ppg) ? p.ros_ppg : null,
      value_ours: ours,
      value_his: v && fin(v.their_value) ? ok(v.their_value, 'clone.price', { multiplier: v.multiplier })
        : unknown(clone ? 'His clone has no per-player read here.' : 'No clone of this manager.', 'clone.price'),
      reasons: (v?.factors ?? []).map(f => f.why).filter(Boolean),
      ...(tag ? { move: tag } : {}),
      ...(tag === 'arrives' && needs.has(String(p.position)) ? { fills_need: true } : {}),
    };
  };
  const sort = list => list.sort((a, b) => posRank(a.position) - posRank(b.position) || b.value_ours - a.value_ours);
  const afterIds = [...before.filter(id => !leaving.includes(id)), ...arriving];
  const rosterBefore = sort(before.map(id => row(id, leaving.includes(id) ? 'leaves' : null)));
  const rosterAfter = sort(afterIds.map(id => row(id, arriving.includes(id) ? 'arrives' : null)));
  const counts = list => list.reduce((m, r) => { const k = r.position ?? '?'; m[k] = (m[k] ?? 0) + 1; return m; }, {});

  const givesUp = rosterBefore.filter(r => r.move === 'leaves');
  const gets = rosterAfter.filter(r => r.move === 'arrives');
  const market = {
    his_give: sum(givesUp, r => r.value_ours), his_get: sum(gets, r => r.value_ours),
  };
  market.pct = screenPct(market.his_get, market.his_give);

  const deal = clone?.deal ?? null;
  const cloneGive = deal && fin(deal.their_perceived_give) ? deal.their_perceived_give : null;
  const cloneGet = deal && fin(deal.their_perceived_get) ? deal.their_perceived_get : null;
  const hisPct = cloneGive != null && cloneGet != null ? screenPct(cloneGet, cloneGive) : null;
  const value_view = deal
    ? ok({
      his_give: cloneGive, his_get: cloneGet, pct: hisPct,
      market_pct: market.pct,
      informed: !!deal.perception_informed,
      basis: deal.perception_informed
        ? 'his clone: our market values moved by his own reads (chat, profile, needs), package capped at +/-15%'
        : 'his clone has no read on these players, so his view equals market value',
    }, 'clone.price')
    : unknown('No clone of this manager, so only market values are known.', 'clone.price');

  return {
    partner: String(offer.partner),
    offer: { give: arriving, get: leaving },
    roster: { before: rosterBefore, after: rosterAfter, counts_before: counts(rosterBefore), counts_after: counts(rosterAfter) },
    gives_up: givesUp,
    gets,
    market: { his_give: market.his_give, his_get: market.his_get, pct: fin(market.pct) ? market.pct : null, source: 'market.fc' },
    value_view,
    title_odds: titleField(impact),
    fair: fairBadge(hisPct, { clone: !!deal }),
  };
}

/**
 * One league, one offer, from the DB and the sim. svc is injectable for tests:
 * { engine: {assetUniverse, loadRosters}, format: {deriveFormat}, cp: {counterpartyLayer, readDeal, playerValuation},
 *   sim: {tradeImpact}, week: {leagueCurrentWeek} }.
 */
export async function hisScreenFor(lg, { partner, give = [], get = [], enabled, svc = null } = {}) {
  const gate = hisScreenGate(enabled);
  if (!gate.on) return { enabled: false, reason: HIS_SCREEN_OFF_REASON };
  const s = svc ?? await loadServices();
  const me = String(lg.my_team_id ?? '');
  const teams = s.engine.loadRosters(lg, s.engine.assetUniverse(lg, s.format.deriveFormat(lg).formatKey));
  const mine = teams.find(t => t.roster_id === me);
  const his = teams.find(t => t.roster_id === String(partner));
  const wrap = body => ({ enabled: true, league: lg.id, ...body, ...(gate.preview ? previewFields(HIS_SCREEN_OFF_REASON) : {}) });
  if (!mine) return wrap({ error: 'your team is not set for this league' });
  if (!his || his.roster_id === me) return wrap({ error: 'the partner is not another team in this league' });
  const giveIds = ids(give), getIds = ids(get);
  if (!giveIds.length && !getIds.length) return wrap({ error: 'the offer names no players' });
  const owns = (t, id) => t.players.some(p => String(p.id) === id);
  const notMine = giveIds.filter(id => !owns(mine, id));
  if (notMine.length) return wrap({ error: `not on your roster: ${notMine.join(', ')}` });
  const notHis = getIds.filter(id => !owns(his, id));
  if (notHis.length) return wrap({ error: `not on his roster: ${notHis.join(', ')}` });

  const players = new Map();
  for (const p of [...mine.players, ...his.players]) players.set(String(p.id), p);
  const slim = id => { const p = players.get(id); return { id: p.id, name: p.name, position: p.position, value: p.value }; };

  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : (lg.payload ?? {});
  const season = lg.season ?? payload.seasonId ?? null;
  const week = s.week.leagueCurrentWeek(lg);
  const layer = s.cp.counterpartyLayer(lg.id, { season, week });
  const m = layer.get(his.roster_id) ?? null;
  const clone = m ? {
    deal: s.cp.readDeal({ theirGive: getIds.map(slim), theirGet: giveIds.map(slim), managerProfile: m }),
    perPlayer: new Map([...his.players.map(p => String(p.id)), ...giveIds].map(id => [id, s.cp.playerValuation(m, slim(id))])),
    needs: m.needs ? [...m.needs] : [],
  } : null;

  let impact;
  try {
    impact = s.sim.tradeImpact(lg, { myTeamId: me, theirTeamId: his.roster_id, iGive: giveIds.map(Number), iGet: getIds.map(Number) });
  } catch (e) {
    impact = { error: String(e.message ?? e) };
  }
  const screen = buildHisScreen({ offer: { partner: his.roster_id, give: giveIds, get: getIds },
    hisRoster: his.players.map(p => p.id), players, clone, impact });
  return wrap(screen);
}

async function loadServices() {
  return {
    engine: await import('../trade-engine.js'),
    format: await import('../format.js'),
    cp: await import('../counterparty-pricing.js'),
    sim: await import('../season-sim.js'),
    week: await import('../league-week.js'),
  };
}
