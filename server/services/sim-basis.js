/**
 * BASIS-02: the title sim prices every rostered player on the finder's rate.
 *
 * RL-17-3 and SIM-CALIB rescale each outcome pool's volume onto a rest-of-season
 * rate, but two gaps kept the Title tab and the trade finder ranking players
 * differently (number_health `projection_basis`, 0.78 on league 4 against a 0.9 bar):
 *
 *   A. Two ROS producers. With the as-of flag on, the level is projection-asof.js's
 *      own run of the ROS model, not the finder's served `ros_ppg`. At the current
 *      week the finder's number is the served one, so it is the level; the as-of rate
 *      stays for replays of an earlier week (where `ros_ppg` would read the future)
 *      and for players the finder has no rate for.
 *   B. No last-season projection, no pool. A rookie or a player new to the data has
 *      no `buildProjections({ through: SEASON - 1 })` entry, so season-sim.js#weekPool
 *      returned null and he scored 0 in every simulated week while the finder rated
 *      him. He now borrows the pool shape of the projected player at his position
 *      whose ppg is closest to his rate, scaled onto that rate. His draws stay keyed
 *      on his own id, so he is not the donor's twin.
 *
 * GRIDIRON_BASIS_02: '1' on, anything else off. Deliberately NOT on under preview
 * mode: it moves title odds, so it stays off until measured on league 4 (PR body,
 * "Needs local measurement"). GRIDIRON_RL17_3_ENABLED=0 (the ROS basis kill switch)
 * vetoes it too. Off, every number is what it was.
 */
import { rosFactor } from './one-world.js';

export const BASIS_02_ENV = 'GRIDIRON_BASIS_02';

/** { on }: read per call, so a test or a run can flip it. */
export function basis02Flag() {
  if (process.env.GRIDIRON_RL17_3_ENABLED === '0') return { on: false };
  return { on: process.env[BASIS_02_ENV] === '1' };
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const positionOf = pr => pr?.position ?? pr?.params?.position ?? null;

// proj map -> position -> [{ id, ppg }] sorted by ppg then id, built once per map.
const byPositionCache = new WeakMap();
function byPosition(proj) {
  let held = byPositionCache.get(proj);
  if (held) return held;
  held = new Map();
  for (const [id, pr] of proj) {
    const pos = positionOf(pr);
    if (!pos || !finite(pr?.ppg) || pr.ppg <= 0 || !pr.params) continue;
    if (!held.has(pos)) held.set(pos, []);
    held.get(pos).push({ id, ppg: pr.ppg });
  }
  for (const list of held.values()) list.sort((a, b) => a.ppg - b.ppg || (a.id > b.id) - (a.id < b.id));
  byPositionCache.set(proj, held);
  return held;
}

/**
 * The projected player at `position` whose ppg is closest to `rate` (ties: the
 * lower id), or null when nobody at that position has a pool to borrow.
 */
export function templateDonor(proj, position, rate) {
  const list = byPosition(proj).get(position);
  if (!list?.length || !finite(rate)) return null;
  let best = null;
  for (const e of list) {
    const gap = Math.abs(e.ppg - rate);
    if (!best || gap < best.gap - 1e-12) best = { ...e, gap };
  }
  return { id: best.id, pr: proj.get(best.id) };
}

/**
 * Applies A and B to a season's basis in place. `basis` is season-sim.js's
 * { scale: Map, fields } (fields may be null when neither ROS flag is on);
 * returns the basis with `template` (player id -> borrowed projection) and the
 * counts it added. `atCurrentWeek` is false for a replay of an earlier week, which
 * keeps the as-of level (no future `ros_ppg`) and borrows no pools.
 */
export function applyBasis02(basis, roster, proj, { atCurrentWeek }) {
  const scale = new Map(basis.scale);
  const template = new Map();
  let finder = 0, missing = 0;
  if (atCurrentWeek) {
    for (const p of roster) {
      if (!finite(p.ros_ppg) || p.ros_ppg < 0) continue;
      const own = proj.get(p.id);
      if (own) {
        const f = rosFactor(p.ros_ppg, own.ppg);
        if (f !== undefined) { scale.set(p.id, f); finder++; }
        continue;
      }
      const donor = templateDonor(proj, p.position, p.ros_ppg);
      if (!donor) { missing++; continue; }
      template.set(p.id, donor.pr);
      scale.set(p.id, rosFactor(p.ros_ppg, donor.pr.ppg));
    }
  }
  return {
    scale, template,
    fields: {
      ...(basis.fields ?? { projection_basis: 'ros' }),
      basis_02: true, ros_finder_level: finder, ros_template: template.size, ros_no_pool: missing
    }
  };
}

/**
 * The pool inputs worldPoolFor needs for one player outside a built world: his own
 * projection, or (flag on) a borrowed one, and the volume factor onto his ros_ppg.
 * null when he has neither.
 */
export function poolBasisFor(p, proj, flag = basis02Flag()) {
  const own = proj.get(p.id);
  if (own) return { pr: own, scale: rosFactor(p.ros_ppg, own.ppg), template: false };
  if (!flag.on || !finite(p.ros_ppg) || p.ros_ppg < 0) return null;
  const donor = templateDonor(proj, p.position, p.ros_ppg);
  return donor ? { pr: donor.pr, scale: rosFactor(p.ros_ppg, donor.pr.ppg), template: true } : null;
}

/**
 * Each simulated player's mean points per game PLAYED over the world's simulated
 * weeks he has a game: the pool mean over his chance to play, which is the unit the
 * finder's ros_ppg is in. The number the audit's row A compares with ros_ppg.
 */
export function simPlayerRates(world) {
  const acc = new Map();
  for (const wd of world.prep.weekData.values()) {
    for (const [id, m] of wd.expected) {
      const active = wd.active?.get(id);
      const rate = finite(active) && active > 0 ? m / active : m;
      const a = acc.get(id) ?? { s: 0, n: 0 };
      a.s += rate; a.n++;
      acc.set(id, a);
    }
  }
  return new Map([...acc].map(([id, a]) => [id, a.s / a.n]));
}
