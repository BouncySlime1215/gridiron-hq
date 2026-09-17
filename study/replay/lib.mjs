/**
 * Replay study — data layer.
 *
 * Loads the two things the study rests on and nothing else:
 *   - every skill player's ACTUAL weekly fantasy points, 2021-2025, scored for
 *     whatever format is being replayed
 *   - a point-in-time PRESEASON consensus rank per season (FantasyPros ECR via
 *     DynastyProcess, scraped late August — verified: 2024 snapshot is dated
 *     2024-08-30, so a simulated drafter knows nothing a real one did not)
 *
 * Outcomes are held fixed. The replay randomises only the things that are
 * genuinely luck: draft order, which manager takes whom, and the schedule.
 *
 * See docs/WHAT-WINS-STUDY.md for why the design looks like this.
 */
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import('../../server/db/index.js');
const { PPR, HALF_PPR, STANDARD, scoreLine } = await import('../../server/services/scoring.js');
const adpModule = await import('../../server/services/historical-adp.js');

export const SCORING = { ppr: PPR, half: HALF_PPR, standard: STANDARD };

/**
 * Name matching between two sources that punctuate differently.
 *
 * Raw lowercase matched only 75% of skill-position ADP rows to weekly usage;
 * the misses were all punctuation and suffixes ("Ja'Marr Chase", "A.J. Brown",
 * "Marvin Harrison Jr."). Stripping both, plus suffixes, is what closes it.
 * The match rate is reported on every load so a silent regression in either
 * source shows up immediately rather than as a quietly shallower draft pool.
 */
export function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g, ' ')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * One season of real outcomes plus the preseason market.
 *
 * `weekly` is indexed by week; a missing week is null (bye, injury, not on a
 * roster) and is NOT zero — the distinction matters because a zero is a real
 * bad game and a null is an absence, and conflating them breaks both the
 * volatility statistics and the "live players" count.
 */
export function loadSeason(season, scoringKey = 'half') {
  const scoring = SCORING[scoringKey] ?? HALF_PPR;
  const usage = rows(`SELECT u.*, p.name, p.position
                      FROM player_week_usage u JOIN players p ON p.id = u.player_id
                      WHERE u.season = ? AND p.position IN ('QB','RB','WR','TE')`, season);
  const byPlayer = new Map();
  for (const u of usage) {
    const key = normName(u.name);
    if (!key) continue;
    let rec = byPlayer.get(key);
    if (!rec) { rec = { key, name: u.name, pos: u.position, weekly: {} }; byPlayer.set(key, rec); }
    rec.weekly[u.week] = scoreLine(u, scoring);
  }

  const adpRaw = (adpModule.historicalAdpFor(season) ?? [])
    .filter(a => POSITIONS.has(a.position));
  let matched = 0;
  const adp = [];
  for (const a of adpRaw) {
    const key = normName(a.name ?? a.player_key);
    const rec = byPlayer.get(key);
    if (rec) {
      matched++;
      rec.adp = a.ecr_rank;
      rec.adp_sd = a.ecr_std_dev;
      adp.push(rec);
    } else {
      // A drafted player with no weekly rows really did score nothing for us
      // (retired, never played, or a name we cannot resolve). Keeping them in
      // the pool with an empty season is the honest representation: real
      // drafters took these picks and got nothing.
      adp.push({ key, name: a.name, pos: a.position, weekly: {}, adp: a.ecr_rank, adp_sd: a.ecr_std_dev, unmatched: true });
    }
  }
  adp.sort((x, y) => x.adp - y.adp);

  // Undrafted players are the waiver pool. Without them, "live players" and any
  // in-season churn rule are meaningless.
  const drafted = new Set(adp.map(p => p.key));
  const pool = [...byPlayer.values()].filter(p => !drafted.has(p.key));

  const weeks = [...new Set(usage.map(u => u.week))].sort((a, b) => a - b);
  return {
    season, scoringKey, weeks,
    adp, pool, byPlayer,
    match_rate: adpRaw.length ? +(matched / adpRaw.length).toFixed(3) : 0,
    n_adp: adp.length, n_pool: pool.length,
  };
}

/** Points in a given week, or null if the player has no row that week. */
export const pointsIn = (player, week) => {
  const v = player.weekly[week];
  return v == null ? null : v;
};

/** Played weeks only — the basis for CV, per the literature. */
export function playedStats(player, weeks) {
  const vals = weeks.map(w => player.weekly[w]).filter(v => v != null);
  if (!vals.length) return { games: 0, mean: 0, sd: 0, cv: null, total: 0 };
  const total = vals.reduce((a, b) => a + b, 0);
  const mean = total / vals.length;
  const sd = vals.length > 1
    ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1)) : 0;
  return { games: vals.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), cv: mean ? +(sd / mean).toFixed(3) : null, total: +total.toFixed(1) };
}

/** Deterministic PRNG so a run can be reproduced exactly from its seed. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Box-Muller, for ADP noise. */
export function randn(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
