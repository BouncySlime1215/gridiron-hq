/**
 * FLIP-01: the flip map written as the `flip_map` section of the War Room
 * plans contract (server/services/campaign/plans-schema.js, PR #238).
 *
 * Every number is a typed field. Title-odds numbers carry their SE and whether
 * they clear 2 SE; the clone prices and P(accept)s carry the source they came
 * from. A number that is not finite is written `unknown` with a reason, never
 * as a bare null or 0 (INTEGRATION-AUDIT-0923 P7).
 */
import { NOISE_K } from './flip-score.js';

export const FLIP_MAP_LIMIT = 20;

const ok = (value, source, extra = {}) => ({ status: 'ok', value, source, ...extra });
const unknown = (source, reason) => ({ status: 'unknown', reason, source });

function num(v, source, { se, asOf } = {}) {
  if (!Number.isFinite(v)) return unknown(source, 'not computed for this pair');
  const extra = {};
  if (Number.isFinite(se)) { extra.se = se; extra.clears_2se = se > 0 && Math.abs(v) > NOISE_K * se; }
  if (asOf) extra.as_of = asOf;
  return ok(v, source, extra);
}

function prob(v, source, asOf) {
  if (!Number.isFinite(v) || v < 0 || v > 1) return unknown(source, 'no acceptance estimate');
  return ok(v, source, asOf ? { as_of: asOf } : {});
}

/**
 * @param result computeFlipMap's output
 * @returns {{ section: object, ids: string[] }} the typed `flip_map` field and
 *   every player id it names (the league entry's `names` must hold each one).
 */
export function toFlipMapSection(result, { asOf, limit = FLIP_MAP_LIMIT } = {}) {
  if (!result || !Array.isArray(result.pairs)) {
    return { section: { status: 'failed', reason: 'flip radar did not run', source: 'sim.title' }, ids: [] };
  }
  if (!result.pairs.length) {
    return { section: unknown('sim.title', 'no tradable players to scan'), ids: [] };
  }
  const ids = new Set();
  const value = result.flips.slice(0, limit).map(f => {
    ids.add(String(f.player));
    const out = {
      player: String(f.player), buy_from: String(f.a), sell_to: String(f.b),
      spread: num(f.spread, 'sim.title', { se: f.se, asOf }),
      price_a: num(f.price_a, 'clone.price', { asOf }),
      price_b: num(f.price_b, 'clone.price', { asOf }),
      legs: null
    };
    if (f.legs) {
      ids.add(String(f.legs.give_a)); ids.add(String(f.legs.get_b));
      out.legs = {
        give_a: String(f.legs.give_a), get_b: String(f.legs.get_b),
        p1: prob(f.legs.p1, 'clone.accept', asOf), p2: prob(f.legs.p2, 'clone.accept', asOf),
        p_both: prob(f.legs.p_both, 'clone.accept', asOf),
        nick_after: num(f.legs.d2, 'sim.title', { se: f.legs.se2, asOf })
      };
    } else {
      out.legs_why_not = f.legs_why_not ?? 'no fair one-player leg';
    }
    return out;
  });
  const section = { status: 'ok', value, source: 'sim.title', n: result.pairs.length };
  if (asOf) section.as_of = asOf;
  if (result.days == null) section.reason = 'no trade deadline in the league payload; ranked without the days factor';
  return { section, ids: [...ids] };
}
