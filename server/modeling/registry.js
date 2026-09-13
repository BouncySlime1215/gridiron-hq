import { configurationHash } from './contracts.js';
import { governedComparison, GOVERNED_COMPARISON_VERSION } from './governed-comparison.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'archived']);
const REQUIRED_GATES = ['schema', 'leakage', 'data_quality', 'baseline_improvement', 'tests'];
const can = (actor, permission) => actor?.permissions?.includes(permission) || actor?.permissions?.includes('model:*');

// Shared by promote() and rollback(): a rollback target is itself a promotion
// (to a possibly-earlier version), so it must clear the exact same gates —
// otherwise rollback becomes a bypass for promoting a queued/failed/never-
// vetted experiment straight to production.
function assertPromotable(candidate) {
  if (candidate?.status !== 'completed') throw new Error('only completed experiments can be promoted');
  const gates = candidate.result?.gates ?? {};
  for (const gate of REQUIRED_GATES) {
    if (gates[gate] !== true) throw new Error(`promotion blocked: ${gate} gate failed`);
  }
  // A governed comparison, once attached, OUTRANKS the gate flag beside it.
  // `baseline_improvement` was previously a boolean anyone writing a result
  // could assert, which is the whole reason a challenger could be promoted on
  // its own say-so. It cannot now be set true over a comparison that says
  // otherwise: the statistics win, and the disagreement is named in the error.
  const comparison = candidate.result?.comparison;
  if (comparison && comparison.verdict !== 'promote') {
    throw new Error(`promotion blocked: governed comparison verdict '${comparison.verdict}' — ${comparison.reason}`);
  }
}

export class ModelRegistry {
  constructor(store) { this.store = store; }

  // The experiment id is derived from spec + pinned dataset/feature versions, not
  // spec alone — otherwise the identical configuration could never be re-evaluated
  // against a new dataset or feature version (the primary key would collide), which
  // breaks reproducible champion/challenger comparisons across dataset revisions.
  create(spec, actor, datasetVersionId = null, featureVersionId = null) {
    if (!can(actor, 'model:train')) throw new Error('forbidden: model:train required');
    const now = new Date().toISOString();
    const id = configurationHash({ spec, dataset_version_id: datasetVersionId, feature_version_id: featureVersionId });
    const experiment = { id, spec, status: 'queued', created_at: now,
      updated_at: now, cancellation_requested: false, logs: [], result: null, created_by_user_id: Number(actor.id) };
    return this.store.insert(experiment);
  }

  transition(id, status, patch = {}) {
    const current = this.store.get(id);
    if (!current) throw new Error('experiment not found');
    if (TERMINAL.has(current.status) && status !== 'archived') throw new Error(`cannot transition terminal experiment ${current.status}`);
    return this.store.update(id, { ...patch, status, updated_at: new Date().toISOString() });
  }

  cancel(id, actor) {
    if (!can(actor, 'model:cancel')) throw new Error('forbidden: model:cancel required');
    return this.transition(id, 'cancelling', { cancellation_requested: true });
  }

  /**
   * Fetch experiments AND say, with statistics, whether any of them beats the
   * first one. Every candidate is compared against `baseline` (the first id by
   * default), so the answer does not depend on which order a caller listed them.
   *
   * An experiment carries the evidence for this in
   * `result.losses` — `{metricName: number[]}`, lower-is-better, one entry per
   * held-out observation, aligned across experiments — and optionally
   * `result.groups`, one cluster key per observation. Experiments without
   * `result.losses` are still returned; they simply cannot be compared, and the
   * reason is reported rather than silently omitted.
   *
   * The previous implementation of this method was `ids.map(...).filter(Boolean)`
   * with no statistics of any kind, which is why every challenge this project
   * has run so far graded its own homework.
   */
  compare(ids, { baseline = null, primaryMetric = null, ...options } = {}) {
    const experiments = ids.map(id => this.store.get(id)).filter(Boolean);
    const baselineId = baseline ?? experiments[0]?.id ?? null;
    const incumbent = experiments.find(e => e.id === baselineId) ?? null;

    const comparisons = experiments
      .filter(e => e.id !== baselineId)
      .map(candidate => {
        const why = comparabilityError(incumbent, candidate);
        if (why) return { challenger: candidate.id, incumbent: baselineId, comparable: false, reason: why };
        return {
          challenger: candidate.id, incumbent: baselineId, comparable: true,
          ...governedComparison({
            incumbent: { label: baselineId, losses: incumbent.result.losses },
            challenger: { label: candidate.id, losses: candidate.result.losses },
            groups: candidate.result.groups ?? incumbent.result.groups ?? null,
            primaryMetric, ...options
          })
        };
      });

    return {
      experiments, baseline: baselineId, primary_metric: primaryMetric,
      comparison_version: GOVERNED_COMPARISON_VERSION, comparisons,
      promotable: comparisons.filter(c => c.comparable && c.verdict === 'promote').map(c => c.challenger)
    };
  }

  /**
   * Run the governed comparison and WRITE its verdict onto the challenger, so
   * `baseline_improvement` becomes a derived fact rather than an assertion.
   *
   * This is the wiring that matters. `assertPromotable` already refuses to
   * promote over a comparison whose verdict is not 'promote'; this is how a
   * comparison gets attached in the first place, and it sets the gate from the
   * verdict rather than trusting whatever the result arrived with.
   */
  challenge(challengerId, { against, primaryMetric = null, ...options } = {}) {
    const challenger = this.store.get(challengerId);
    if (!challenger) throw new Error('challenger not found');
    const incumbent = this.store.get(against);
    if (!incumbent) throw new Error('incumbent not found');
    const why = comparabilityError(incumbent, challenger);
    if (why) throw new Error(`cannot run a governed comparison: ${why}`);

    const comparison = governedComparison({
      incumbent: { label: incumbent.id, losses: incumbent.result.losses },
      challenger: { label: challenger.id, losses: challenger.result.losses },
      groups: challenger.result.groups ?? incumbent.result.groups ?? null,
      primaryMetric, ...options
    });

    const result = { ...challenger.result, comparison,
      gates: { ...(challenger.result?.gates ?? {}), baseline_improvement: comparison.verdict === 'promote' } };
    this.store.update(challengerId, { result, updated_at: new Date().toISOString() });
    return comparison;
  }

  promote(id, actor) {
    if (!can(actor, 'model:promote')) throw new Error('forbidden: model:promote required');
    const candidate = this.store.get(id);
    assertPromotable(candidate);
    return this.store.atomicPromote(id, { action: 'promote', gates: candidate.result.gates,
      promoted_by: actor.id, promoted_at: new Date().toISOString() });
  }

  rollback(versionId, actor) {
    if (!can(actor, 'model:promote')) throw new Error('forbidden: model:promote required');
    const candidate = this.store.get(versionId);
    if (!candidate) throw new Error('rollback target not found');
    assertPromotable(candidate);
    return this.store.atomicPromote(versionId, { action: 'rollback', gates: candidate.result.gates,
      rolled_back_by: actor.id, promoted_at: new Date().toISOString() });
  }
}

/** Why two experiments cannot be compared, or null when they can. */
function comparabilityError(incumbent, candidate) {
  if (!incumbent) return 'baseline experiment not found';
  if (!incumbent.result?.losses) return 'baseline carries no result.losses to compare against';
  if (!candidate.result?.losses) return 'challenger carries no result.losses';
  const shared = Object.keys(incumbent.result.losses)
    .filter(m => Array.isArray(candidate.result.losses[m]));
  if (!shared.length) return 'no metric is present on both experiments';
  return null;
}

export class MemoryModelStore {
  constructor() { this.items = new Map(); this.production = null; }
  insert(item) { if (this.items.has(item.id)) throw new Error('experiment configuration already exists'); this.items.set(item.id, structuredClone(item)); return this.get(item.id); }
  get(id) { const x = this.items.get(id); return x ? structuredClone(x) : null; }
  list() { return [...this.items.values()].map(structuredClone); }
  update(id, patch) { const next = { ...this.items.get(id), ...structuredClone(patch) }; this.items.set(id, next); return this.get(id); }
  atomicPromote(id, audit) { const previous = this.production; this.production = id; return { active: id, previous, audit }; }
}
