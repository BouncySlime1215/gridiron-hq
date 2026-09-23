/** RL-10-1 stub (RED): the producer is not built yet. */
export const ESPN_ZERO_SOURCE = 'espn_projection_zero';
export function espnZeroInactive() {
  return { covered: false, source: null, reason: 'not built', ids: new Set() };
}
