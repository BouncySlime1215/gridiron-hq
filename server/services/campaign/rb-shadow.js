/**
 * RB-DELTAS shadow table (pure). For every served step (each deck card's steps, on the confirm dice), the
 * title delta on the conditional estimator (RB) and on plain Monte Carlo, side by side, so the coordinator can
 * decide on Tuesday 9/29 whether GRIDIRON_RB_TITLE=deltas may serve. The rule set for that review: no served
 * step flips sign, and |rb - plain| within 2 combined SE on >= 90% of rows.
 *
 * Deltas are cumulative (the path through this step against today's roster), as the confirm dice price them.
 * `sign_agree` compares each step's OWN gain (its delta minus the step before's) on the two estimators, the
 * number STEP-REGRET and "beats doing nothing" read; `within_2se` compares the cumulative deltas.
 * The two estimators share the same runs, so sqrt(se_rb^2 + se_plain^2) overstates the SE of their
 * difference: within_2se is lenient on purpose, as the review rule is written.
 */
import { moveId } from './view.js';

export const RB_SHADOW_ENV = 'GRIDIRON_WARROOM_RB_SHADOW';

/**
 * Rows for one league's plan result ({ league, week, deck, confirm_checked }); [] when no step carries both
 * estimators. Served steps (deck cards) have served: true; every other path the active mode priced on the
 * confirm dice (confirm_checked) is logged with served: false, so a tick with no deck still adds evidence.
 */
export function rbShadowRows(res) {
  const rows = [];
  const seen = new Set();
  const plans = [...(res?.deck ?? []).map(c => [c?.plan, true]), ...(res?.confirm_checked ?? []).map(p => [p, false])];
  for (const [plan, served] of plans) {
    if (!plan?.steps?.length || !plan.steps.every(st => st.title_pair)) continue;
    const id = moveId(res.league, plan);
    if (seen.has(id)) continue;
    seen.add(id);
    let rbBefore = 0, plainBefore = 0;
    plan.steps.forEach((st, i) => {
      const { rb_delta, rb_se, plain_delta, plain_se } = st.title_pair;
      const rbOwn = rb_delta - rbBefore, plainOwn = plain_delta - plainBefore;
      rbBefore = rb_delta; plainBefore = plain_delta;
      const se = Math.hypot(rb_se ?? 0, plain_se ?? 0);
      rows.push({
        week: res.week ?? null, move_id: id, step: i + 1, served,
        rb_delta, rb_se, plain_delta, plain_se,
        rb_own: +rbOwn.toFixed(6), plain_own: +plainOwn.toFixed(6),
        sign_agree: Math.sign(rbOwn) === Math.sign(plainOwn),
        // At 0.1% title odds a plain delta moves in whole runs (1/1200 each): a flip against a plain delta
        // inside its own noise says nothing about RB. The review can read flips where plain clears 2 SE.
        plain_clears_2se: plain_se != null && Math.abs(plain_delta) > 2 * plain_se,
        within_2se: Math.abs(rb_delta - plain_delta) <= 2 * se
      });
    });
  }
  return rows;
}

/** Served rows' { rows, sign_flips, within_2se_share, passes } (the Tuesday rule), and the same over every row. */
export function rbShadowSummary(rows) {
  return { ...rule(rows.filter(r => r.served !== false)), all: rule(rows) };
}

function rule(rows) {
  const n = rows.length;
  const flips = rows.filter(r => !r.sign_agree).length;
  const within = rows.filter(r => r.within_2se).length;
  const share = n ? within / n : null;
  return { rows: n, sign_flips: flips, within_2se_share: share == null ? null : +share.toFixed(3),
    sign_flips_where_plain_clears: rows.filter(r => !r.sign_agree && r.plain_clears_2se).length,
    passes: n > 0 && flips === 0 && share >= 0.9 };
}
