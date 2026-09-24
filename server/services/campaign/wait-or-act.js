/**
 * North-star row 18: wait-or-act for pending injury / role news (pure, simple version).
 *
 * A step whose incoming player carries an injury flag (or trending role news)
 * gets "wait N days": the news lands before the next game, and buying before
 * it resolves pays full price for a player who may not play. The option value
 * of waiting is the part of the step's gain that the bad news would erase:
 * P(bad news) x the step's gain. P(bad news) is a hand-set guess
 * (BAD_NEWS_P), labelled as such, until an injury-outcome model exists.
 * A flagged player Nick GIVES does not trigger a wait (the report is public;
 * the other side can read it too).
 *
 * FEAS-140: R&D r24 KILLED this idea (IDEA-151: the 2024 CI of waiting vs acting
 * on Q/D/Out spans 0). The timing call now sits behind its own flag,
 * GRIDIRON_WAIT_OR_ACT ('1' on; default off; the preview switch does NOT turn a
 * killed idea on). Callers ask waitOrActOn() and pass { enabled }; with it off a
 * step with pending news reads "act", naming the news and the kill. Any "wait N
 * days" that is still produced (flag on, or a caller that passes no options) is
 * labelled untested: `untested: true` and the reason starts "untested".
 */
export const BAD_NEWS_P = 0.3;
export const WAIT_DAYS = 2;
export const WAIT_OR_ACT_ENV = 'GRIDIRON_WAIT_OR_ACT';
export const KILLED_BY = 'R&D r24 (IDEA-151): waiting on the news tested no better than acting';

/** True only when GRIDIRON_WAIT_OR_ACT is exactly '1'. */
export const waitOrActOn = (env = process.env) => env[WAIT_OR_ACT_ENV] === '1';

/**
 * step: { get: ids, delta }; players: id -> { injury, trend_kind, name }
 * opts.enabled: false -> never "wait" (the planner passes waitOrActOn()). Omitted -> the
 * legacy behaviour, still labelled untested.
 */
export function waitOrAct(step, players, { enabled = true } = {}) {
  const P = id => players.get(String(id)) ?? players.get(Number(id)) ?? {};
  const flagged = step.get.filter(id => P(id).injury);
  const role = step.get.filter(id => !P(id).injury && P(id).trend_kind);
  if (!flagged.length && !role.length) return { flag: 'act', days: 0, option_value: 0, reason: 'no pending news on the players you get' };
  const who = [...flagged, ...role].map(id => P(id).name ?? `player ${id}`).join(', ');
  const news = flagged.length ? `${who} carries an injury flag` : `${who} has role news trending`;
  if (!enabled) {
    return { flag: 'act', days: 0, option_value: 0, wait_or_act: 'off', killed_by: KILLED_BY,
      reason: `${news}; no timing call: ${KILLED_BY}` };
  }
  const gain = Math.max(0, step.delta ?? 0);
  return {
    flag: 'wait', days: WAIT_DAYS, untested: true, killed_by: KILLED_BY,
    option_value: BAD_NEWS_P * gain, option_value_basis: `guess: ${BAD_NEWS_P} chance the news is bad (hand-set)`,
    reason: flagged.length ? `untested (${KILLED_BY}): ${news}; the report lands before his next game`
      : `untested (${KILLED_BY}): ${news}; let it settle`,
  };
}
