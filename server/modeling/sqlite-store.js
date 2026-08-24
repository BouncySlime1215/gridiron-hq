import { db, row, rows, run } from '../db/index.js';

export function ensureModelLabSchema(database = db) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_experiments (
      id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      logs_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
      promoted_at TEXT, promoted_by TEXT
    );
    CREATE TABLE IF NOT EXISTS model_predictions (
      run_id TEXT NOT NULL, player_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
      as_of TEXT NOT NULL, status TEXT NOT NULL, prediction REAL, lower REAL, upper REAL,
      active_probability REAL, actual REAL, error TEXT, fold_cutoff INTEGER, is_holdout INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, player_id, season, week)
    );
    CREATE TABLE IF NOT EXISTS model_production_pointer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), experiment_id TEXT NOT NULL,
      previous_experiment_id TEXT, audit_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
}

const decode = value => value == null ? null : JSON.parse(value);
const hydrate = item => item && ({ id: item.id, spec: decode(item.spec_json), status: item.status,
  created_at: item.created_at, updated_at: item.updated_at, cancellation_requested: Boolean(item.cancellation_requested),
  logs: decode(item.logs_json) ?? [], result: decode(item.result_json) });

export class SqliteModelStore {
  constructor(database = db) { this.db = database; ensureModelLabSchema(database); }
  get(id) { return hydrate(this.db.prepare('SELECT * FROM model_experiments WHERE id=?').get(id)); }
  insert(item) {
    this.db.prepare(`INSERT INTO model_experiments
      (id,spec_json,status,created_at,updated_at,cancellation_requested,logs_json,result_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(item.id, JSON.stringify(item.spec), item.status, item.created_at, item.updated_at,
        Number(item.cancellation_requested), JSON.stringify(item.logs ?? []), item.result ? JSON.stringify(item.result) : null);
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
      this.db.prepare('UPDATE model_experiments SET promoted_at=?,promoted_by=? WHERE id=?').run(audit.promoted_at, audit.promoted_by ?? audit.rolled_back_by, id);
      this.db.exec('COMMIT'); return { active: id, previous, audit };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export function persistAudit(audit) {
  ensureModelLabSchema();
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
  ensureModelLabSchema();
  return rows('SELECT * FROM model_predictions WHERE run_id=? ORDER BY season,week,player_id', runId);
}

