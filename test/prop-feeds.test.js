import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Free prop feeds: Action Network and Underdog parsed into the same
// nfl_prop_quote_snapshots shape the (never-populated) Odds API path wrote.
// Fixtures below are trimmed real payloads captured 2026-09-02.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-propfeeds-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const pf = await import('../server/services/prop-feeds.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT OR IGNORE INTO nfl_teams (abbr,name,conference,division) VALUES
  ('NE','New England Patriots','AFC','East'),('SEA','Seattle Seahawks','NFC','West')`);

const game = { id: 290843, season: 2026, week: 1, commence_time: '2026-09-10T00:20:00.000Z',
  home: { abbr: 'SEA', name: 'Seattle Seahawks' }, away: { abbr: 'NE', name: 'New England Patriots' } };

test('Action Network: supported markets are captured, milestones are counted and skipped, the opener is flagged', () => {
  const payload = {
    players: { 5794: { full_name: 'Hunter Henry' }, 946: { full_name: 'Jason Myers' } },
    player_props: {
      core_bet_type_16_receiving_yards: {
        type: 'core_bet_type_16_receiving_yards', player_abbr: 'H.Henry',
        lines: {
          30: [{ side: 'over', odds: -110, value: 30.5, player_id: 5794 }, { side: 'under', odds: -110, value: 30.5, player_id: 5794 }],
          68: [{ side: 'over', odds: -114, value: 33.5, player_id: 5794 }, { side: 'under', odds: -110, value: 33.5, player_id: 5794 }]
        }
      },
      core_bet_type_62_anytime_touchdown_scorer: {
        type: 'core_bet_type_62_anytime_touchdown_scorer', player_abbr: 'H.Henry',
        lines: { 69: [{ side: 'noside', odds: 305, value: 0, player_id: 5794 }] }
      },
      // Milestone ladder: same stem as receiving yards but not the exact market we read.
      'core_bet_type_530_1023_player_receiving_yards_milestones_25_or_more': {
        type: 'core_bet_type_530_1023_player_receiving_yards_milestones_25_or_more',
        lines: { 68: [{ side: 'over', odds: -150, value: 24.5, player_id: 5794 }] }
      }
    }
  };
  const { rows: parsed, unsupported } = pf.__test.parseActionNetworkProps(payload, game, '2026-09-02T18:00:00Z');
  assert.equal(unsupported, 1, 'the milestone market is counted, not written');

  const dk = parsed.filter(r => r.book === 'draftkings' && r.market === 'player_reception_yds');
  assert.equal(dk.length, 2, 'DraftKings receiving-yards over and under both land');
  assert.equal(dk[0].event_id, 'nfl:2026-09-10:NE@SEA', 'the canonical away@home key, not Action Network\'s numeric id');
  assert.equal(dk[0].line, 33.5);
  assert.equal(dk[0].provider, 'actionnetwork');
  assert.equal(dk[0].book_updated_at, null, 'directly fetched, no aggregator staleness risk');

  const opener = parsed.find(r => r.book === 'action_open');
  assert.ok(opener, 'book 30 (Open) is kept, distinct from the reachable books');
  assert.equal(opener.is_opener, 1);

  const td = parsed.find(r => r.market === 'player_anytime_td');
  assert.equal(td.side, 'Yes', 'a one-sided moneyline market normalises to a single side');
  assert.equal(td.line, null, 'anytime TD has no yardage line');
  assert.equal(td.american_price, 305);
});

test('Action Network rows persist through the same nfl_prop_quote_snapshots table the Odds API path used', () => {
  const { rows: parsed } = pf.__test.parseActionNetworkProps({
    players: { 1: { full_name: 'Test Player' } },
    player_props: { core_bet_type_9_passing_yards: { type: 'core_bet_type_9_passing_yards',
      lines: { 68: [{ side: 'over', odds: -110, value: 250.5, player_id: 1 }] } } }
  }, game, '2026-09-02T18:00:00Z');
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_quote_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,player,side,line,line_key,american_price,provider,book_updated_at,is_opener)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const q of parsed) insert.run(q.captured_at, q.event_id, q.commence_time, q.home_team, q.away_team,
    q.book, q.market, q.player, q.side, q.line, String(q.line), q.american_price, q.provider, q.book_updated_at, q.is_opener);
  const stored = rows(`SELECT * FROM nfl_prop_quote_snapshots WHERE provider='actionnetwork'`);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].market, 'player_pass_yds');
});

test('Underdog: the supported stat maps to Over/Under with two-sided real prices; an unsupported stat is skipped', () => {
  const payload = {
    games: [{ id: 178892, sport_id: 'NFL', full_team_names_title: 'New England Patriots @ Seattle Seahawks', scheduled_at: '2026-09-10T00:20:00Z' }],
    players: [{ id: 'p1', first_name: 'DK', last_name: 'Metcalf' }],
    appearances: [{ id: 'a1', match_id: 178892, player_id: 'p1' }],
    over_under_lines: [
      {
        stat_value: '61.5',
        over_under: { category: 'player_prop', appearance_stat: { appearance_id: 'a1', stat: 'receiving_yds' }, title: 'DK Metcalf Receiving Yards O/U' },
        options: [
          { choice: 'higher', american_price: '-112' },
          { choice: 'lower', american_price: '-112' }
        ]
      },
      {
        stat_value: '8.5',
        over_under: { category: 'player_prop', appearance_stat: { appearance_id: 'a1', stat: 'regular_season_games_started' }, title: 'not a weekly prop' },
        options: [{ choice: 'higher', american_price: '-112' }, { choice: 'lower', american_price: '-112' }]
      }
    ]
  };
  const { rows: parsed, unsupported } = pf.__test.parseUnderdog(payload, '2026-09-02T18:00:00Z');
  assert.equal(unsupported, 1, 'the season-long stat is counted and skipped');
  assert.equal(parsed.length, 2, 'over and under for the one supported market');
  const over = parsed.find(r => r.side === 'Over');
  assert.equal(over.market, 'player_reception_yds');
  assert.equal(over.line, 61.5);
  assert.equal(over.american_price, -112);
  assert.equal(over.player, 'DK Metcalf');
  assert.equal(over.home_team, 'Seattle Seahawks');
  assert.equal(over.away_team, 'New England Patriots');
  assert.equal(over.event_id, 'nfl:2026-09-10:NE@SEA', 'joins the same canonical key Action Network uses for this game');
});

test('Underdog: an appearance whose player_id has no matching player is skipped, never stored under the market title as a fake name', () => {
  const payload = {
    games: [{ id: 178892, sport_id: 'NFL', full_team_names_title: 'New England Patriots @ Seattle Seahawks', scheduled_at: '2026-09-10T00:20:00Z' }],
    players: [], // the roster this player_id points to was never fetched
    appearances: [{ id: 'a1', match_id: 178892, player_id: 'missing-player' }],
    over_under_lines: [{
      stat_value: '61.5',
      over_under: { category: 'player_prop', appearance_stat: { appearance_id: 'a1', stat: 'receiving_yds' }, title: 'Some Player Receiving Yards O/U' },
      options: [{ choice: 'higher', american_price: '-112' }, { choice: 'lower', american_price: '-112' }]
    }]
  };
  const { rows: parsed } = pf.__test.parseUnderdog(payload, '2026-09-02T18:00:00Z');
  assert.equal(parsed.length, 0, 'no row is written under a market-title string standing in for a player name');
});

test('propFeedStatus summarises by provider and market once rows exist', () => {
  const status = pf.propFeedStatus();
  assert.ok(status.by_provider.some(p => p.provider === 'actionnetwork'));
  assert.ok(status.by_market.some(m => m.market === 'player_pass_yds'));
});
