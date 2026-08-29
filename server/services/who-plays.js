/**
 * Who is playing this week, and how confident we are about each answer.
 *
 * The information exists and it is scattered. The official injury report says
 * Out, Doubtful or Questionable. The transaction wire says released or placed
 * on IR. Typed news signals from beat reporters say a player was limited in
 * practice or is expected to play. Snap counts say how much a player matters if
 * he does. Nothing joined them, so a lineup decision meant opening four screens
 * and doing it by eye.
 *
 * This joins them into one answer per player, with the sources it came from and
 * an honest confidence attached.
 *
 * THE PRECEDENCE RULE, which is the part that matters: the official report
 * outranks a beat reporter, and a beat reporter outranks an inference from snap
 * counts. When two sources disagree the conflict is REPORTED rather than
 * silently resolved, because a coach saying "we'll see" while a reporter says
 * "expected to play" is genuinely uncertain, and flattening that into a single
 * number would invent confidence nobody has.
 */
import { rows, row } from '../db/index.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Play probability implied by an official designation.
 *
 * These are the league-wide historical rates, and they are far from the
 * intuitive reading: Questionable is genuinely close to a coin flip in name
 * only — most Questionable players play.
 */
const STATUS_PLAY_PROBABILITY = {
  OUT: 0.0,
  DOUBTFUL: 0.06,
  QUESTIONABLE: 0.72,
  'INJURED RESERVE': 0.0,
  PUP: 0.0
};

/** How much a source is trusted when sources disagree. */
const SOURCE_RANK = { official: 3, transaction: 3, news: 2, snaps: 1 };

/**
 * Everything known about who plays for one team this week.
 *
 * @param week  the week whose report to read. Injury reports are published
 *   before kickoff, so reading week W for a week-W game is legitimate.
 */
export function whoPlays(season, week, team) {
  const t = String(team ?? '').toUpperCase();

  // 1. The official report. Highest authority.
  const official = rows(
    `SELECT full_name, position, report_status, practice_status, injury
     FROM nfl_injuries
     WHERE season = ? AND week = ? AND UPPER(team) = ? AND report_status IS NOT NULL`,
    season, week, t);

  // 2. Typed news signals — beat reporters and insiders, already extracted.
  const news = rows(
    `SELECT player_name, signal_type, status, unavailable_probability, role_delta,
            confidence, published_at, source
     FROM nfl_news_signals
     WHERE UPPER(team) = ? ORDER BY published_at DESC`, t);

  // 3. Snap share, which decides whether an absence actually matters.
  const snaps = rows(
    `SELECT player, position, AVG(offense_pct) AS pct FROM nfl_snaps
     WHERE season = ? AND week < ? AND UPPER(team) = ?
     GROUP BY player, position`, season, week, t);
  const snapOf = new Map(snaps.map(s => [String(s.player).toLowerCase(), s.pct ?? 0]));

  const byPlayer = new Map();
  const add = (name, entry) => {
    const key = String(name ?? '').toLowerCase().trim();
    if (!key) return;
    if (!byPlayer.has(key)) {
      byPlayer.set(key, { player: name, sources: [], snap_share: r4(snapOf.get(key) ?? null) });
    }
    byPlayer.get(key).sources.push(entry);
  };

  for (const o of official) {
    const status = String(o.report_status ?? '').toUpperCase();
    add(o.full_name, { source: 'official', rank: SOURCE_RANK.official,
      status, position: o.position, injury: o.injury,
      practice: o.practice_status,
      play_probability: STATUS_PLAY_PROBABILITY[status] ?? null });
  }

  for (const n of news) {
    // A signal only speaks to availability if it carries a probability.
    if (!Number.isFinite(n.unavailable_probability)) continue;
    add(n.player_name, { source: 'news', rank: SOURCE_RANK.news,
      status: n.status, signal: n.signal_type,
      published_at: n.published_at, reporter: n.source,
      play_probability: clamp(1 - n.unavailable_probability, 0, 1),
      confidence: n.confidence });
  }

  const players = [...byPlayer.values()].map(p => {
    // The highest-ranked source that has an opinion wins; ties go to the newest.
    const ranked = [...p.sources].sort((a, b) =>
      (b.rank - a.rank) || String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
    const lead = ranked.find(s => Number.isFinite(s.play_probability)) ?? ranked[0];

    // Disagreement is reported, not resolved. Two sources more than 30 points
    // apart on the same player is real uncertainty and pretending otherwise is
    // how a lineup gets set on a number nobody stands behind.
    const probs = ranked.map(s => s.play_probability).filter(Number.isFinite);
    const spread = probs.length > 1 ? Math.max(...probs) - Math.min(...probs) : 0;

    return {
      player: p.player,
      position: ranked.find(s => s.position)?.position ?? null,
      snap_share: p.snap_share,
      play_probability: r4(lead?.play_probability ?? null),
      decided_by: lead?.source ?? null,
      official_status: ranked.find(s => s.source === 'official')?.status ?? null,
      injury: ranked.find(s => s.injury)?.injury ?? null,
      practice: ranked.find(s => s.practice)?.practice ?? null,
      sources_count: ranked.length,
      sources_disagree: spread > 0.3,
      disagreement_spread: spread > 0.3 ? r4(spread) : null,
      // What his absence would actually cost, which is the number a lineup
      // decision needs rather than the designation itself.
      expected_snaps_lost: r4((p.snap_share ?? 0) * (1 - (lead?.play_probability ?? 1))),
      sources: ranked
    };
  });

  const out = players.filter(p => (p.play_probability ?? 1) < 0.5);
  const questionable = players.filter(p =>
    (p.play_probability ?? 1) >= 0.5 && (p.play_probability ?? 1) < 0.95);

  return {
    season, week, team: t,
    players_flagged: players.length,
    out: out.sort((a, b) => (b.snap_share ?? 0) - (a.snap_share ?? 0)),
    questionable: questionable.sort((a, b) => (b.snap_share ?? 0) - (a.snap_share ?? 0)),
    conflicts: players.filter(p => p.sources_disagree),
    // The aggregate a projection actually consumes.
    expected_snaps_lost: r4(players.reduce((s, p) => s + (p.expected_snaps_lost ?? 0), 0)),
    note: 'Official report outranks a beat reporter, which outranks an inference from snap counts. ' +
      'Where sources disagree by more than thirty points the conflict is reported rather than ' +
      'averaged away — that is real uncertainty, and flattening it would invent confidence.',
    caveat: official.length ? undefined
      : `No official injury report stored for ${season} week ${week}. Reports cover 2023-2025 in ` +
        'this database, so an earlier or later week falls back to news signals alone.'
  };
}

/** The whole slate, ranked by how much availability is in doubt. */
export function slateAvailability(season, week) {
  const teams = rows(`SELECT DISTINCT team FROM nfl_injuries WHERE season = ? AND week = ?`,
    season, week).map(r => r.team);
  if (!teams.length) {
    return { error: `no injury report stored for ${season} week ${week}`,
      seasons_available: rows(`SELECT DISTINCT season FROM nfl_injuries ORDER BY season`)
        .map(r => r.season) };
  }
  const all = teams.map(t => {
    const w = whoPlays(season, week, t);
    return { team: t, out: w.out.length, questionable: w.questionable.length,
      conflicts: w.conflicts.length, expected_snaps_lost: w.expected_snaps_lost,
      biggest_absence: w.out[0] ? { player: w.out[0].player, position: w.out[0].position,
        snap_share: w.out[0].snap_share } : null };
  }).sort((a, b) => (b.expected_snaps_lost ?? 0) - (a.expected_snaps_lost ?? 0));

  return { season, week, teams: all.length, teams_ranked: all,
    note: 'Ranked by expected snaps lost rather than by headcount — four missing special-teamers is ' +
      'not the same as a missing quarterback, and only the weighted version is decision-relevant.' };
}

/** What the availability pipeline can currently see. */
export function availabilitySources() {
  const inj = row(`SELECT COUNT(*) AS n, MIN(season) AS lo, MAX(season) AS hi FROM nfl_injuries`) ?? {};
  const news = row(`SELECT COUNT(*) AS n, MAX(published_at) AS last FROM nfl_news_signals`) ?? {};
  const snaps = row(`SELECT COUNT(*) AS n FROM nfl_snaps`) ?? {};
  let sources = null;
  try {
    sources = row(`SELECT COUNT(*) AS n, SUM(CASE WHEN verdict='valid' THEN 1 ELSE 0 END) AS valid
                   FROM news_source_validation`);
  } catch { /* validation not yet run */ }
  return {
    official_injury_rows: inj.n ?? 0, injury_seasons: `${inj.lo ?? '—'}–${inj.hi ?? '—'}`,
    typed_news_signals: news.n ?? 0, newest_signal: news.last ?? null,
    snap_rows: snaps.n ?? 0,
    twitter_sources: sources ? { checked: sources.n, valid: sources.valid } : 'not validated yet',
    note: 'Availability is only as good as its weakest source. The official report is authoritative ' +
      'but weekly; news signals are fast but only as trustworthy as the handle they came from, ' +
      'which is why the handles themselves get validated.'
  };
}
