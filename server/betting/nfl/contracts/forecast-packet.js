/**
 * The versioned forecast-packet schema. One authority.
 *
 * Codex plan section 10.3 asks for exactly this: "Shared versioned packet
 * schema/canonicalization used by source freeze, family adapters, decision tape
 * and execution. One schema authority." Section 4.1 states the contract itself
 * -- eight groups of required content -- and says why it matters in one line
 * that is worth repeating: **"A hash without retained content cannot
 * reconstruct a decision."**
 *
 * WHAT THIS IS FOR. Correction C11 fixed the packet's clocks and its scoping:
 * it no longer matches the wrong game, the wrong period, or the wrong receipt
 * instant, and it now carries actual rows rather than counts. What it does not
 * yet have is a schema that every consumer agrees on, which is what lets a
 * forecast CONSUME the packet rather than re-reading the tables itself. That
 * consumption is C11's remaining half and slice 7's prerequisite.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a second packet builder.
 * `nfl-t60-packet.js` freezes the evidence; this validates and canonicalizes
 * what it produced, and refuses what does not meet the contract. Two builders
 * would be two answers to "what was knowable", which is the failure the whole
 * correction register exists to prevent.
 *
 * VALIDATION FAILS, IT DOES NOT REPAIR. A packet missing its event identity is
 * not a packet with a gap in it; it is not a packet. Returning a partially
 * repaired object would let a decision be made from evidence nobody checked.
 */
import crypto from 'node:crypto';

export const PACKET_SCHEMA_VERSION = 'nfl-forecast-packet-v1';

/**
 * The eight contract groups of section 4.1, and what each must carry.
 *
 * Expressed as data rather than as a wall of `if` statements so that the
 * contract can be read, reported and tested as one object -- and so a group
 * cannot be quietly dropped by deleting a check nobody notices is missing.
 */
export const CONTRACT_GROUPS = Object.freeze({
  event: Object.freeze({
    required: ['event_key', 'season', 'week', 'home', 'away', 'kickoff_at', 'schedule_version'],
    note: 'A reschedule updates schedule history, not event identity.'
  }),
  market: Object.freeze({
    required: ['market', 'period', 'side', 'handicap', 'offered_price', 'bookmaker',
      'settlement_rule_version', 'quote_id'],
    note: 'Full-game spread, selected side, signed handicap, offered price, and the rules it settles under.'
  }),
  observation: Object.freeze({
    required: ['experiment_id', 'horizon', 'cutoff_at', 'job_id', 'observation_id', 'attempt'],
    note: 'Which declared observation this is. Separate from what it decided.'
  }),
  source_lineage: Object.freeze({
    required: ['provider', 'received_at', 'receipt_clock_source', 'mode'],
    note: 'True first receipt, kept apart from request time and from provider publication (C11).'
  }),
  feature_lineage: Object.freeze({
    required: ['values', 'transformation_version', 'missing'],
    note: 'Actual values, not counts. An injury row\'s modified_at is not proof its current value was available earlier.'
  }),
  forecast: Object.freeze({
    required: ['graph_version', 'forecast_identity', 'probability_target', 'calibration_id'],
    note: 'Which model, under which calibration, predicting what exactly.'
  }),
  decision: Object.freeze({
    required: ['policy_id', 'policy_version', 'qualification_state'],
    note: 'And the reason, whatever it was — including abstention.'
  }),
  integrity: Object.freeze({
    required: ['code_identity', 'data_identity_status', 'schema_version'],
    note: 'Content integrity and repeated-observation identity are SEPARATE fields (C01).'
  })
});

/** Every value a `qualification_state` may take. An unknown one is a bug, not a new state. */
export const QUALIFICATION_STATES = Object.freeze([
  'qualified', 'research_only', 'unqualified', 'abstained', 'unavailable'
]);

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate a packet against the contract.
 *
 * Returns `{ ok: true, packet }` or `{ ok: false, problems }` with EVERY
 * problem listed, not just the first. A caller fixing a packet should not have
 * to discover its eight defects one run at a time.
 */
export function validateForecastPacket(packet) {
  const problems = [];
  if (!packet || typeof packet !== 'object') {
    return { ok: false, problems: ['packet is not an object'] };
  }

  for (const [group, spec] of Object.entries(CONTRACT_GROUPS)) {
    const section = packet[group];
    if (section == null || typeof section !== 'object') {
      problems.push(`${group}: missing entirely — ${spec.note}`);
      continue;
    }
    for (const field of spec.required) {
      if (section[field] === undefined) problems.push(`${group}.${field}: missing`);
    }
  }

  // Contract-specific checks that a required-field list cannot express.
  // Section 4.1's market group is scoped to full-game spreads only (see
  // CONTRACT_GROUPS.market's note above): a `market: 'totals'` packet cannot
  // legitimately carry a spread `side`/`handicap`, so the market TYPE itself
  // is part of the contract, not just its fields' individual shapes.
  const market = packet.market ?? {};
  if (market.market !== undefined && market.market !== 'spreads') {
    problems.push(`market.market: this contract covers spreads only, got ${market.market}`);
  }
  if (market.period !== undefined && market.period !== 'full_game') {
    problems.push(`market.period: this contract covers full-game spreads only, got ${market.period}`);
  }
  if (market.handicap !== undefined && !Number.isFinite(market.handicap)) {
    problems.push('market.handicap: must be a finite signed number');
  }
  if (market.side !== undefined && !['home', 'away'].includes(market.side)) {
    problems.push(`market.side: must be home or away, got ${market.side}`);
  }
  // American odds strictly between -100 and +100 do not exist (the same
  // convention spread-probabilities.js's profitMultiple() enforces); zero is
  // not a price at all.
  if (market.offered_price !== undefined
      && (!Number.isFinite(market.offered_price) || Math.abs(market.offered_price) < 100)) {
    problems.push(`market.offered_price: must be a real American price (|price| >= 100), got ${market.offered_price}`);
  }

  const observation = packet.observation ?? {};
  if (observation.cutoff_at !== undefined && Number.isNaN(Date.parse(observation.cutoff_at))) {
    problems.push('observation.cutoff_at: not a parseable instant');
  }
  // A "T-60" packet's entire point is that the decision cutoff precedes
  // kickoff; a cutoff at or after kickoff is not a pre-game observation.
  const event = packet.event ?? {};
  if (observation.cutoff_at !== undefined && event.kickoff_at !== undefined
      && !Number.isNaN(Date.parse(observation.cutoff_at)) && !Number.isNaN(Date.parse(event.kickoff_at))
      && Date.parse(observation.cutoff_at) >= Date.parse(event.kickoff_at)) {
    problems.push('observation.cutoff_at: must be strictly before event.kickoff_at');
  }

  // The receipt clock is the whole of correction C11. A packet claiming
  // prospective status on a legacy request-time clock is claiming something
  // its own data cannot support.
  const lineage = packet.source_lineage ?? {};
  if (lineage.received_at !== undefined && Number.isNaN(Date.parse(lineage.received_at))) {
    problems.push('source_lineage.received_at: not a parseable instant');
  }
  if (lineage.mode === 'prospective' && lineage.receipt_clock_source !== 'response_completion') {
    problems.push('source_lineage: a prospective packet needs an observed response-completion receipt; ' +
      `got ${lineage.receipt_clock_source}. A request time is a lower bound, not a receipt.`);
  }
  if (lineage.received_at !== undefined && observation.cutoff_at !== undefined
      && !Number.isNaN(Date.parse(lineage.received_at)) && !Number.isNaN(Date.parse(observation.cutoff_at))
      && Date.parse(lineage.received_at) > Date.parse(observation.cutoff_at)) {
    problems.push('source_lineage.received_at: after the cutoff, so it was not knowable at the cutoff');
  }

  const decision = packet.decision ?? {};
  if (decision.qualification_state !== undefined
      && !QUALIFICATION_STATES.includes(decision.qualification_state)) {
    problems.push(`decision.qualification_state: unknown state ${decision.qualification_state}`);
  }

  const integrity = packet.integrity ?? {};
  if (integrity.code_identity !== undefined && !HEX64.test(integrity.code_identity)) {
    problems.push('integrity.code_identity: must be a real computed sha256, not an arbitrary string');
  }
  if (integrity.data_identity_status === 'frozen_packet' && !HEX64.test(integrity.data_hash ?? '')) {
    problems.push('integrity: a frozen_packet claim must carry its packet hash');
  }

  // Feature lineage must carry VALUES. This is the line the whole correction
  // turns on: counts and a latest timestamp are a health summary, and a
  // forecast cannot be reconstructed from them. `values` must therefore be a
  // real array of well-formed {name, value} entries -- not an object (which
  // could carry a bare count under a familiar-looking key), not null, and not
  // an empty array with nothing recorded as missing.
  const features = packet.feature_lineage ?? {};
  if (features.values !== undefined) {
    if (!Array.isArray(features.values)) {
      problems.push('feature_lineage.values: must be an array of {name, value} entries, not a count');
    } else if (features.values.length === 0 && (features.missing ?? []).length === 0) {
      problems.push('feature_lineage: no values and nothing recorded as missing — ' +
        'an empty packet must say what was absent, not simply be empty');
    } else {
      features.values.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(`feature_lineage.values[${i}]: must be a {name, value} entry, got ${JSON.stringify(entry)}`);
          return;
        }
        if (typeof entry.name !== 'string' || entry.name.length === 0) {
          problems.push(`feature_lineage.values[${i}].name: must be a non-empty string`);
        }
        if (!('value' in entry)) {
          problems.push(`feature_lineage.values[${i}].value: missing`);
        } else if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) {
          // A qualitative feature ('active', 'out') is a legitimate value;
          // a NUMERIC feature that is NaN/Infinity is a computed value that
          // never resolved, and is not knowable evidence.
          problems.push(`feature_lineage.values[${i}].value: numeric feature values must be finite, got ${entry.value}`);
        }
      });
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, packet };
}

/**
 * A canonical, stable serialization of a packet's immutable content.
 *
 * Key order is sorted recursively so that two packets with identical content
 * hash identically regardless of how their objects were assembled. Without
 * this, re-ordering a builder's property writes changes the content address of
 * a decision that did not change -- which is the same class of defect as C01,
 * in the opposite direction.
 *
 * NON-FINITE NUMBERS ARE REFUSED, NOT SILENTLY REWRITTEN. `JSON.stringify`
 * coerces `NaN` and `Infinity` to `null`, which would make a computed-but-
 * invalid feature value hash IDENTICALLY to an explicitly-missing one -- two
 * different claims about the evidence collapsing to the same content
 * address. `validateForecastPacket` already refuses a non-finite feature
 * value before a decision packet reaches this function, but `canonicalize`
 * is also reused directly by `nfl-t60-packet.js`'s `t60PacketHash` for the
 * T-60 evidence packet, which is a different shape that does not go through
 * `validateForecastPacket` (see that module's own TODO on the architecture
 * mismatch). Refusing here, rather than trusting every caller to have
 * checked first, is what actually prevents the collision.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalize(value[k])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalize: refusing to hash a non-finite number (${value}); ` +
      'JSON would silently coerce it to null, colliding with an explicitly-missing value');
  }
  return value;
}

/**
 * The packet's content address.
 *
 * Deliberately EXCLUDES `observation.attempt`: a retry of one observation is
 * the same evidence, and hashing the attempt number would make every retry a
 * different packet. Everything else about the observation IS included, because
 * two distinct declared observations are two pieces of evidence even when
 * their contents match (correction C01's separation of observation identity
 * from content identity).
 */
export function packetHash(packet) {
  const { attempt: _attempt, ...observation } = packet.observation ?? {};
  const content = canonicalize({ ...packet, observation, schema_version: PACKET_SCHEMA_VERSION });
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Validate, canonicalize and address a packet in one step.
 *
 * Throws on an invalid packet rather than returning one. Every caller of this
 * is about to make or record a decision from the result, and there is no
 * useful thing to do with a packet that does not meet the contract.
 */
export function sealForecastPacket(packet) {
  const check = validateForecastPacket(packet);
  if (!check.ok) {
    throw new TypeError(`forecast packet does not meet the section 4.1 contract:\n  - ${check.problems.join('\n  - ')}`);
  }
  const canonical = canonicalize(packet);
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    content_hash: packetHash(packet),
    packet: canonical
  };
}

/** The contract itself, for a status page or a test that asserts nothing was dropped. */
export function contractDescription() {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    groups: Object.fromEntries(Object.entries(CONTRACT_GROUPS)
      .map(([name, spec]) => [name, { required: [...spec.required], note: spec.note }])),
    qualification_states: [...QUALIFICATION_STATES]
  };
}
