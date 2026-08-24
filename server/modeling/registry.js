import { configurationHash } from './contracts.js';

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
}

export class ModelRegistry {
  constructor(store) { this.store = store; }

  create(spec, actor) {
    if (!can(actor, 'model:train')) throw new Error('forbidden: model:train required');
    const now = new Date().toISOString();
    const experiment = { id: configurationHash(spec), spec, status: 'queued', created_at: now,
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

  compare(ids) { return ids.map(id => this.store.get(id)).filter(Boolean); }

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

export class MemoryModelStore {
  constructor() { this.items = new Map(); this.production = null; }
  insert(item) { if (this.items.has(item.id)) throw new Error('experiment configuration already exists'); this.items.set(item.id, structuredClone(item)); return this.get(item.id); }
  get(id) { const x = this.items.get(id); return x ? structuredClone(x) : null; }
  list() { return [...this.items.values()].map(structuredClone); }
  update(id, patch) { const next = { ...this.items.get(id), ...structuredClone(patch) }; this.items.set(id, next); return this.get(id); }
  atomicPromote(id, audit) { const previous = this.production; this.production = id; return { active: id, previous, audit }; }
}
