/**
 * Which of four states the player-usage backfill is actually in.
 *
 * The existing banner asks one question — did every bootstrap source run? —
 * and `GET /api/model/setup-status` answers it by counting sources whose
 * `last_status` is `'never run'`. A source that ran, reported `ok`, and wrote
 * **nothing** is therefore indistinguishable from a healthy one: `needs_setup`
 * comes back false, the banner never renders, and the app projects this season
 * off whatever season it last had rows for, saying nothing.
 *
 * That is not hypothetical. It is the state this install is in: the weekly
 * usage source is stamped `ok` while `player_week_usage` holds 2021–2025 rows
 * and none for the season being played.
 *
 * So four states, and the fourth is the one that matters:
 *
 *   healthy      rows for the season being played, up to about the current week
 *   never_run    the source has not run — a fresh clone, and a retry fixes it
 *   stale        it ran and has rows, but they stop short of the current week
 *   ok_no_rows   it reports success and the table has no rows for this season
 *
 * They are mutually exclusive and tested one by one. `ok_no_rows` deliberately
 * does NOT offer "Update now": running the same pull again is what produced the
 * nothing, and a button that cannot help is worse than no button, because a
 * person who presses it and sees the banner persist learns to ignore banners.
 *
 * Plain `.js` with a `.d.ts` beside it, as with the other decision helpers on
 * this stack: node:test has no build step and cannot import a `.tsx`.
 */

/** @type {readonly string[]} */
const KNOWN = ['healthy', 'never_run', 'stale', 'ok_no_rows'];

export function coverageState(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  const state = String(coverage.state ?? '');
  // An unrecognised state is not quietly treated as healthy. A server that
  // grows a fifth state should surface as something a reader can ask about,
  // not vanish — the same rule the availability vocabulary follows.
  if (!KNOWN.includes(state)) return 'unrecognised';
  return state;
}

/** Whether re-running the pull could plausibly change anything. */
export function canRetry(state) {
  return state === 'never_run' || state === 'stale';
}

/**
 * The headline for each state, in a manager's words rather than a schema's.
 *
 * Each names the season and week it is talking about, because "missing data"
 * with no year in it is what let this go unnoticed.
 */
export function coverageHeadline(state, coverage) {
  const season = coverage?.season ?? null;
  const upTo = coverage?.latest_week ?? null;
  const week = coverage?.league_week ?? null;
  switch (state) {
    case 'never_run':
      return 'This install is missing historical model data';
    case 'stale':
      return season && upTo && week
        ? `Player usage stops at week ${upTo}; this league is on week ${week}`
        : 'Player usage has not caught up to the current week';
    case 'ok_no_rows':
      return season
        ? `Player usage reports that it updated, but holds no ${season} rows at all`
        : 'Player usage reports that it updated, but holds no rows for this season';
    case 'unrecognised':
      return 'Player usage is in a state this build does not recognise';
    default:
      return null;
  }
}

/** What the person reading it should understand, and what to do. */
export function coverageDetail(state, coverage) {
  const season = coverage?.season ?? null;
  const had = coverage?.seasons_with_rows;
  switch (state) {
    case 'never_run':
      return 'None of it ships in the repository — it only exists once the one-time backfill has run.';
    case 'stale':
      return 'Recent weeks are being projected from older ones until this catches up.';
    case 'ok_no_rows':
      return 'Running it again produces the same nothing: the pull already believes it succeeded. '
        + (Array.isArray(had) && had.length
          ? `Every number that needs this season's usage is coming from ${had.join(', ')} instead. `
          : 'Every number that needs this season\'s usage is coming from an earlier season instead. ')
        + 'Someone has to find out why it reports success with no rows.';
    case 'unrecognised':
      return 'It is being shown rather than hidden, because a state nobody planned for is not the same as a healthy one.';
    default:
      return null;
  }
}
