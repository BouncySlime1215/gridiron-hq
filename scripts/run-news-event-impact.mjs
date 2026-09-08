#!/usr/bin/env node
/**
 * CLI for Package E: typed news-event extraction, the impact/timing model,
 * and the three negative controls, run against the real local database.
 *
 * This is deliberately NOT run by `npm test` — it makes real, billed calls to
 * the Anthropic API (Haiku 4.5, ~$1/$5 per million input/output tokens; a
 * batch of `--limit` stories runs a handful of cents at typical story
 * lengths — check `usageSummary()` / the Dev Hub after a run for the exact
 * figure). Bounded by --limit on purpose; this is not a historical backfill
 * tool. Run it yourself when you want to spend that budget:
 *
 *   node scripts/run-news-event-impact.mjs extract [--limit 20] [--since-days 7]
 *   node scripts/run-news-event-impact.mjs press   [--limit 20] [--since-days 14]
 *   node scripts/run-news-event-impact.mjs impact  [--market spreads]
 *   node scripts/run-news-event-impact.mjs controls
 */
import { extractNewsEventsFromItems, extractPressConferenceRoleSignals, newsEventCoverage,
  verifyNewsEventProvenance } from '../server/services/nfl-news-events.js';
import { buildImpactDataset, evaluateModels, irrelevantTeamControl, duplicateArticleControl,
  timeShiftedFutureControl, freezeImpactRun } from '../server/services/nfl-news-event-impact.js';
import { rows } from '../server/db/index.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'impact';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

if (command === 'extract') {
  print(await extractNewsEventsFromItems({ sinceDays: Number(flag('since-days', 7)), limit: Number(flag('limit', 20)) }));
} else if (command === 'press') {
  print(await extractPressConferenceRoleSignals({ sinceDays: Number(flag('since-days', 14)), limit: Number(flag('limit', 20)) }));
} else if (command === 'impact') {
  const market = flag('market', 'spreads');
  const dataset = buildImpactDataset({ market });
  const evaluation = evaluateModels(dataset);
  const coverage = newsEventCoverage();
  const provenance = verifyNewsEventProvenance();
  const report = { coverage, provenance, dataset: { ...dataset, rows: dataset.rows.slice(0, 50) }, evaluation };
  print(report);
  print(freezeImpactRun(report));
} else if (command === 'controls') {
  const claim = rows(`SELECT * FROM nfl_news_events WHERE team IS NOT NULL ORDER BY first_seen_time DESC LIMIT 1`)[0];
  if (!claim) { print({ error: 'no typed events yet — run `extract` first' }); process.exit(1); }
  const teams = rows(`SELECT abbr FROM nfl_teams WHERE abbr != ? ORDER BY RANDOM() LIMIT 1`, claim.team);
  const unrelatedTeam = teams[0]?.abbr;
  const irrelevant = unrelatedTeam ? irrelevantTeamControl(claim, unrelatedTeam) : { skipped: true };
  const duplicate = await duplicateArticleControl(extractNewsEventsFromItems, { sinceDays: 7, limit: 5 });
  const shifted = timeShiftedFutureControl(claim);
  print({ irrelevant_team: irrelevant, duplicate_article: duplicate, time_shifted_future_news: shifted });
} else {
  throw new Error('command must be extract, press, impact, or controls');
}
