import { db, row, rows, run } from '../db/index.js';

// Schema lives in server/migrations/004_model_lab.js, applied once at server
// startup by runMigrations(). Callers (routes, background jobs) run after
// startup and can rely on the tables existing; tests that construct a store
// against a fresh throwaway db must call runMigrations() first, same as the
// draft-state-machine tests do.
const decode = value => value == null ? null : JSON.parse(value);
const hydrate = item => item && ({ id: item.id, spec: decode(item.spec_json), status: item.status,
  created_at: item.created_at, updated_at: item.updated_at, cancellation_requested: Boolean(item.cancellation_requested),
  logs: decode(item.logs_json) ?? [], result: decode(item.result_json), created_by_user_id: item.created_by_user_id ?? null });

export class SqliteModelStore {
  constructor(database = db) { this.db = database; }
  get(id) { return hydrate(this.db.prepare('SELECT * FROM model_experiments WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM model_experiments ORDER BY created_at DESC').all().map(hydrate); }
  production() {
    const pointer = this.db.prepare('SELECT * FROM model_production_pointer WHERE singleton=1').get();
    return pointer ? { ...pointer, audit: decode(pointer.audit_json) } : null;
  }
  insert(item) {
    this.db.prepare(`INSERT INTO model_experiments
      (id,spec_json,status,created_at,updated_at,cancellation_requested,logs_json,result_json,created_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(item.id, JSON.stringify(item.spec), item.status, item.created_at, item.updated_at,
        Number(item.cancellation_requested), JSON.stringify(item.logs ?? []), item.result ? JSON.stringify(item.result) : null,
        item.created_by_user_id);
    return this.get(item.id);
  }
  update(id, patch) {
    const current = this.get(id); if (!current) throw new Error('experiment not found');
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE model_experiments SET status=?,updated_at=?,cancellation_requested=?,logs_json=?,result_json=? WHERE id=?`)
      .run(next.status, next.updated_at, Number(next.cancellation_requested), JSON.stringify(next.logs ?? []), next.result ? JSON.stringify(next.result) : null, id);
    return this.get(id);
  }
  atomicPromote(id, audit) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT experiment_id FROM model_production_pointer WHERE singleton=1').get()?.experiment_id ?? null;
      this.db.prepare(`INSERT INTO model_production_pointer (singleton,experiment_id,previous_experiment_id,audit_json,updated_at)
        VALUES (1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET experiment_id=excluded.experiment_id,
        previous_experiment_id=excluded.previous_experiment_id,audit_json=excluded.audit_json,updated_at=excluded.updated_at`)
        .run(id, previous, JSON.stringify(audit), audit.promoted_at);
      this.db.prepare('UPDATE model_experiments SET promoted_at=?,promoted_by=?,promoted_by_user_id=? WHERE id=?')
        .run(audit.promoted_at, audit.promoted_by ?? audit.rolled_back_by, Number(audit.promoted_by ?? audit.rolled_back_by), id);
      this.db.prepare(`INSERT INTO model_promotion_history
        (experiment_id,previous_experiment_id,action,actor_id,gate_audit_json,created_at,actor_user_id)
        VALUES (?,?,?,?,?,?,?)`).run(id, previous, audit.action ?? 'promote', audit.promoted_by ?? audit.rolled_back_by,
          JSON.stringify(audit.gates ?? {}), audit.promoted_at, Number(audit.promoted_by ?? audit.rolled_back_by));
      this.db.prepare(`INSERT INTO model_audit_log
        (actor_id,action,entity_type,entity_id,details_json,created_at,actor_user_id) VALUES (?,?,?,?,?,?,?)`)
        .run(String(audit.promoted_by ?? audit.rolled_back_by), `experiment.${audit.action ?? 'promote'}`,
          'experiment', id, JSON.stringify({ previous, gates: audit.gates ?? {} }), audit.promoted_at,
          Number(audit.promoted_by ?? audit.rolled_back_by));
      this.db.exec('COMMIT'); return { active: id, previous, audit };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export function recordModelAudit(database, actor, action, entityType, entityId = null, details = {}) {
  if (!actor?.id) throw new Error('authenticated actor required for model audit');
  database.prepare(`INSERT INTO model_audit_log
    (actor_id,action,entity_type,entity_id,details_json,created_at,actor_user_id) VALUES (?,?,?,?,?,?,?)`)
    .run(String(actor.id), action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details), new Date().toISOString(), Number(actor.id));
}

export function registrySnapshot(database = db) {
  const store = new SqliteModelStore(database);
  return {
    experiments: store.list(),
    production: store.production(),
    experiment_inputs: database.prepare('SELECT * FROM model_experiment_inputs ORDER BY experiment_id').all(),
    datasets: database.prepare('SELECT * FROM model_dataset_versions ORDER BY created_at DESC').all().map(x => ({ ...x, metadata: decode(x.metadata_json) })),
    features: database.prepare('SELECT * FROM model_feature_versions ORDER BY created_at DESC').all().map(x => ({ ...x, contract: decode(x.contract_json) })),
    backtests: database.prepare('SELECT * FROM model_backtests ORDER BY started_at DESC').all().map(x => ({ ...x, result: decode(x.result_json) })),
    metrics: database.prepare('SELECT * FROM model_metrics ORDER BY id DESC').all(),
    promotions: database.prepare('SELECT * FROM model_promotion_history ORDER BY id DESC').all().map(x => ({ ...x, gate_audit: decode(x.gate_audit_json) })),
    audit_log: database.prepare('SELECT * FROM model_audit_log ORDER BY id DESC LIMIT 200').all().map(x => ({ ...x, details: decode(x.details_json) }))
  };
}

export function persistAudit(audit) {
  const insert = db.prepare(`INSERT INTO model_predictions
    (run_id,player_id,season,week,as_of,status,prediction,lower,upper,active_probability,actual,error,fold_cutoff,is_holdout)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,player_id,season,week) DO UPDATE SET
    status=excluded.status,prediction=excluded.prediction,lower=excluded.lower,upper=excluded.upper,
    active_probability=excluded.active_probability,actual=excluded.actual,error=excluded.error`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const fold of audit.folds ?? []) for (const p of fold.predictions) insert.run(audit.run_id, String(p.player_id), p.season, p.week,
      p.as_of, p.status, p.prediction, p.lower, p.upper, p.active_probability, p.actual, p.error ?? null, fold.cutoff, 0);
    for (const p of audit.holdout?.predictions ?? []) insert.run(audit.run_id, String(p.player_id), p.season, p.week,
      p.as_of, p.status, p.prediction, p.lower, p.upper, p.active_probability, p.actual, p.error ?? null, null, 1);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return row('SELECT COUNT(*) AS count FROM model_predictions WHERE run_id=?', audit.run_id)?.count ?? 0;
}

export function predictionsForRun(runId) {
  return rows('SELECT * FROM model_predictions WHERE run_id=? ORDER BY season,week,player_id', runId);
}
