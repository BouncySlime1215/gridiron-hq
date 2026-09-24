/**
 * COACH-MSG: grounded group-chat messages per campaign step (NORTH-STAR row 6).
 * Fixtures: test/fixtures/warroom-contract/producer-plans.json (made-up league written by the
 * real producer) and hand-built made-up profiles. No real league, manager or chat data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import('../server/services/campaign/messages.js');
const C = await import('../server/services/campaign/message-check.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

const PLANS = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/warroom-contract/producer-plans.json'), 'utf8'));
const live = () => PLANS.leagues.filter(e => !e.error && e.next_move?.status === 'ok');

const NAMES = { 10: 'Alpha Runner (RB)', 11: 'Bravo Catcher (WR)', 12: 'Charlie Passer (QB)', 13: 'Delta Tight (TE)', 14: 'Echo Brown (RB)' };
const facts = (ids, extra = {}) => C.factsFor({ names: NAMES, ids, ...extra });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/* ---------------------------------------------------------------- checker */

test('checker: a message naming only the step players passes and lists its claims', () => {
  const r = C.checkMessage('Hey! Would you do Alpha Runner for Bravo Catcher? No worries if not.', facts(['10', '11']));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.claims.players.sort(), ['10', '11']);
});

test('checker: a player outside the step is rejected, by full name and by surname', () => {
  assert.equal(C.checkMessage('Would you do Alpha Runner for Charlie Passer?', facts(['10', '11'])).ok, false);
  const r = C.checkMessage('Would you do Alpha Runner for Passer?', facts(['10', '11']));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /Passer/);
});

test('checker: a number not in the step fields is rejected; one that is passes', () => {
  assert.equal(C.checkMessage('Alpha Runner scores 14.2 a game.', facts(['10'])).ok, false);
  assert.equal(C.checkMessage('Team 7 is next.', facts(['10'], { numbers: ['7'] })).ok, true);
  assert.equal(C.checkMessage('his screen +28%', facts(['10'], { numbers: ['28%'] })).ok, true);
});

test('checker: positions must be an allowed player position or an engine-read hole', () => {
  assert.equal(C.checkMessage('You could use a TE.', facts(['10'])).ok, false);
  assert.equal(C.checkMessage('You could use a TE.', facts(['10'], { holes: ['TE'] })).ok, true);
  assert.equal(C.checkMessage('Alpha Runner is an RB.', facts(['10'])).ok, true);
});

test('checker: invented names, quotes and over-length messages are rejected', () => {
  assert.equal(C.checkMessage('Would you do Alpha Runner for Zed Unknown?', facts(['10'])).ok, false, 'invented proper noun');
  assert.equal(C.checkMessage('He said "no way" last week.', facts(['10'])).ok, false, 'quote mark');
  assert.equal(C.checkMessage(`Alpha Runner ${'x'.repeat(C.MAX_CHARS)}`, facts(['10'])).ok, false, 'too long');
  assert.equal(C.checkMessage('', facts(['10'])).ok, false, 'empty');
});

test('checker: a name that contains digits never reads as a number, and P1 is not P12', () => {
  const names = { 1: 'P1 (QB)', 12: 'P12 (WR)' };
  assert.equal(C.checkMessage('Would you do P1 for P12?', C.factsFor({ names, ids: ['1', '12'] })).ok, true);
  assert.equal(C.checkMessage('Would you do P1 for P12?', C.factsFor({ names, ids: ['1'] })).ok, false);
});

/* ---------------------------------------------------------------- profile labels */

const PROFILE = {
  how_to_approach: 'Keep it short and clean, one exact trade. Say it is his call; he hates being rushed. Expect a slow reply.',
  best_bait: 'Echo Brown is what he wants. Do not open with Alpha Runner.',
  what_shuts_him_down: ['Lowball offers', 'Asks for Charlie Passer'],
  says_no: { does_his_no_hold: 'usually' },
  roster_read: { really_untouchable: ['Charlie Passer'] },
};

test('profile -> labels only: bait, negated bait, core asks and approach classes', () => {
  const p = M.profileLabels(PROFILE, { giveIds: ['10', '14'], getIds: ['12'], names: NAMES });
  for (const k of ['short_clean', 'his_call', 'no_pressure', 'slow_reply', 'no_lowball', 'no_holds']) assert.ok(p.labels.has(k), k);
  assert.equal(p.bait, '14');
  assert.ok(p.avoid_lead.has('10'), 'the bait line says not to open with him');
  assert.ok(p.core_ask.has('12'));
  assert.deepEqual(M.profileLabels(null).labels.size, 0);
});

test('offer text: framed on his need, short when the profile says so, never copies profile text', () => {
  const partner = { team: '3', roster_holes: ['RB'], chat_labels: ['tone:friendly'] };
  const prof = M.profileLabels(PROFILE, { giveIds: ['14'], getIds: ['11'], names: NAMES });
  const t = M.offerText({ names: NAMES, partner, prof, give: ['14'], get: ['11'], even: true, seed: 1 });
  assert.match(t, /RB/);
  assert.match(t, /Echo Brown/);
  assert.match(t, /Your call\./);
  assert.match(t, /No rush/);
  assert.ok(t.length <= C.MAX_CHARS);
  for (const phrase of ['short and clean', 'is what he wants', 'hates being rushed', 'Lowball']) assert.ok(!t.includes(phrase), phrase);
  assert.equal(C.checkMessage(t, C.factsFor({ names: NAMES, ids: ['14', '11'], holes: ['RB'] })).ok, true);
});

/* ---------------------------------------------------------------- the entry */

test('flag off: the entry comes back untouched', () => {
  withEnv({ [M.COACH_MESSAGES_ENV]: undefined, [PREVIEW_ENV]: undefined }, () => {
    const e = live()[0];
    const r = M.applyCoachMessages(e);
    assert.equal(r.entry, e);
    assert.equal(r.stats.steps, 0);
  });
});

test('flag on (own flag or preview switch): every graded step gets a grounded coach message, <= 280 chars', () => {
  for (const env of [{ [M.COACH_MESSAGES_ENV]: '1', [PREVIEW_ENV]: undefined }, { [M.COACH_MESSAGES_ENV]: undefined, [PREVIEW_ENV]: '1' }]) {
    withEnv(env, () => {
      let steps = 0, grounded = 0;
      for (const e of live()) {
        const { entry } = M.applyCoachMessages(e);
        const g = M.gradeEntry(entry);
        steps += g.steps; grounded += g.coach - g.ungrounded;
        assert.equal(g.ungrounded, 0);
        assert.ok(g.max_len <= C.MAX_CHARS);
      }
      assert.ok(steps > 0, 'the fixture has steps to grade');
      assert.ok(grounded / steps >= 0.9, `${grounded}/${steps}`);
    });
  }
});

test('the plans file with coach texts still passes validatePlans, and the input is not mutated', () => {
  const before = JSON.stringify(PLANS);
  const doc = { ...PLANS, leagues: PLANS.leagues.map(e => M.applyCoachMessages(e, { force: true }).entry) };
  const v = validatePlans(doc);
  assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 3)));
  assert.equal(JSON.stringify(PLANS), before);
});

test('every priced step gets a reply table (accept / decline / counter / silence) and a walk-away, in names not ids', () => {
  let priced = 0;
  for (const e of live()) {
    const { entry } = M.applyCoachMessages(e, { force: true });
    for (const m of M.targetMoves(entry)) {
      for (const s of m.steps) {
        if (!M.isPriced(s)) continue;
        priced++;
        assert.equal(s.reply_table.status, 'ok');
        for (const k of ['accept', 'decline', 'counter', 'silence']) {
          const row = s.reply_table.value[k];
          assert.equal(row.status, 'ok', k);
          assert.ok(row.value.message, `${k} has a reply text`);
        }
        // The walk-away is rephrased only where the engine priced one; otherwise its reason stays.
        if (s.walk_away.status === 'ok') assert.ok(s.walk_away.value.max_give.length >= 1);
        else assert.notEqual(s.walk_away.source, 'plan.path', 'no invented walk-away');
        const cr = s.reply_table.value.counter.value.counter_rules;
        if (cr) assert.doesNotMatch(cr.counter_with, /^\d+( \+ \d+)*/, 'names, not ids');
      }
    }
  }
  assert.ok(priced > 0);
});

test('a step with no playbook gets the offer message only; its reply table and walk-away stay unknown', () => {
  let unpriced = 0;
  for (const e of live()) {
    const orig = new Map(M.targetMoves(e).flatMap(m => m.steps.map((s, i) => [`${m.move_id}#${i}`, s])));
    const { entry } = M.applyCoachMessages(e, { force: true });
    assert.equal(M.gradeEntry(entry).invented_playbook, 0);
    for (const m of M.targetMoves(entry)) {
      m.steps.forEach((s, i) => {
        const before = orig.get(`${m.move_id}#${i}`);
        if (M.isPriced(before)) return;
        unpriced++;
        assert.deepEqual(s.reply_table, before.reply_table, 'reply table untouched');
        assert.deepEqual(s.walk_away, before.walk_away, 'walk-away untouched');
        assert.deepEqual(s.opening, before.opening);
        assert.equal(s.message.source, M.COACH_SOURCE);
        assert.doesNotMatch(s.message.value, /backup|priced|slider/i);
      });
    }
  }
  assert.ok(unpriced > 0, 'the fixture has later steps with no playbook');
});

test('a priced step with no backup never tells Nick to use a backup', () => {
  for (const e of live()) {
    const { entry } = M.applyCoachMessages(e, { force: true });
    for (const m of M.targetMoves(entry)) {
      for (const s of m.steps) {
        if (!M.isPriced(s) || s.reply_table.value.decline.value?.move_id) continue;
        const rt = s.reply_table.value;
        for (const k of ['decline', 'counter', 'silence']) assert.doesNotMatch(rt[k].value.do, /use the backup|offer Team/, k);
        assert.doesNotMatch(rt.decline.value.do, /No backup clears/);
        if (s.walk_away.status === 'ok') assert.doesNotMatch(s.walk_away.value.text, /backup/);
      }
    }
  }
});

test('a phraser that invents a player or a number is rejected and the template text stays', () => {
  const e = live()[0];
  const liar = () => 'Hey! Would you do P1 for P2? He scores 99 a game.';
  const { entry, stats } = M.applyCoachMessages(e, { force: true, phrase: liar });
  assert.equal(stats.grounded, 0);
  assert.ok(stats.fallback > 0);
  const s0 = entry.next_move.value.steps[0];
  assert.deepEqual(s0.message, e.next_move.value.steps[0].message, 'template fallback');
  assert.equal(M.gradeEntry(entry).ungrounded, 0, 'no ungrounded coach message survives');
});

test('baseline measure: the producer template states numbers that are not in the step fields', () => {
  const g = live().map(M.gradeEntry).reduce((a, b) => ({ steps: a.steps + b.steps, template: a.template + b.template,
    template_ungrounded: a.template_ungrounded + b.template_ungrounded, coach: a.coach + b.coach }));
  assert.equal(g.coach, 0);
  assert.ok(g.template > 0 && g.template_ungrounded > 0);
});

test('model phraser: off without the paid opt-in; on, its text is gated by the checker', async () => {
  const ctx = { names: NAMES, give: ['10'], get: ['11'], partner: { roster_holes: [] }, prof: M.profileLabels(null) };
  let called = 0;
  const good = async () => { called++; return 'Hey! Would you do Alpha Runner for Bravo Catcher? No worries if not.'; };
  const bad = async () => 'Would you do Alpha Runner for Charlie Passer?';
  assert.equal(await M.phraseWithModel(ctx, { callModel: good, env: { [M.COACH_MESSAGES_ENV]: '1' } }), null);
  assert.equal(called, 0, 'no paid call without the opt-in');
  const env = { [M.COACH_MESSAGES_ENV]: '1', GRIDIRON_ALLOW_PAID_RUN: 'yes' };
  assert.match(await M.phraseWithModel(ctx, { callModel: good, env }), /Alpha Runner/);
  assert.equal(await M.phraseWithModel(ctx, { callModel: bad, env }), null);
  assert.equal(await M.phraseWithModel(ctx, { callModel: async () => { throw new Error('budget'); }, env }), null);
});

test('gradePlansFile: the metric command, before and after, on the made-up file', () => {
  const before = M.gradePlansFile(PLANS);
  assert.equal(before.totals.coach, 0);
  const after = M.gradePlansFile(PLANS, { apply: true });
  assert.equal(after.totals.ungrounded, 0);
  assert.ok(after.grounded_share >= 0.9, String(after.grounded_share));
  assert.equal(after.totals.invented_playbook, 0);
  assert.ok(after.totals.full_coach <= after.totals.priced_steps);
  assert.ok(after.totals.max_len <= C.MAX_CHARS);
  assert.equal(validatePlans(after.doc).ok, true);
});
