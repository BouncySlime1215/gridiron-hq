#!/usr/bin/env node
/** CLI for the content-addressed, week-at-a-time NFL audit. */
import {
  blindAuditProtocol, blindAuditStatus, preregisterBlindAudit, runNextBlindAuditWeek
} from '../server/services/nfl-blind-audit.js';

const [command = 'protocol', rawId] = process.argv.slice(2);
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

if (command === 'protocol') {
  print(blindAuditProtocol());
} else if (command === 'preregister') {
  print(preregisterBlindAudit());
} else if (command === 'status') {
  if (!rawId) throw new Error('usage: node scripts/nfl-blind-audit.mjs status <run-id>');
  print(blindAuditStatus(Number(rawId)));
} else if (command === 'next') {
  if (!rawId) throw new Error('usage: node scripts/nfl-blind-audit.mjs next <run-id>');
  print(runNextBlindAuditWeek(Number(rawId)));
} else if (command === 'run') {
  if (!rawId) throw new Error('usage: node scripts/nfl-blind-audit.mjs run <run-id> [max-weeks]');
  const maxWeeks = Math.max(1, Number(process.argv[4]) || Number.MAX_SAFE_INTEGER);
  let status = blindAuditStatus(Number(rawId)), opened = 0;
  if (!status) throw new Error('blind audit not found');
  while (status.status !== 'complete' && opened < maxWeeks) {
    status = runNextBlindAuditWeek(Number(rawId)); opened++;
    const latest = status.weeks.at(-1);
    process.stderr.write(`opened ${latest.season} W${latest.week} · ${status.progress.opened}/${status.progress.total} · ${latest.chain_hash.slice(0, 12)}\n`);
  }
  print(status);
} else {
  throw new Error('command must be protocol, preregister, status, next, or run');
}
