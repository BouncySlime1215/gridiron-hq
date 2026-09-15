/**
 * The forecast-packet contract (Codex plan section 4.1, module required by
 * section 10.3: "One schema authority").
 *
 * Section 4.1's own sentence is the whole reason this exists:
 *
 *     "A hash without retained content cannot reconstruct a decision.
 *      Counts and a last-update time are a health summary, not the packet."
 *
 * These tests hold the contract to that: a packet that carries counts instead
 * of values is refused, a packet that claims prospective status on a legacy
 * request-time clock is refused, and a packet whose evidence arrived after its
 * own cutoff is refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { validateForecastPacket, sealForecastPacket, packetHash, canonicalize,
  contractDescription, CONTRACT_GROUPS, PACKET_SCHEMA_VERSION } =
  await import('../server/betting/nfl/contracts/forecast-packet.js');

const HASH = 'a'.repeat(64);

/** A packet that meets the contract, so each test can break exactly one thing. */
const valid = (over = {}) => ({
  event: { event_key: 'nfl|2026-09-20|CHI@CAR', season: 2026, week: 3, home: 'CAR', away: 'CHI',
    kickoff_at: '2026-09-20T17:00:00Z', schedule_version: 'sched-1', ...(over.event ?? {}) },
  market: { market: 'spreads', period: 'full_game', side: 'home', handicap: -2.5,
    offered_price: -110, bookmaker: 'draftkings', settlement_rule_version: 'ot_included',
    quote_id: 'q-1', ...(over.market ?? {}) },
  observation: { experiment_id: 'exp-1', horizon: 'T-60', cutoff_at: '2026-09-20T16:00:00Z',
    job_id: 'job-1', observation_id: 'obs-1', attempt: 1, ...(over.observation ?? {}) },
  source_lineage: { provider: 'the-odds-api', received_at: '2026-09-20T15:45:00Z',
    receipt_clock_source: 'response_completion', mode: 'prospective', ...(over.source_lineage ?? {}) },
  feature_lineage: { values: [{ name: 'qb_status', value: 'active' }],
    transformation_version: 'v1', missing: [], ...(over.feature_lineage ?? {}) },
  forecast: { graph_version: 'market_residual', forecast_identity: 'f'.repeat(64),
    probability_target: 'full_game_spread_cover', calibration_id: 'cover-logit-v3',
    ...(over.forecast ?? {}) },
  decision: { policy_id: 'nfl-spread-v1', policy_version: '1.2.0',
    qualification_state: 'research_only', ...(over.decision ?? {}) },
  integrity: { code_identity: HASH, data_identity_status: 'unfrozen_live_tables',
    schema_version: PACKET_SCHEMA_VERSION, ...(over.integrity ?? {}) }
});

test('a complete packet meets the contract', () => {
  const result = validateForecastPacket(valid());
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test('all eight of section 4.1\'s contract groups are required', () => {
  assert.deepEqual(Object.keys(CONTRACT_GROUPS).sort(), [
    'decision', 'event', 'feature_lineage', 'forecast', 'integrity', 'market',
    'observation', 'source_lineage'
  ]);
  for (const group of Object.keys(CONTRACT_GROUPS)) {
    const packet = valid();
    delete packet[group];
    const result = validateForecastPacket(packet);
    assert.equal(result.ok, false, `${group} must be required`);
    assert.ok(result.problems.some(p => p.startsWith(group)));
  }
});

test('EVERY problem is reported, not just the first', () => {
  const broken = valid();
  delete broken.event.event_key;
  delete broken.market.quote_id;
  delete broken.forecast.calibration_id;
  const result = validateForecastPacket(broken);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3,
    'a caller fixing a packet should not discover its defects one run at a time');
});

test('counts are not a packet: feature lineage must carry actual values', () => {
  // Section 4.1: "Counts and a last-update time are a health summary, not the
  // packet." This is the sentence correction C11 turns on.
  const empty = valid({ feature_lineage: { values: [], missing: [] } });
  const result = validateForecastPacket(empty);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /must say what was absent/.test(p)));

  // An empty packet that SAYS what was missing is legitimate — that is a
  // recorded observation of absence, which is exactly what C11 asks for.
  const declared = valid({ feature_lineage: { values: [], missing: ['nfl_injuries'] } });
  assert.equal(validateForecastPacket(declared).ok, true);
});

test('a prospective packet cannot rest on a request-time clock', () => {
  // Correction C11: requested_at <= received_at always, so a request time
  // makes evidence look earlier than it was.
  const legacy = valid({ source_lineage: { receipt_clock_source: 'legacy_request_time_only' } });
  const result = validateForecastPacket(legacy);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /lower bound, not a receipt/.test(p)));

  // The same clock is fine for a labeled historical packet, which makes the
  // weaker claim explicitly.
  const historical = valid({ source_lineage: {
    receipt_clock_source: 'legacy_request_time_only', mode: 'historical' } });
  assert.equal(validateForecastPacket(historical).ok, true);
});

test('evidence received AFTER the cutoff is refused', () => {
  const late = valid({ source_lineage: { received_at: '2026-09-20T16:30:00Z' } });
  const result = validateForecastPacket(late);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /not knowable at the cutoff/.test(p)));
});

test('the contract is spread-only, full-game, and refuses anything else', () => {
  assert.equal(validateForecastPacket(valid({ market: { period: 'first_half' } })).ok, false);
  assert.equal(validateForecastPacket(valid({ market: { side: 'over' } })).ok, false);
  assert.equal(validateForecastPacket(valid({ market: { handicap: 'minus three' } })).ok, false);
});

test('an arbitrary code identity is refused, and a frozen claim needs its hash', () => {
  assert.equal(validateForecastPacket(valid({ integrity: { code_identity: 'trust-me' } })).ok, false);
  assert.equal(validateForecastPacket(valid({
    integrity: { data_identity_status: 'frozen_packet' } })).ok, false);
  assert.equal(validateForecastPacket(valid({
    integrity: { data_identity_status: 'frozen_packet', data_hash: 'b'.repeat(64) } })).ok, true);
});

test('an unknown qualification state is a bug, not a new state', () => {
  assert.equal(validateForecastPacket(valid({ decision: { qualification_state: 'pretty_good' } })).ok, false);
  for (const state of ['qualified', 'research_only', 'unqualified', 'abstained', 'unavailable']) {
    assert.equal(validateForecastPacket(valid({ decision: { qualification_state: state } })).ok, true, state);
  }
});

test('canonicalization makes the hash independent of key order', () => {
  const a = valid();
  // The same content, assembled in a different order.
  const b = { integrity: a.integrity, decision: a.decision, forecast: a.forecast,
    feature_lineage: a.feature_lineage, source_lineage: a.source_lineage,
    observation: a.observation, market: a.market, event: a.event };
  assert.equal(packetHash(a), packetHash(b),
    're-ordering a builder\'s property writes must not change a decision\'s content address');
  assert.deepEqual(canonicalize(a), canonicalize(b));
});

test('a retry of one observation is the same packet; a different observation is not', () => {
  const first = valid();
  const retry = valid({ observation: { attempt: 4 } });
  assert.equal(packetHash(first), packetHash(retry),
    'attempt 4 of one observation is the same evidence');

  const other = valid({ observation: { observation_id: 'obs-2' } });
  assert.notEqual(packetHash(first), packetHash(other),
    'two declared observations are two pieces of evidence, even with identical contents');
});

test('any material change moves the content address', () => {
  const base = packetHash(valid());
  const seen = new Map([[base, 'baseline']]);
  const mutations = {
    handicap: valid({ market: { handicap: -3.5 } }),
    price: valid({ market: { offered_price: -125 } }),
    quote: valid({ market: { quote_id: 'q-2' } }),
    forecast: valid({ forecast: { forecast_identity: 'c'.repeat(64) } }),
    calibration: valid({ forecast: { calibration_id: 'cover-logit-v4' } }),
    policy: valid({ decision: { policy_version: '1.3.0' } }),
    cutoff: valid({ observation: { cutoff_at: '2026-09-20T15:00:00Z' } }),
    code: valid({ integrity: { code_identity: 'd'.repeat(64) } }),
    features: valid({ feature_lineage: { values: [{ name: 'qb_status', value: 'out' }] } })
  };
  for (const [label, packet] of Object.entries(mutations)) {
    const hash = packetHash(packet);
    assert.ok(!seen.has(hash), `${label} collided with ${seen.get(hash)}`);
    seen.set(hash, label);
  }
});

test('sealing throws on an invalid packet rather than returning one', () => {
  assert.throws(() => sealForecastPacket(valid({ market: { period: 'first_half' } })),
    /does not meet the section 4.1 contract/);
  const sealed = sealForecastPacket(valid());
  assert.equal(sealed.schema_version, PACKET_SCHEMA_VERSION);
  assert.match(sealed.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(sealed.packet.event.event_key, 'nfl|2026-09-20|CHI@CAR');
});

test('source_lineage.received_at must be a real, parseable instant', () => {
  const bad = valid({ source_lineage: { received_at: 'bad-clock' } });
  const result = validateForecastPacket(bad);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /received_at: not a parseable instant/.test(p)));
});

test('feature_lineage.values as a bare object is not a packet -- an object can hide a count', () => {
  const asObject = valid({ feature_lineage: { values: {} } });
  const result = validateForecastPacket(asObject);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /must be an array of \{name, value\} entries/.test(p)));
});

test('feature_lineage.values as null is not a packet', () => {
  const asNull = valid({ feature_lineage: { values: null } });
  const result = validateForecastPacket(asNull);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /must be an array of \{name, value\} entries/.test(p)));
});

test('a numeric feature value must be finite', () => {
  const nonFinite = valid({ feature_lineage: { values: [{ name: 'x', value: NaN }] } });
  const result = validateForecastPacket(nonFinite);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /numeric feature values must be finite/.test(p)));

  // A qualitative feature value (a status string, not a computed number) is
  // legitimate and must not be rejected by the same check.
  assert.equal(validateForecastPacket(valid()).ok, true);
});

test('offered_price must be a real American price, never zero', () => {
  const zero = valid({ market: { offered_price: 0 } });
  const result = validateForecastPacket(zero);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /offered_price: must be a real American price/.test(p)));

  // Prices strictly between -100 and +100 do not exist either.
  assert.equal(validateForecastPacket(valid({ market: { offered_price: 50 } })).ok, false);
});

test('market.market must match the contract\'s field shape: spreads only', () => {
  // This contract's market group carries a spread's fields (side: home/away,
  // a signed handicap) -- a `totals` packet built from the same fields is a
  // different market wearing this one's shape, and must be refused.
  const wrongMarket = valid({ market: { market: 'totals' } });
  const result = validateForecastPacket(wrongMarket);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /market.market: this contract covers spreads only/.test(p)));
});

test('observation.cutoff_at must be strictly before event.kickoff_at', () => {
  const late = valid({ observation: { cutoff_at: '2026-09-20T18:00:00Z' } }); // kickoff is 17:00Z
  const result = validateForecastPacket(late);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /cutoff_at: must be strictly before event.kickoff_at/.test(p)));

  // Equal to kickoff is also refused -- "T-60" means strictly before.
  const atKickoff = valid({ observation: { cutoff_at: '2026-09-20T17:00:00Z' } });
  assert.equal(validateForecastPacket(atKickoff).ok, false);
});

test('canonicalize refuses to hash a non-finite number rather than let it collide with null', () => {
  // JSON.stringify silently coerces both NaN and a corrupted Infinity to
  // null, which would make a computed-but-invalid feature value and an
  // explicitly-missing one hash identically. canonicalize() must fail loudly
  // instead, because it is also reused directly by nfl-t60-packet.js's
  // t60PacketHash() on a packet shape that never goes through
  // validateForecastPacket.
  assert.throws(() => canonicalize({ a: NaN }), /refusing to hash a non-finite number/);
  assert.throws(() => canonicalize({ a: Infinity }), /refusing to hash a non-finite number/);
  assert.throws(() => packetHash(valid({ feature_lineage: {
    values: [{ name: 'x', value: 1 }] }, market: { handicap: NaN } })),
    /refusing to hash a non-finite number/);
  // A genuinely missing value (null) is unaffected -- it is not a number at
  // all, so it canonicalizes and hashes exactly as before.
  assert.doesNotThrow(() => canonicalize({ a: null }));
});

test('the contract can be read back in full', () => {
  const described = contractDescription();
  assert.equal(described.schema_version, PACKET_SCHEMA_VERSION);
  assert.equal(Object.keys(described.groups).length, 8);
  for (const spec of Object.values(described.groups)) {
    assert.ok(spec.required.length > 0);
    assert.ok(spec.note.length > 20, 'each group says why it is required');
  }
});
