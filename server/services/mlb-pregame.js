/** Pregame-only MLB snapshots: starters, announced lineups, scratches and real quotes. */
import { db, rows, run } from '../db/index.js';
import { syncProbableStarters } from './mlb.js';
import { hasKey, mlbEvents, mlbEventOdds, MLB_MARKETS } from './odds-api.js';
import { appDate } from './date-util.js';

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_pregame_snapshots (
    game_pk INTEGER NOT NULL, captured_at TEXT NOT NULL, slate_date TEXT NOT NULL,
    game_time TEXT, probable_starters_json TEXT NOT NULL,
    lineups_json TEXT NOT NULL, scratches_json TEXT NOT NULL,
    lineup_status TEXT NOT NULL, odds_status TEXT NOT NULL,
    PRIMARY KEY (game_pk, captured_at)
  );
  CREATE TABLE IF NOT EXISTS mlb_market_quotes (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, game_pk INTEGER,
    commence_time TEXT, home_team TEXT, away_team TEXT, book TEXT NOT NULL,
    market TEXT NOT NULL, selection TEXT, side TEXT, line REAL, price INTEGER,
    PRIMARY KEY (captured_at,event_id,book,market,selection,side,line)
  );
  CREATE INDEX IF NOT EXISTS idx_mlb_quotes_game ON mlb_market_quotes(game_pk,market,captured_at);
`);

async function boxscoreLineup(gamePk) {
  const res = await fetch(`${MLB_BASE}/game/${gamePk}/boxscore`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return { lineups: [], scratches: [], status: `boxscore HTTP ${res.status}` };
  const data = await res.json();
  const lineups = [], scratches = [];
  for (const side of ['home', 'away']) {
    const team = data.teams?.[side];
    for (const p of Object.values(team?.players ?? {})) {
      const item = {
        side, player_id: p.person?.id ?? null, name: p.person?.fullName ?? null,
        batting_order: p.battingOrder ? Number(String(p.battingOrder).slice(0, 1)) : null,
        position: p.position?.abbreviation ?? null, status: p.status?.description ?? null
      };
      if (item.batting_order) lineups.push(item);
      else if (item.status && !/active/i.test(item.status)) scratches.push(item);
    }
  }
  lineups.sort((a, b) => a.side.localeCompare(b.side) || a.batting_order - b.batting_order);
  return { lineups, scratches, status: lineups.length >= 18 ? 'confirmed' : lineups.length ? 'partial' : 'not_announced' };
}

const normalize = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function captureMlbPregame(date) {
  const today = appDate();
  if (date < today) throw new Error('pregame snapshots cannot be created retroactively');
  await syncProbableStarters(5);
  const games = rows('SELECT * FROM mlb_games WHERE date=? ORDER BY game_time', date);
  const events = hasKey() ? await mlbEvents({ ttlMs: 0 }) : [];
  const capturedAt = new Date().toISOString();
  let quoteCount = 0;
  for (const g of games) {
    const starters = rows(`SELECT team_id,pitcher_id,pitcher_name,fetched_at FROM mlb_probable_starters
                           WHERE game_pk=? ORDER BY team_id`, g.game_pk);
    const lineup = await boxscoreLineup(g.game_pk);
    const event = (events ?? []).find(e => normalize(e.home_team) === normalize(g.home_team)
      && normalize(e.away_team) === normalize(g.away_team));
    let oddsStatus = hasKey() ? 'event_not_matched' : 'no_odds_key';
    if (event) {
      const payload = await mlbEventOdds(event.id, { markets: MLB_MARKETS, ttlMs: 0 });
      oddsStatus = payload?.bookmakers?.length ? 'captured' : 'no_markets_posted';
      for (const book of payload?.bookmakers ?? []) for (const market of book.markets ?? []) {
        for (const o of market.outcomes ?? []) {
          run(`INSERT INTO mlb_market_quotes
            (captured_at,event_id,game_pk,commence_time,home_team,away_team,book,market,selection,side,line,price)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
            capturedAt, event.id, g.game_pk, event.commence_time, event.home_team, event.away_team,
            book.key, market.key, o.description ?? (market.key === 'totals_1st_1_innings' ? g.home_team + ' vs ' + g.away_team : o.name),
            o.name, o.point ?? null, o.price ?? null);
          quoteCount++;
        }
      }
    }
    run(`INSERT INTO mlb_pregame_snapshots
      (game_pk,captured_at,slate_date,game_time,probable_starters_json,lineups_json,scratches_json,lineup_status,odds_status)
      VALUES (?,?,?,?,?,?,?,?,?)`, g.game_pk, capturedAt, date, g.game_time,
      JSON.stringify(starters), JSON.stringify(lineup.lineups), JSON.stringify(lineup.scratches), lineup.status, oddsStatus);
  }
  return { date, captured_at: capturedAt, games: games.length, quotes: quoteCount,
    odds_available: hasKey(), mode: 'pregame_forward_only' };
}

export function mlbPregameCoverage() {
  return {
    snapshots: rows(`SELECT slate_date,COUNT(DISTINCT game_pk) games,COUNT(*) captures,
      SUM(lineup_status='confirmed') confirmed_lineups,MAX(captured_at) latest
      FROM mlb_pregame_snapshots GROUP BY slate_date ORDER BY slate_date DESC`),
    quotes: rows(`SELECT market,COUNT(*) quotes,COUNT(DISTINCT game_pk) games,
      MIN(captured_at) first_capture,MAX(captured_at) last_capture FROM mlb_market_quotes GROUP BY market`)
  };
}

export function latestMlbQuotes(date) {
  return rows(`SELECT q.* FROM mlb_market_quotes q
    JOIN (SELECT game_pk,market,selection,side,line,MAX(captured_at) at FROM mlb_market_quotes
          GROUP BY game_pk,market,selection,side,line) x
    ON x.game_pk=q.game_pk AND x.market=q.market AND x.selection=q.selection AND x.side=q.side
      AND COALESCE(x.line,-999)=COALESCE(q.line,-999) AND x.at=q.captured_at
    JOIN mlb_games g ON g.game_pk=q.game_pk WHERE g.date=?`, date);
}

export function latestMlbSnapshot(gamePk) {
  const r = rows(`SELECT * FROM mlb_pregame_snapshots WHERE game_pk=? ORDER BY captured_at DESC LIMIT 1`, gamePk)[0];
  if (!r) return null;
  return { ...r, probable_starters: JSON.parse(r.probable_starters_json), lineups: JSON.parse(r.lineups_json),
    scratches: JSON.parse(r.scratches_json), probable_starters_json: undefined, lineups_json: undefined, scratches_json: undefined };
}
