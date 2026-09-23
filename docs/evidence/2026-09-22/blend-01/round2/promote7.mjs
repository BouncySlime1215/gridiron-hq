// On a scratch clone only (local copy, not production): promote fit 7 in both windows as S-03 does.
const ROOT = process.env.TREE; process.env.SCHEDULER_DISABLED = '1';
const fc = await import(`${ROOT}/server/services/fantasy-coordinator.js`);
const s = fc.promoteFantasyCoordinatorFit(7, { windows: { '2-4': 'on', '5-17': 'on' },
  evidence: 'docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json' });
console.log('served fit', s.fit_row?.id, JSON.stringify(s.promotion?.windows), 'ready', s.ready);
