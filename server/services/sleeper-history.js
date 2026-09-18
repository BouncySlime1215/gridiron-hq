/**
 * Real public-league history from Sleeper — the pure parsing layer.
 *
 * Why it exists (plan section 00, parts D2-D3, Nick 2026-09-18): the Team Outlook has to
 * say how much an early-season record really means, and "real history on fantasy
 * leagues overall and mine" needs more than Nick's 12 league-seasons. Sleeper's
 * public API serves complete historical leagues — weekly matchups, standings, max
 * possible points and playoff brackets — for thousands of real managers.
 *
 * Privacy by construction: nothing here returns a user id, a display name or a team
 * name. The crawler needs user ids only to discover more leagues and keeps them in a
 * crawl queue that it purges when it finishes.
 *
 * Everything is a pure function of the API's own JSON so it can be tested against the
 * real shapes without the network.
 */

/** A missing score is unknown, not zero: Number(null) is 0, which would read as a team that scored nothing. */
const num = v => (v == null || v === '' ? NaN : Number(v));

const MIN_TEAMS = 8;
const MAX_TEAMS = 14;
/** A playoff start before week 12 or after week 17 is a custom format we do not model. */
const PLAYOFF_START = [12, 17];

/** Completed, redraft, managed-lineup NFL leagues of a normal size with real playoffs. */
export function isEligibleLeague(league, { seasons } = {}) {
  if (!league || league.status !== 'complete') return false;
  if (league.sport && league.sport !== 'nfl') return false;
  const season = Number(league.season);
  if (seasons && !seasons.includes(season)) return false;
  const s = league.settings ?? {};
  if (Number(s.type ?? 0) !== 0) return false;            // 0 redraft, 1 keeper, 2 dynasty
  if (Number(s.best_ball ?? 0) === 1) return false;        // no lineup decisions to measure
  const teams = Number(s.num_teams);
  if (!(teams >= MIN_TEAMS && teams <= MAX_TEAMS)) return false;
  const po = Number(s.playoff_teams);
  if (!(po >= 2 && po < teams)) return false;
  const start = Number(s.playoff_week_start);
  if (!(start >= PLAYOFF_START[0] && start <= PLAYOFF_START[1])) return false;
  return true;
}

/** 'ppr' | 'half' | 'std' from the reception value. */
export function scoringType(scoring = {}) {
  const rec = Number(scoring?.rec ?? 0);
  if (rec >= 1) return 'ppr';
  if (rec >= 0.5) return 'half';
  return 'std';
}

/** Weeks 1 .. playoff_week_start - 1. */
export function regularSeasonWeeks(league) {
  const start = Number(league?.settings?.playoff_week_start);
  return Array.from({ length: Math.max(0, start - 1) }, (_, i) => i + 1);
}

/** Every roster id that appears in the winners bracket — first-round teams and bye teams alike. */
export function playoffTeams(bracket) {
  const out = new Set();
  for (const m of bracket ?? []) {
    for (const t of [m.t1, m.t2]) if (Number.isInteger(t)) out.add(t);
  }
  return out;
}

/**
 * The champion: the winner of the placement-1 match; if the bracket carries no placement
 * flags, the winner of the last-round match that is not a consolation game.
 */
export function champion(bracket) {
  if (!Array.isArray(bracket) || !bracket.length) return null;
  const title = bracket.find(m => Number(m.p) === 1);
  if (title) return Number.isInteger(title.w) ? title.w : null;
  const maxRound = Math.max(...bracket.map(m => Number(m.r) || 0));
  const finals = bracket.filter(m => Number(m.r) === maxRound && m.p == null);
  return finals.length === 1 && Number.isInteger(finals[0].w) ? finals[0].w : null;
}

/**
 * All-play per roster per week: the share of the other teams that roster outscored
 * that week (a tie counts half). Returns Map<roster_id, number[]> aligned to `weeks`;
 * a roster with no row in a week gets null for that week.
 */
export function allPlayByWeek(matchupsByWeek, weeks) {
  const out = new Map();
  weeks.forEach((w, i) => {
    const rows = (matchupsByWeek?.[w] ?? []).filter(r => Number.isFinite(num(r.points)));
    for (const r of rows) {
      const others = rows.filter(o => o.roster_id !== r.roster_id);
      const me = Number(r.points);
      const wins = others.reduce((a, o) => a + (me > Number(o.points) ? 1 : me === Number(o.points) ? 0.5 : 0), 0);
      if (!out.has(r.roster_id)) out.set(r.roster_id, new Array(weeks.length).fill(null));
      out.get(r.roster_id)[i] = others.length ? wins / others.length : null;
    }
  });
  return out;
}

const withDecimal = (whole, dec) => (whole == null ? null : Number(whole) + Number(dec ?? 0) / 100);

/**
 * Whether a league actually played, as opposed to being created and closed with
 * `status: 'complete'` but never drafted. Found in the first crawl: 162 of 488
 * stored leagues (33%) had every roster at wins=losses=ties=0, fpts=0 and empty
 * matchup weeks — real example, Sleeper league 1003885794173517824, whose rosters
 * carry `starters: ["0","0",...]` (the placeholder for an empty slot; nobody ever
 * drafted). `isEligibleLeague` cannot catch this: format settings (team count,
 * playoff_teams, playoff_week_start) are set at league creation, before a single
 * game is played. This checks outcomes instead: at least one roster with a
 * non-zero record OR non-zero points is enough (a real NFL season cannot end
 * 0-0-0 for every team with zero points scored by anyone).
 */
export function leaguePlayed(rosters) {
  if (!Array.isArray(rosters) || !rosters.length) return false;
  return rosters.some(r => {
    const s = r?.settings ?? {};
    const record = num(s.wins) || num(s.losses) || num(s.ties);
    const points = withDecimal(s.fpts, s.fpts_decimal);
    return Boolean(record) || (points != null && points > 0);
  });
}


/**
 * Team-season and team-week rows for one league-season.
 * `reg_seed` is the regular-season standing: wins (ties as half) then points for.
 */
export function buildTeamSeasons(league, rosters, matchupsByWeek, bracket) {
  const weeks = regularSeasonWeeks(league);
  const inPlayoffs = playoffTeams(bracket);
  const champ = champion(bracket);
  const teams = (rosters ?? []).map(r => {
    const s = r.settings ?? {};
    const wins = Number(s.wins ?? 0), losses = Number(s.losses ?? 0), ties = Number(s.ties ?? 0);
    return {
      roster_id: r.roster_id,
      wins, losses, ties,
      points_for: withDecimal(s.fpts, s.fpts_decimal),
      points_against: withDecimal(s.fpts_against, s.fpts_against_decimal),
      max_points: s.ppts == null ? null : withDecimal(s.ppts, s.ppts_decimal),
      made_playoffs: inPlayoffs.has(r.roster_id) ? 1 : 0,
      champion: champ === r.roster_id ? 1 : 0,
    };
  });
  const ranked = [...teams].sort((a, b) =>
    (b.wins + b.ties / 2) - (a.wins + a.ties / 2) || (b.points_for ?? 0) - (a.points_for ?? 0));
  ranked.forEach((t, i) => { t.reg_seed = i + 1; });

  const weekRows = [];
  for (const w of weeks) {
    const rows = matchupsByWeek?.[w] ?? [];
    for (const r of rows) {
      const opp = rows.find(o => o.matchup_id != null && o.matchup_id === r.matchup_id && o.roster_id !== r.roster_id);
      weekRows.push({
        roster_id: r.roster_id, week: w,
        points: Number.isFinite(num(r.points)) ? num(r.points) : null,
        opponent_roster_id: opp?.roster_id ?? null,
        starters_json: JSON.stringify(r.starters ?? []),
        players_json: JSON.stringify(r.players ?? []),
      });
    }
  }
  return { teams, weeks: weekRows };
}

/**
 * One week's transactions as rows: trades, waivers (with the bid, including failed bids,
 * which measure competition for a player) and free-agent moves. The `creator` user id is
 * never kept — only roster ids, the players moved, and timestamps.
 */
export function parseTransactions(txs, week) {
  const out = [];
  for (const t of txs ?? []) {
    if (!t || !t.type) continue;
    const created = num(t.created), updated = num(t.status_updated);
    out.push({
      week, type: String(t.type), status: t.status ?? null,
      roster_ids_json: JSON.stringify(t.roster_ids ?? []),
      adds_json: JSON.stringify(t.adds ?? {}),
      drops_json: JSON.stringify(t.drops ?? {}),
      waiver_bid: Number.isFinite(num(t.settings?.waiver_bid)) ? num(t.settings.waiver_bid) : null,
      draft_picks: Array.isArray(t.draft_picks) ? t.draft_picks.length : 0,
      created_ms: Number.isFinite(created) ? created : null,
      latency_ms: Number.isFinite(created) && Number.isFinite(updated) ? updated - created : null,
    });
  }
  return out;
}
