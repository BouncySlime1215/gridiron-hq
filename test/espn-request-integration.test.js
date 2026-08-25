import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('private ESPN request paths use the shared client without independent cookies', () => {
  const draft = read('server/services/espn-draft.js');
  const leagues = read('server/routes/leagues.js');
  const players = read('server/routes/espn.js');

  assert.match(draft, /from '\.\/espn-client\.js'/);
  assert.match(leagues, /from '\.\.\/services\/espn-client\.js'/);
  assert.doesNotMatch(draft, /headers\.Cookie|Cookie\s*:/);
  assert.doesNotMatch(leagues, /headers\.Cookie|Cookie\s*:/);
  assert.doesNotMatch(players, /headers\.Cookie|Cookie\s*:/);
  assert.doesNotMatch(`${draft}\n${leagues}\n${players}`, /ORDER BY fetched_at DESC LIMIT 1/);
});

test('draft and roster calls bind credentials to the requested league row', () => {
  const draft = read('server/services/espn-draft.js');
  const leagues = read('server/routes/leagues.js');

  assert.match(draft, /SELECT \* FROM leagues WHERE id = \?/);
  assert.match(draft, /String\(league\.league_id\) !== String\(draft\.espn_league_id\)/);
  assert.match(draft, /espn_s2: league\.espn_s2, swid: league\.swid/);
  assert.match(leagues, /leagueId: lg\.league_id[\s\S]*espn_s2: lg\.espn_s2[\s\S]*swid: lg\.swid/);
});

test('global player synchronization remains public and credential-free', () => {
  const source = read('server/routes/espn.js');
  const fn = source.slice(source.indexOf('export async function syncPlayersFromESPN'), source.indexOf("r.post('/sync-players'"));
  assert.match(fn, /leaguedefaults\/3\?view=kona_player_info/);
  assert.doesNotMatch(fn, /espn_s2|swid|Cookie/);
});
