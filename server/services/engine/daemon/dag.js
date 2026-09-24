/**
 * The producer DAG (ENGINE-ARCHITECTURE.md §4.2): who reads whose fields.
 *
 * Edges come from declarations only: producer B depends on producer A when one of B's
 * `inputs.fields` is a field A owns. A cycle is a registration error at start (the daemon
 * refuses to start), and so is an input field no producer in the process declares: a
 * producer would otherwise read a field that is never written and serve nothing, quietly.
 *
 * A producer entry is {name, inputs:{events, fields, scope, schedule, cost, budget_ms}, fields}
 * (registry.producerSpec plus the module's `run`). `cost: 'heavy'` producers run per league
 * behind a dirty bit; everything else with `schedule: 'tick'` runs whole every tick.
 */

/** field -> producer name, for the given producers. Throws when two claim one field. */
export function fieldOwners(producers) {
  const owners = new Map();
  for (const p of producers) {
    for (const f of p.fields ?? []) {
      if (owners.has(f) && owners.get(f) !== p.name) throw new Error(`field ${f} is declared by ${owners.get(f)} and ${p.name}`);
      owners.set(f, p.name);
    }
  }
  return owners;
}

/**
 * Topological order (dependencies first; ties by declaration order, so the order is stable).
 * Throws "declaration cycle: a -> b -> a" on a cycle, and names an input nobody writes.
 */
export function buildDag(producers) {
  const byName = new Map(producers.map(p => [p.name, p]));
  if (byName.size !== producers.length) throw new Error('a producer is declared twice');
  const owners = fieldOwners(producers);
  const deps = new Map();
  for (const p of producers) {
    const set = new Set();
    for (const f of p.inputs?.fields ?? []) {
      const owner = owners.get(f);
      if (!owner) throw new Error(`producer ${p.name} reads field ${f}, which no declared producer writes`);
      if (owner !== p.name) set.add(owner);
    }
    deps.set(p.name, [...set]);
  }
  const order = [];
  const state = new Map(); // name -> 'visiting' | 'done'
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const loop = [...trail.slice(trail.indexOf(name)), name];
      throw new Error(`declaration cycle: ${loop.join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const d of deps.get(name)) visit(d, [...trail, name]);
    state.set(name, 'done');
    order.push(byName.get(name));
  };
  for (const p of producers) visit(p.name, []);
  return { order, deps, owners };
}

/** A printable DAG: one line per producer with its inputs (scripts/engine-dag.mjs). */
export function describeDag(producers) {
  const { order, deps } = buildDag(producers);
  return order.map(p => ({
    producer: p.name, cost: p.inputs?.cost ?? 'cheap', schedule: p.inputs?.schedule ?? 'tick', scope: p.inputs?.scope ?? null,
    fields: [...(p.fields ?? [])], reads_fields: [...(p.inputs?.fields ?? [])], reads_events: [...(p.inputs?.events ?? [])],
    after: deps.get(p.name),
  }));
}
