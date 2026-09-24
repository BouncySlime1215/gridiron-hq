/**
 * BROKEN-E: one chance-to-play reader, `avail.p_play`, with a typed "unknown".
 *
 * Before this, each caller read weeklyAvailability() with its own arguments and
 * filled a missing number with its own `?? 0.92` (trade-engine.js asset build and
 * lineup-diff swap, season-sim.js pool). 0.92 is DEFAULT_ACTIVE_PROBABILITY, a
 * standing constant nothing fitted, and it was served without a label: a player
 * the engine knew nothing about looked like a healthy veteran.
 *
 * Here a player is `ok` (a row priced him from something measured) or `unknown`,
 * with the reason:
 *   - no_row              no availability row at all (unfitted_position)
 *   - no_number           a row with no usable active_probability (unvouched /
 *                         unrecognised, availability-basis.js)
 *   - no_games_no_report  no games on file (durability prior is the constant),
 *                         no injury-report line, and no fitted role cell priced
 *                         him: the row's number is the constant, not a reading.
 * An unknown player carries `p_play: null`. A simulation still needs a number, so
 * the result also carries `value`, which for `unknown` is a labelled prior
 * (fittedUnknownPrior below) and never a silent default.
 *
 * Default off. GRIDIRON_AVAIL_P_PLAY=1 is the ship switch; GRIDIRON_PREVIEW_UNCONFIRMED=1
 * (preview-mode.js) also turns it on and then marks the output preview: true.
 */
import { weeklyAvailability, fittedAvailability } from './contingency.js';
import { DEFAULT_ACTIVE_PROBABILITY } from './availability-basis.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const AVAIL_P_PLAY_ENV = 'GRIDIRON_AVAIL_P_PLAY';
export const AVAIL_P_PLAY_OFF_REASON = 'BROKEN-E avail.p_play: typed unknown with a fitted prior, '
  + 'default off until the prior is read against the live DB';

/** Fewest measured, unlisted players at a position before their mean is used as the prior. */
export const MIN_PRIOR_N = 20;

export const availPPlayEnabled = () => process.env[AVAIL_P_PLAY_ENV] === '1';

/** { on, preview }: on by its own flag, or by preview mode (then preview: true). */
export function availPPlayMode() {
  const own = availPPlayEnabled();
  const preview = !own && previewUnconfirmed();
  return { on: own || preview, preview };
}

/** Why a row (or its absence) says nothing measured about this week, or null when it does. */
export function unknownReason(row) {
  if (!row) return 'no_row';
  if (!Number.isFinite(row.active_probability)) return 'no_number';
  if (row.durability_prior_measured === false && row.report_status == null
    && row.availability_basis !== 'role') return 'no_games_no_report';
  return null;
}

const REASON_BASIS = { no_row: 'unfitted_position', no_games_no_report: 'default_durability' };

/**
 * The prior an unknown player is priced at, most to least informed:
 *   1. the fitted role table's no-report cell at unknown tier (fit on 2021-24
 *      player-weeks, scripts/fit-availability.mjs), with its n;
 *   2. the mean chance to play of this week's measured, unlisted players at the
 *      same position (at least MIN_PRIOR_N of them), then at all positions;
 *   3. nothing to fit: DEFAULT_ACTIVE_PROBABILITY, labelled fitted: false.
 */
export function fittedUnknownPrior({ position = null, rows, fitted = null }) {
  const cell = fitted?.hasRole ? fitted.roleLookup({
    status: 'noreport', practice: 'none', position: position ?? '*', tier: 'unknown', gap: '*'
  }) : null;
  if (cell && Number.isFinite(cell.p)) {
    return { value: +cell.p.toFixed(3), fitted: true, n: cell.n, source: `role fit, no report (${cell.basis}, n=${cell.n})` };
  }
  const known = [...(rows?.values() ?? [])].filter(r => unknownReason(r) == null
    && r.durability_prior_measured === true && r.report_status == null);
  for (const [scope, list] of [[position, known.filter(r => r.position === position)], ['all', known]]) {
    if (scope == null || list.length < MIN_PRIOR_N) continue;
    const mean = list.reduce((s, r) => s + r.active_probability, 0) / list.length;
    return { value: +mean.toFixed(3), fitted: true, n: list.length,
      source: `mean of ${list.length} measured unlisted ${scope === 'all' ? 'QB/RB/WR/TE' : scope} this week` };
  }
  return { value: DEFAULT_ACTIVE_PROBABILITY, fitted: false, n: 0,
    source: 'standing constant: no fitted role table and too few measured players to fit a prior' };
}

/** One player's avail.p_play from his weekly row (or its absence) and the week's prior. */
export function pPlay(row, prior) {
  const reason = unknownReason(row);
  if (reason == null) {
    return { status: 'ok', p_play: row.active_probability, value: row.active_probability,
      basis: row.availability_basis ?? null };
  }
  const basis = REASON_BASIS[reason]
    ?? (row?.availability_basis ? 'unvouched' : 'unrecognised');
  return { status: 'unknown', p_play: null, value: prior.value, basis, reason, prior };
}

/**
 * The one entry point: every caller reads the same week through the same
 * arguments (through = season - 1, role and ESPN on), so two pages cannot price
 * the same player-week off different rows.
 */
export function availPPlayWeek(season, week, { rows = null, fitted = undefined, preview = false } = {}) {
  const table = rows ?? weeklyAvailability(season, week, { through: season - 1 });
  const fit = fitted === undefined ? fittedAvailability() : fitted;
  const priors = new Map();
  const priorFor = position => {
    if (!priors.has(position)) priors.set(position, fittedUnknownPrior({ position, rows: table, fitted: fit }));
    return priors.get(position);
  };
  const tag = preview ? previewFields(AVAIL_P_PLAY_OFF_REASON) : null;
  return {
    season, week, rows: table,
    of(playerId, position = null) {
      const row = table.get(playerId);
      const out = pPlay(row, priorFor(row?.position ?? position));
      return tag ? { ...out, ...tag } : out;
    }
  };
}

/** The JSON a caller serves: status, the number or null, and the labelled prior when unknown. */
export function pPlayJson(pp) {
  const { value, ...rest } = pp;
  return rest.status === 'ok' ? { ...rest, p_play: +rest.p_play.toFixed(3) } : rest;
}
