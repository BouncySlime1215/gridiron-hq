/**
 * A truncated child report must not be logged as `ok` (2026-09-22).
 *
 * `scripts/refresh-live-data.mjs` spawns four children with `spawnSync`, whose
 * stdio is a pipe, and reads each one's result off the END of its output:
 *
 *     :101  transactionsCapture    outputLines(r).filter(...).at(-1)
 *     :123  rosterSnapshots        lines.filter(/^roster_snapshots:/).at(-1) ?? lines.at(-1)
 *     :232  managerSignals         lines.at(-1)
 *
 * Two independent ways that reports success on a run that did not succeed.
 *
 * ONE — truncation cuts the TAIL, so the summary line is the first casualty.
 * `process.exit()` does not flush a pipe (measured: 0/24 whole payloads above
 * 200 KB; see docs/tdd/2026-09-22-flush-then-exit.md), and every one of these
 * children ends in a `process.exit`. When the summary is lost,
 * `transactionsCapture` runs `/failed (\d+)/` against whatever line came last,
 * matches nothing, concludes `leaguesFailed = 0`, and — because the collector
 * exits 0 whether or not leagues failed — logs **ok**. The absence of the
 * summary is read as the absence of problems.
 *
 * TWO — `spawnFailure(r)` is consulted only as a fallback for the summary text
 * (`?? spawnFailure(r)`), so in `transactionsCapture` a child that died on a
 * signal or overflowed its buffer is ignored outright as long as ANY line
 * arrived before it died.
 *
 * The file already knows the right shape: `parseChatStatus` (:236) finds the
 * chat extractor's line by its MARKER and returns null when it is absent, and
 * the comment above it says the run is an error when there is "no status line".
 * One of four children is read that way. These tests hold the other three to it.
 *
 * No child script changes. Each already prints a recognisable summary
 * (`transactions:`, `roster_snapshots:`, `manager_signals:`), so the parent can
 * tell "the child said nothing" from "the child said it was fine" without a new
 * marker protocol — which would have meant editing three scripts this unit does
 * not own, and would still be unreliable until their flush is fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-child-outcome-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const LOOP = await import('../scripts/refresh-live-data.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

/** Matches the existing suite's helper, so both read the same way. */
function fakeSpawn(results = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const script = args.find(a => /\.(mjs|py)$/.test(a)) ?? '';
    return { status: 0, stdout: '', stderr: '', ...(results[path.basename(script)] ?? {}) };
  };
  return { spawn, calls };
}

const logger = () => { const lines = []; return { lines, log: l => lines.push(l) }; };
const recorder = () => { const records = []; return { records, record: (job, status, detail) => records.push({ job, status, detail }) }; };

const TX = /^transactions: seen \d+/;

/* ---- the reader itself ------------------------------------------------ */

test('a summary line that is present is found and reported', () => {
  const out = LOOP.childOutcome({ status: 0, stdout: 'working\ntransactions: seen 12, new 3, failed 0\n' }, { marker: TX });
  assert.equal(out.ok, true);
  assert.match(out.text, /seen 12/);
  assert.equal(out.truncated, false);
});

test('exit 0 with NO summary line is a failure, not a success', () => {
  // The defect. The child exited 0 and printed plenty; its report never arrived.
  const out = LOOP.childOutcome({ status: 0, stdout: 'league 1 ok\nleague 2 ok\n' }, { marker: TX });
  assert.equal(out.ok, false, 'a run whose summary never arrived was reported as ok');
  assert.equal(out.truncated, true);
  assert.match(out.text, /summary/i, 'the log line must say WHAT went wrong, not just that something did');
});

test('exit 0 with no output at all is a failure', () => {
  const out = LOOP.childOutcome({ status: 0, stdout: '' }, { marker: TX });
  assert.equal(out.ok, false);
  assert.equal(out.truncated, true);
});

test('the summary is found by marker, not by position', () => {
  // A diagnostic printed after the summary must not hide it. `.at(-1)` loses this.
  const out = LOOP.childOutcome(
    { status: 0, stdout: 'transactions: seen 4, new 1, failed 0\nclosing db\n' }, { marker: TX });
  assert.equal(out.ok, true);
  assert.match(out.text, /seen 4/);
});

test('a non-zero exit is a failure even when the summary did arrive', () => {
  const out = LOOP.childOutcome(
    { status: 1, stdout: 'transactions: seen 0, new 0, failed 2\n' }, { marker: TX });
  assert.equal(out.ok, false);
  assert.equal(out.truncated, false, 'the child reported; it reported a failure');
});

test('a spawn error is a failure even when output arrived first', () => {
  // Today this is ignored outright in transactionsCapture as long as any line exists.
  const out = LOOP.childOutcome(
    { status: 0, stdout: 'transactions: seen 1, new 0, failed 0\n', error: new Error('spawn ENOBUFS') },
    { marker: TX });
  assert.equal(out.ok, false, 'a child that overflowed its buffer was reported as ok');
  assert.match(out.text, /ENOBUFS/);
});

test('a child killed by a signal is a failure', () => {
  const out = LOOP.childOutcome({ status: null, signal: 'SIGKILL', stdout: 'partial\n' }, { marker: TX });
  assert.equal(out.ok, false);
  assert.match(out.text, /SIGKILL/);
});

test('truncation and an outright failure are told apart', () => {
  const cut = LOOP.childOutcome({ status: 0, stdout: 'x\n' }, { marker: TX });
  const failed = LOOP.childOutcome({ status: 2, stdout: 'transactions: seen 0, new 0, failed 1\n' }, { marker: TX });
  assert.notEqual(cut.text, failed.text,
    'a lost report and a reported failure must not produce the same line: they send a reader to different places');
});

/* ---- the three call sites --------------------------------------------- */

test('transactionsCapture: a truncated report is ERROR, not ok', () => {
  const { spawn } = fakeSpawn({ 'collect-league-transactions.mjs': { status: 0, stdout: 'league 1 fetched\n' } });
  const { lines, log } = logger();
  LOOP.transactionsCapture({ spawn, log });
  assert.match(lines[0], /ERROR/, `a truncated collector run logged: ${lines[0]}`);
});

test('transactionsCapture: a good run is still ok', () => {
  const { spawn } = fakeSpawn({
    'collect-league-transactions.mjs': { status: 0, stdout: 'transactions: seen 9, new 2, failed 0\n' } });
  const { lines, log } = logger();
  LOOP.transactionsCapture({ spawn, log });
  assert.doesNotMatch(lines[0], /ERROR/);
  assert.match(lines[0], /seen 9/);
});

test('transactionsCapture: failing leagues are still ERROR (the collector exits 0 either way)', () => {
  const { spawn } = fakeSpawn({
    'collect-league-transactions.mjs': { status: 0, stdout: 'transactions: seen 9, new 2, failed 3\n' } });
  const { lines, log } = logger();
  LOOP.transactionsCapture({ spawn, log });
  assert.match(lines[0], /ERROR/);
});

test('rosterSnapshots: a truncated report is ERROR, not ok', () => {
  const { spawn } = fakeSpawn({ 'collect-roster-snapshots.mjs': { status: 0, stdout: 'league 3 period 2 written\n' } });
  const { lines, log } = logger();
  const { record } = recorder();
  LOOP.rosterSnapshots({ spawn, log, record });
  assert.match(lines[0], /ERROR/, `a truncated snapshot run logged: ${lines[0]}`);
});

test('managerSignals: a truncated report is ERROR, not ok', () => {
  const { spawn } = fakeSpawn({ 'build-manager-signals.mjs': { status: 0, stdout: 'league 1 rewritten\n' } });
  const { lines, log } = logger();
  const { record } = recorder();
  const step = LOOP.createManagerSignalsStep({ spawn, log, record, inputsKey: () => 'k' });
  const out = step();
  assert.equal(out.ok, false, 'a truncated build was reported as a success');
  assert.match(lines[0], /ERROR/);
});

test('a truncated run does not mark manager signals fresh, or the next tick skips it', () => {
  // The freshness cache keys off success. Caching a truncated run would hide it
  // for up to six hours, which is worse than the wrong log line.
  const { spawn } = fakeSpawn({ 'build-manager-signals.mjs': { status: 0, stdout: 'partial\n' } });
  const { log } = logger();
  const { record } = recorder();
  const step = LOOP.createManagerSignalsStep({ spawn, log, record, inputsKey: () => 'same' });
  step();
  const second = step();
  assert.notEqual(second.skipped, true, 'a truncated run was cached as a success and the next tick skipped');
});

test('secrets never reach the log line on a good run', () => {
  const { spawn } = fakeSpawn({
    'collect-league-transactions.mjs': { status: 0, stdout: 'espn_s2=SECRETVALUE\ntransactions: seen 1, new 0, failed 0\n' } });
  const { lines, log } = logger();
  LOOP.transactionsCapture({ spawn, log });
  assert.doesNotMatch(lines[0], /SECRETVALUE|espn_s2/);
});

/*
 * The two paths that actually quote the child's own output back. The good-run
 * case above proves almost nothing on its own: the line it logs is the matched
 * summary, and a credential would never be inside that. The mutation sweep found
 * this -- dropping the secret filter entirely left the test above passing.
 */
test('secrets never reach the log line when the report was truncated', () => {
  // The truncated message quotes the last line it DID see, which is exactly where
  // a credential echoed mid-run would be.
  const { spawn } = fakeSpawn({
    'collect-league-transactions.mjs': { status: 0, stdout: 'starting\nespn_s2=SECRETVALUE\n' } });
  const { lines, log } = logger();
  LOOP.transactionsCapture({ spawn, log });
  assert.match(lines[0], /ERROR/);
  assert.doesNotMatch(lines[0], /SECRETVALUE|espn_s2/);
});

test('secrets never reach the log line when the child exited non-zero', () => {
  // The failure path joins the child's problem lines into the log line.
  const { spawn } = fakeSpawn({
    'collect-roster-snapshots.mjs': { status: 1, stdout: 'league 1 ERROR SWID={SECRETVALUE} rejected\nroster_snapshots: partial\n' } });
  const { lines, log } = logger();
  const { record } = recorder();
  LOOP.rosterSnapshots({ spawn, log, record });
  assert.match(lines[0], /ERROR/);
  assert.doesNotMatch(lines[0], /SECRETVALUE|SWID/);
});
