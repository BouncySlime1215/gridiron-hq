/**
 * The producers the engine daemon runs, as DAG entries (daemon/dag.js): each module's
 * `{name, run, resolveFit?}` joined with its declaration from the registry (versions,
 * fields, inputs). The writers never leave their modules.
 */
import { producerSpec } from '../registry.js';
import { calendarProducer } from './calendar.js';
import { leagueProducer } from './league.js';
import { gamescriptProducer } from './gamescript.js';
import { graderProducer } from './grader.js';
import { monitorProducer } from './monitor.js';

/** A module's producer plus its registered declaration. */
export function producerEntry(mod) {
  const spec = producerSpec(mod.name);
  if (!spec) throw new Error(`producer ${mod.name} has a run but no registerProducer declaration`);
  return Object.freeze({ ...spec, ...mod });
}

export function daemonProducers() {
  return [calendarProducer, leagueProducer, gamescriptProducer, graderProducer, monitorProducer].map(producerEntry);
}
