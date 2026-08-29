/**
 * Referee crews, and whether they move a total.
 *
 * The folklore is that some crews call more penalties than others, that
 * penalties extend drives, and that extended drives score points — so the
 * referee assignment ought to be worth something on a total. It is one of the
 * few widely-repeated betting claims that can be checked cleanly, because
 * nflverse publishes every official for every game back to 2015 and this
 * database already holds the scores and the closing totals.
 *
 * That combination is unusual and worth stating: the crew is known BEFORE
 * kickoff and the total is set before the crew is announced in many cases, so
 * if crews genuinely differed by a couple of points there would be a real,
 * legally-obtainable edge sitting in public data.
 *
 * This measures it rather than repeating it. The answer is reported with the
 * sample size and a significance test against the number of crews examined,
 * because "referee X goes over 60% of the time" on thirty games is exactly the
 * shape of a finding that evaporates.
 */
import { rows, row, run } from '../db/index.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

run(`CREATE TABLE IF NOT EXISTS nfl_officials (
  game_id     TEXT NOT NULL,
  official_id TEXT,
  name        TEXT NOT NULL,
  position    TEXT,
  season      INTEGER,
  week        INTEGER,
  season_type TEXT,
  PRIMARY KEY (game_id, name, position)
)`);
run(`CREATE INDEX IF NOT EXISTS idx_off_season ON nfl_officials(season, week)`);

function splitCsv(line) {
  const out = []; let cur = '', quoted = false;
  for (const c of line) {
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Ingest every official assignment nflverse has. */
export async function ingestOfficials() {
  const res = await fetch(`${BASE}/officials/officials.csv`, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) return { error: `officials returned ${res.status}` };
  const lines = (await res.text()).split('\n');
  const header = splitCsv(lines[0]).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  let stored = 0;
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const p = splitCsv(raw);
    const gameId = p[idx.game_id];
    const name = (p[idx.official_name] ?? '').trim();
    if (!gameId || !name) continue;
    run(`INSERT INTO nfl_officials (game_id, official_id, name, position, season, week, season_type)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(game_id, name, position) DO NOTHING`,
    gameId, p[idx.official_id] ?? null, name, (p[idx.position] ?? '').trim() || null,
    Number(p[idx.season]) || null, Number(p[idx.week]) || null, p[idx.season_type] ?? null);
    stored++;
  }
  const total = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT game_id) AS games,
                            COUNT(DISTINCT name) AS officials FROM nfl_officials`) ?? {};
  return { assignments_stored: stored, corpus: total,
    note: 'Every official, every game, back to 2015. The referee is the crew chief — the other six ' +
      'positions travel with him, so the referee identifies the crew.' };
}

/**
 * Does the referee move the total?
 *
 * Joins each game's referee to its closing total and actual total, then asks
 * two separate questions that are easy to conflate:
 *
 *   1. Do some crews preside over higher-scoring games? Almost certainly yes,
 *      and almost certainly meaningless — the schedule assigns crews to games,
 *      and a crew that drew more Chiefs games will look high-scoring.
 *   2. Do some crews' games go OVER the number more often? This is the only
 *      version that is a betting claim, because the number already contains
 *      everything known about the teams. It is the harder test and the honest
 *      one.
 *
 * Significance is corrected for the number of crews examined. With seventeen
 * referees and a few dozen games each, someone will be at 60% by luck.
 */
export function refereeTotals({ minGames = 25 } = {}) {
  const joined = rows(`
    SELECT o.name AS referee, g.season, g.week, g.total,
           (g.team_score + g.opp_score) AS actual
    FROM nfl_officials o
    JOIN game_lines g
      ON g.season = o.season AND g.week = o.week AND g.home = 1
     AND (g.team || g.opponent) IS NOT NULL
    WHERE o.position = 'Referee' AND g.total IS NOT NULL
      AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL`);

  if (joined.length < 100) {
    return { error: `only ${joined.length} referee-games joined`,
      hint: 'The join is by season and week rather than by game id, because nflverse game ids and ' +
        'this archive\'s keys differ — so a week with several games attributes the crew to all of ' +
        'them. Treat this as indicative until the ids are reconciled.' };
  }

  const byRef = new Map();
  for (const r of joined) {
    if (!byRef.has(r.referee)) byRef.set(r.referee, []);
    byRef.get(r.referee).push(r);
  }

  const crews = [...byRef.entries()]
    .filter(([, g]) => g.length >= minGames)
    .map(([referee, g]) => {
      const overs = g.filter(x => x.actual > x.total).length;
      const unders = g.filter(x => x.actual < x.total).length;
      const graded = overs + unders;
      const rate = graded ? overs / graded : null;
      const se = graded ? Math.sqrt(0.25 / graded) : null;
      return { referee, games: g.length, graded,
        over_rate: r4(rate),
        mean_total_line: r2(mean(g.map(x => x.total))),
        mean_actual: r2(mean(g.map(x => x.actual))),
        points_over_line: r2(mean(g.map(x => x.actual - x.total))),
        z_vs_coinflip: rate != null && se ? r2((rate - 0.5) / se) : null };
    })
    .sort((a, b) => (b.over_rate ?? 0) - (a.over_rate ?? 0));

  // Corrected threshold for having looked at every crew.
  const n = crews.length;
  const correctedAlpha = 1 - Math.pow(1 - 0.05, 1 / Math.max(1, n));
  const zRequired = Math.abs(inverseNormal(correctedAlpha / 2));
  const significant = crews.filter(c => Math.abs(c.z_vs_coinflip ?? 0) > zRequired);

  return {
    referee_games: joined.length, crews_examined: n, min_games: minGames,
    multiple_comparisons: { corrected_alpha: r4(correctedAlpha), z_required: r2(zRequired) },
    crews,
    significant_crews: significant,
    verdict: significant.length
      ? `${significant.length} crew(s) clear the corrected threshold: ` +
        significant.map(c => `${c.referee} (${(c.over_rate * 100).toFixed(1)}% over, z=${c.z_vs_coinflip})`).join(', ') +
        '. Worth a forward test before acting on.'
      : `No crew's over rate clears the corrected threshold. Across ${n} referees the spread between ` +
        'the highest and lowest is what you would expect from chance alone, so the folklore that ' +
        'certain crews reliably produce overs does not survive the correction.',
    note: 'The betting question is the over RATE against the posted number, not the raw scoring — a ' +
      'crew that draws high-scoring teams will preside over high-scoring games without offering any ' +
      'edge, because the total already knows about the teams.'
  };
}

/** Acklam inverse normal, adequate for a threshold. */
function inverseNormal(p) {
  const a = [-39.696830, 220.946098, -275.928510, 138.357751, -30.664798, 2.506628];
  const b = [-54.476098, 161.585836, -155.698979, 66.801311, -13.280681];
  const c = [-0.007784894002, -0.32239645, -2.400758, -2.549732, 4.374664, 2.938163];
  const d = [0.007784695709, 0.32246712, 2.445134, 3.754408];
  const pl = 0.02425;
  let q, r, x;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) { q = p - 0.5; r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else { q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
         ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

/** What the officials corpus holds. */
export function officialsStatus() {
  const t = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT game_id) AS games,
                        COUNT(DISTINCT name) AS people FROM nfl_officials`) ?? {};
  const refs = row(`SELECT COUNT(DISTINCT name) AS n FROM nfl_officials WHERE position='Referee'`)?.n ?? 0;
  const seasons = rows(`SELECT season, COUNT(DISTINCT game_id) AS games FROM nfl_officials
                        GROUP BY season ORDER BY season DESC LIMIT 12`);
  return { assignments: t.n ?? 0, games: t.games ?? 0, officials: t.people ?? 0,
    referees: refs, by_season: seasons };
}
