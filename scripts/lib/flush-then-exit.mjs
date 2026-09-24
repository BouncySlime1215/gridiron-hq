/**
 * Print a report, then exit — in that order.
 *
 * `process.exit()` does not flush a pipe. A script that ends
 *
 *     console.log(JSON.stringify(report, null, 2));
 *     process.exit(0);
 *
 * is correct when a human runs it, because a TTY flushes synchronously, and
 * silently wrong the moment a parent process captures its stdout: `execFile`
 * and `execFileSync` both pipe by default, and the exit wins the race against
 * the flush. Measured on this container, a ~1 MB report loses its tail every
 * time (0/24 whole across four payload sizes, six trials each). Where it cuts
 * is not a constant, so nothing should ever key off a byte count — see
 * docs/tdd/2026-09-22-flush-then-exit.md.
 *
 * The parent then reads a JSON document that stops mid-string, and the best it
 * can say is that the report could not be parsed. Whether it reads that as a
 * damaged pipe or as a script that printed nothing depends entirely on how
 * carefully the parent was written.
 *
 * `stream` and `exit` are injectable so the ordering can be asserted without
 * spawning a process; scripts pass neither.
 */

/**
 * Write `text`, and exit with `code` once it has actually left the process.
 *
 * A stream error — a parent that closed the pipe — exits rather than waits.
 * Hanging is strictly worse than the truncation this replaces: the scheduler
 * would report the job as killed on its timeout and say nothing about why.
 */
export function writeThenExit(text, { code = 0, stream = process.stdout, exit = process.exit } = {}) {
  let exited = false;
  const finish = () => {
    if (exited) return;      // a flush and a late error must not exit twice
    exited = true;
    exit(code);
  };
  stream.once('error', finish);
  stream.write(text, finish);
}

/**
 * The machine-readable report, then the exit.
 *
 * The bytes are exactly what `console.log(JSON.stringify(value, null, 2))`
 * produced, trailing newline included, because parsers that already read these
 * scripts are not part of this change.
 */
export function printJsonThenExit(value, { code = 0, stream = process.stdout, exit = process.exit } = {}) {
  writeThenExit(`${JSON.stringify(value, null, 2)}\n`, { code, stream, exit });
}

/**
 * Exit once everything already printed has actually left the process.
 *
 * For a script with nothing left to write at its exit — it has been
 * `console.log`ging all along and simply needs to come down. `process.exit()`
 * there loses whatever is still queued, and with many small lines the loss is
 * partial and varies run to run: measured at 2,812 / 3,311 / 2,435 / 1,433 of
 * 8,000 lines, against 8,000 every time through this.
 *
 * The empty write is the mechanism, not a trick: stream writes are ordered, so
 * an empty chunk's callback cannot fire until every chunk queued before it has
 * drained. Nothing is added to the output — a stray byte would land in the
 * middle of a report another process parses.
 */
export function exitWhenFlushed(code = 0, { stream = process.stdout, exit = process.exit } = {}) {
  writeThenExit('', { code, stream, exit });
}
