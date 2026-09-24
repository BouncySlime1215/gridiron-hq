/**
 * M5, the pitch bandit: which message framing to lead with, per manager.
 *
 * A Thompson-sampling bandit over four framing arms (need-first,
 * fairness-first, urgency-first, face-safe short). Each manager's prior comes
 * from his negotiation profile's `how_to_approach`; the posterior moves with
 * every sent offer that settles (CLONE-01b b1 trade_outcomes). The campaign
 * producer asks it which framing to use; every choice is logged and tied to
 * the offer it was sent with.
 *
 * Gates, pre-registered in docs/tdd/pitch-bandit.tdd.md:
 *  P1 prior: keywords in how_to_approach raise that arm's prior mean; no
 *     profile gives every arm the same base prior, and the basis says so.
 *  P2 veto: what_shuts_him_down naming pressure/deadlines makes urgency_first
 *     ineligible; it is never chosen. face_safe_short is never vetoed.
 *  P3 update: only settled, sent offers with a linked choice move the
 *     posterior (accepted 1, countered 0.5, declined/expired 0); pending rows
 *     and unlinked choices do not.
 *  P4 Thompson: an arm with a clear lead wins most draws; with flat priors
 *     every arm is still chosen sometimes (exploration).
 *  P5 floor: an arm whose posterior mean sits below the floor is never chosen;
 *     if every arm is below it, the best-mean arm is chosen with a reason.
 *  P6 log: every choice writes one pitch_choices row; "I sent this" links the
 *     latest unlinked choice for that deal, or the one named; one choice per
 *     offer.
 *  P7 per manager: one manager's outcomes never move another's posterior.
 *  P8 frameMessage: face_safe_short keeps only the ask; no arm adds a number
 *     that was not in the engine's message.
 *  P9 migration 090 is additive: trade_outcomes' columns are unchanged.
 *  P10 pitchFor (the producer's one call) logs a choice, frames the message
 *     with that arm and carries the choice id that "I sent this" links.
 *  F1 GRIDIRON_PITCH_BANDIT off: pitchFor returns the message unchanged and
 *     writes no pitch_choices row; on and preview both frame and log, preview
 *     with its fields (FIX-263-2).
 *  R1 the prior reads people.profile from the one reader (PEOPLE-01): an ok
 *     entry boosts and vetoes, a quiet (unknown) entry gets the flat prior with
 *     the reader's reason (FIX-263-3).
 *  H1 the campaign producer frames every step through adapter.pitch: a planned
 *     step's message carries pitch_choice_id, and the War Room "I sent it"
 *     (offer.sent) links that choice to the sent offer (FIX-263-4).
 *
 * Every team, player and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pitch-bandit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PITCH_BANDIT = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const bandit = await import('../server/services/pitch-bandit.js');
const { PITCH_ARMS, FLOOR_ABS, priorFromProfile, posteriorFor, chooseFraming, frameMessage, pitchFor, seededRng } = bandit;
const { recordSentOffer } = await import('../server/services/trade-outcomes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

const SEASON = 2026;
let nextLeague = 900;
const freshLeague = () => nextLeague++;
const BAND = { band: { low: 0.2, mid: 0.35, high: 0.5 }, basis: 'heuristic_unanchored' };
let dealN = 0;
const dealFor = partner => ({
  id: `deal-${++dealN}`, partner_id: partner,
  i_give: [{ espn_id: 1000 + dealN, name: `Give ${dealN}` }],
  i_get: [{ espn_id: 5000 + dealN, name: `Get ${dealN}` }],
  acceptance: BAND,
});

/** Choose, send, and settle one offer to `partner` with `arm` forced. */
function loggedOffer(leagueId, partner, arm, status) {
  const deal = dealFor(partner);
  const c = chooseFraming({ league_id: leagueId, season: SEASON, counterparty_team_id: partner,
    deal, profile: null, rng: seededRng(dealN), force_arm: arm });
  const sent = recordSentOffer({ league_id: leagueId, season: SEASON, proposer_team_id: '1', model_version: 'fixture', deal,
    sent_at: `2026-10-0${1 + (dealN % 8)}T12:00:00Z` });
  if (status !== 'proposed') {
    run(`UPDATE trade_outcomes SET status = ?, resolved_at = '2026-10-10T00:00:00Z' WHERE id = ?`, status, sent.id);
  }
  return { choice: c, outcome_id: sent.id };
}

const tally = (n, fn) => {
  const counts = Object.fromEntries(PITCH_ARMS.map(a => [a, 0]));
  for (let i = 0; i < n; i++) counts[fn(i).arm]++;
  return counts;
};

/* ------------------------------------------------------------------ P1 */

test('P1 how_to_approach keywords raise that arm; no profile gives a flat base prior', () => {
  const flat = priorFromProfile(null);
  const means = PITCH_ARMS.map(a => flat.arms[a].alpha / (flat.arms[a].alpha + flat.arms[a].beta));
  assert.ok(means.every(m => Math.abs(m - means[0]) < 1e-12), 'flat prior when there is no profile');
  assert.match(flat.basis, /no negotiation profile/);

  const p = priorFromProfile({ how_to_approach: 'Keep it short and direct. Show him the roster hole it fills.' });
  const mean = a => p.arms[a].alpha / (p.arms[a].alpha + p.arms[a].beta);
  assert.ok(mean('face_safe_short') > mean('urgency_first'));
  assert.ok(mean('need_first') > mean('urgency_first'));
  assert.equal(mean('urgency_first'), mean('fairness_first'));
  assert.ok(p.arms.face_safe_short.hits.length > 0, 'the matched words are recorded');
  assert.match(p.basis, /how_to_approach/);
  assert.equal(p.fitted, false);
});

/* ------------------------------------------------------------------ P2 */

test('P2 what_shuts_him_down vetoes urgency; the vetoed arm is never chosen', () => {
  const L = freshLeague();
  const profile = { how_to_approach: 'Hit him fast before the deadline, he likes urgency.',
    what_shuts_him_down: ['Being pressured or rushed', 'Lowball offers'] };
  const prior = priorFromProfile(profile);
  assert.ok(prior.vetoed.includes('urgency_first'));
  assert.ok(!prior.vetoed.includes('face_safe_short'));
  const counts = tally(200, i => chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '7',
    profile, rng: seededRng(i + 1), log: false }));
  assert.equal(counts.urgency_first, 0);
});

/* ------------------------------------------------------------------ P3 */

test('P3 only settled, sent, linked offers move the posterior; countered counts half', () => {
  const L = freshLeague();
  loggedOffer(L, '3', 'fairness_first', 'accepted');
  loggedOffer(L, '3', 'fairness_first', 'accepted');
  loggedOffer(L, '3', 'fairness_first', 'declined');
  loggedOffer(L, '3', 'fairness_first', 'countered');
  loggedOffer(L, '3', 'fairness_first', 'expired');
  loggedOffer(L, '3', 'fairness_first', 'proposed'); // pending: not counted
  // a choice that was never sent: not counted
  chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '3', deal: dealFor('3'),
    profile: null, rng: seededRng(99), force_arm: 'fairness_first' });

  const post = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '3', profile: null });
  const prior = priorFromProfile(null).arms.fairness_first;
  const f = post.arms.fairness_first;
  assert.equal(f.n, 5);
  assert.ok(Math.abs(f.alpha - (prior.alpha + 2.5)) < 1e-9, `alpha ${f.alpha}`);
  assert.ok(Math.abs(f.beta - (prior.beta + 2.5)) < 1e-9, `beta ${f.beta}`);
  assert.equal(post.arms.need_first.n, 0);
});

/* ------------------------------------------------------------------ P4 */

test('P4 Thompson sampling exploits a clear lead and still explores flat priors', () => {
  const L = freshLeague();
  for (let i = 0; i < 6; i++) loggedOffer(L, '4', 'need_first', 'accepted');
  const lead = tally(200, i => chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '4',
    profile: null, rng: seededRng(1000 + i), log: false }));
  assert.ok(lead.need_first > 160, `need_first chosen ${lead.need_first}/200`);

  const flat = tally(400, i => chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '44',
    profile: null, rng: seededRng(5000 + i), log: false }));
  for (const a of PITCH_ARMS) assert.ok(flat[a] > 40, `${a} explored ${flat[a]}/400`);
});

/* ------------------------------------------------------------------ P5 */

test('P5 an arm below the floor is never chosen; all below picks the best mean', () => {
  const L = freshLeague();
  for (let i = 0; i < 12; i++) loggedOffer(L, '5', 'urgency_first', 'declined');
  const post = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '5', profile: null });
  assert.ok(post.arms.urgency_first.mean < FLOOR_ABS, `mean ${post.arms.urgency_first.mean}`);
  const counts = tally(500, i => chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '5',
    profile: null, rng: seededRng(20_000 + i), log: false }));
  assert.equal(counts.urgency_first, 0);

  const L2 = freshLeague();
  for (const a of PITCH_ARMS) {
    const n = a === 'need_first' ? 10 : 14;
    for (let i = 0; i < n; i++) loggedOffer(L2, '6', a, 'declined');
  }
  const pick = chooseFraming({ league_id: L2, season: SEASON, counterparty_team_id: '6',
    profile: null, rng: seededRng(1), log: false });
  assert.equal(pick.arm, 'need_first');
  assert.match(pick.reason, /below the floor/);
});

/* ------------------------------------------------------------------ P6 */

test('P6 every choice is logged; "I sent this" links the latest unlinked choice, or the one named', () => {
  const L = freshLeague();
  const deal = dealFor('8');
  const first = chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '8', deal,
    profile: { how_to_approach: 'short and direct' }, rng: seededRng(3) });
  const second = chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '8', deal,
    profile: { how_to_approach: 'short and direct' }, rng: seededRng(4) });
  const logged = rows('SELECT * FROM pitch_choices WHERE league_id = ? ORDER BY id', L);
  assert.equal(logged.length, 2);
  const r0 = logged[0];
  assert.equal(r0.id, first.choice_id);
  assert.equal(r0.arm, first.arm);
  assert.equal(r0.idea_id, deal.id);
  assert.equal(r0.outcome_id, null);
  for (const k of ['samples_json', 'posterior_json', 'eligible_json']) assert.ok(JSON.parse(r0[k]));
  assert.match(r0.prior_basis, /how_to_approach/);

  const sent = recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1', model_version: 'fixture', deal });
  assert.equal(row('SELECT outcome_id FROM pitch_choices WHERE id = ?', second.choice_id).outcome_id, sent.id);
  assert.equal(row('SELECT outcome_id FROM pitch_choices WHERE id = ?', first.choice_id).outcome_id, null);
  // a second tap does not relink
  recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1', model_version: 'fixture', deal });
  assert.equal(row('SELECT COUNT(*) AS n FROM pitch_choices WHERE outcome_id = ?', sent.id).n, 1);

  // named choice wins over the latest
  const deal2 = dealFor('8');
  const a = chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '8', deal: deal2,
    profile: null, rng: seededRng(5) });
  chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: '8', deal: deal2,
    profile: null, rng: seededRng(6) });
  const sent2 = recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1', model_version: 'fixture', deal: deal2,
    pitch_choice_id: a.choice_id });
  assert.equal(row('SELECT outcome_id FROM pitch_choices WHERE id = ?', a.choice_id).outcome_id, sent2.id);

  // a deal with no choice sends fine and links nothing
  const bare = recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1', model_version: 'fixture', deal: dealFor('8') });
  assert.equal(bare.state, 'recorded');
  assert.equal(bare.pitch_choice_id ?? null, null);
});

/* ------------------------------------------------------------------ P7 */

test('P7 one manager\'s outcomes never move another\'s posterior', () => {
  const L = freshLeague();
  for (let i = 0; i < 5; i++) loggedOffer(L, '9', 'fairness_first', 'accepted');
  const other = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '10', profile: null });
  const flat = priorFromProfile(null);
  for (const a of PITCH_ARMS) {
    assert.equal(other.arms[a].n, 0);
    assert.equal(other.arms[a].alpha, flat.arms[a].alpha);
  }
});

/* ------------------------------------------------------------------ P8 */

test('P8 frameMessage reshapes the engine message without adding numbers', () => {
  const msg = {
    text: 'Looks like you could use a RB. Runner One projects 14.2 pts a game the rest of the way. Would you do Runner One for Catcher Two?',
    facts: [{ text: 'his roster read lists RB as a need', field: 'counterparty.needs' },
      { text: 'Runner One ros_ppg 14.2', field: 'asset.ros_ppg' }],
    checked: true, source: 'template',
  };
  const numbers = s => (s.match(/\d+(\.\d+)?/g) ?? []).sort();
  for (const arm of PITCH_ARMS) {
    const out = frameMessage(msg, arm);
    assert.equal(out.framing, arm);
    assert.ok(out.text.includes('Would you do Runner One for Catcher Two?'), `${arm} keeps the ask`);
    for (const n of numbers(out.text)) assert.ok(numbers(msg.text).includes(n), `${arm} added ${n}`);
  }
  const short = frameMessage(msg, 'face_safe_short');
  assert.ok(!/could use/.test(short.text), 'face-safe drops the need line');
  assert.ok(!/14\.2/.test(short.text));
  assert.deepEqual(short.facts, []);
  assert.ok(frameMessage(msg, 'need_first').text.startsWith('Looks like you could use a RB.'));
  assert.throws(() => frameMessage(msg, 'nonsense'), /unknown framing arm/);
});

/* ------------------------------------------------------------------ P9 */

test('P9 migration 090 is additive and leaves trade_outcomes alone', async () => {
  const cols = rows('PRAGMA table_info(pitch_choices)').map(c => c.name);
  for (const c of ['league_id', 'season', 'counterparty_team_id', 'idea_id', 'arm', 'outcome_id', 'chosen_at'])
    assert.ok(cols.includes(c), c);
  const toCols = rows('PRAGMA table_info(trade_outcomes)').map(c => c.name);
  assert.ok(!toCols.includes('pitch_json'), 'pitch_json stays for the b2 migration');
  const m = await import('../server/migrations/090_pitch_bandit.js');
  assert.equal(m.name, '090_pitch_bandit');
  // one choice per offer
  assert.throws(() => run(`INSERT INTO pitch_choices (league_id, season, counterparty_team_id, arm, prior_basis,
      samples_json, posterior_json, eligible_json, floor, reason, chosen_at, outcome_id)
    SELECT league_id, season, counterparty_team_id, arm, prior_basis, samples_json, posterior_json, eligible_json,
      floor, reason, chosen_at, outcome_id FROM pitch_choices WHERE outcome_id IS NOT NULL LIMIT 1`), /UNIQUE/);
});

/* ----------------------------------------------------------------- P10 */

test('P10 pitchFor: the campaign producer\'s one call logs, frames and links', () => {
  const L = freshLeague();
  const deal = dealFor('11');
  const message = { text: 'Looks like you could use a WR. Would you do Give A for Get B?', facts: [], checked: true };
  const { message: framed, choice } = pitchFor({ league_id: L, season: SEASON, counterparty_team_id: '11',
    deal, message, profile: { how_to_approach: 'brief and direct' }, rng: seededRng(7) });
  assert.equal(framed.framing, choice.arm);
  assert.equal(framed.pitch_choice_id, choice.choice_id);
  assert.equal(row('SELECT arm FROM pitch_choices WHERE id = ?', choice.choice_id).arm, choice.arm);
  const sent = recordSentOffer({ league_id: L, season: SEASON, proposer_team_id: '1', model_version: 'fixture',
    deal, pitch_choice_id: framed.pitch_choice_id });
  assert.equal(sent.pitch_choice_id, choice.choice_id);
});

/* ------------------------------------------------------------------ F1 */

test('F1 flag off: pitchFor keeps the message and logs nothing; on and preview frame and log', () => {
  const L = freshLeague();
  const message = { text: 'Looks like you could use a WR. Would you do Give A for Get B?', facts: [], checked: true };
  const count = () => row('SELECT COUNT(*) n FROM pitch_choices WHERE league_id = ?', L).n;
  const call = () => pitchFor({ league_id: L, season: SEASON, counterparty_team_id: '12', deal: dealFor('12'),
    message, profile: null, rng: seededRng(5) });
  const saved = { bandit: process.env.GRIDIRON_PITCH_BANDIT, preview: process.env.GRIDIRON_PREVIEW_UNCONFIRMED };
  try {
    delete process.env.GRIDIRON_PITCH_BANDIT;
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    const off = call();
    assert.equal(off.enabled, false);
    assert.equal(off.message, message, 'off returns the producer message itself');
    assert.equal(off.choice, null);
    assert.equal(count(), 0, 'off writes no pitch_choices row');

    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const preview = call();
    assert.equal(preview.enabled, true);
    assert.equal(preview.preview, true);
    assert.match(preview.preview_reason, /default-off/);
    assert.equal(preview.message.pitch_choice_id, preview.choice.choice_id);
    assert.equal(count(), 1);

    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    process.env.GRIDIRON_PITCH_BANDIT = '1';
    const on = call();
    assert.equal(on.enabled, true);
    assert.equal(on.preview, undefined);
    assert.equal(on.message.framing, on.choice.arm);
    assert.equal(count(), 2);
  } finally {
    for (const [k, v] of [['GRIDIRON_PITCH_BANDIT', saved.bandit], ['GRIDIRON_PREVIEW_UNCONFIRMED', saved.preview]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/* ------------------------------------------------------------------ R1 */

test('R1 the prior comes from the one people.profile reader; a quiet manager gets the flat prior', async () => {
  const { peopleProfileFromRows } = await import('../server/services/people/profile-reader.js');
  const profile = (extra) => ({
    headline: 'h', says_no: { how: 'plain', hard_no_looks_like: ['x'], soft_no_looks_like: ['y'], does_his_no_hold: 'yes', evidence: ['e'] },
    praise_means: { reading: 'belief', why: 'w', hypes_before_selling: false, agrees_with_numbers: 'a', evidence: ['e'] },
    techniques: [{ name: 't', how_he_does_it: 'h', evidence: ['e'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 's', baseline_tone: 'b', inflation: 'none' },
    roster_read: { really_untouchable: [], quietly_available: [], overvalues: [], undervalues: [], reasoning: 'r' },
    what_moves_him: ['m'], best_bait: 'b', confidence: 'medium', caveats: ['c'],
    deal_feelings: { after_win: 'w', after_loss: 'l' }, values_talk: { claims: ['c'], acts: ['a'] },
    behaviour_vs_words: 'b', changes_since_0918: ['c'], as_of: '2026-09-22', nick_override: {}, ...extra,
  });
  const stored = (name, p, n) => ({ name, profile_json: JSON.stringify({ ...p, messages_read: n }), messages_read: n,
    model: 'm', built_at: '2026-09-22 05:00:00', corpus_hash: `h-${name}` });
  const people = peopleProfileFromRows({
    leagueId: 77,
    profiles: [
      stored('Made Up A', profile({ how_to_approach: 'Keep it short and direct.', what_shuts_him_down: ['pressure and deadlines'] }), 120),
      stored('Made Up B', profile({ how_to_approach: 'Keep it short.', what_shuts_him_down: ['s'] }), 5),
    ],
    ids: new Map([['21', { chat_name: 'Made Up A' }], ['22', { chat_name: 'Made Up B' }]]),
  });
  assert.equal(people.byRoster.get('21').status, 'ok', people.byRoster.get('21').reason ?? '');
  assert.equal(people.byRoster.get('22').status, 'unknown');

  const L = freshLeague();
  const read = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '21', people });
  assert.ok(read.arms.face_safe_short.mean > read.arms.need_first.mean, 'how_to_approach boosts face_safe_short');
  assert.deepEqual(read.vetoed, ['urgency_first']);
  assert.match(read.basis, /keyword prior/);

  const quiet = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '22', people });
  assert.deepEqual(new Set(PITCH_ARMS.map(a => quiet.arms[a].mean.toFixed(6))).size, 1, 'unknown is not scored');
  assert.match(quiet.basis, /quiet in chat/);

  const none = posteriorFor({ league_id: L, season: SEASON, counterparty_team_id: '23', people });
  assert.match(none.basis, /no profile for this manager/);
});

/* ------------------------------------------------------------------ H1 */

test('H1 the producer frames each step through adapter.pitch; "I sent it" links the choice', async () => {
  const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
  const { planLeague } = await import('../server/services/campaign/planner.js');
  const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
  const { toEntry } = await import('../server/services/campaign/view.js');
  const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
  const { recordRequest } = await import('../server/services/warroom-actions/store.js');
  const { producerPitch } = bandit;

  const a = makeAdapter();
  const L = a.league.id;
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
       VALUES (?, 'espn', ?, ?, ?, '{"teams":[]}', 4, '1', 4)`, L, `espn-pitch-${L}`, SEASON, `L${L}`);
  a.pitch = producerPitch({ league_id: L, season: SEASON, rng: seededRng(11), now: '2026-10-01T00:00:00Z' });

  const res = planLeague(a, { objective: normaliseObjective({}) });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
  assert.deepEqual(validateLeague(entry).errors, [], 'pitch_choice_id / framing are contract keys on the message field');

  const step = entry.next_move.value.steps[0];
  assert.equal(step.message.status, 'ok');
  assert.ok(Number.isInteger(step.message.pitch_choice_id), 'a produced step carries a pitch_choice_id');
  const choice = row('SELECT * FROM pitch_choices WHERE id = ?', step.message.pitch_choice_id);
  assert.equal(choice.counterparty_team_id, String(step.partner));
  assert.equal(choice.arm, step.message.framing);
  assert.equal(choice.outcome_id, null);

  // As fix-07-warroom-inputs.test.js does: the ledger takes one of 067's model_basis values.
  step.p_yes_band = { low: Math.min(0.2, step.p_yes.value), high: Math.max(0.6, step.p_yes.value), basis: 'heuristic_unanchored' };
  // A later run logged a newer choice for the same deal; the card's own choice is the one that links.
  const newer = chooseFraming({ league_id: L, season: SEASON, counterparty_team_id: String(step.partner),
    idea_id: choice.idea_id, profile: null, rng: seededRng(12), now: '2026-10-02T00:00:00Z' });
  const plans = { status: 'ok', entries: [entry], as_of: entry.as_of ?? '2026-10-01T00:00:00Z', id: 'plans@pitch' };
  const sent = recordRequest({ userId: 1, leagueId: L, kind: 'offer.sent',
    payload: { move_id: entry.next_move.value.move_id }, plans });
  assert.equal(sent.trade_outcome.state, 'recorded', JSON.stringify(sent.trade_outcome));
  const linked = row('SELECT outcome_id FROM pitch_choices WHERE id = ?', choice.id);
  assert.equal(linked.outcome_id, sent.trade_outcome.id, 'the sent offer links the step\'s choice');
  assert.equal(row('SELECT outcome_id FROM pitch_choices WHERE id = ?', newer.choice_id).outcome_id, null);

  const saved = process.env.GRIDIRON_PITCH_BANDIT;
  delete process.env.GRIDIRON_PITCH_BANDIT;
  try {
    const before = row('SELECT COUNT(*) n FROM pitch_choices').n;
    const off = toEntry(planLeague(Object.assign(makeAdapter(), { pitch: producerPitch({ league_id: L, season: SEASON }) }),
      { objective: normaliseObjective({}) }), { names: a.names(), as_of: '2026-10-01T00:00:00Z' });
    assert.equal(off.next_move.value.steps[0].message.pitch_choice_id, undefined, 'off: the draft is unframed');
    assert.equal(row('SELECT COUNT(*) n FROM pitch_choices').n, before, 'off: the producer logs nothing');
  } finally { process.env.GRIDIRON_PITCH_BANDIT = saved; }
});
