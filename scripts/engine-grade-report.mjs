#!/usr/bin/env node
/**
 * The grade report (ENGINE-ARCHITECTURE.md §6.2): `grade.season_to_date` per producer@version,
 * one line per graded field, from the grader's rows only (engine_state, field grade.*).
 * Aggregates only: no prediction, outcome or player row is printed.
 *
 *   node scripts/engine-grade-report.mjs [--producer P] [--version V] [--json]
 *
 * A promotion PR commits this output under docs/evidence/<date>/ (§6.2); check-promotion.mjs
 * reads the same rows. Exit 0 with rows printed; 1 when no grade row matches.
 */
import { pathToFileURL } from 'node:url';

/** The latest grade.season_to_date row per producer@version entity, optionally filtered. */
export function readSeasonGrades(database, { producer = null, version = null } = {}) {
  const found = database.prepare(`SELECT s.entity_id, s.value, s.as_of, s.producer_version FROM engine_state s
      WHERE s.id IN (SELECT MAX(id) FROM engine_state WHERE field = 'grade.season_to_date' AND entity_type = 'producer'
        AND json_extract(health, '$.status') <> 'failed' GROUP BY entity_id)
      ORDER BY s.entity_id`).all();
  return found.map(r => ({ entity: r.entity_id, as_of: r.as_of, grader_version: r.producer_version, value: JSON.parse(r.value) }))
    .filter(r => {
      const at = r.entity.lastIndexOf('@');
      return (producer == null || r.entity.slice(0, at) === producer) && (version == null || r.entity.slice(at + 1) === String(version));
    });
}

const fmt = v => (v == null ? '-' : typeof v === 'number' ? String(+v.toFixed(4)) : String(v));
const primaryOf = f => {
  if (!f.metrics) return 'metrics=-';
  if (f.kind === 'dist') {
    return `quantile_score=${fmt(f.metrics.quantile_score)} coverage80=${fmt(f.metrics.coverage80)} pit_ks_p=${fmt(f.metrics.pit_ks?.p)}`;
  }
  return `log_loss=${fmt(f.metrics.log_loss)} brier=${fmt(f.metrics.brier)}`;
};

/** One line per (producer@version, field). */
export function formatReport(list) {
  const lines = [];
  for (const r of list) {
    for (const [field, f] of Object.entries(r.value.by_field ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const labels = Object.entries(f.labels ?? {}).map(([k, n]) => `${k}:${n}`).join(',') || '-';
      const excluded = Object.entries(f.excluded ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',') || '-';
      let line = `${r.entity}  ${field}  ${f.lane}  season=${fmt(r.value.season)}  n=${f.n}  weeks=${f.clusters?.weeks ?? 0}`
        + ` entities=${f.clusters?.entities ?? 0}  floor=${f.floor_met ? 'met' : 'no'}  ${primaryOf(f)}  labels=${labels}`
        + `  excluded=${excluded}`;
      if (f.vs_incumbent) {
        const v = f.vs_incumbent;
        line += `  vs_active@${v.version}: delta=${fmt(v.delta_mean)} [${fmt(v.interval?.lo)}, ${fmt(v.interval?.hi)}]`
          + ` pairs=${v.n_pairs} weeks=${v.weeks}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function args(argv) {
  const out = { producer: null, version: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--producer') out.producer = argv[++i];
    else if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--json') out.json = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

async function main() {
  let opts;
  try { opts = args(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\nusage: engine-grade-report.mjs [--producer P] [--version V] [--json]`);
    process.exit(64);
  }
  const { db } = await import('../server/db/index.js');
  const list = readSeasonGrades(db, opts);
  if (!list.length) { console.error('no grade.season_to_date rows match'); process.exit(1); }
  console.log(opts.json ? JSON.stringify(list, null, 2) : formatReport(list));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
