/**
 * SELF-01b: the War Room's follow / ignore card ("You, from your own moves").
 *
 * GRIDIRON_SELF_CLONE_ENABLED=1 turns it on. Default off; fly.toml does not set it.
 * It sits inside the War Room, so the route also needs the War Room's own switch
 * (warroom-flag.js). This file is the only reader of GRIDIRON_SELF_CLONE_ENABLED,
 * read per call so a test can flip it.
 *
 * The view reshapes selfBiasFlags() into Fields (the War Room contract, see
 * client/src/components/warroom/types.ts). Held-back candidates are served as a
 * count only: a habit that has not predicted Nick's own later weeks is not shown,
 * not even by name (ENGINE-SPECS SELF-01b "else not shown").
 */
import { selfBiasFlags } from './engine/self-bias.js';

export const SELF_CLONE_ENV = 'GRIDIRON_SELF_CLONE_ENABLED';
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

export function selfCloneFlag() {
  return { enabled: process.env[SELF_CLONE_ENV] === '1' };
}

const FOLLOW_ABSENT = {
  absent: 'The follow ledger (SELF-01a, migration 081) has not run on this database.',
  empty: 'Nothing recorded yet: no shown call has been resolved for this league.',
};

export function warRoomSelf(leagueId) {
  if (!selfCloneFlag().enabled) return { enabled: false };
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

  return { enabled: true, league_id: Number(leagueId), follow, flags, held: b.held, note: NOTE };
}
