/**
 * Draft-pick capital.
 *
 * Ported from akodsi/fantasy-advisor (queries._attach_picks + analysis.adjusted_pick_value),
 * with one correction found while porting: a season's picks stop being assets once its
 * rookie draft has been held, so completed-draft seasons are excluded.
 *
 * In dynasty leagues picks are a large share of a team's tradeable capital — leaving them
 * out understates every roster and distorts contention-window comparisons.
 */
import { rows, row } from '../db/index.js';

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];
const SEASONS_AHEAD = 3;
// Fixed-roster leagues (no taxi squad) make every rookie cost an active roster spot,
// so a pick is worth less there than its raw market price.
const NO_TAXI_DISCOUNT = 0.15;

const ordinal = r => ORDINAL[r - 1] ?? `${r}th`;

export function adjustedPickValue(base, taxiSlots) {
  if (!base) return 0;
  return taxiSlots ? base : Math.round(base * (1 - NO_TAXI_DISCOUNT));
}

/** Generic round values for a format: { 'FP_2027_1': 2876, ... } */
function roundValues(formatKey) {
  const m = new Map();
  for (const p of rows('SELECT pick_key, value FROM pick_values WHERE format_key = ?', formatKey)) {
    m.set(p.pick_key, p.value);
  }
  return m;
}

/**
 * Per-team draft pick inventory for a league.
 *
 * Sleeper only: ESPN's API exposes no traded-pick ledger and no rookie-draft
 * structure we can reconstruct, so ESPN leagues get an empty inventory.
 *
 * @returns {Map<string, {picks: object[], picks_value: number}>} keyed by roster id
 */
export function pickInventory(lg, formatKey) {
  const out = new Map();
  if (!lg?.payload) return out;

  const payload = JSON.parse(lg.payload);
  if (lg.platform !== 'sleeper') return out;

  const settings = payload.league?.settings ?? {};
  const rounds = settings.draft_rounds || 3;
  const taxiSlots = settings.taxi_slots ?? 0;
  const startSeason = Number(payload.league?.season || lg.season || new Date().getFullYear());

  // Seasons whose rookie draft is already complete are spent, not owned.
  const drafted = new Set(
    (payload.drafts ?? []).filter(d => d.status === 'complete').map(d => String(d.season))
  );
  const seasons = [];
  for (let i = 0; seasons.length < SEASONS_AHEAD && i < SEASONS_AHEAD + 2; i++) {
    const s = String(startSeason + i);
    if (!drafted.has(s)) seasons.push(s);
  }

  const values = roundValues(formatKey);
  const rosters = payload.rosters ?? [];
  const userById = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
  const ownerName = ro =>
    userById[ro.owner_id]?.metadata?.team_name
    || userById[ro.owner_id]?.display_name
    || `Team ${ro.roster_id}`;

  const nameByRoster = {};
  for (const ro of rosters) {
    const key = String(ro.roster_id);
    out.set(key, { picks: [], picks_value: 0 });
    nameByRoster[key] = ownerName(ro);
  }

  // Sleeper's traded_picks lists only picks that changed hands; `roster_id` is the
  // slot the pick originally belonged to and `owner_id` is who holds it now.
  const reassigned = new Map();
  for (const t of payload.traded_picks ?? []) {
    reassigned.set(`${t.season}|${t.round}|${t.roster_id}`, String(t.owner_id));
  }

  for (const ro of rosters) {
    const origin = String(ro.roster_id);
    for (const season of seasons) {
      for (let rnd = 1; rnd <= rounds; rnd++) {
        const holder = reassigned.get(`${season}|${rnd}|${origin}`) ?? origin;
        const bucket = out.get(holder);
        if (!bucket) continue;   // pick held by a roster that has left the league
        const value = adjustedPickValue(values.get(`FP_${season}_${rnd}`) ?? 0, taxiSlots);
        bucket.picks.push({
          season, round: rnd,
          label: `${season} ${ordinal(rnd)}`,
          value,
          from: holder === origin ? null : nameByRoster[origin]
        });
        bucket.picks_value += value;
      }
    }
  }

  for (const bucket of out.values()) {
    bucket.picks.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
  }
  return out;
}

/** Convenience for callers that only need the total per roster. */
export function pickCapital(lg, formatKey) {
  const inv = pickInventory(lg, formatKey);
  const m = new Map();
  for (const [id, v] of inv) m.set(id, v.picks_value);
  return m;
}
