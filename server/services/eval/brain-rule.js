/**
 * EVAL-01 fallback rule, as one pure function the campaign producer calls.
 *
 *   any check 'failing'  -> risk mode falls back to BALANCED, TESTING-tier signals off
 *
 * Fail closed: a report that is missing, stale, or has a grader that could not
 * run is treated the same way, because "we could not look" is not "nothing is
 * failing". SAFE is never raised to BALANCED: it is already the stricter mode,
 * so the fallback only ever lowers risk.
 *
 * A check whose detail says `shadow_only` grades a unit that serves nothing yet
 * (LIVING-01b's re-gate, eval/living-gate.js): its failing means "do not promote
 * that unit", not "a served number is wrong", so it never lowers the mode. It is
 * listed in `shadow` (GET /api/brain-report shows the rows themselves).
 *
 * Mode ids: 'safe', 'balanced', 'all_in' (the spec's "FUCK IT, LET'S GO" tail
 * mode, CAMPAIGN-01d). TESTING-tier signals exist only in the tail mode.
 *
 * No database, no clock: the caller passes the report and `now`.
 */
export const RISK_MODES = Object.freeze({ SAFE: 'safe', BALANCED: 'balanced', ALL_IN: 'all_in' });
export const REPORT_MAX_AGE_HOURS = 48;

export function brainReportRule({ requestedMode, report, now }) {
  if (!Object.values(RISK_MODES).includes(requestedMode)) throw new Error(`unknown risk mode: ${requestedMode}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('brainReportRule needs now as a valid Date');
  const blocking = [];
  const shadow = [];
  if (!report || !Array.isArray(report.checks) || !report.checks.length) {
    blocking.push({ check: null, reason: 'no brain report has been computed yet' });
  } else {
    const ageH = (now.getTime() - Date.parse(report.computed_at)) / 3_600_000;
    if (Number.isFinite(ageH) && ageH < -1) {
      blocking.push({ check: null, reason: 'brain report is dated in the future (clock skew)' });
    } else if (!Number.isFinite(ageH) || ageH > REPORT_MAX_AGE_HOURS) {
      blocking.push({ check: null, reason: `brain report is stale (${Number.isFinite(ageH) ? `${Math.round(ageH)} h` : 'no timestamp'}; limit ${REPORT_MAX_AGE_HOURS} h)` });
    }
    for (const c of report.checks) {
      if (c.detail?.shadow_only === true) {
        if (c.status === 'failing' || c.detail?.grader_error) shadow.push({ check: c.check, status: c.detail?.grader_error ? 'grader_error' : c.status });
        continue;
      }
      if (c.status === 'failing') blocking.push({ check: c.check, reason: `${c.check} ${c.name ?? ''} is failing`.replace(/\s+/g, ' ').trim() });
      else if (c.detail?.grader_error) blocking.push({ check: c.check, reason: `${c.check} grader could not run: ${c.detail.grader_error}` });
    }
  }
  if (blocking.length) {
    const mode = requestedMode === RISK_MODES.SAFE ? RISK_MODES.SAFE : RISK_MODES.BALANCED;
    return {
      mode,
      testing_tier_enabled: false,
      fell_back: mode !== requestedMode,
      blocking,
      shadow,
      reason: `${mode === requestedMode ? 'Kept' : 'Fell back to'} ${mode}; testing-tier signals off: ${blocking.map(b => b.reason).join('; ')}`,
    };
  }
  return {
    mode: requestedMode,
    testing_tier_enabled: requestedMode === RISK_MODES.ALL_IN,
    fell_back: false,
    blocking: [],
    shadow,
    reason: 'no check is failing',
  };
}
