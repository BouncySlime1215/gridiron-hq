/**
 * RB-DELTAS: GRIDIRON_RB_TITLE=deltas serves the conditional estimate for paired title deltas (and their
 * SEs), keeps served title levels on plain Monte Carlo; shadow carries both, and the producer logs a
 * per-step table (rb-shadow.js) for the Tuesday 9/29 review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const RB = await import('../server/services/rb-title.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { rbShadowRows, rbShadowSummary } = await import('../server/services/campaign/rb-shadow.js');
const { moveId } = await import('../server/services/campaign/view.js');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('flag: deltas is its own value; preview never turns it on', () => {
  withEnv({ [RB.RB_TITLE_ENV]: 'deltas' }, () => assert.equal(RB.rbTitleMode(), 'deltas'));
  withEnv({ [RB.RB_TITLE_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.equal(RB.rbTitleMode(), 'off'));
});

const step = (rb, rbSe, plain, plainSe) => ({ team: '2', give: [1], get: [2], p: 0.5, delta: plain,
  title_pair: { rb_delta: rb, rb_se: rbSe, plain_delta: plain, plain_se: plainSe } });

test('shadow table: one row per served step, own-gain sign agreement and the 2-SE check', () => {
  const plan = { target: '2', steps: [step(0.003, 0.0004, 0.0035, 0.0012), step(0.0028, 0.0004, 0.0045, 0.0013)] };
  const res = { league: 4, week: 4, deck: [{ plan }] };
  const rows = rbShadowRows(res);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].move_id, moveId(4, plan));
  assert.deepEqual(rows.map(r => [r.week, r.step]), [[4, 1], [4, 2]]);
  assert.equal(rows[0].sign_agree, true);
  // Step 2: RB own gain -0.0002, plain +0.001: a sign flip (the review rule fails on it).
  assert.equal(rows[1].sign_agree, false);
  assert.equal(rows[1].rb_own, -0.0002);
  assert.equal(rows[0].within_2se, true);
  assert.ok(rows.every(r => r.served === true));
  const s = rbShadowSummary(rows);
  // Plain's 0.0045 +/- 0.0013 clears 2 SE, so this flip counts where plain clears too.
  assert.equal(rows[1].plain_clears_2se, true);
  assert.deepEqual(s, { rows: 2, sign_flips: 1, within_2se_share: 1, sign_flips_where_plain_clears: 1, passes: false,
    all: { rows: 2, sign_flips: 1, within_2se_share: 1, sign_flips_where_plain_clears: 1, passes: false } });
  assert.equal(rbShadowSummary([rows[0]]).passes, true);
  // A priced-but-not-served path is logged as served: false and only counts toward `all`.
  const other = { target: '9', steps: [step(0.001, 0.0003, -0.001, 0.0009)] };
  const more = rbShadowRows({ ...res, confirm_checked: [plan, other] });
  assert.equal(more.length, 3, 'the served path is not logged twice');
  assert.equal(more[2].served, false);
  const s2 = rbShadowSummary(more);
  assert.equal(s2.sign_flips, 1);
  assert.equal(s2.all.sign_flips, 2);
});

test('shadow table: steps without both estimators log nothing (flag off, or a points objective card)', () => {
  const plan = { target: '2', steps: [{ team: '2', give: [1], get: [2], p: 0.5, delta: 0.01 }] };
  assert.deepEqual(rbShadowRows({ league: 4, week: 4, deck: [{ plan }] }), []);
  assert.deepEqual(rbShadowSummary([]), { rows: 0, sign_flips: 0, within_2se_share: null, sign_flips_where_plain_clears: 0, passes: false,
    all: { rows: 0, sign_flips: 0, within_2se_share: null, sign_flips_where_plain_clears: 0, passes: false } });
});
