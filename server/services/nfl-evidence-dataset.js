/**
 * The extracted dataset, and the rows it refused.
 *
 * Package A's deliverable is not "clean data". It is a dataset whose exclusions
 * are counted, named and reviewable, because the exclusions are where the bias
 * lives. A builder that drops 40% of one book's quotes and says nothing has
 * quietly decided which books the research is about.
 *
 * Every row is passed through the exact-contract key and then through four
 * chronology rules that a leak must break:
 *
 *   future_snapshot          captured after the moment we claim to read it at
 *   after_kickoff            captured at or past kickoff, so not a pregame price
 *   book_ahead_of_snapshot   a book timestamp later than the snapshot holding it
 *   duplicate_contract_conflict  one contract, one book, one instant, two prices
 *
 * The last one is the interesting failure. Two different prices for the same
 * exact contract at the same instant from the same book means either the
 * contract key is too coarse (an alternate line stored as the main line, a
 * period we did not read) or the feed merged two events. Both are reasons to
 * stop, and averaging them is how a dataset develops a small permanent lie.
 *
 * The output is written once under a content hash and never edited. Research
 * runs cite the hash; a rebuild that produces a different hash is a different
 * dataset and starts a different experiment, which is the only way a result
 * stays reproducible after the warehouse moves underneath it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from '../db/index.js';
import { contractKey, eventKey, QUARANTINE_REASONS, CONTRACT_KEY_VERSION } from './nfl-contract-key.js';

export const DATASET_VERSION = 'nfl-evidence-dataset-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(root, 'server/data/evidence-datasets');

/** American prices live outside (-100, 100). Anything inside it is a parsing artefact. */
const validAmerican = price => Number.isFinite(price) && Math.abs(price) >= 100;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

const bump = (counter, key) => { counter[key] = (counter[key] ?? 0) + 1; };

/**
 * Build one extracted dataset from the quote tape.
 *
 * `decisionAt` is the moment the dataset pretends to be read at. Defaults to
 * now; set it earlier to reconstruct what a decision at that time could have
 * used, and every later row becomes `future_snapshot` rather than a feature.
 */
export function buildEvidenceDataset({ decisionAt = new Date().toISOString(),
  markets = ['spreads', 'totals', 'h2h'], sinceSnapshot = null, limitBatches = null } = {}) {
  const startedAt = new Date().toISOString();
  const decision = new Date(decisionAt).toISOString();

  const batchArgs = [];
  let batchWhere = '';
  if (sinceSnapshot) { batchWhere = 'WHERE snapshot_at>=?'; batchArgs.push(sinceSnapshot); }
  const batches = rows(`SELECT batch_id,snapshot_at,mode,source_ref,provider FROM nfl_quote_batches
    ${batchWhere} ORDER BY snapshot_at${limitBatches ? ' LIMIT ' + Number(limitBatches) : ''}`, ...batchArgs);

  const quarantine = {};
  const droppedByBook = {};
  const keptByBook = {};
  const eventIdToKey = new Map();
  const eventKeyToIds = new Map();
  const seenAtInstant = new Map();
  const accepted = [];
  let scanned = 0;

  const drop = (reason, quote) => {
    bump(quarantine, reason);
    bump(droppedByBook, quote.bookmaker_key ?? 'unknown');
  };

  for (const batch of batches) {
    const quotes = rows(`SELECT quote_id,batch_id,provider,provider_event_id,commence_time,snapshot_at,
      book_updated_at,bookmaker_key,market,period,side_key,home_team,away_team,line,american_price
      FROM nfl_quote_tape WHERE batch_id=?`, batch.batch_id);
    for (const quote of quotes) {
      scanned++;
      if (markets.length && !markets.includes(quote.market)) { drop('market_not_requested', quote); continue; }

      // Chronology before contracts: a row from the future is not a contract
      // with a problem, it is not evidence at all.
      if (quote.snapshot_at > decision) { drop('future_snapshot', quote); continue; }
      if (!(quote.snapshot_at < quote.commence_time)) { drop('after_kickoff', quote); continue; }
      if (quote.book_updated_at && quote.book_updated_at > quote.snapshot_at) {
        drop('book_ahead_of_snapshot', quote); continue;
      }
      if (!validAmerican(quote.american_price)) { drop('invalid_price', quote); continue; }

      const contract = contractKey({ homeTeam: quote.home_team, awayTeam: quote.away_team,
        commenceTime: quote.commence_time, market: quote.market, period: quote.period,
        side: quote.side_key, line: quote.line });
      if (!contract.ok) { drop(contract.reason, quote); continue; }

      // Duplicate-event detection: a provider id and an event key must agree in
      // both directions. Either violation means two games are being treated as
      // one somewhere upstream.
      const priorKey = eventIdToKey.get(quote.provider_event_id);
      if (priorKey && priorKey !== contract.event_key) { drop('event_id_maps_to_two_games', quote); continue; }
      eventIdToKey.set(quote.provider_event_id, contract.event_key);
      const ids = eventKeyToIds.get(contract.event_key) ?? new Set();
      ids.add(quote.provider_event_id);
      eventKeyToIds.set(contract.event_key, ids);

      const instant = `${contract.key}|${quote.bookmaker_key}|${quote.snapshot_at}`;
      const priorPrice = seenAtInstant.get(instant);
      if (priorPrice != null) {
        if (priorPrice !== quote.american_price) drop('duplicate_contract_conflict', quote);
        else bump(quarantine, 'duplicate_identical_quote');
        continue;
      }
      seenAtInstant.set(instant, quote.american_price);

      bump(keptByBook, quote.bookmaker_key);
      accepted.push({
        contract_key: contract.key, contract_hash: contract.key_hash,
        event_key: contract.event_key, game_date: contract.game_date, kickoff: contract.kickoff,
        home: contract.home, away: contract.away,
        market: contract.market, period: contract.period, side: contract.side, line: contract.line,
        overtime: contract.overtime, settlement: contract.settlement,
        book: quote.bookmaker_key, price: quote.american_price,
        snapshot_at: quote.snapshot_at, book_updated_at: quote.book_updated_at,
        provider: quote.provider, provider_event_id: quote.provider_event_id,
        batch_id: quote.batch_id, quote_id: quote.quote_id,
        // Every quote in this tape was read from a stored archive rather than
        // captured by a live pregame listener, so nothing here proves a price
        // was obtainable. Package H replays that question separately.
        provenance: batch.mode === 'historical' ? 'reconstructed' : 'captured',
        minutes_to_kickoff: +((new Date(quote.commence_time) - new Date(quote.snapshot_at)) / 60000).toFixed(2)
      });
    }
  }

  const duplicateEvents = [...eventKeyToIds.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([key, ids]) => ({ event_key: key, provider_event_ids: [...ids] }));

  const dropped = Object.values(quarantine).reduce((a, b) => a + b, 0);
  const books = [...new Set([...Object.keys(keptByBook), ...Object.keys(droppedByBook)])].sort()
    .map(book => {
      const kept = keptByBook[book] ?? 0, lost = droppedByBook[book] ?? 0;
      return { book, kept, dropped: lost,
        drop_rate: kept + lost ? +(lost / (kept + lost)).toFixed(4) : null };
    }).sort((a, b) => (b.drop_rate ?? 0) - (a.drop_rate ?? 0));

  return {
    schema: DATASET_VERSION, contract_version: CONTRACT_KEY_VERSION,
    built_at: startedAt, decision_at: decision,
    filters: { markets, since_snapshot: sinceSnapshot, limit_batches: limitBatches },
    scanned, accepted: accepted.length, dropped,
    quarantine: Object.entries(quarantine).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count,
        explanation: QUARANTINE_REASONS[reason] ?? 'See the contract key module for this reason.' })),
    coverage_bias: books,
    duplicate_events: duplicateEvents.slice(0, 50),
    duplicate_event_count: duplicateEvents.length,
    events: eventKeyToIds.size,
    provenance: {
      captured: accepted.filter(r => r.provenance === 'captured').length,
      reconstructed: accepted.filter(r => r.provenance === 'reconstructed').length
    },
    rows: accepted,
    limitations: [
      'Every row here is an archived quote. Being in the tape does not prove the price was reachable, in stock, or within a limit.',
      'The overtime and push rules attached to each contract are the common US convention, not each book\'s confirmed house rules.',
      'Books with a high drop rate are under-represented in anything trained on this dataset. Read coverage_bias before comparing books.',
      'A quarantine count of zero for a rule means the tape never violated it here, not that the rule is unnecessary.'
    ]
  };
}

/**
 * Freeze a dataset to disk under its own content hash.
 *
 * The hash covers the rows and the filters, so re-running the builder after the
 * warehouse changes produces a new directory rather than editing the one an
 * experiment already cited.
 *
 * Hashed and written one line at a time rather than via `rows.map().join('\n')`
 * into one JS string first. A full season's quote tape freezes to 750K+ rows,
 * and a string that large throws `RangeError: Invalid string length` (V8's
 * per-string cap) — found running this for real against a live-DB copy for the
 * first time; nothing had ever frozen a dataset at this scale before, so there
 * is no prior hash format this needs to stay compatible with.
 */
export function freezeEvidenceDataset(dataset, { outputDir = OUTPUT_DIR } = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(dataset.filters));
  for (const row of dataset.rows) hash.update('\n' + JSON.stringify(row));
  const datasetHash = hash.digest('hex').slice(0, 16);

  const dir = path.join(outputDir, datasetHash);
  const manifest = { ...dataset, rows: undefined, dataset_hash: datasetHash,
    row_file: 'rows.jsonl', frozen_at: new Date().toISOString() };
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { existing: true, dataset_hash: datasetHash, dir };
  }
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'rows.jsonl'), 'w');
  try {
    for (let i = 0; i < dataset.rows.length; i++) {
      fs.writeSync(fd, (i ? '\n' : '') + JSON.stringify(dataset.rows[i]));
    }
  } finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outputDir, 'latest.json'), JSON.stringify(manifest, null, 2));
  return { existing: false, dataset_hash: datasetHash, dir, rows: dataset.rows.length };
}

/** The frozen manifest the research page reads. Never rebuilds; a missing one is a missing one. */
export function latestEvidenceDataset({ outputDir = OUTPUT_DIR } = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'));
    return manifest?.schema === DATASET_VERSION ? manifest : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Load a frozen dataset's rows by hash, for a replay that must cite its input. */
export function readFrozenRows(datasetHash, { outputDir = OUTPUT_DIR } = {}) {
  const file = path.join(outputDir, datasetHash, 'rows.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export { eventKey };
