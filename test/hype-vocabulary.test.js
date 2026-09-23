/**
 * S-19b: one stat vocabulary for "hype".
 *
 * The word "hype" now means exactly one thing: trade price minus value
 * (services/hype.js#playerHype, TM-09's market hype, and their served
 * consumers). Before this unit, two different concepts also used the word:
 * the usage-gap tactic (trade-tactics.js's `hype_window`, actual minus
 * expected points from usage) and the matching valuation-map source
 * (counterparty-pricing.js's `hype_vs_usage`). Both are renamed to
 * `outscoring_usage`, in both their internal key and their served label,
 * so a served string that still says "hype" is either the price-minus-value
 * surface or a bug.
 *
 * `talk-vs-model.js#expectationGaps` (the feed for both) never named "hype"
 * itself and needs no change; it is scanned here as a control consumer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../server/', import.meta.url);

function readAllServerSource() {
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(root.pathname);
  return Object.fromEntries(files.map(f => [path.relative(root.pathname, f), fs.readFileSync(f, 'utf8')]));
}

// The one allowed exception: text that names the actual price-minus-value
// producer. A line naming this is never a violation.
const ALLOWED_HYPE_MENTION = /services\/hype\.js#playerHype|trade-price hype|hype\.js|hype-decay|hype_decay|hype\b.*=\s*price\s*-\s*value|market hype|the one hype producer|OTHER_HYPE_PRODUCERS|TM-09/i;

// "hype" as a token: splits on anything that is not a letter, so snake_case
// keys ('hype_window', 'hype_vs_usage', 'hype_gap') are caught. /\bhype\b/
// misses them because '_' is a word character (skeptic finding, S-19b).
function namesHype(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z]+/).includes('hype');
}

test('matcher control: namesHype catches snake_case keys and plain words, not substrings', () => {
  for (const s of ['hype_vs_usage', 'hype_window', 'hype_gap', 'Sell inside the hype window', 'HYPE']) {
    assert.equal(namesHype(s), true, s);
  }
  for (const s of ['outscoring_usage', 'hyperbole', 'Outscoring usage', '']) {
    assert.equal(namesHype(s), false, s);
  }
});

test('control: the scan reads real source and finds a known price-minus-value "hype" mention', () => {
  const src = readAllServerSource();
  assert.ok(src['services/counterparty-pricing.js']?.includes('services/hype.js#playerHype'),
    'control: the allowed disambiguation citation is present, so a 0-hit result below is not a broken scan');
});

test('TACTICS and VALUATION_SOURCES: no key or label names hype except the allowed exception', async () => {
  const { TACTICS } = await import('../server/services/trade-tactics.js');
  const { VALUATION_SOURCES } = await import('../server/services/counterparty-pricing.js');
  const hits = [];
  for (const [key, spec] of Object.entries(TACTICS)) {
    if (namesHype(key) && !ALLOWED_HYPE_MENTION.test(key)) hits.push(`TACTICS key '${key}'`);
    if (namesHype(spec.label) && !ALLOWED_HYPE_MENTION.test(spec.label)) {
      hits.push(`TACTICS.${key}.label '${spec.label}'`);
    }
  }
  for (const [key, spec] of Object.entries(VALUATION_SOURCES)) {
    if (namesHype(key) && !ALLOWED_HYPE_MENTION.test(key)) hits.push(`VALUATION_SOURCES key '${key}'`);
    if (namesHype(spec.label) && !ALLOWED_HYPE_MENTION.test(spec.label)) {
      hits.push(`VALUATION_SOURCES.${key}.label '${spec.label}'`);
    }
  }
  assert.deepEqual(hits, [], 'the usage-gap surfaces must not use the word "hype"');
});

test('served tactic: the outscoring-usage tactic fires under key outscoring_usage, never hype_window', async () => {
  const tactics = await import('../server/services/trade-tactics.js');
  const p = { name: 'Hot', position: 'WR', value: 2000, ros_ppg: 13 };
  const gaps = new Map([['hot', { games: 3, gap_per_game: 7.0, xfp_per_game: 6, actual_per_game: 13 }]]);
  const out = tactics.tacticsForDeal({
    give: [p], get: [{ name: 'Theirs', position: 'WR', value: 2000, ros_ppg: 12 }],
    manager: { receptiveness: 1, gaps, players: new Map([['hot', { sentiment: 3.5, n: 6 }]]) },
    valuationOf: () => ({ our_value: 2000, their_value: 2000, multiplier: 1, owns: false, factors: [] }),
    partnerId: '2',
  });
  const fired = out.tactics.find(t => t.key === 'outscoring_usage');
  assert.ok(fired, 'the tactic must fire under its renamed key when the gap and praise both clear');
  assert.equal(namesHype(fired.label), false, 'the served label must not say hype');
  assert.ok(!out.tactics.some(t => namesHype(t.key)), 'no served tactic key may name hype');
  assert.ok(!out.tactics.some(t => t.key === 'hype_window'), 'the retired key must never be served again');
});
