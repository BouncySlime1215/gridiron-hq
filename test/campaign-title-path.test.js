/**
 * TITLE-PATH EXPLAINER (plan item 41): three plain lines on why the served move wins the title.
 * Pre-registration: docs/tdd/2026-09-26-title-path.tdd.md (E1-E5) and the PR body.
 * Made-up leagues only (test/fixtures/campaign-league.mjs and synthetic players); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const TP = await import('../server/services/campaign/title-path.js');
const { TITLE_PATH_ENV, titlePathFlag, titlePath, slotLine, weeksLine, oddsLine, blockedInMove, finalRoster, DEV_TEXT, MAX_LINE } = TP;
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const objective = normaliseObjective({ kind: 'title' });
const ON = { [TITLE_PATH_ENV]: '1' };

/* ------------------------------------------------------------ E4 the flag */

test('E4 flag: only 1 computes it (as shadow); unset, 0, shadow and preview mode are off', () => {
  assert.equal(titlePathFlag(ON), 'shadow');
  for (const env of [{}, { [TITLE_PATH_ENV]: '0' }, { [TITLE_PATH_ENV]: 'shadow' }, { GRIDIRON_PREVIEW_UNCONFIRMED: '1' }]) {
    assert.equal(titlePathFlag(env), 'off', JSON.stringify(env));
  }
});

const strip = e => JSON.parse(JSON.stringify(e, (k, v) => (k === 'runtime_ms' || k === 'phases_ms' ? undefined : v)));
const entryFor = env => {
  const a = makeAdapter();
  const res = planLeague(a, { objective, env });
  return { res, entry: toEntry(res, { names: a.names(), as_of: '2026-09-26T00:00:00Z' }) };
};

test('E4 off: nothing is computed and the entry carries no title_path', () => {
  const { res, entry } = entryFor({});
  assert.equal(res.title_path, undefined);
  assert.equal(entry._run.inputs.title_path, undefined);
});

test('E4 shadow moves nothing: on vs off entries differ only at _run.inputs.title_path, and both pass the contract', () => {
  const off = strip(entryFor({}).entry);
  const on = strip(entryFor(ON).entry);
  assert.ok(on._run.inputs.title_path, 'shadow block written');
  assert.equal(on._run.inputs.title_path.mode, 'shadow');
  const { title_path, ...rest } = on._run.inputs;
  assert.deepEqual({ ...on, _run: { ...on._run, inputs: rest } }, off);
  assert.ok(validateLeague(entryFor(ON).entry).ok);
});

/* ------------------------------------------------------ E1 grounding */

// The fixture's made-up players are named P1..P35; their names are not figures.
const numbersIn = line => (line.replace(/\bP\d+\b/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const pct1 = x => Math.round(x * 1000) / 10;

test('E1 grounding: on 10 seeds every figure in the text is a plan number, and the odds line is the plan\'s own odds', () => {
  let explained = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const a = makeAdapter({ seed: 1000 + seed * 7 });
    const res = planLeague(a, { objective, env: ON });
    const tp = res.title_path;
    if (!res.best) { assert.equal(tp.status, 'unknown'); continue; }
    assert.equal(tp.status, 'ok', tp.reason);
    explained++;
    const allowed = new Set(tp.numbers.map(Number));
    for (const line of tp.lines) for (const n of numbersIn(line)) assert.ok(allowed.has(n), `seed ${seed}: ${n} in "${line}" is not a plan number`);
    assert.equal(tp.odds.now, pct1(res.now.title));
    assert.equal(tp.odds.if_lands, pct1(res.now.title + res.best.delta_final));
    assert.equal(tp.odds.expected, pct1(res.now.title + res.best.expected));
    assert.equal(tp.odds.p_complete, Math.round(res.best.p_complete * 100));
  }
  assert.ok(explained >= 8, `explained ${explained} of 10`);
});

test('E1 grounding: the weeks line is the world\'s own weekly draws, after minus now', () => {
  const nowW = [{ week: 5, samples: [100, 102] }, { week: 6, samples: [100, 100] }];
  const after = [{ week: 5, samples: [104, 106] }, { week: 6, samples: [101, 101] }];
  const w = weeksLine({ nowWeeks: nowW, afterWeeks: after, from: 5 });
  assert.deepEqual(w.top, [{ week: 5, delta: 4 }, { week: 6, delta: 1 }]);
  assert.equal(w.per_week, 2.5);
  assert.equal(w.text, 'Your lineup gains +2.5 pts a week from week 5; most in weeks 5, 6 (+4.0, +1.0).');
});

/* ------------------------------------------------------- E2 Nick's rules */

const PL = new Map([
  ['160', { name: 'Made-up WR A', position: 'WR', ros_ppg: 15 }], ['80', { name: 'Made-up RB B', position: 'RB', ros_ppg: 14 }],
  ['277', { name: 'Made-up WR C', position: 'WR', ros_ppg: 13 }], ['290', { name: 'Made-up WR D', position: 'WR', ros_ppg: 12 }],
  ['1', { name: 'Made-up RB E', position: 'RB', ros_ppg: 9 }], ['2', { name: 'Made-up WR F', position: 'WR', ros_ppg: 8 }],
  ['3', { name: 'Made-up TE G', position: 'TE', ros_ppg: 6 }], ['9', { name: 'Made-up RB H', position: 'RB', ros_ppg: 5 }],
  ['50', { name: 'Made-up RB I', position: 'RB', ros_ppg: 16 }], ['51', { name: 'Made-up WR J', position: 'WR', ros_ppg: 11 }],
  ['52', { name: 'Made-up QB K', position: 'QB', ros_ppg: 18 }],
]);
const MINE = ['160', '80', '277', '1', '2', '3', '9'];
const STARTERS = new Set(['160', '80', '277', '1', '2', '3']);
const move = (give, get, extra = {}) => ({ steps: [{ team: '4', give, get }], delta_final: 0.04, expected: 0.02, expected_se: 0.003, p_complete: 0.5, ...extra });
const explain = (plan, extra = {}) => titlePath({ plan, titleNow: 0.1, roster: MINE, players: PL, starters: STARTERS, ...extra });

test('E2 rules: a move that gives 160, 80 or 277, or gets 290, is refused with no text', () => {
  for (const [give, get, id] of [[['160'], ['50'], '160'], [['80'], ['50'], '80'], [['277'], ['50'], '277'], [['9'], ['290'], '290']]) {
    const r = explain(move(give, get));
    assert.equal(r.status, 'refused', `${give} for ${get}`);
    assert.deepEqual(r.blocked, [id]);
    assert.equal(r.lines, undefined);
  }
});

test('E2 rules: an objective untouchable is refused too, and a clean move is explained', () => {
  assert.equal(explain(move(['1'], ['50']), { untouchable: ['1'] }).status, 'refused');
  const ok = explain(move(['1', '9'], ['50']));
  assert.equal(ok.status, 'ok');
  assert.deepEqual(blockedInMove(move(['1', '9'], ['50']).steps, { untouchable: [], mine: MINE }), []);
});

test('E2 rules: through the planner, the explained move never names a blocked id', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const a = makeAdapter({ seed: 2000 + seed });
    a.untouchable = new Set(['2', '3']);
    const res = planLeague(a, { objective, env: ON });
    if (!res.best) continue;
    const ids = res.best.steps.flatMap(s => [...s.give, ...s.get]).map(String);
    assert.ok(!ids.includes('2') && !ids.includes('3'), 'the planner kept the untouchables out');
    assert.equal(res.title_path.status, 'ok');
  }
});

/* ------------------------------------------------- E3 plain text, short */

test('E3 text: at most three lines, each short, with no raw engine labels, file names or bare ids', () => {
  const plans = [move(['1', '9'], ['50']), move(['2'], ['51']), move(['9'], ['52']),
    { ...move(['1'], ['51']), steps: [{ team: '4', give: ['1'], get: ['51'] }, { team: '5', give: ['9'], get: ['50'] }] }];
  const weekly = st => [{ week: 14, samples: [100 + (st ? 3 : 0)] }, { week: 15, samples: [100 + (st ? 6 : 0)] }];
  for (const plan of plans) {
    const r = explain(plan, { weeklyOf: weekly, from: 14, playoffWeeks: [15, 16, 17] });
    assert.ok(r.lines.length <= 3 && r.lines.length >= 2);
    for (const l of r.lines) {
      assert.ok(l.length <= MAX_LINE, `${l.length}: ${l}`);
      assert.ok(!DEV_TEXT.test(l), `dev text in: ${l}`);
    }
  }
  for (let seed = 1; seed <= 5; seed++) {
    const res = planLeague(makeAdapter({ seed: 3000 + seed }), { objective, env: ON });
    for (const l of res.title_path.lines ?? []) assert.ok(l.length <= MAX_LINE && !DEV_TEXT.test(l), l);
  }
});

/* ------------------------------------------------------------- the lines */

test('slot: the get replaces the weakest same-position starter he outscores', () => {
  const s = slotLine({ roster: MINE, steps: move(['9'], ['50']).steps, players: PL, starters: STARTERS });
  assert.equal(s.replaces, '1');
  assert.equal(s.text, 'Fixes your RB slot: Made-up RB I (16 pts a game) starts over Made-up RB E (9).');
});

test('slot: a starter the move gives away is the one replaced, and the line says so', () => {
  const s = slotLine({ roster: MINE, steps: move(['2'], ['51']).steps, players: PL, starters: STARTERS });
  assert.equal(s.replaces, '2');
  assert.match(s.text, /whom you trade away\.$/);
});

test('slot: a WR who outscores no WR starter can still start at FLEX over the weakest RB/WR/TE starter', () => {
  const pl = new Map([...PL, ['51', { ...PL.get('51'), ros_ppg: 7 }]]);
  const s = slotLine({ roster: MINE, steps: move(['9'], ['51']).steps, players: pl, starters: STARTERS });
  assert.equal(s.position, 'FLEX');
  assert.equal(s.replaces, '3');
});

test('slot: a get who starts nowhere is called depth', () => {
  const s = slotLine({ roster: MINE, steps: move(['9'], ['52']).steps, players: PL, starters: STARTERS });
  assert.equal(s.replaces, null);
  assert.match(s.text, /adds QB depth/);
});

test('slot: a player got then given later in the path is not a net get', () => {
  const steps = [{ give: ['9'], get: ['52'] }, { give: ['52'], get: ['50'] }];
  assert.deepEqual(finalRoster(MINE, steps).slice(-1), ['50']);
  assert.equal(slotLine({ roster: MINE, steps, players: PL, starters: STARTERS }).get, '50');
});

test('weeks: flat gains say "about the same every week"; playoff weeks are called out when known', () => {
  const nowW = [14, 15, 16, 17].map(week => ({ week, samples: [100] }));
  const flat = weeksLine({ nowWeeks: nowW, afterWeeks: nowW.map(w => ({ week: w.week, samples: [103] })), from: 14 });
  assert.equal(flat.text, 'Your lineup gains +3.0 pts a week from week 14, about the same every week.');
  const po = weeksLine({ nowWeeks: nowW, afterWeeks: nowW.map(w => ({ week: w.week, samples: [w.week >= 15 ? 106 : 100] })), from: 14, playoffWeeks: [15, 16, 17] });
  assert.match(po.text, /playoff weeks 15-17: \+6\.0 a week\.$/);
  assert.equal(weeksLine({ nowWeeks: nowW, afterWeeks: nowW, from: 18 }).status, 'unknown');
});

test('odds: before -> if it lands -> counting a no, with the SE and the guess label', () => {
  const o = oddsLine({ titleNow: 0.005, plan: move(['1'], ['50'], { delta_final: 0.0483, expected: 0.0212, expected_se: 0.015, p_complete: 0.44 }) });
  assert.equal(o.text, 'Title odds 0.5% now, 5.3% if the trade lands, 2.6% counting the chance of a no (give or take 1.5); it completes 44% of the time, a guess.');
  assert.equal(oddsLine({ titleNow: 0.1, plan: { steps: [] } }).status, 'unknown');
});

test('no move: unknown with a reason, never invented', () => {
  const r = explain(null);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /No move clears/);
});

/* --------------------------------------------------------------- E5 speed */

test('E5 speed: the explainer adds under 50 ms to a planned league', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective, env: {} });
  const W = a.world(a.seed);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    titlePath({ plan: res.best, titleNow: res.now.title, roster: a.rosters.get('1'), players: a.players, starters: a.starters,
      weeklyOf: st => W.weekly(st ? finalRoster(a.rosters.get('1'), res.best.steps).map(Number) : a.rosters.get('1')), from: 4 });
  }
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
});
