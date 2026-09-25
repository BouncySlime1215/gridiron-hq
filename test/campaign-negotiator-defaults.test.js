/**
 * NEGOTIATOR-DEFAULTS (ONE-PLAN 4d, night 1): the negotiator's default levers, behind
 * GRIDIRON_NEGOTIATOR_DEFAULTS=1 (off by default: nothing Nick sees moves until measured).
 *
 *   defensible anchor   the opening is never below ANCHOR_FLOOR_PCT under even on his screen
 *   two packages        a second genuine package (both beat the backup) when the ladder has one
 *   firm, plain words   no "open to tweaking" / "happy to tweak"; one "why this helps you" line
 *   expiry              every offer says how long it stands
 *   withdraw on news    every offer carries the withdraw rule
 *   interest first      a short feeler before the formal proposal
 *   no pressure tricks  no door-in-the-face, no fake scarcity in any outgoing text
 *   cool-off            he just lost: wait, then a fair offer (no post-loss P(yes) boost)
 *   alt on confirm dice the "Or X for Y" package is served only when it beats doing nothing on the
 *                       confirm dice and stays inside the overpay cap (else alt_dropped says why)
 * The no-trade row per risk mode is NO-TRADE-SHRINK's (modes.js#noTradeRow), not this unit's.
 *
 * Made-up league in test/fixtures/campaign-league.mjs, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ND = await import('../server/services/campaign/negotiator-defaults.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { applyCoachMessages } = await import('../server/services/campaign/messages.js');
const { checkMessage, factsFor } = await import('../server/services/campaign/message-check.js');

const AS_OF = '2026-09-24T00:00:00.000Z';
const FLAGS = ['GRIDIRON_NEGOTIATOR_DEFAULTS', 'GRIDIRON_COACH_MESSAGES', 'GRIDIRON_PREVIEW_UNCONFIRMED'];
const ND_ON = { GRIDIRON_NEGOTIATOR_DEFAULTS: '1' };
const withEnv = (vals, fn) => {
  const saved = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, vals);
  try { return fn(); } finally {
    for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};
// The flag reaches the planner the way the producer passes it: settings.env (never process.env).
const run = (obj = {}, adapterOpts = {}, env = {}, wrap = a => a) => {
  const a = wrap(makeAdapter(adapterOpts));
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced', ...obj }), env });
  return { res, entry: toEntry(res, { names: a.names(), as_of: AS_OF }), names: a.names() };
};
const OBJECTIVES = [{}, { risk_mode: 'all_in' }, { risk_mode: 'safe' }];
const movesOf = entry => [entry.next_move.value, ...(entry.alternatives.value ?? [])].filter(Boolean);
const NAMES = { 1: 'Alpha One (QB)', 2: 'Bravo Two (RB)', 3: 'Charlie Three (WR)', 11: 'Delta Eleven (WR)', 12: 'Echo Twelve (TE)' };
const who = id => {
  const m = /^(.*?) \((\w+)\)$/.exec(NAMES[id] ?? '');
  return m ? { name: m[1], position: m[2] } : { name: `player ${id}`, position: null };
};

/* ------------------------------------------------------------------ pure pieces */

test('flag: off unless GRIDIRON_NEGOTIATOR_DEFAULTS is exactly 1 (the preview switch does not turn it on)', () => {
  assert.equal(ND.negotiatorDefaultsOn({}), false);
  assert.equal(ND.negotiatorDefaultsOn({ GRIDIRON_NEGOTIATOR_DEFAULTS: '0' }), false);
  assert.equal(ND.negotiatorDefaultsOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(ND.negotiatorDefaultsOn({ GRIDIRON_NEGOTIATOR_DEFAULTS: '1' }), true);
  assert.equal(ND.negotiatorDefaultsOn(), false, 'no env passed: off');
  assert.equal('noTradeRow' in ND, false, 'one producer of the no-trade row: modes.js');
});

const rung = (give, his_pct, nick_gain = 0.01, p = 0.3) => ({ give, his_pct, nick_gain, p });

test('defensible anchor: an opening below the floor on his screen is lifted to the first rung at or above it', () => {
  const ladder = {
    opening: rung([1], -18), walk_away: rung([1, 3], 6), indifference: rung([2], -1),
    ladder: [rung([1], -18), rung([3], -9), rung([2], -1), rung([1, 3], 6)], reason: null,
  };
  const out = ND.defensibleLadder(ladder);
  assert.deepEqual(out.opening.give, [2]);
  assert.equal(out.anchor.lifted, true);
  assert.equal(out.anchor.from_pct, -18);
  assert.equal(out.anchor.to_pct, -1);
  assert.equal(out.anchor.defensible, true);
  assert.ok(out.ladder.every(c => c.his_pct >= -ND.ANCHOR_FLOOR_PCT), 'no rung under the floor is left to climb');
  assert.deepEqual(out.walk_away, ladder.walk_away, 'the walk-away never moves');
});

test('defensible anchor: an opening already inside the floor is kept; no ladder is left as it was', () => {
  const ladder = { opening: rung([2], -3), walk_away: rung([1, 3], 6), ladder: [rung([2], -3), rung([1, 3], 6)], reason: null };
  const out = ND.defensibleLadder(ladder);
  assert.equal(out.opening, ladder.opening);
  assert.equal(out.anchor.lifted, false);
  const none = { opening: null, walk_away: null, ladder: [], reason: 'no priced packages' };
  assert.equal(ND.defensibleLadder(none).opening, null);
  assert.equal(ND.defensibleLadder(none).anchor, null);
});

test('defensible anchor: when even the walk-away is under the floor, open at the walk-away and say it is not defensible', () => {
  const ladder = { opening: rung([1], -30), walk_away: rung([3], -12), ladder: [rung([1], -30), rung([3], -12)], reason: null };
  const out = ND.defensibleLadder(ladder);
  assert.deepEqual(out.opening.give, [3]);
  assert.equal(out.anchor.defensible, false);
});

test('two packages: a second package with a different give, close in value on his screen; none when the ladder has none', () => {
  const ladder = { opening: rung([2], -1), walk_away: rung([1, 3], 12),
    ladder: [rung([2], -1), rung([3], 2, 0.02), rung([1, 3], 12, 0.05)] };
  const alt = ND.secondPackage(ladder);
  assert.deepEqual(alt.give, [3], 'within the band; the richer rung is too far above the opening');
  assert.equal(ND.secondPackage({ opening: rung([2], -1), ladder: [rung([2], -1)] }), null);
  assert.equal(ND.secondPackage({ opening: rung([2], -1), ladder: [rung([2], -1), rung([2], 1)] }), null, 'same give is not a second package');
});

test('why line: names the fit when he is thin at the position, else what the player adds', () => {
  assert.equal(ND.whyLine({ who, give: [2], holes: ['RB'] }), 'Bravo Two fills your RB hole.');
  assert.equal(ND.whyLine({ who, give: [3], holes: ['RB'] }), 'Charlie Three gives you another WR.');
  assert.equal(ND.whyLine({ who: () => ({ name: 'X', position: null }), give: [9], holes: [] }), null);
});

test('firm offer text: why line, both packages, fair, expiry, easy no; nothing soft, nothing pressuring; passes the checker', () => {
  const text = ND.firmOfferText({ who, give: [2], get: [11], alt: [3], holes: ['RB'] });
  assert.match(text, /^Bravo Two fills your RB hole\./);
  assert.match(text, /Bravo Two for Delta Eleven/);
  assert.match(text, /Or Charlie Three for Delta Eleven/);
  assert.match(text, /fair/);
  assert.match(text, /stands for two days/);
  assert.doesNotMatch(text, /tweak/i);
  assert.deepEqual(ND.pressureTactics(text), []);
  const facts = factsFor({ names: NAMES, ids: ['2', '3', '11'], holes: ['RB'], numbers: [] });
  assert.deepEqual(checkMessage(text, facts).errors, []);
});

test('feeler: asks about interest in his player before any formal offer, names only the get', () => {
  const text = ND.feelerText({ who, give: [2], get: [11] });
  assert.match(text, /Delta Eleven/);
  assert.doesNotMatch(text, /Bravo Two/);
  assert.match(text, /before I send/i);
  assert.deepEqual(ND.pressureTactics(text), []);
});

test('pressure tactics: fake scarcity and ultimatums are caught; a plain expiry is not', () => {
  for (const t of ['I have other offers on him.', 'Someone else is asking about him.', 'This won\'t last.',
    'Last chance on this one.', 'Take it or leave it.', 'Final offer.', 'Better move before anyone else does.']) {
    assert.ok(ND.pressureTactics(t).length > 0, t);
  }
  assert.deepEqual(ND.pressureTactics('The offer stands for two days. No worries if it is a no.'), []);
});

test('cool-off: he lost last week -> wait a day, then a fair offer; a later wait already set is kept', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  const lost = ND.coolOff({ when: 'now', until: null, n: 3, why: 'nothing argues for waiting' }, { margin: -22, now });
  assert.equal(lost.when, 'wait');
  assert.equal(lost.until, '2026-09-23T12:00:00.000Z');
  assert.equal(lost.cool_off, true);
  assert.match(lost.why, /cool off/);
  assert.match(lost.why, /fair offer/);
  const won = { when: 'now', until: null, why: 'x' };
  assert.equal(ND.coolOff(won, { margin: 10, now }), won);
  assert.equal(ND.coolOff(won, { margin: null, now }), won);
  const later = { when: 'wait', until: '2026-09-24T00:00:00.000Z', why: 'he declined' };
  assert.equal(ND.coolOff(later, { margin: -5, now }).until, later.until);
});

/* ------------------------------------------------------------------ the producer, flag off / on */

test('the flag in process.env alone does nothing: the planner reads settings.env', () => {
  withEnv(ND_ON, () => {
    const { res } = run({});
    for (const pb of res.playbook) assert.equal('negotiation' in pb, false);
  });
});

test('flag off: no step carries negotiation', () => {
  withEnv({}, () => {
    for (const obj of OBJECTIVES) {
      const { res, entry } = run(obj);
      for (const pb of res.playbook) assert.equal('negotiation' in pb, false);
      for (const m of movesOf(entry)) for (const s of m.steps) assert.equal('negotiation' in s, false);
    }
  });
});

test('flag on: every priced step carries the levers, openings are defensible, the entry validates', () => {
  let pricedAll = 0;
  withEnv({}, () => {
    for (const obj of OBJECTIVES) {
      const { res, entry } = run(obj, {}, ND_ON);
      assert.deepEqual(validateLeague(entry).errors, [], JSON.stringify(obj));
      let priced = 0;
      for (const m of movesOf(entry)) {
        for (const s of m.steps) {
          if (s.reply_table.status !== 'ok') continue;
          priced++;
          assert.equal(s.negotiation.status, 'ok');
          const n = s.negotiation.value;
          for (const l of ['firm_wording', 'expiry', 'withdraw_on_news', 'feeler_first', 'no_pressure_tactics']) assert.ok(n.levers.includes(l), l);
          assert.equal(n.expires_hours, ND.OFFER_HOURS);
          assert.match(n.withdraw_if, /news/);
          assert.deepEqual(ND.pressureTactics(n.feeler), []);
          assert.deepEqual(ND.pressureTactics(s.message.value), []);
          assert.doesNotMatch(s.message.value, /tweak/i);
          if (n.anchor && n.anchor.defensible) assert.ok(n.anchor.to_pct >= -ND.ANCHOR_FLOOR_PCT);
        }
      }
      pricedAll += priced;
      for (const pb of res.playbook) if (pb.opening && pb.negotiation.anchor?.defensible) assert.ok(pb.opening.his_pct >= -ND.ANCHOR_FLOOR_PCT);
      // The no-trade row stays NO-TRADE-SHRINK's shape: this unit writes none of its own.
      for (const r of entry.risk_modes.value) if (r.no_trade) assert.ok(['plan', 'no_trade'].includes(r.no_trade.pick));
    }
  });
  assert.ok(pricedAll > 0, 'fixture has priced steps (a mode may serve no trade on the confirm dice)');
});

test('flag on: the served plan (move ids, title odds, p_yes) is the same as flag off', () => {
  for (const obj of OBJECTIVES) {
    const off = withEnv({}, () => run(obj));
    const on = withEnv({}, () => run(obj, {}, ND_ON));
    const key = e => movesOf(e).map(m => [m.move_id, m.steps.map(s => [s.p_yes.value, s.title_odds_delta.value])]);
    assert.deepEqual(key(on.entry), key(off.entry));
  }
});

test('flag on: he lost last week -> send_when waits (cool-off) and the lever is tagged', () => {
  withEnv({}, () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const lostAll = Object.fromEntries(['2', '3', '4'].map(t => [t, {
      send_when: ND.coolOff({ when: 'now', until: null, why: 'nothing argues for waiting' }, { margin: -20, now }) }]));
    const { entry } = run({}, { managerExtra: lostAll }, ND_ON);
    const s = entry.next_move.value.steps[0];
    assert.match(s.send_when.value, /^Wait until .*cool off/);
    assert.ok(s.negotiation.value.levers.includes('cool_off'));
  });
});

test('flag on + coach messages: the coach text is the firm text, grounded, with no soft or pressure phrasing', () => {
  withEnv({ GRIDIRON_COACH_MESSAGES: '1' }, () => {
    const { entry } = run({}, {}, ND_ON);
    const { entry: out, stats } = applyCoachMessages(entry, { force: true });
    assert.deepEqual(stats.errors, []);
    for (const m of movesOf(out)) {
      for (const s of m.steps) {
        if (s.negotiation?.status !== 'ok') continue;
        assert.match(s.message.value, /stands for two days/);
        assert.doesNotMatch(s.message.value, /tweak/i);
        for (const k of ['accept', 'decline', 'counter', 'silence']) {
          const msg = s.reply_table.value[k]?.value?.message;
          if (msg) { assert.doesNotMatch(msg, /tweak/i, k); assert.deepEqual(ND.pressureTactics(msg), [], k); }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ the second package on the confirm dice */

const altKeys = res => [...new Set(res.deck.flatMap(c => c.playbooks ?? [c.playbook]).filter(Boolean)
  .filter(pb => pb.negotiation?.alt_package).map(pb => pb.negotiation.alt_package.give.map(String).sort().join('+')))];

test('flag on: a served second package beats doing nothing on the confirm dice and is inside the cap', () => {
  withEnv({ GRIDIRON_COACH_MESSAGES: '1' }, () => {
    for (const obj of OBJECTIVES) {
      const { res } = run(obj, {}, ND_ON);
      for (const pb of res.deck.flatMap(c => c.playbooks ?? [c.playbook]).filter(Boolean)) {
        const n = pb.negotiation;
        if (n?.alt_package) assert.equal(n.alt_dropped, undefined);
        if (n?.alt_dropped) assert.ok(['confirm_dice', 'over_cap'].includes(n.alt_dropped));
      }
    }
  });
});

test('flag on: a second package that loses on the confirm dice is dropped from the offer text', () => {
  withEnv({ GRIDIRON_COACH_MESSAGES: '1' }, () => {
    const clean = run({}, {}, ND_ON);
    const served = altKeys(clean.res);
    assert.ok(served.length > 0, 'the fixture serves at least one second package');
    const poisoned = new Set(served.map(k => k.split('+')));
    // Same league, but on every world other than the planning one (the confirm dice), a state where
    // Nick has given away one of the served second packages scores far below doing nothing.
    const wrap = a => {
      const world = a.world;
      return { ...a, world: s => {
        const w = world(s);
        if (s === a.seed || !w || w.fail) return w;
        return { ...w, rescore(state, x = '1', y = null) {
          const r = w.rescore(state, x, y);
          const mine = new Set((state.get('1') ?? a.rosters.get('1')).map(String));
          if (x === '1' && [...poisoned].some(g => g.every(id => !mine.has(id)))) {
            return { ...r, me: { ...r.me, title_delta: -0.05, playoff_delta: -0.05, points_delta: -50 } };
          }
          return r;
        } };
      } };
    };
    const { res, entry } = run({}, {}, ND_ON, wrap);
    const pbs = res.deck.flatMap(c => c.playbooks ?? [c.playbook]).filter(Boolean);
    for (const k of altKeys(res)) assert.equal(served.includes(k), false, `${k} lost on the confirm dice but is still offered`);
    assert.ok(pbs.some(pb => pb.negotiation?.alt_dropped === 'confirm_dice'), 'the drop is recorded with its reason');
    for (const m of movesOf(entry)) for (const s of m.steps) {
      const alt = s.negotiation?.value?.alt_package;
      if (s.message?.status === 'ok' && !alt) assert.doesNotMatch(s.message.value, /whichever works better/);
    }
  });
});

test('cap rule for the second package: over the cap only as the planned premium package confirmed on fresh dice', () => {
  const valueOf = id => ({ 1: 1000, 2: 1000, 3: 1150, 11: 2000 })[id] ?? 0;
  const step = { give: [1, 3], get: [11] };
  // 1 + 2 = 2000 for 2000: even, inside a 0 cap.
  assert.equal(ND.altWithinCap({ give: [1, 2], step, valueOf, maxOverpay: 0 }), true);
  // 1 + 3 = 2150 for 2000: +7.5%, over a 0 cap.
  assert.equal(ND.altWithinCap({ give: [1, 3], step, valueOf, maxOverpay: 0 }), false);
  // Same package as a premium step that has not held on the confirm dice: still over.
  assert.equal(ND.altWithinCap({ give: [1, 3], step: { ...step, depth_premium: { pct: 0.075 } }, valueOf, maxOverpay: 0 }), false);
  // The planned premium package, confirmed on fresh dice: allowed.
  assert.equal(ND.altWithinCap({ give: [1, 3], step: { ...step, depth_premium: { pct: 0.075, confirmed: { points_delta: 1, title_delta: 0.01 } } },
    valueOf, maxOverpay: 0 }), true);
  // A different over-cap package beside a confirmed premium step: over.
  assert.equal(ND.altWithinCap({ give: [2, 3], step: { ...step, depth_premium: { pct: 0.075, confirmed: {} } }, valueOf, maxOverpay: 0 }), false);
});
