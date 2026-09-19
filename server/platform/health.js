/**
 * Liveness, for the host's health check — deliberately the cheapest route that
 * can still FAIL when the app is broken.
 *
 * `fly.toml` used to carry a TCP check and nothing else. A TCP check is
 * answered by the kernel's listen backlog, which keeps accepting connections
 * perfectly well while Node's event loop is blocked, so a wedged process looks
 * healthy forever: Fly went on routing traffic to it and never restarted it.
 * That is how the app stayed down rather than recovering by itself.
 *
 * So this must execute JavaScript on the event loop and touch SQLite
 * synchronously, because those are the two things that actually wedge (see
 * runJobOffThread in services/scheduler.js). A check that only proved a socket
 * was open would reproduce the original bug.
 *
 * Unauthenticated on purpose: a health check cannot hold a bearer token. It is
 * mounted above every authenticated router so no auth failure can ever mask a
 * liveness answer.
 *
 * WHICH IS EXACTLY WHY IT MUST SAY AS LITTLE AS POSSIBLE. This endpoint is
 * public on the open internet, and the reason the start-up probes moved here
 * at all is that they used to poll `GET /api/model/status`, which answers with
 * row counts out of the database — app data handed to anyone who asks. An
 * endpoint that replaces that one and then leaks something itself has not
 * fixed anything.
 *
 * It lives in its own file rather than inline in `server/index.js` so that the
 * failure body can be tested. That is the half a reviewer cannot see by
 * reading the happy path, and it is the half that matters.
 */
export function healthHandler(openDb = () => import('../db/index.js')) {
  return async (_req, res) => {
    try {
      const { db } = await openDb();
      // One prepared read against a table that always exists. Proves the event
      // loop is turning AND that a synchronous SQLite call can complete, which
      // together are what "the app can serve a request" actually means here.
      db.prepare('SELECT 1').get();
      res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
    } catch (error) {
      // 503, not 500: this is the signal that should make the host replace the
      // machine, and an error handler that returned 200 would be the TCP check
      // all over again.
      //
      // The message goes to the log and NOT to the response. A SQLite failure
      // here reads like "unable to open database file: /data/app.sqlite" — the
      // one moment this endpoint has something worth disclosing is the one
      // moment it is answering the whole internet about a broken machine.
      console.error('[health] liveness check failed:', error.message);
      res.status(503).json({ ok: false });
    }
  };
}
