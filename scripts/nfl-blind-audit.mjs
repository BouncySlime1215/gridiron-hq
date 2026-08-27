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
} else {
  throw new Error('command must be protocol, preregister, status, or next');
}
