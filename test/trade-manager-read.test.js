/**
 * The manager read, from the layer to the wire to the panel.
 *
 * The counterparty layer is built out of Maps and Sets because that is what is
 * cheapest to price a deal with. Nothing serialised them, so `players`, `reads`,
 * `owned`, `needs`, `surplus` and `stance.respect` / `stance.probe` either never
 * left `readDeal` at all or would have arrived at the client as `{}` — a shape
 * that reads as "no opinion" rather than "not sent". The gates here are the
 * contract that replaced it:
 *
 *  M1 JSON-safe: every Map and Set on a profile reaches the wire as an array or
 *     an object, and survives a JSON round trip with its content intact.
 *  M2 bounded: the per-player reads are narrowed to the players in THIS deal,
 *     and a player nobody has said anything about is ABSENT rather than present
 *     and empty — "no read" must not be readable as "he is neutral on him".
 *  M3 "no data" is not "neutral": an empty read returns null, a profile with no
 *     roster analysis reports `needs: null` while one that was analysed and found
 *     nothing reports `[]`, and `readDeal` with no manager fabricates nothing.
 *  M4 the sample travels with the effect: `receptiveness_factors` keep their `n`
 *     and their cap, because a factor without its sample is a bare number.
 *  M5 the panel: ManagerRead is mounted on every scored deal, gates on
 *     `counterparty_data`, renders an absent tactic rather than hiding it, and
 *     the lone hand-set 'hard' badge it replaced is gone from TradeCard.
 *
 * No database is touched: serialization and `readDeal` are pure functions of a
 * layer profile, and the panel is checked as source.
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeManagerRead, readDeal } from '../server/services/counterparty-pricing.js';

/* ------------------------------------------------------------- fixtures */

const JT = 'Jonathan Taylor';
const CHASE = "Ja'Marr Chase";
const SWIFT = 'D’Andre Swift';

const player = (name, value = 4000) => ({ id: name.length, name, value, position: 'RB' });

/** A layer profile exactly as `counterpartyLayer` builds one: Maps and Sets. */
const profile = (over = {}) => ({
  roster_id: '3',
  receptiveness: 1.12,
  tier: 'hard',
  chat_msgs: 412,
  chat_weight: 1,
  open_to_trade_pct: 0.71,
  trade_talk_pct: 0.6,
  accept_rate: 0.25,
  accept_rate_n: 30,
  players: new Map([
    [JT.toLowerCase(), { sentiment: 3.1, n: 7, last: '2026-09-10', multiplier: 1.06 }],
    [CHASE.toLowerCase(), { sentiment: 1.4, n: 5, last: '2026-09-11', multiplier: 0.95 }],
  ]),
  reads: new Map([
    [JT.toLowerCase(), { verdict: 'sales_pitch', confidence: 'strong', player: JT, mentions: 7,
      sentiment: 3.1, multiplier: 1.06, why: 'praises his own player while he runs hot',
      action: 'do not pay the premium' }],
  ]),
  stance: { stance: 'probe', respect: new Set([CHASE.toLowerCase()]),
    probe: new Set([JT.toLowerCase()]), note: 'his word has held 3 of 6 times', credibility: null },
  priors: { prior_seller: 1 },
  untouchable_rate: 0.04,
  owned: new Set([JT.toLowerCase(), CHASE.toLowerCase()]),
  roster_size: 15,
  needs: new Set(['TE', 'QB']),
  surplus: new Set(['RB']),
  window: { label: 'win-now', stance: 'buying' },
  luck: { value: 1.2, n: 6 },
  negotiation: {
    headline: 'Opens high, folds in two messages',
    how_to_approach: 'name a number first',
    best_bait: 'a starting TE',
    confidence: 'medium',
    says_no: { how: 'flatly', does_his_no_hold: 'rarely', evidence: ['quote one', 'quote two'] },
    praise_means: { reading: 'marketing', why: 'he sells what he praises', evidence: ['quote'] },
    calibration: { enthusiasm_scale: 'loud', inflation: 'heavy' },
    techniques: [{ name: 'anchor high', how_he_does_it: 'opens 30% over', how_often: 'often',
      evidence: ['a quote long enough to matter', 'another quote'] }],
    roster_read: { really_untouchable: [CHASE], quietly_available: [], overvalues: [], undervalues: [] },
    what_moves_him: ['a starting TE', 'draft picks', 'a third thing that should be trimmed'],
    what_shuts_him_down: ['lowballs'],
    caveats: ['small corpus'],
  },
  negotiation_n: 412,
  receptiveness_factors: [
    { source: 'chat_engagement', label: 'How he talks in the league chat', effect: 0.08,
      n: 412, cap: 0.5, fitted: false, why: 'open-to-trade rank 0.71, trade-talk rank 0.60' },
    { source: 'observed_accept_rate', label: 'What he has actually done with offers',
      effect: null, n: 30, cap: null, fitted: false, why: 'accepted 25% of 30 decided offers' },
    { source: 'nick_prior', label: "Nick's read: seller", effect: null, n: 3, cap: null,
      fitted: false, why: 'seller 1' },
  ],
  ...over,
});

const deal = () => ({ theirGive: [player(JT)], theirGet: [player(SWIFT)] });

/* ------------------------------------------------- M1 JSON-safe on the wire */

test('M1a: every Map and Set on a layer profile reaches the wire as JSON, not as {}', () => {
  const read = serializeManagerRead(profile(), [player(JT), player(CHASE)]);
  const wire = JSON.parse(JSON.stringify(read));

  assert.ok(Array.isArray(wire.player_reads), 'player_reads is not an array');
  assert.ok(Array.isArray(wire.needs), 'needs is not an array');
  assert.ok(Array.isArray(wire.surplus), 'surplus is not an array');
  assert.deepEqual(wire.needs, ['QB', 'TE'], 'needs lost its content');
  assert.deepEqual(wire.surplus, ['RB']);
  // The failure this replaced: a Map stringifies to {} and the read disappears
  // while still looking like a present, empty object.
  for (const [key, value] of Object.entries(wire)) {
    assert.notDeepEqual(value, {}, `${key} arrived as an empty object`);
  }
});

test('M1b: a per-player read keeps the sentiment, the verdict and the sample it was built from', () => {
  const wire = JSON.parse(JSON.stringify(serializeManagerRead(profile(), [player(JT)])));
  assert.equal(wire.player_reads.length, 1);
  const [jt] = wire.player_reads;
  assert.equal(jt.player, JT);
  assert.equal(jt.verdict, 'sales_pitch');
  assert.equal(jt.confidence, 'strong');
  assert.equal(jt.mentions, 7);
  assert.equal(jt.owns, true, 'the owned Set did not survive');
  assert.equal(jt.declared, 'not_held', 'the probe Set did not survive');
  assert.match(jt.why, /praises his own player/);
});

test('M1c: the stance Sets are reported as which player they name, not as objects', () => {
  const wire = serializeManagerRead(profile(), [player(CHASE)]);
  assert.equal(wire.player_reads[0].declared, 'held',
    'a respected declaration must survive as "held"');
});

test('M1d: the negotiation profile is cut to what a card shows, not shipped whole', () => {
  const wire = serializeManagerRead(profile(), []);
  assert.equal(wire.negotiation.headline, 'Opens high, folds in two messages');
  assert.equal(wire.negotiation.no_holds, 'rarely');
  assert.equal(wire.negotiation.praise_means, 'marketing');
  assert.equal(wire.negotiation.inflation, 'heavy');
  assert.equal(wire.negotiation.what_moves_him.length, 2, 'the list is not trimmed');
  // Twenty-five deals repeating every evidence quote is how a response balloons.
  assert.equal(wire.negotiation.techniques, undefined, 'techniques and their quotes are repeated per deal');
  assert.ok(JSON.stringify(wire.negotiation).length < 600,
    `the per-deal negotiation block is ${JSON.stringify(wire.negotiation).length} bytes`);
});

/* ------------------------------------------------------- M2 bounded output */

test('M2a: the reads are narrowed to the players in this deal', () => {
  // CHASE is talked about and is NOT in this deal, so he must not ride along.
  const wire = serializeManagerRead(profile(), [player(JT)]);
  assert.deepEqual(wire.player_reads.map(r => r.player), [JT]);
});

test('M2b: a player he has never mentioned is absent, not present and empty', () => {
  const wire = serializeManagerRead(profile(), [player(SWIFT)]);
  assert.deepEqual(wire.player_reads, [],
    'a player with no read must not arrive as a read with null fields');
});

test('M2c: the same player twice in one deal is reported once', () => {
  const wire = serializeManagerRead(profile(), [player(JT), player(JT)]);
  assert.equal(wire.player_reads.length, 1);
});

/* ------------------------------------------ M3 "no data" is not "neutral" */

test('M3a: no manager profile serialises to null, not to a hollow read', () => {
  assert.equal(serializeManagerRead(null, [player(JT)]), null);
  assert.equal(serializeManagerRead(undefined), null);
});

test('M3b: a league with no roster analysis reports needs as null, not as an empty read', () => {
  const none = serializeManagerRead(profile({ needs: null, surplus: null }), []);
  assert.equal(none.needs, null, 'not analysed must not look like analysed-and-empty');
  const analysed = serializeManagerRead(profile({ needs: new Set(), surplus: new Set() }), []);
  assert.deepEqual(analysed.needs, [], 'analysed-and-empty must not look like not analysed');
});

test('M3c: readDeal with no manager fabricates no read at all', () => {
  const out = readDeal({ ...deal(), managerProfile: null });
  assert.equal(out.receptiveness, 1, 'the no-information default is 1');
  assert.equal(out.perception_informed, false);
  assert.equal(out.perception_delta, null);
  assert.equal(out.tier, undefined, 'a hand-set tier was invented');
  assert.equal(out.negotiation, undefined, 'a negotiation profile was invented');
  assert.equal(out.player_reads, undefined, 'a per-player read was invented');
  assert.deepEqual(Object.keys(out).filter(k => /factor|player_reads|negotiation/.test(k)), [],
    'an empty counterparty produced read-shaped fields');
});

test('M3d: an empty profile object still reports nothing measured rather than zeros', () => {
  const wire = serializeManagerRead({}, [player(JT)]);
  assert.deepEqual(wire.player_reads, []);
  assert.deepEqual(wire.receptiveness_factors, []);
  assert.equal(wire.negotiation, null);
  assert.equal(wire.priors, null, 'an absent prior set must be null, not {}');
  assert.equal(wire.tier, null);
});

/* ------------------------------------- M4 the sample travels with the effect */

test('M4a: readDeal now carries the receptiveness factors, each with its sample and cap', () => {
  const out = readDeal({ ...deal(), managerProfile: profile() });
  const wire = JSON.parse(JSON.stringify(out));
  assert.equal(wire.receptiveness, 1.12, 'readDeal must still report the layer receptiveness');
  assert.equal(wire.receptiveness_factors.length, 3);
  const chat = wire.receptiveness_factors.find(f => f.source === 'chat_engagement');
  assert.equal(chat.n, 412, 'the sample behind the factor did not travel');
  assert.equal(chat.cap, 0.5);
  assert.equal(chat.fitted, false, 'nothing here is fitted and it must keep saying so');
  const rate = wire.receptiveness_factors.find(f => f.source === 'observed_accept_rate');
  assert.equal(rate.effect, null, 'a source that never reduced to a number must stay null');
});

test('M4b: readDeal keeps its own fields when the serialised read is merged in', () => {
  const out = readDeal({ ...deal(), managerProfile: profile() });
  assert.equal(out.chat_msgs, 412);
  assert.equal(out.accept_rate, 0.25);
  assert.equal(out.accept_rate_n, 30);
  assert.equal(out.word_note, 'his word has held 3 of 6 times');
  assert.equal(typeof out.perception_informed, 'boolean');
  assert.equal(out.tier, 'hard', 'the hand-set tier is reported, not applied');
});

test('M4c: the whole counterparty block a deal carries is JSON-serialisable', () => {
  const block = { ...readDeal({ ...deal(), managerProfile: profile() }), counterparty_data: true };
  const wire = JSON.parse(JSON.stringify(block));
  const walk = (v, path) => {
    assert.ok(!(v instanceof Map) && !(v instanceof Set), `${path} is still a Map/Set`);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(wire, 'counterparty');
  assert.equal(wire.counterparty_data, true);
});

/* ---------------------------------------------------------- M5 the panel */

const clientSrc = name => readFileSync(new URL(`../client/src/components/${name}`, import.meta.url), 'utf8');

test('M5a: ManagerRead returns null when it has nothing, like PlayerEvidence and RiskStrip', () => {
  const src = clientSrc('trade/ManagerRead.tsx');
  assert.match(src, /export default function ManagerRead/, 'not a default export');
  assert.match(src, /if \(!hasManagerRead\(deal\)\) return null;/,
    'the panel must return null when there is nothing to say');
});

test('M5b: the panel gates on counterparty_data and says so instead of guessing', () => {
  const src = clientSrc('trade/ManagerRead.tsx');
  assert.match(src, /hasManagerData\(cp\)/, 'the no-corpus case is not gated');
  assert.match(src, /No read on this manager yet/, 'there is no honest no-data line');
  // The distinction the service itself insists on.
  assert.match(src, /not "he looks neutral"/i,
    'the no-data line must not be confusable with a neutral read');
});

test('M5c: a tactic with no data behind it is rendered, not hidden', () => {
  const src = clientSrc('trade/ManagerRead.tsx');
  assert.match(src, /Not enough data for/, 'tactics_absent is not rendered');
  assert.match(src, /tactics_absent/, 'the absent list is not read at all');
});

test('M5d: a factor with no sample is not printed as if it were measured', () => {
  const src = clientSrc('trade/ManagerRead.tsx');
  assert.match(src, /f\.effect != null && \(f\.n \?\? 0\) > 0/,
    'the measured gate is missing');
  assert.match(src, /no sample behind it/, 'a zero sample is not called out');
});

test('M5e: every scored deal shows the panel, and the lone hand-set badge is gone', () => {
  const src = clientSrc('TradeCard.tsx');
  assert.match(src, /import ManagerRead from '\.\/trade\/ManagerRead'/, 'the panel is not imported');
  assert.match(src, /<ManagerRead deal=\{deal\} compact=\{compact\} \/>/, 'the panel is not mounted');
  assert.doesNotMatch(src, /HARD TO TRADE WITH/,
    'the hand-set tier badge is still the only manager signal on the card');
});
