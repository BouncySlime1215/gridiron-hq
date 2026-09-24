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
 */
export const BAD_NEWS_P = 0.3;
export const WAIT_DAYS = 2;

/** step: { get: ids, delta }; players: id -> { injury, trend_kind, name } */
export function waitOrAct(step, players) {
  const P = id => players.get(String(id)) ?? players.get(Number(id)) ?? {};
  const flagged = step.get.filter(id => P(id).injury);
  const role = step.get.filter(id => !P(id).injury && P(id).trend_kind);
  if (!flagged.length && !role.length) return { flag: 'act', days: 0, option_value: 0, reason: 'no pending news on the players you get' };
  const gain = Math.max(0, step.delta ?? 0);
  const who = [...flagged, ...role].map(id => P(id).name ?? `player ${id}`).join(', ');
  return {
    flag: 'wait', days: WAIT_DAYS,
    option_value: BAD_NEWS_P * gain, option_value_basis: `guess: ${BAD_NEWS_P} chance the news is bad (hand-set)`,
    reason: flagged.length ? `${who} carries an injury flag; the report lands before his next game`
      : `${who} has role news trending; let it settle`,
  };
}
