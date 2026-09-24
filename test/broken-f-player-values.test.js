/**
 * BROKEN-F (BROKEN-NUMBERS row F): three player values — FantasyCalc market
 * value, preseason VOR (routes/edge.js#vorBoard) and a league-mate's clone
 * price — were all served as a bare, unlabelled `value`.
 * docs/tdd/2026-09-24-broken-f-player-values.tdd.md has the record.
 *
 * Pinned here: the registry; the switch-off no-op; null (not 0) for an
 * unpriced player; the finder's assets carrying both named fields; the asset
 * cache not serving one shape for the other; League Hub labelling its REDRAFT
 * price as such. The clone-price panel is pinned in test/valuation-panel.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-broken-f-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '3';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const pv = await import('../server/services/player-values.js');
const te = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
const { default: leaguesRouter } = await import('../server/routes/leagues.js');
const { requireAuthenticated, hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/leagues', requireAuthenticated, leaguesRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/leagues`;

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const saved = process.env[PREVIEW_ENV];
const withSwitch = async (on, fn) => {
  if (on) process.env[PREVIEW_ENV] = '1'; else delete process.env[PREVIEW_ENV];
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
};

// ------------------------------------------------------------------ registry
test('three named kinds, each with a label, scale and basis; no two share a label', () => {
  assert.deepEqual(pv.VALUE_KINDS, ['market_value', 'preseason_vor', 'clone_price']);
  const labels = pv.VALUE_KINDS.map(k => pv.PLAYER_VALUE_FIELDS[k].label);
  assert.equal(new Set(labels).size, 3);
  for (const k of pv.VALUE_KINDS) {
    for (const f of ['label', 'short', 'scale', 'basis']) assert.ok(pv.PLAYER_VALUE_FIELDS[k][f], `${k}.${f}`);
  }
  assert.match(pv.PLAYER_VALUE_FIELDS.preseason_vor.basis, /not updated in-season/);
});

test('switch off: every helper is a no-op, so no response changes shape', () => withSwitch(false, () => {
  assert.deepEqual(pv.namedPlayerValues({ market: { value: 5000 }, board: { vor: 40 } }), {});
  assert.deepEqual(pv.valueLabelBlock('market_value'), {});
  assert.deepEqual(pv.carryNamedValues({ value: 5000 }), {});
  const result = { deals: [] };
  assert.equal(pv.stampValueKind(result, 'market_value'), result, 'the same object back, untouched');
}));

test('switch on: named values from the raw inputs; unpriced is null, never 0', () => withSwitch(true, () => {
  assert.deepEqual(pv.namedPlayerValues({ market: { value: 5000 }, board: { vor: -3.5 } }),
    { market_value: 5000, preseason_vor: -3.5, value_kind: 'market_value' });
  assert.deepEqual(pv.namedPlayerValues({}),
    { market_value: null, preseason_vor: null, value_kind: 'market_value' });
  const block = pv.valueLabelBlock('clone_price');
  assert.equal(block.value_kind, 'clone_price');
  assert.equal(block.value_label, 'Clone price');
  assert.equal(block.preview, true);
  assert.match(block.preview_reason, /BROKEN-F/);
  assert.equal(pv.valueLabelBlock('market_value', { format: 'redraft' }).value_label,
    'Market value (FantasyCalc), redraft');
  assert.throws(() => pv.valueLabelBlock('value'), /unknown player value kind/);
  assert.deepEqual(pv.stampValueKind([1], 'market_value'), [1], 'arrays pass through');
}));

// ------------------------------------------------------- finder asset fields
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (91, 'espn', 'bf-91', 2026, 'BF', '1', 10, 1, ?, '2026-09-18 01:00:00')`,
JSON.stringify({ teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] }));
const lg = () => row('SELECT * FROM leagues WHERE id = 91');
const { formatKey } = deriveFormat(lg());
run(`INSERT INTO players (id, name, position) VALUES (9101, 'Priced Runner', 'RB'), (9102, 'Unpriced Runner', 'RB')`);
run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points) VALUES (9101, 2026, 'projected', 250),
     (9102, 2026, 'projected', 150)`);
run(`INSERT INTO dynasty_values (player_id, format_key, value, fetched_at) VALUES (9101, ?, 4200, datetime('now'))`, formatKey);

test('finder assets: switch on names market value and preseason VOR; off leaves the old shape', async () => {
  const off = await withSwitch(false, () => te.assetUniverse(lg(), formatKey).get(9101));
  assert.ok(!('market_value' in off) && !('value_kind' in off), 'switch off: no named fields');
  assert.equal(off.value, 4200);

  const on = await withSwitch(true, () => te.assetUniverse(lg(), formatKey));
  const priced = on.get(9101), unpriced = on.get(9102);
  assert.equal(priced.value_kind, 'market_value');
  assert.equal(priced.market_value, priced.value, 'market_value is the finder\'s own `value`');
  assert.equal(priced.market_value, 4200);
  assert.equal(priced.preseason_vor, priced.vor, 'preseason_vor is vorBoard\'s number');
  assert.equal(unpriced.value, 0, 'the bare field keeps its old 0');
  assert.equal(unpriced.market_value, null, 'the named field says unpriced');

  const again = await withSwitch(false, () => te.assetUniverse(lg(), formatKey).get(9101));
  assert.ok(!('market_value' in again), 'the cache does not serve the switch-on shape after it is turned off');
});

// ------------------------------------------------------------ League Hub
const POS_ID = { QB: 1 };
run(`INSERT INTO players (id, name, position) VALUES (9201, 'Hub Passer', 'QB'), (9202, 'Other Passer', 'QB')`);
run(`INSERT INTO player_metrics (player_id, source, value) VALUES (9201, 'fc_value', 8000), (9202, 'fc_value', 4000)`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, roster_positions)
     VALUES (92, 'espn', 'bf-92', 2026, 'Hub', ?, ?)`,
JSON.stringify({ teams: [
  { id: 1, name: 'Team 1', roster: { entries: [{ playerPoolEntry: { player: { id: 1, fullName: 'Hub Passer', defaultPositionId: POS_ID.QB } } }] } },
  { id: 2, name: 'Team 2', roster: { entries: [{ playerPoolEntry: { player: { id: 2, fullName: 'Other Passer', defaultPositionId: POS_ID.QB } } }] } }
] }), JSON.stringify(['QB']));
run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'bf-tester', 'BF Tester');
const userId = row('SELECT last_insert_rowid() AS id').id;
run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (92, ?, ?)', userId, 'commissioner');
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken('bf-token'));
const analysis = async () => {
  const res = await fetch(`${base}/92/analysis`, { headers: { authorization: 'Bearer bf-token' } });
  assert.equal(res.status, 200);
  return res.json();
};

test('League Hub: under preview it says its value is the REDRAFT market price, not this league\'s format', async () => {
  const off = await withSwitch(false, analysis);
  assert.ok(off.rosters.length === 2, 'the fixture grades');
  assert.ok(!('value_kind' in off) && !('preview' in off), 'switch off: unchanged');

  const on = await withSwitch(true, analysis);
  assert.equal(on.value_kind, 'market_value');
  assert.equal(on.value_format, pv.LEAGUE_HUB_VALUE_FORMAT);
  assert.match(on.value_label, /^Market value \(FantasyCalc\), redraft price/);
  assert.equal(on.preview, true);
  assert.deepEqual(on.rosters, off.rosters, 'the label changes; the numbers do not');
});

// ------------------------------------------------------------ client mirror
test('the client label table says exactly what the server registry says', () => {
  const src = fs.readFileSync(new URL('../client/src/lib/playerValues.ts', import.meta.url), 'utf8');
  for (const k of pv.VALUE_KINDS) {
    const { label, short } = pv.PLAYER_VALUE_FIELDS[k];
    const line = src.split('\n').find(l => l.trim().startsWith(`${k}:`));
    assert.ok(line, `client names ${k}`);
    assert.ok(line.includes(`label: '${label}'`) && line.includes(`short: '${short}'`), `${k}: ${line}`);
  }
});

test('every page that prints a bare player value reads its label through playerValues.ts', () => {
  // Known-nonzero control: these are the five render sites BROKEN-F found
  // (TradeCard pill tooltip, TradeLab target lists x2, outlook, mock roster)
  // plus League Hub's caption.
  const uses = f => (fs.readFileSync(new URL(`../client/src/${f}`, import.meta.url), 'utf8')
    .match(/valueLabel\(|valueShort\(/g) ?? []).length;
  assert.ok(uses('components/TradeCard.tsx') >= 1);
  assert.ok(uses('pages/TradeLab.tsx') >= 4);
  assert.ok(uses('pages/Leagues.tsx') >= 1);
  const tl = fs.readFileSync(new URL('../client/src/pages/TradeLab.tsx', import.meta.url), 'utf8');
  assert.match(tl, /<dt className="text-slate-400">\{valueLabel\(o, 'Market'\)\}<\/dt>/, 'outlook label');
  assert.equal((tl.match(/title=\{valueLabel\(p, 'Market value'\)\}>\{valueShort\(p\)/g) ?? []).length, 3,
    'both target lists and the mock roster tag their number');
  const tc = fs.readFileSync(new URL('../client/src/components/TradeCard.tsx', import.meta.url), 'utf8');
  assert.match(tc, /\$\{valueLabel\(p, 'market'\)\} \$\{p\.value/, 'pill tooltip');
  const lh = fs.readFileSync(new URL('../client/src/pages/Leagues.tsx', import.meta.url), 'utf8');
  assert.match(lh, /priced off \{valueLabel\(analysis, 'real FantasyCalc trade values'\)\}/, 'League Hub caption');
  assert.equal((tl.match(/>\{p\.value\?\.toLocaleString\(\)\}<\/span>/g) ?? []).length, 0,
    'no bare {p.value} span is left without its label');
});
