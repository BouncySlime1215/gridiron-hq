/**
 * One way to decide whether two player records are the same person.
 *
 * The ESPN player sync used to match on `lower(name) = lower(?) AND position = ?` and
 * take the first row back. That is wrong in both directions:
 *
 *   - Too strict: ESPN writes "Ja'Marr Chase" with a curly apostrophe and the seed data
 *     uses a straight one, so the two never matched and the sync inserted a second row.
 *     The app then treats them as different people — real drafts here ended up with
 *     Ja'Marr Chase's picks split across two player ids, which breaks rosters, "already
 *     drafted" checks and every downstream valuation.
 *   - Too loose: with two genuine same-name, same-position players (which the NFL does
 *     have), `row(...)` silently returns whichever came first and the sync rebinds that
 *     row's espn_id to the wrong human.
 *
 * Matching on the stable id first, then a normalized name, and refusing to guess when
 * candidates are genuinely ambiguous, fixes both.
 */

/**
 * Casefold a player name down to something comparable across sources.
 *
 * Strips diacritics before removing punctuation so "José" and "Jose" agree (dropping
 * non-letters first would leave "jos" vs "jose"). Suffixes go too: ESPN and Sleeper
 * disagree constantly about "Jr."/"Jr"/"" and "III"/"3rd".
 */
export function normalizePlayerName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // é -> e, before punctuation is dropped
    .toLowerCase()
    // Removed outright, not turned into spaces: "A.J." must collapse to "aj" to match
    // "AJ", and an apostrophe never separates words ("Ja'Marr" -> "jamarr").
    .replace(/[‘’ʼ'`.]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')                        // hyphens and anything else -> space
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')            // generational suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the existing player row an incoming record refers to.
 *
 * @param candidates rows with at least {id, name, position, team_id, espn_id}
 * @param incoming   {espn_id, name, position, team_id}
 * @returns {{match, ambiguous, candidates}} — `match` is null when nothing fits, and
 *          `ambiguous` is true when several rows fit equally well and the caller must
 *          not just pick one.
 */
export function findPlayerMatch(candidates, incoming) {
  const { espn_id, name, position, team_id } = incoming;

  // 1. The stable id wins outright. Without this a name collision could move an
  //    espn_id off the player it actually belongs to.
  if (espn_id != null) {
    const byId = candidates.find(c => c.espn_id != null && Number(c.espn_id) === Number(espn_id));
    if (byId) return { match: byId, ambiguous: false, candidates: [byId] };
  }

  const wanted = normalizePlayerName(name);
  if (!wanted) return { match: null, ambiguous: false, candidates: [] };

  let pool = candidates.filter(c =>
    c.position === position && normalizePlayerName(c.name) === wanted);

  if (pool.length === 0) return { match: null, ambiguous: false, candidates: [] };
  if (pool.length === 1) return { match: pool[0], ambiguous: false, candidates: pool };

  // Several rows share this name and position. Never rebind a row that already belongs
  // to a *different* ESPN player — that row is a known, distinct human.
  const free = pool.filter(c => c.espn_id == null || Number(c.espn_id) === Number(espn_id));
  if (free.length === 1) return { match: free[0], ambiguous: false, candidates: pool };
  const narrowed = free.length ? free : pool;

  // Same NFL team is strong evidence it's the same person.
  if (team_id != null) {
    const sameTeam = narrowed.filter(c => c.team_id === team_id);
    if (sameTeam.length === 1) return { match: sameTeam[0], ambiguous: false, candidates: pool };
  }

  // Genuinely can't tell them apart — say so instead of silently taking the first.
  return { match: null, ambiguous: true, candidates: pool };
}
