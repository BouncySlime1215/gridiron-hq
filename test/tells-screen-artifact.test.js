// TELLS-01a: guards on the committed screen artifact (server/data/tells-screen.json).
// The repo is public: Sleeper data may appear as aggregates only, with no league ids,
// roster/user ids, player ids or names. The artifact is written by
// scripts/rnd/tells-factory.py; these tests read it and never touch a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(path.join(root, 'server/data/tells-screen.json'), 'utf8');
const art = JSON.parse(raw);

// Tell ids come from a closed grammar: FAMILY[:POS]|stat|window, or PREV|stat.
const TELL_ID = /^(?:(?:ADD_FA|CLAIM_WON|CLAIM_FAIL|CLAIM_ALL|DROP|ADD_ANY|DROPTEN):(?:ALL|QB|RB|WR|TE|K|DEF)|TRADE:ALL|LINEUP|TRADESHAPE)\|[a-zA-Z_]+\|(?:w13|w46|w16|w26)$|^PREV\|[a-z_]+$/;
const FORBIDDEN_KEYS = /^(league_?id|leagues?|roster_?id|owner_?id|user_?id|users?|username|display_?name|name|team_?name|manager|player_?id|players|avatar)$/i;

function walk(value, visit, where = '$') {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${where}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { visit(k, v, `${where}.${k}`); walk(v, visit, `${where}.${k}`); }
  }
}

test('the artifact carries no league ids, user ids, player ids or names', () => {
  // Sleeper league and user ids are 15-19 digit numbers; player ids are short numbers
  // or team codes, and none of them may appear as a value. sha256 fields are exempt.
  walk(art, (k, v, where) => {
    assert.doesNotMatch(k, FORBIDDEN_KEYS, `forbidden key at ${where}`);
    if (typeof v === 'string' && !/sha256$/.test(k)) {
      assert.doesNotMatch(v, /\d{9,}/, `long digit run (an id?) at ${where}`);
    }
  });
  assert.doesNotMatch(raw, /"(?:league_id|roster_id|owner_id|user_id|username|display_name)"/);
  // Every tell id parses: no free text rides in the id.
  for (const t of art.tells) assert.match(t.id, TELL_ID, `unexpected tell id ${t.id}`);
});

test('the artifact never mentions 2025 as a fit or graded season', () => {
  const s = art.fit_stamp;
  const seasons = [...s.arm_a.fit, ...s.arm_a.confirm, ...s.arm_b.fit, ...s.arm_b.replicate, ...s.arm_b.grade];
  assert.ok(seasons.every(y => y >= 2021 && y <= 2024), `seasons ${seasons}`);
});

test('a tell below the support floor is never confirmed, and a tested one is dead:support', () => {
  const floor = art.fit_stamp.rules.support_chains;
  assert.equal(floor, 30);
  const below = art.tells.filter(t => t.arm === 'A' && t.support_chains < floor);
  for (const t of below) {
    assert.notEqual(t.verdict, 'confirmed', `${t.id} confirmed below the support floor`);
    if (t.outcome != null) assert.equal(t.dead_reason, 'support', `${t.id} tested below the floor`);
  }
  for (const t of art.tells.filter(x => x.verdict === 'confirmed' && x.arm === 'A')) {
    assert.ok(t.support_chains >= floor, `${t.id} confirmed with ${t.support_chains} chains`);
  }
});

test('every tell has a verdict; dead tells say why; confirmed tells carry evidence', () => {
  for (const t of art.tells) {
    assert.ok(['confirmed', 'dead', 'lead'].includes(t.verdict), `${t.id} verdict ${t.verdict}`);
    if (t.verdict !== 'confirmed') assert.ok(t.dead_reason, `${t.id} ${t.verdict} with no reason`);
    if (t.verdict === 'confirmed' && t.arm === 'A') {
      for (const k of ['effect_fit', 'q_fit', 'effect_confirm', 'q_confirm']) assert.equal(typeof t[k], 'number', `${t.id}.${k}`);
      assert.ok(t.q_fit <= art.fit_stamp.rules.bh_q && t.q_confirm < art.fit_stamp.rules.confirm_q);
    }
    assert.equal(typeof t.espn_observable, 'string', `${t.id} espn_observable`);
  }
});

test('no this-season tell may enter P(accept); arm B only when its 90% CI clears 0', () => {
  const armA = art.tells.filter(t => t.arm === 'A');
  assert.ok(armA.every(t => t.p_accept_eligible === false));
  const trade = armA.filter(t => t.outcome === 'trade');
  const killed = art.summary.arm_a.trade_kill;
  if (killed) assert.ok(trade.every(t => t.verdict !== 'confirmed'), 'trade KILL but a this-season trade tell is confirmed');
  const b = art.summary.arm_b;
  const eligible = art.tells.filter(t => t.arm === 'B' && t.p_accept_eligible);
  if (!(b.ci90 && b.ci90[0] > 0)) assert.equal(eligible.length, 0, 'arm B eligible without a CI clear of 0');
});

test('placebo gate: zero placebo survivors is recorded, not assumed', () => {
  assert.equal(typeof art.summary.arm_a.placebo.bh, 'number');
  assert.equal(art.summary.arm_a.placebo.bh, 0);
  assert.equal(art.summary.arm_a.placebo.full_rule, 0);
});
