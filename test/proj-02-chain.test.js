import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// PROJ-02-a sharp chain (docs/evidence/2026-09-23/proj-02-a-sharp-chain-preregistration.md).
// buildProjections exposes each link of the chain on the projection object:
//   plays (pace x script) -> pass_rate -> share (normalized per team) -> volume -> eff -> td.
// The hard rule: over a team's as-of roster, chain targets sum to team pass attempts x
// team target rate and chain carries sum to team rushes, within 0.5%.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj02-chain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-pbp.js'); // creates nfl_player_week_features, joined by history()
const { buildProjections, CHAIN_SERVED } = await import('../server/services/projections.js');
const { clearGameScriptCache } = await import('../server/services/gamescript.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertPlayer = (id, name, position) => run(
  `INSERT INTO players (id, name, position, fantasy_relevant) VALUES (?,?,?,1)`, id, name, position);
const usage = (pid, season, week, team, pos, { att = 0, car = 0, tgt = 0, share = null } = {}) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, attempts, passing_yards, passing_tds, interceptions,
    carries, rushing_yards, rushing_tds, targets, receptions, receiving_yards, receiving_tds, target_share)
   VALUES (?,?,?,?,'OPP',?,?,?,?,0,?,?,0,?,?,?,0,?)`,
  pid, season, week, team, pos, att, att * 7, att ? 1 : 0, car, car * 4, tgt, Math.round(tgt * 0.65), tgt * 8, share);

// Two teams, four weeks of 2023. Team targets are well under team pass attempts
// (throwaways, spikes), so the team target rate is < 1 and the chain must use it.
const TEAMS = {
  AAA: { qb: [1, 34, 3], rb: [2, 20, 4], wr1: [3, 10], wr2: [4, 7], te: [5, 5] },
  BBB: { qb: [11, 28, 5], rb: [12, 24, 2], wr1: [13, 8], wr2: [14, 6], te: [15, 4] }
};
for (const [team, t] of Object.entries(TEAMS)) {
  const names = [['qb', 'QB'], ['rb', 'RB'], ['wr1', 'WR'], ['wr2', 'WR'], ['te', 'TE']];
  for (const [slot, pos] of names) insertPlayer(t[slot][0], `${team}-${slot}`, pos);
  const teamTargets = t.rb[2] + t.wr1[1] + t.wr2[1] + t.te[1];
  for (let w = 1; w <= 4; w++) {
    usage(t.qb[0], 2023, w, team, 'QB', { att: t.qb[1], car: t.qb[2] });
    usage(t.rb[0], 2023, w, team, 'RB', { car: t.rb[1], tgt: t.rb[2], share: t.rb[2] / teamTargets });
    for (const slot of ['wr1', 'wr2', 'te']) {
      const pos = slot === 'te' ? 'TE' : 'WR';
      usage(t[slot][0], 2023, w, team, pos, { tgt: t[slot][1], share: t[slot][1] / teamTargets });
    }
  }
}
// A receiver who last played for AAA in 2022 is not on AAA's as-of roster.
insertPlayer(99, 'AAA-stale', 'WR');
for (let w = 1; w <= 6; w++) usage(99, 2022, w, 'AAA', 'WR', { tgt: 6, share: 0.2 });

// The week being predicted (2023 W5) has a line for AAA only; the stored game-script
// fit is read (fewer than 100 observations, so the cutoff refit falls back to it).
run(`INSERT INTO gamescript_model (target, b0, b_spread, b_total, r2, n, fitted_at) VALUES
     ('pass_att', 20, 0.5, 0.3, 0.1, 500, datetime('now')),
     ('rush_att', 30, -0.4, -0.1, 0.1, 500, datetime('now'))`);
run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source)
     VALUES (2023, 5, 'AAA', 'BBB', 1, 7, 44.5, 18.75, 'test')`);
clearGameScriptCache();

const proj = buildProjections({ through: 2023, throughWeek: 4 });
const LINK_KEYS = ['eff', 'pass_rate', 'plays', 'share', 'td', 'volume'];

test('every projection exposes the six chain links', () => {
  assert.ok(proj.size >= 11);
  for (const p of proj.values()) {
    assert.ok(p.links, `${p.name} has no links`);
    assert.deepEqual(Object.keys(p.links).sort(), LINK_KEYS);
  }
});

test('RED hard rule: roster targets sum to team pass attempts x target rate, carries to team rushes (within 0.5%)', () => {
  for (const team of ['AAA', 'BBB']) {
    const roster = [...proj.values()].filter(p => p.team === team && p.links.share.roster);
    assert.equal(roster.length, 5, `${team} roster`);
    const { pass_att, rush_att, target_rate } = roster[0].links.plays.team;
    assert.ok(target_rate > 0 && target_rate < 1, `target rate ${target_rate} should be measured below 1`);
    const targets = roster.reduce((s, p) => s + p.links.volume.targets.chain, 0);
    const carries = roster.reduce((s, p) => s + p.links.volume.carries.chain, 0);
    assert.ok(Math.abs(targets / (pass_att * target_rate) - 1) <= 0.005,
      `${team}: targets ${targets} vs ${pass_att} x ${target_rate}`);
    assert.ok(Math.abs(carries / rush_att - 1) <= 0.005, `${team}: carries ${carries} vs ${rush_att}`);
    const shareSum = roster.reduce((s, p) => s + p.links.share.target_share, 0);
    assert.ok(Math.abs(shareSum - 1) <= 0.005, `${team}: target shares sum ${shareSum}`);
  }
});

test('a player whose last row is outside the team\'s last 3 played weeks is off the roster and keeps his incumbent volume', () => {
  const stale = proj.get(99);
  assert.equal(stale.team, 'AAA');
  assert.equal(stale.links.share.roster, false);
  const t = stale.links.volume.targets;
  assert.equal(t.served, 'incumbent');
  assert.equal(t.value, t.incumbent);
  assert.ok(Math.abs(t.incumbent - stale.volume.targets_per_game) < 0.005);
});

test('plays and pass rate read the week\'s line from gameScriptFor; no line means neutral', () => {
  const aaa = proj.get(1).links, bbb = proj.get(11).links;
  const t = aaa.plays.team;
  assert.ok(aaa.pass_rate.script, 'AAA has a week-5 line');
  const { pass_mult, rush_mult } = aaa.pass_rate.script;
  assert.notEqual(pass_mult, 1);
  assert.ok(Math.abs(aaa.plays.chain - (t.pass_att * pass_mult + t.rush_att * rush_mult)) < 0.01);
  assert.ok(Math.abs(aaa.pass_rate.chain - t.pass_att * pass_mult / aaa.plays.chain) < 0.001);
  // A 7-point underdog throws more than neutral under this fit.
  assert.ok(aaa.pass_rate.chain > t.pass_att / (t.pass_att + t.rush_att));
  assert.equal(bbb.pass_rate.script, null);
  assert.ok(Math.abs(bbb.plays.chain - (bbb.plays.team.pass_att + bbb.plays.team.rush_att)) < 0.01);
  // chain_scripted says which configuration the chain value is.
  assert.equal(aaa.plays.chain_scripted, true);
  assert.equal(aaa.pass_rate.chain_scripted, true);
  assert.equal(bbb.plays.chain_scripted, false);
  assert.equal(bbb.pass_rate.chain_scripted, false);
});

test('shares: each roster player\'s share is his raw share over the team\'s raw-share sum; QB gets no targets', () => {
  const byTeam = new Map();
  for (const p of proj.values()) {
    if (!p.links.share.roster) continue;
    (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)).push(p);
  }
  for (const [team, roster] of byTeam) {
    const sT = roster.reduce((s, p) => s + p.links.share.raw_target_share, 0);
    const sC = roster.reduce((s, p) => s + p.links.share.raw_carry_share, 0);
    for (const p of roster) {
      const sh = p.links.share;
      assert.ok(Math.abs(sh.target_share - sh.raw_target_share / sT) < 1e-4, `${p.name} target share ${sh.target_share}`);
      assert.ok(Math.abs(sh.carry_share - sh.raw_carry_share / sC) < 1e-4, `${p.name} carry share ${sh.carry_share}`);
      const t = p.links.plays.team;
      assert.ok(Math.abs(p.links.volume.targets.chain - sh.target_share * t.pass_att * t.target_rate) < 1e-3, `${team} ${p.name} targets`);
      assert.ok(Math.abs(p.links.volume.carries.chain - sh.carry_share * t.rush_att) < 1e-3, `${team} ${p.name} carries`);
    }
  }
  // Pinned on this fixture (shrunk raw shares, temp DB): a uniform share or a QB whose
  // carries are dropped both move these.
  const qb = proj.get(1).links.share, wr1 = proj.get(3).links.share;
  assert.equal(qb.target_share, 0);
  assert.ok(qb.raw_carry_share > 0.05, `QB raw carry share ${qb.raw_carry_share}`);
  assert.ok(Math.abs(qb.carry_share - 0.1099) < 5e-4, `QB carry share ${qb.carry_share}`);
  assert.ok(Math.abs(wr1.target_share - 0.3490) < 5e-4, `WR1 target share ${wr1.target_share}`);
});

test('incumbents: main\'s neutral shrunk pace (teamVolume); season averages kept for reference', () => {
  const l = proj.get(1).links;
  const t = l.plays.team;
  assert.ok(Math.abs(l.plays.incumbent - (t.pass_att + t.rush_att)) < 0.01);
  assert.ok(Math.abs(l.pass_rate.incumbent - t.pass_att / (t.pass_att + t.rush_att)) < 1e-4);
  // AAA every week: 34 attempts, 3 + 20 carries.
  assert.equal(l.plays.season_average, 57);
  assert.ok(Math.abs(l.pass_rate.season_average - 34 / 57) < 1e-4);
});

test('served values follow the recorded ship decision; eff and td are the incumbent shrunk rates', () => {
  for (const p of proj.values()) {
    const { volume, eff, td, plays, pass_rate } = p.links;
    for (const v of [volume.targets, volume.carries]) {
      const expected = p.links.share.roster && v.served === 'chain' ? v.chain : v.incumbent;
      assert.equal(v.value, expected);
    }
    assert.equal(p.params.targets, volume.targets.value);
    assert.equal(p.params.carries, volume.carries.value);
    assert.equal(plays.value, plays.served === 'chain' ? plays.chain : plays.incumbent);
    assert.equal(pass_rate.value, pass_rate.served === 'chain' ? pass_rate.chain : pass_rate.incumbent);
    assert.equal(eff.yards_per_target, p.params.ypt);
    assert.equal(td.rec_td_rate, p.params.rec_td_rate);
  }
});

test('ship decisions: no link beats its real incumbent, so every served value is main\'s number', () => {
  assert.deepEqual({ ...CHAIN_SERVED }, { plays: false, pass_rate: false, targets: false, carries: false });
  const aaa = proj.get(1).links;
  assert.equal(aaa.plays.served, 'incumbent');
  assert.equal(aaa.plays.value, aaa.plays.incumbent);
  assert.notEqual(aaa.plays.value, aaa.plays.chain, 'AAA has a line, so chain and neutral pace differ');
  assert.equal(aaa.pass_rate.served, 'incumbent');
  assert.equal(aaa.pass_rate.value, aaa.pass_rate.incumbent);
  // Volume is not served from the chain, so the served number is untouched: the WR1's
  // params and ppg equal the incumbent volume scored through the same rates.
  const wr = proj.get(3);
  assert.equal(wr.links.volume.targets.served, 'incumbent');
  assert.notEqual(wr.links.volume.targets.chain, wr.links.volume.targets.incumbent);
  assert.equal(wr.params.targets, wr.links.volume.targets.incumbent);
});

// The route that serializes links (GET /api/model/projections, routes/model.js) takes
// the as-of cutoff week, so a reader can get the scripted chain the grade was run on.
test('GET /api/model/projections?through=2023&week=4 serves links with the week-5 script; without week they are neutral', async () => {
  const { row } = await import('../server/db/index.js');
  const { default: modelRouter } = await import('../server/routes/model.js');
  const { hashSessionToken } = await import('../server/platform/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use('/api/model', modelRouter);
  app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    run(`INSERT INTO leagues (platform, league_id, season, name, ppr, payload, roster_positions)
         VALUES ('espn','proj02-league',2026,'Test League',1,?,?)`,
      JSON.stringify({ settings: {}, teams: [] }), JSON.stringify(['QB', 'RB', 'WR', 'TE']));
    const lg = row(`SELECT id FROM leagues WHERE league_id = 'proj02-league'`);
    run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'proj02-tester', 'Tester');
    const userId = row('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', lg.id, userId, 'member');
    run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
      userId, hashSessionToken('proj02-token'));
    const base = `http://127.0.0.1:${server.address().port}/api/model/projections?league_id=${lg.id}&through=2023`;
    const get = async q => {
      const res = await fetch(base + q, { headers: { authorization: 'Bearer proj02-token' } });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json());
    };
    const withWeek = await get('&week=4');
    assert.equal(withWeek.week, 4);
    const aaa = withWeek.players.find(p => p.name === 'AAA-qb').links;
    assert.equal(aaa.pass_rate.chain_scripted, true);
    assert.ok(aaa.pass_rate.script && aaa.pass_rate.script.week === 5, 'the week-5 line is applied');
    assert.equal(aaa.plays.served, 'incumbent');
    const noWeek = await get('');
    const aaa0 = noWeek.players.find(p => p.name === 'AAA-qb').links;
    assert.equal(aaa0.pass_rate.chain_scripted, false);
    assert.equal(aaa0.pass_rate.script, null);
    const bad = await fetch(base + '&week=x', { headers: { authorization: 'Bearer proj02-token' } });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
