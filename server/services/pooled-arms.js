/**
 * Pooling model arms across walk-forward seasons so a comparison compares rows.
 *
 * WHY THIS FILE EXISTS. `offseason-model.js` grades several model arms on the
 * same held-out seasons and then pools them: every arm appends its per-row
 * absolute errors into `pooled[name].errs` season by season, and the overall
 * table compares each arm against a baseline with
 * `pairedBootstrapDiff(base.errs, arm.errs, { groups: arm.groups })`.
 *
 * That is a PAIRED test. It is only meaningful if `base.errs[i]` and
 * `arm.errs[i]` describe the same row. They do as long as every arm covers
 * every season, and an arm is built lazily: the GBM challenger is fitted inside
 * a `try` and simply omitted from that season's predictions when the fit
 * throws. One throw on one season of three, and the GBM arm holds rows from
 * seasons 2 and 3 while the baseline holds rows from seasons 1, 2 and 3.
 *
 * Nothing downstream notices. `pairedBootstrapDiff` takes
 * `n = min(base.length, arm.length)`, which is the SHORTER (the GBM arm), and
 * `groups` was built in lockstep with that same shorter arm -- so
 * `groups.length === n` holds and the clustered path is taken. It then pairs
 * the GBM's season-2-and-3 rows against the baseline's season-1-and-2 rows and
 * returns a tight, clean, significant-looking interval on a comparison of
 * nothing. The exact-length guard in `backtest-significance.js` protects the
 * mirror case (a `groups` array sized to the LONGER arm) and cannot see this
 * one: both arrays it is handed really are the same length as each other.
 *
 * So arms are pooled with a ROW KEY here, and compared on the rows they share.
 * A comparison that cannot be aligned is REFUSED, and the refusal is served --
 * `comparison_basis` names both arms and their row counts on every interval,
 * present or refused, because a caller reading `mean_diff` has no other way to
 * find out that half a season went missing.
 */

import { pairedBootstrapDiff } from './backtest-significance.js';

/** Fewer paired rows than this and there is nothing to bootstrap. */
export const MIN_PAIRED_ROWS = 10;

/**
 * Append one season's worth of an arm's results, keyed by row.
 *
 * `keys` identifies each row and is what alignment is done on, so it must be
 * unique within the pooled set: the caller builds it from the row's own
 * identity (season, team, player), never from its index.
 */
export function poolArm(pooled, name, { errs, preds, truth, groups, keys }) {
  if (!Array.isArray(keys)) throw new TypeError(`pooled arm ${name} was given no row keys`);
  for (const [label, arr] of [['errs', errs], ['preds', preds], ['truth', truth], ['groups', groups]]) {
    if (arr.length !== keys.length) {
      throw new RangeError(
        `pooled arm ${name}: ${label} has ${arr.length} rows against ${keys.length} keys`);
    }
  }
  const arm = (pooled[name] ??= { errs: [], preds: [], truth: [], groups: [], keys: [], seen: new Set() });
  // A KEY THAT REPEATS IS NOT A ROW IDENTITY. Alignment reads the first index a
  // key appears at, so a duplicate silently pairs several of one arm's rows
  // against one row of the other -- the same wrong pairing as by index, arriving
  // through a key that looks specific enough. A caller building the key from the
  // season and team but forgetting the player gets that, and the row counts still
  // come out plausible, so nothing downstream can tell. It is refused here
  // instead, where the caller that built the key can be named.
  for (const k of keys) {
    if (arm.seen.has(k)) {
      throw new RangeError(
        `pooled arm ${name}: row key ${k} appears twice, so it does not identify a row`);
    }
    arm.seen.add(k);
  }
  arm.errs.push(...errs); arm.preds.push(...preds);
  arm.truth.push(...truth); arm.groups.push(...groups); arm.keys.push(...keys);
  return arm;
}

/**
 * A clustered interval, or a throw — for a caller that has already established
 * its rows line up and needs the clustering it asked for.
 *
 * `pairedBootstrapDiff` falls back to an unclustered resample whenever `groups`
 * does not line up exactly, and the interval it returns is indistinguishable
 * from a clustered one. The fallback is honest but narrower than the truth:
 * within-unit correlation is what the clustering exists to account for, so an
 * unclustered interval on correlated rows overstates precision, and a model
 * audit that reports one as if it were clustered is reporting a tighter result
 * than it measured. Every caller in this repo that passes `groups` is asserting
 * its rows are correlated within a unit, so a decline is a defect rather than a
 * degradation, and these are offline grading paths, not request handlers: a
 * throw here fails a model audit instead of publishing a number nobody can see
 * is wrong.
 *
 * It throws on two conditions, and the second was added after the first shipped:
 * clustering DECLINED (the original), and a MISALIGNED pairing -- two value
 * arrays of different lengths, where clustering is GRANTED because `groups` was
 * sized to the shorter one. Only the first was guarded until this commit, and
 * the second is the one that inverts a sign.
 */
export function clusteredDiff(valuesA, valuesB, opts) {
  if (!opts?.groups) throw new TypeError('clusteredDiff requires groups; use pairedBootstrapDiff');
  // MISALIGNED AND GRANTED is the case the first version of this guard missed. It threw when
  // clustering was DECLINED, which is the safe direction: an unclustered interval is honest,
  // merely narrower than the truth. Clustering GRANTED on a pairing that does not exist is the
  // D34 shape itself, and `groups.length === n` is satisfied precisely when `groups` is sized to
  // the shorter array -- which is how every pooled caller builds it. So the lengths are checked
  // here, before the clustered/declined question is even asked.
  if (valuesA.length !== valuesB.length) {
    throw new RangeError(
      `two value arrays of different lengths (${valuesA.length} and ${valuesB.length}) have no `
      + `pairing, so this comparison cannot be made; align the rows first`);
  }
  const out = pairedBootstrapDiff(valuesA, valuesB, opts);
  if (out.error) return out;
  if (out.clustered !== true) {
    throw new RangeError(
      `clustering was requested and declined: ${valuesA.length} against ${valuesB.length} `
      + `values with ${opts.groups.length} groups, so the interval would not be clustered`);
  }
  return out;
}

/** Which seasons each arm actually covers, and which arms are short. */
export function armCoverage(pooled, { seasonOf = k => String(k).split('|')[0] } = {}) {
  const seasons = {};
  for (const [name, arm] of Object.entries(pooled)) {
    seasons[name] = [...new Set(arm.keys.map(seasonOf))].sort();
  }
  const widest = Object.values(seasons).reduce((a, b) => (b.length > a.length ? b : a), []);
  const short = Object.entries(seasons)
    .filter(([, s]) => s.length < widest.length)
    .map(([name, s]) => ({ arm: name, covers: s, missing: widest.filter(w => !s.includes(w)) }));
  return { by_arm: seasons, all_seasons: widest, incomplete: short };
}

/**
 * The paired interval between two pooled arms, on the rows they share.
 *
 * Returns whatever `pairedBootstrapDiff` returns plus `comparison_basis`, which
 * is served whether the comparison succeeded or was refused. An arm that is
 * missing rows is not an error in itself -- a challenger that could not be
 * fitted on one season is still gradeable on the others -- but WHICH rows were
 * compared stops being derivable from the output the moment the arms differ, so
 * it is stated rather than implied.
 */
export function comparePooledArms(baseName, base, armName, arm, opts = {}) {
  const basis = {
    arms: [baseName, armName],
    rows: { [baseName]: base?.keys?.length ?? 0, [armName]: arm?.keys?.length ?? 0 },
    compared: 0, aligned: true, dropped: 0, reason: null
  };
  if (!base?.keys || !arm?.keys) {
    basis.aligned = false;
    basis.reason = `one of these arms was pooled without row keys, so they cannot be paired`;
    return { error: basis.reason, clustered: false, comparison_basis: basis };
  }

  const armAt = new Map();
  for (const [i, k] of arm.keys.entries()) if (!armAt.has(k)) armAt.set(k, i);
  const a = [], b = [], groups = [];
  for (const [i, k] of base.keys.entries()) {
    const j = armAt.get(k);
    if (j === undefined) continue;
    a.push(base.errs[i]); b.push(arm.errs[j]); groups.push(base.groups[i]);
  }
  basis.compared = a.length;
  basis.dropped = Math.max(base.keys.length, arm.keys.length) - a.length;
  basis.aligned = basis.dropped === 0;

  if (a.length < MIN_PAIRED_ROWS) {
    basis.reason = `${baseName} and ${armName} share only ${a.length} rows `
      + `(${basis.rows[baseName]} against ${basis.rows[armName]}), which is too few to compare`;
    return { error: basis.reason, n: a.length, clustered: false, comparison_basis: basis };
  }
  if (!basis.aligned) {
    // Not a refusal: the shared rows are a real comparison. But the arms cover
    // different sets, so the number below answers a narrower question than the
    // one the table's column heading asks, and that has to travel with it.
    basis.reason = `${armName} covers ${basis.rows[armName]} of ${basis.rows[baseName]} rows; `
      + `compared on the ${a.length} they share`;
  }
  return { ...clusteredDiff(a, b, { ...opts, groups }), comparison_basis: basis };
}
