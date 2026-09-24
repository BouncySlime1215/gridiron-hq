/**
 * SELF-01b: the War Room's follow / ignore card ("You, from your own moves").
 *
 * GRIDIRON_SELF_CLONE_ENABLED=1 turns it on. Default off; fly.toml does not set it.
 * Preview mode (preview-mode.js) turns it on too; the view then carries
 * `preview: true` and SELF_CLONE_OFF_REASON as `preview_reason`. It sits inside the
 * War Room, so the route also needs the War Room's own switch (warroom-flag.js).
 * This file is the only reader of GRIDIRON_SELF_CLONE_ENABLED, read per call so a
 * test can flip it.
 *
 * The view reshapes selfBiasFlags() into Fields (the War Room contract, see
 * client/src/components/warroom/types.ts). Held-back candidates are served as a
 * count only: a habit that has not predicted Nick's own later weeks is not shown,
 * not even by name (ENGINE-SPECS SELF-01b "else not shown").
 */
import { selfBiasFlags } from './engine/self-bias.js';
import { previewUnconfirmed, previewFields, previewText } from './preview-mode.js';

export const SELF_CLONE_ENV = 'GRIDIRON_SELF_CLONE_ENABLED';
export const SELF_CLONE_OFF_REASON =
  'The self card is default-off, unconfirmed forward: its thresholds (4 fit, 4 forward, 4-week horizon) '
  + `are guesses and no flag has passed its forward check on real rows yet. Set ${SELF_CLONE_ENV}=1 to switch it on.`;
const PRODUCER = 'self-bias';
const PRODUCER_VERSION = 'self-01b.1';
const SOURCE = 'self.record';

const KIND_LABEL = Object.freeze({
  start_sit: 'Start/sit calls', waiver: 'Waiver calls', trade: 'Trade ideas', next_move: 'War Room next moves',
});
const KIND_ORDER = ['start_sit', 'waiver', 'trade', 'next_move'];

export const NOTE = 'A flag shows only when, fitted on your earlier weeks, it called your later weeks '
  + 'better than the base rate. Endowment and post-loss panic were already ruled out on your record and are not checked.';

const field = (status, value, reason) => {
  const f = { status, source: SOURCE, producer: PRODUCER, producer_version: PRODUCER_VERSION };
  if (status === 'ok') f.value = value;
  if (reason) f.reason = reason;
  return f;
};

/** { enabled } or, when on only because of preview mode, { enabled, preview, preview_reason }. */
export function selfCloneFlag() {
  if (process.env[SELF_CLONE_ENV] === '1') return { enabled: true };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(SELF_CLONE_OFF_REASON) };
  return { enabled: false };
}

const FOLLOW_ABSENT = {
  absent: 'The follow ledger (SELF-01a, migration 082) has not run on this database.',
  empty: 'Nothing recorded yet: no shown call has been resolved for this league.',
};

/**
 * The clone section: LIVING-01a's activity model pointed at his own team, his rows
 * weighted up (ENGINE-SPECS SELF-01b). activity-model.js is not on main yet
 * (#220, superseded by #280), so the section is typed unknown until it is fitted.
 */
export const CLONE_UNFITTED =
  'Not fitted yet: the activity model it runs on (LIVING-01a) has not merged, so there is no model of you to show.';

function regretField(r) {
  if (!r.entries.length) {
    return field('unknown', undefined, 'No settled trade or offer where the choice was yours yet.');
  }
  const scored = r.entries.filter(e => e.realised_regret != null);
  const asOf = r.entries.filter(e => e.as_of_edge != null);
  return field('ok', {
    choices: r.entries.length,
    scored: scored.length,
    open: r.entries.filter(e => e.realised_state === 'horizon_open').length,
    // Positive = the road not taken scored more. Only settled horizons count.
    realised_regret: scored.length ? Math.round(scored.reduce((a, e) => a + e.realised_regret, 0) * 10) / 10 : null,
    regrets: scored.filter(e => e.realised_regret > 0).length,
    as_of_better: asOf.filter(e => e.as_of_edge > 0).length,
    as_of_n: asOf.length,
  });
}

export function warRoomSelf(leagueId) {
  const flag = selfCloneFlag();
  if (!flag.enabled) return { enabled: false };
  const pv = flag.preview ? { preview: true, preview_reason: flag.preview_reason } : {};
  const b = selfBiasFlags(leagueId);

  const kinds = KIND_ORDER.filter(k => b.follow.by_kind[k])
    .map(k => ({ kind: k, label: KIND_LABEL[k], ...b.follow.by_kind[k] }));
  const follow = kinds.length
    ? field('ok', { kinds })
    : field('unknown', undefined, FOLLOW_ABSENT[b.sources.follow_ledger] ?? FOLLOW_ABSENT.empty);

  const noRecord = b.sources.follow_ledger !== 'ok' && b.sources.trade_outcomes !== 'ok';
  const flags = noRecord
    ? field('unknown', undefined, 'No record to read habits from yet: no resolved calls and no settled trades.')
    : field('ok', b.flags);

  const guard = b.concession.guarded.length
    ? field('ok', { reoffers: b.concession.guarded })
    : field('unknown', undefined, b.concession.reoffers
      ? 'No re-offer guard has passed its check on your later weeks yet.'
      : 'No re-offer to a manager who turned you down yet.');
  const clone = field('unknown', undefined, CLONE_UNFITTED);

  return {
    enabled: true, ...pv, league_id: Number(leagueId), follow, flags, held: b.held,
    regret: regretField(b.regret), guard, clone,
    note: flag.preview ? previewText(NOTE) : NOTE,
  };
}
