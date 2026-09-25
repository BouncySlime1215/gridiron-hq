/**
 * BITEMPORAL (ONE-PLAN 4d night 7): the carried-in record, checked against ESPN's.
 *
 * season-sim.js#initialRecords re-derives each team's wins and points-for from
 * `payload.schedule` and carries them into every title-odds run. ESPN publishes
 * its own official record on `payload.teams[].record.overall`. Nothing compared
 * the two, so a stat correction, a tie rule or a median-game rule read differently
 * would move every title number with no sign on any surface.
 *
 * This is a check, not a second producer: it reads the records season-sim already
 * built and reports per roster id where they differ. It never replaces them.
 * Served only under GRIDIRON_STANDINGS_RECONCILE=1 (shadow) until a league-4 run
 * has shown what it says; roster ids only, no team or manager names.
 */

export const STANDINGS_RECONCILE_ENV = 'GRIDIRON_STANDINGS_RECONCILE';
export const STANDINGS_RECONCILE_VERSION = 'standings-reconcile-v1';

// Points are stored to two decimals by ESPN; anything under a cent is float noise.
const PF_TOLERANCE = 0.01;

/**
 * @param lg        league row ({ platform, payload })
 * @param derived   Map roster_id -> { w, pf } as season-sim carries it in
 * @param opts      { fromWeek, medianGame }: the window the derived record covers
 */
export function reconcileStandings(lg, derived, { fromWeek, medianGame = false } = {}) {
  const base = { version: STANDINGS_RECONCILE_VERSION, from_week: fromWeek };
  const weeks = Math.max(0, Number(fromWeek) - 1);
  if (!weeks) return { ...base, status: 'nothing_carried_in', mismatches: [] };
  if (lg?.platform !== 'espn') return { ...base, status: 'unsupported_platform', mismatches: [] };

  let payload;
  try { payload = JSON.parse(lg.payload ?? 'null'); }
  catch (e) { return { ...base, status: 'payload_unreadable', error: e.message, mismatches: [] }; }
  const official = new Map();
  for (const t of payload?.teams ?? []) {
    const rec = t?.record?.overall;
    if (t?.id == null || !rec || !Number.isFinite(Number(rec.wins))) continue;
    official.set(String(t.id), rec);
  }
  if (!official.size) return { ...base, status: 'no_official_record', mismatches: [] };

  // ESPN's record covers the weeks it has scored; the sim's covers weeks before
  // fromWeek. When the game counts differ the two windows differ, and comparing
  // them would report a false mismatch.
  const expectedGames = weeks * (medianGame ? 2 : 1);
  const games = rec => Number(rec.wins) + Number(rec.losses ?? 0) + Number(rec.ties ?? 0);
  const offWindow = [...official.entries()].filter(([, rec]) => games(rec) !== expectedGames)
    .map(([id, rec]) => ({ roster_id: id, official_games: games(rec) }));
  if (offWindow.length) {
    return { ...base, status: 'window_differs', weeks_compared: 0, expected_games: expectedGames,
      off_window: offWindow, mismatches: [] };
  }

  const mismatches = [];
  const missing = [];
  let checked = 0;
  for (const [id, rec] of official) {
    const d = derived?.get?.(id);
    if (!d) { missing.push(id); continue; }
    checked++;
    const officialW = Number(rec.wins) + 0.5 * Number(rec.ties ?? 0);
    const officialPf = Number(rec.pointsFor);
    const wDiff = d.w - officialW;
    const pfDiff = Number.isFinite(officialPf) ? +(d.pf - officialPf).toFixed(2) : null;
    if (wDiff !== 0 || (pfDiff != null && Math.abs(pfDiff) > PF_TOLERANCE)) {
      mismatches.push({ roster_id: id, derived_w: d.w, official_w: officialW, w_diff: wDiff,
        derived_pf: +d.pf.toFixed(2), official_pf: Number.isFinite(officialPf) ? officialPf : null,
        pf_diff: pfDiff });
    }
  }
  return { ...base, status: mismatches.length || missing.length ? 'mismatch' : 'match',
    weeks_compared: weeks, teams_checked: checked, missing_from_derived: missing, mismatches };
}

/** The season-sim field: `{}` unless the flag is on, so no served output changes by default. */
export function standingsCheckField(lg, derived, fromWeek, medianGame) {
  if (process.env[STANDINGS_RECONCILE_ENV] !== '1') return {};
  return { standings_check: { shadow: true, ...reconcileStandings(lg, derived, { fromWeek, medianGame }) } };
}
