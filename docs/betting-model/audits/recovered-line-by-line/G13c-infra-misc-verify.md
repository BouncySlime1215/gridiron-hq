# Verification pass: reader G13c-infra-misc (24 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). Live server confirmed running: PID 56651 on :5177 (uptime ~1d8h50m), launcher PID 50918 on :5199, tunnel.mjs PID 50971 alive (uptime ~4d14h, parent of cloudflared PID 50981), launcher's own permanent cloudflared PID 86537 on :5199. Repo IS a git checkout (`git rev-parse --is-inside-work-tree` = true, `git ls-files` = 860 files).

---

## #127 scripts/import-scottfree.mjs:42 — OUTCOME_COLUMNS unused, leakage into features_json
**Claim**: OUTCOME_COLUMNS declared, never referenced; TOP_LEVEL filter misses `home_total_points`/`away_total_points`, which land unfiltered in `features_json`.

Read the whole 137-line file. Confirmed literally: `grep -n OUTCOME_COLUMNS` hits only the comment (L10) and the declaration (L42) — never read in the filter loop at L111-115, which only checks `TOP_LEVEL.includes(k)`. Diffed the two lists programmatically: `OUTCOME_COLUMNS - TOP_LEVEL = {home_total_points, away_total_points}`. Migration `022_scottfree_game_features.js` (read in full, L1-60) confirms these are real vendor CSV columns ("every home_total_points/away_total_points column" at L17) that are NOT top-level DB columns (schema at L39-58 has no such columns) — so if the vendor CSV carries them, they fall through into `featureRow`/`features_json` unfiltered. The code-level defect is real.

**Impact check**: `grep -rln "nfl_scottfree_game_features|scottfree"` across the whole repo returns only: the migration file, the importer itself, and `test/model-registry-persistence.test.js` (which only asserts the table is created/dropped by migrate/rollback — never reads features_json or trains anything on it). No route, service, or script currently reads `nfl_scottfree_game_features.features_json` as a feature set. The leakage guard is broken, but there is currently no consumer that could be poisoned by it — nothing trains on this table today.

**Verdict**: refuted=true, corrected_severity=P3. Real dormant landmine, zero current consumers, so it changes nothing a user or model sees today.

---

## #128 scripts/launcher.mjs:89 — startTunnel probes cloudflared not tunnel.mjs registrar
**Claim**: `processRunning('cloudflared tunnel --url http://localhost:5177')` matches an orphaned cloudflared child even if tunnel.mjs (the parent/registrar) is dead, so /api/auth/tunnel-url stays null forever; cited evidence: cloudflared PID 50981 ppid 50971, "no process 50971 exists."

Read the whole 150-line file. The code pattern described exists as written (L81-95) and the *theoretical* failure mode (pgrep -f matches by cmdline substring, not by actual parent liveness) is a legitimate design smell.

**Live-state check (read-only, non-disruptive)**:
- `ps -p 50971` → alive, `Ss`, elapsed 04-14:31:53, exact command `node scripts/tunnel.mjs`.
- `ps -p 50981` → alive, ppid **50971** (i.e. correctly parented under the live tunnel.mjs, NOT orphaned).
- `curl http://127.0.0.1:5177/api/auth/tunnel-url` → `{"tunnel_url":"https://findarticles-enabling-worm-brush.trycloudflare.com"}` — NOT null.
- `server/data/launcher-logs/tunnel.log` (359 lines, read in full): first block shows a *successful* initial announce+register with that exact URL, then ~350 consecutive "could not register the tunnel with the app: fetch failed" lines, but the file stopped growing ~32 min before I read it even though the process is still alive and the code re-registers every 30s (`setInterval(... 30000)`) — meaning recent 30s attempts are succeeding silently (register() only logs on catch), consistent with a since-resolved transient failure window (app PID 56651 restarted ~1d8h ago, which would blank the in-memory URL and require one successful re-registration to repopulate it — exactly what the current populated `/api/auth/tunnel-url` shows).

The claim's central evidence ("no process 50971 exists... tunnel.mjs is dead, cloudflared is orphaned") is factually false on this machine right now: tunnel.mjs is alive and correctly parents cloudflared, and the registered URL is live and answering. The specific incident described is not occurring.

**Verdict**: refuted=true, corrected_severity=P3. The `processRunning()` design gap is real in the abstract, but on the actual, currently-running system nothing is orphaned and phone access is currently working — it changes nothing right now.

---

## #129 server/routes/nfl-betting.js:1752 — synchronous 90s ridge fit on a GET route
**Claim**: `GET /football-first/:season/:week/:home/:away` calls `footballFirstLean` → `residualModel` → `cached()`, which computes synchronously on a miss inside an Express handler, against compute-cache.js's own explicit warning; fingerprint churns on any `game_lines` insert; report-cache.js's worker-thread pre-warm can't populate the main thread's cache.

Read nfl-betting.js lines 1700-1800 (route def at L1746-1762), football-first.js in full (418 lines: header 1-59, FEATURES/CARRYOVER 60-135, footballFeatures 136-260, fitResidualModel/solve 261-333, residualModel/footballFirstLean 334-418), compute-cache.js in full (119 lines), report-cache.js lines 1-90.

Confirmed exactly as claimed:
- `r.get('/football-first/:season/:week/:home/:away', ...)` at L1747 calls `footballFirstLean(season, week, home, away)` directly and synchronously (no await, no worker offload) — `server/routes/nfl-betting.js:1752`.
- `footballFirstLean` (football-first.js:361) calls `residualModel` (football-first.js:343), which calls `cached(key, fingerprint(...), () => fitResidualModel(beforeSeason, target))` (football-first.js:345-348).
- `compute-cache.js:74-85` `cached()` computes synchronously on a miss (`const value = compute();`), and its own docstring (compute-cache.js:61-64) states verbatim: "`cached()` computes on a miss, which is right for a background job and wrong inside a route — a ninety-second fit called from an Express handler blocks the whole event loop."
- Fingerprint deps: `[{table:'game_lines',stamp:'week'}, {table:'nfl_injuries',stamp:'week'}, {table:'nfl_team_week_features',stamp:'week'}]` (football-first.js:345-348) — a `COUNT(*)` fingerprint that changes on any insert to any of the three tables.
- `scripts/betting/nfl/strategy/t60-runner.js` is scheduled via `setInterval` from `server/services/scheduler.js` (confirmed `nfl_t60_runner` entry at scheduler.js:785-788, driven by the interval loop at scheduler.js:1125) — i.e. runs in the SAME Node process/event loop as the Express server, so a 90s synchronous block from this route would genuinely stall the T-60 capture's own scheduled tick, not just other HTTP requests.
- `server/services/report-cache.js:56-59` (`football_first_fit` entry) computes `residualModel` for the current season in a `Worker` thread (`import { Worker } from 'node:worker_threads'` at L22) — confirmed this is a genuinely separate module instance/store (compute-cache.js's `store` Map is per-module-instance, and a worker thread gets its own instance), so the pre-warm cannot populate the main thread's in-memory cache used by the GET route.

**Verdict**: refuted=false, severity confirmed P1. This is real, currently live, and matches the codebase's own explicit self-warning almost verbatim.

---

## #130 scripts/package-release.mjs:224 — non-git fallback would sweep the live DB
**Claim**: `walk()` fallback's EXCLUDE only matches exact basenames, so `server/data.sqlite` (basename `data.sqlite`, not `data`) survives the walk and would ship in the zip.

Read the whole 229-line file. Confirmed: `EXCLUDE = new Set(['node_modules','.git','dist','.env','.DS_Store','data','coverage','.vite','client/dist'])` (L41-44); `walk()` (L222-228) filters only `if (EXCLUDE.has(e.name)) continue` — exact basename match. `server/data.sqlite` (11,782,246,400 bytes today, confirmed via `ls -la`), `server/data.sqlite-wal`, and the `.bak` files all have basenames that do not equal `'data'`, so `walk()` would include them if it ever ran.

**But**: `git rev-parse --is-inside-work-tree` = true and `git ls-files` returns 860 files — this IS a git checkout, so the primary path (`execSync('git ls-files')`, L168-170) is what actually executes; `walk()` only runs if `git ls-files` throws (L171-174), which requires a broken/missing `.git` or a non-git extracted copy — not the case for any release built from this repo as it stands. Also confirmed `.gitignore` already excludes `server/data.sqlite`/`-shm`/`-wal`/`*.bak` (see #142 below), so the primary path is already safe independent of the fallback.

**Verdict**: refuted=true, corrected_severity=P3. Real bug in dead-in-practice fallback code; the actually-executed path (this is a git repo) already ships a safe release. Changes nothing today.

---

## #131 server/services/football-first.js:257 — train on week>=5, serve any week; carryover breaks distribution match
**Claim**: `fitResidualModel` trains only on `week >= 5` rows (always within-season features, no carryover), but at serve time weeks 1-4 substitute prior-season carryover values for the same feature names — so the abstention guard (all-zero → abstain) doesn't fire once carryover populates non-zero values, and the model scores an unseen feature distribution.

Read football-first.js in full again with this lens (lines 136-260, 334-418).
- `fitResidualModel` query: `WHERE home = 1 AND season < ? AND season >= ? AND week >= 5` (football-first.js: confirmed in the SQL at the top of `fitResidualModel`) — every training sample has `earlySeason = week<=4` false, so `withCarryover` always returns `now` (the current-season computation), never the carried branch. Training features are always "genuine within-season" values.
- At serve time, `footballFeatures(season, week, home, away)` computes `earlySeason = week <= 4` (L184) and, when true, calls `withCarryover` for `homeEff`/`awayEff`/`homeCoach`/`awayCoach`, falling back to `efficiencyGap(team, season-1, {throughWeek:99})` / `coachingProfile(team, season-1, 99)` when the current-season read is `insufficient` — i.e. week 1-4 games get last-season, full-season values instead of the current-season partial-season values the model was fit on.
- Abstain guard (L104-113 area, `footballFirstLean`): `informative = FEATURES.filter(spec => Math.abs(f[spec.key]??0) > 1e-9)`. `availabilityPicture`/`quarterbackPicture` genuinely return 0 at week ≤1 (no rows for "before this week"), but `efficiencyGap`/`coachingProfile` DO populate via the carryover branch, so `efficiency_edge`, `pace_edge`, `script_conflict` become non-zero — `informative.length > 0` — the abstain path is skipped.
- `contOf` (football-first.js:206) calls `rosterContinuity(t, season)`, which (see #144) ignores `season` in its "current roster" query — confirmed real, feeding into `homeW`/`awayW` weighting on the carryover path.

This directly affects the app's live output for the actual, current NFL Week 1 2026 games (today is 2026-09-12, Week 1 weekend) — every week-1-4 lean is being produced by a feature distribution the ridge model never trained on.

**Verdict**: refuted=false, severity confirmed P2. Real, live, currently affecting Week 1 2026 output.

---

## #132 server/services/football-context.js:212 — tempo trait label backwards
**Claim**: `off_seconds_per_drive` trait (`flip:true`) reads backwards — a genuinely slow team gets labeled "plays fast."

Read football-context.js:150-260 in full. Traced the math: `pct_raw = fraction of teams with x < v` (fraction FASTER than this team, since lower seconds/drive = faster). For a slow team, `v` is high → most other teams are faster → `pct_raw` is high (e.g. 0.9). Then `if (t.flip) pct = 1 - pct` → `pct` becomes low (0.1). Label selection: `trait: pct >= 0.75 ? t.label : t.inverse` uses the ALREADY-FLIPPED `pct` — `0.1 >= 0.75` is false → picks `t.inverse = 'plays fast'` for a team that is actually slow. Confirmed backwards exactly as claimed.

Note: without the flip, the raw `pct` (0.9) would correctly select `t.label = 'plays slowly'` — the flip is only needed for the separate numeric `.percentile` field, which `football-first.js`'s `paceOf()` reads and needs "high = fast" for `pace_edge` to be directionally correct (confirmed: `paceEdge = paceOf(home)+paceOf(away)-1`). So the SAME flipped `pct` is correctly consumed by the numeric feature but incorrectly consumed by the human-readable label logic that runs right after it.

**Reach check**: `coachingProfile` is called from `football-context.js:302-303` (`footballContext()`), which is returned directly in the API response of `GET /football-first/:season/:week/:home/:away` (`nfl-betting.js:1762: football: footballContext(...)`) — i.e. the `reading` string built from this backwards label is served to the client that renders pick explanations.

**Verdict**: refuted=false, severity confirmed P2. Real, user-facing text defect (not a numeric/lean defect — the coefficient/lean math is unaffected, only the plain-English label).

---

## #133 server/services/nfl-live.js:95 — OT win probability pinned at exactly 0/1
**Claim**: `clockSeconds(period>4)` returns 0 → `liveWinProbability`'s `left<=0` branch returns exactly 1/0/0.5, bypassing the module's own floor/clamp (`0.005`..`0.995`) that its own comment says exists specifically so "a game still being played is never 0% or 100%."

Read nfl-live.js in full (172 lines). Confirmed: `clockSeconds` (L79-86): `if (period > 4) return 0;`. `liveWinProbability` (L63-82): `const left = Math.max(0, Math.min(GAME_SECONDS, secondsLeft ?? 0));` → 0; `if (left <= 0) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;` returns before ever reaching the `floor = 0.005` clamp defined at L84-88. `probability_reliable: state !== 'in' || secondsLeft > 300` (L153) does correctly evaluate false for a live OT game (state 'in', secondsLeft 0), so the field is flagged unreliable — but the win-probability NUMBER itself is still exactly 1.0/0.0, contradicting the module's own explicit design statement.

**Verdict**: refuted=false, severity confirmed P2. Real, and directly user-facing whenever a live game reaches overtime (imminent given today is the Week 1 2026 weekend).

---

## #134 server/services/football-first.js:222 — script_conflict sign backwards vs. stated convention
**Claim**: `scriptConflict` computation runs backwards relative to the file's own documented "positive = home advantaged" convention.

Read football-first.js:196-225 closely and hand-traced with a concrete case. Convention (L198-199, restated at L221): positive = home advantaged; `spread` from home's view, positive = home is the underdog (L221 comment).

Concrete trace: home is a big underdog (`g.spread = +10`) and home's staff is strongly run-heavy (`passOf(homeCoach)` percentile ≈ 0.1). `term1 = g.spread>3 ? (0.5 - passOf(homeCoach)) : 0 = 0.5-0.1 = +0.4`. Away term is 0 (spread is not `< -3`). `scriptConflict = 0.4 - 0 = +0.4` (positive). But the actual football situation — a run-heavy team trailing, forced out of its identity — is a DISADVANTAGE for home, which per the stated convention should be NEGATIVE. Confirmed the sign is inverted exactly as claimed. Symmetric argument holds for the away term (subtracted rather than added, same inversion).

**Consequence, verified**: because this is a fitted ridge coefficient (not a hand-tuned sign), `fitResidualModel` learns whatever sign the data actually supports for the (mis-oriented) raw feature — so the overall `lean_points` number is numerically unaffected (self-correcting via the coefficient), matching the claim's own concession. What IS affected: `contributions[]`/`leading_reason`/`leading_story` (football-first.js: contributions block, `FEATURES[3].story` at the script_conflict entry) attach a fixed English causal story to this feature that assumes the documented (uninverted) direction — so the narrative text describing WHY a lean points a certain way can misdescribe the mechanism for this feature.

**Verdict**: refuted=false, severity confirmed P2. Real; narrative/explanation-only impact (the number itself is unaffected), consistent with claim's own framing.

---

## #135 server/services/football-first.js:293 — ridge lambda on unstandardized features
**Claim**: `lambda = 5` applied uniformly to `XtX` diagonal without standardizing features first, so the same lambda means different things per feature given wildly different scales (availability_edge ~±0.3, qb_downgrade_edge up to 9.9 points per L125's own docstring, wind ~0-4, etc.).

Read `fitResidualModel` in full (football-first.js:261-333). Confirmed: no normalization/standardization step anywhere between building `x = [1, ...FEATURES.map(...)]` and `for (let i=1;i<p;i++) XtX[i][i] += lambda;` (lambda=5, intercept unpenalized). Feature scale claims cross-checked against `FEATURES` docstrings: `qb_downgrade_edge` story explicitly cites "measured at 9.9" (points); `availability_edge` is a usage-share difference (bounded roughly ±0.3-0.4 in practice); `pace_edge` is a percentile-sum-minus-1 (bounded [-1,1]); `wind = max(0,mph-15)/10` (bounded 0 to ~3-4). These are genuinely incompatible units, so a single flat lambda shrinks them unevenly in a way that is an artifact of arbitrary units rather than of evidence — a real, well-founded methodological critique of code that is currently fitting and serving live Week 1 2026 leans.

**Verdict**: refuted=false, severity confirmed P2.

---

## #136 server/services/system-connectivity.js:63 — connectivity audit scans only 2 of 11 server/ dirs
**Claim**: scans only `services/`+`routes/`+`index.js`, missing `betting/, data/, db/, draft/, migrations/, modeling/, news/, platform/, scripts/` (11 dirs total), so a module used only from one of those would be falsely reported ORPHANED with a delete recommendation. Cited example: `date-util.js` used by the live T-60 runner.

Read the whole 116-line file; confirmed the code only calls `record(SERVICES, services); record(ROUTES, routes);` plus root `index.js` (L63-65) — `ls -d server/*/` does return 11 directories, confirming the claim's count.

**Empirically checked the actual consequence** (read-only Python scan, no repo mutation): reimplemented `connectivityAudit`'s exact import-scanning logic in a throwaway script and compared its 16 reported "orphans" against a FULL server/-tree import scan (all 11 directories, not just services+routes+index). Result: **0 of the 16 flagged orphans are actually imported from anywhere else in server/** (betting/, data/, db/, draft/, modeling/, news/, platform/, scripts/ included) — i.e., the narrow scan currently produces the exact same orphan list a full scan would. The claim's own concrete example, `date-util.js`, is in fact imported by ~19 files under `server/services/` itself (grep confirmed: nfl-team-card.js, nfl-postgame-truth.js, forward-ledger.js, game-cutoff.js, etc., plus `server/betting/nfl/strategy/t60-runner.js`) — so it is NOT one of the 16 flagged orphans in the first place; it was never at risk under the current scan.

**Verdict**: refuted=true, corrected_severity=P3. The scan-scope gap is a real design limitation, but empirically produces zero false-positive orphans against the current codebase — it changes nothing a user sees today. (The claim's chosen example, date-util.js, doesn't even reach the "orphaned" bucket.)

---

## #137 server/services/system-connectivity.js:28 — ROOT via URL.pathname, silent healthy:true on failure
**Claim**: `new URL('../', import.meta.url).pathname` breaks on Windows or on any path containing a space, silently yielding `healthy:true` with zero modules scanned.

Read the file in full; confirmed the mechanism is real (Windows drive-letter paths and %20-encoded spaces would indeed break `existsSync(SERVICES)` → `jsFiles()` returns `[]` → `orphans=[]` → `unexpectedOrphans.length===0` → `healthy:true`), and confirmed by grep that `launcher.mjs`, `start.mjs`, and `client/vite.config.ts` all correctly use `fileURLToPath` (inconsistency in this file is real).

**Live-state check**: `node -e` (read-only) resolved `ROOT` on this actual deployment: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/`, and `existsSync(ROOT+'services')` → true. This repo path has no spaces and this machine is macOS, so the failure mode does not occur here. Confirmed `connectivityAudit()` IS reachable via a live route (`server/routes/betting-hub.js:720-721`), but on Nick's actual running deployment it currently returns the correct 16-orphan report (matching #136's finding), not a silent-empty false positive.

**Verdict**: refuted=true, corrected_severity=P3. Real portability landmine (matters if ever run on Windows or from a space-containing path), but does not manifest on Nick's current Mac deployment — changes nothing today.

---

## #138 .github/workflows/ci.yml:94 — offline guard applied to test step, omitted from smoke step
**Claim**: `test/offline-guard.mjs` (via `NODE_OPTIONS`) is set for the `npm test` step but not the `npm run start:smoke` step, which boots the real server.

Read the whole 96-line workflow file, `test/offline-guard.mjs` in full (39 lines), and `scripts/start-smoke.mjs` in full (44 lines). Confirmed: Test step env (L79-83) sets `SCHEDULER_DISABLED`, `NODE_OPTIONS: '--import ./test/offline-guard.mjs'`, `GRIDIRON_DB_PATH`; the smoke step env (L94-96) sets only `SCHEDULER_DISABLED`. No job- or workflow-level `env:` block exists to backfill `NODE_OPTIONS` for the smoke step. `offline-guard.mjs` genuinely monkeypatches `globalThis.fetch` to throw on any non-localhost host. `start-smoke.mjs` spawns the real server with `env: {...process.env, API_PORT, GRIDIRON_DB_PATH}` — i.e., it inherits the CI step's env verbatim (no guard) plus its own `GRIDIRON_DB_PATH` override to an isolated temp sqlite. Traced boot path (`server/index.js`, `db/seed/index.js` — no `fetch(` found anywhere under `server/db/seed`) and confirmed `SCHEDULER_DISABLED` genuinely gates `startScheduler()` (`scheduler.js:1082-1083`), so no scheduled job runs during the smoke boot. I did not find a concrete boot-time fetch that would currently fire in the smoke step, but the workflow's own header (L7-9) commits to "must never require provider credentials, call a paid data/LLM API" as a property of the whole workflow, and this step alone has no enforcement mechanism for that guarantee — exactly the "assertion vs. enforced property" gap the same file's own comments (L68-71) say was already rejected once for `npm test`.

**Verdict**: refuted=false, severity confirmed P2. Real, currently-existing gap in every CI run of this exact file; whether it has ever actually fired is unverified/unknown, but the missing enforcement itself is a fact about the code as configured today, not a hypothetical requiring unusual conditions.

---

## #139 scripts/start.mjs:87 — always exits 0 even when app fails to start
**Claim**: `server.on('exit', code => process.exit(code ?? 0))` (L87) combined with the failure path `server.kill('SIGTERM'); process.exitCode = 1;` (L136-137) results in exit code 0 always, because killing by signal fires `exit` with `code === null`, so `code ?? 0` evaluates to 0 and `process.exit(0)` runs, overriding the previously-set `process.exitCode`.

Read the whole 144-line file. Confirmed exactly: L87 registers the handler immediately after spawn; L124-143 `openWhenReady()` polls up to 60 times (30s), and on failure at L134-139 does `console.error(...); server.kill('SIGTERM'); process.exitCode = 1; return;`. Node's documented child_process semantics: a process killed by a signal fires `'exit'` with `code=null, signal='SIGTERM'`. `code ?? 0` → 0. `process.exit(0)` is called explicitly, which per Node's own documented behavior overrides any prior `process.exitCode` assignment and terminates immediately with 0.

**Reach check**: `package.json`: `"start": "node scripts/start.mjs"`; `mac/Start Gridiron HQ.command` and `windows/Start Gridiron HQ.cmd` (confirmed present via `find`) are the actual desktop-shortcut launchers end users double-click, and per `scripts/start.mjs`'s own header comment they exist specifically so "the interface is built, start the server, then open a browser once it is actually answering" — this is the real user-facing launch path, not a dev-only script.

**Verdict**: refuted=false, severity confirmed P2. Real and directly affects the actual desktop launcher scripts Nick's install/start flow depends on.

---

## #140 scripts/launcher.mjs:140 — /status's tunnel_up hard-wired true
**Claim**: `/status` uses the generic `processRunning('cloudflared tunnel')` pattern that L82-88's own comment says always matches the launcher's own permanent tunnel, so `tunnel_up` is always true and "is the field a phone user checks."

Read the whole file again with this lens. Confirmed the code fact: `pgrep -f "cloudflared tunnel"` (run live, read-only) currently returns BOTH PID 50981 (app's tunnel, :5177) and PID 86537 (launcher's own permanent tunnel, :5199) — so `tunnel_up` would read true even if only the launcher's own tunnel were alive and the app's tunnel were fully dead. The logic bug is real.

**Reach check**: grepped the whole repo (client/src, server/) for any consumer of this launcher `/status` JSON's `tunnel_up` field or of port 5199 generally. Found none — the ONLY place `/status` is consumed is `launcher.mjs`'s own `/start` page's `poll()` script (read in full, L122-134), which reads `r.tunnel_url` and `r.server_up` from the same JSON but never references `r.tunnel_up` at all. No other route, page, or doc in the repo reads this field (a separate, unrelated `tunnel_up` key exists in `server/routes/draft-capture.js:75` for a different feature entirely).

**Verdict**: refuted=true, corrected_severity=P3. The `tunnel_up` computation is genuinely always-true-in-practice, but nothing in the current codebase displays or acts on that field — it changes nothing a user currently sees.

---

## #141 scripts/nfl-2022-2025-rebuild.mjs:238 — unanchored "chain" match seals a resumable audit
**Claim**: `/no remaining weeks|already complete|sealed as|chain/i` matches the bare substring "chain" anywhere (TLS cert-chain errors, "markov chain", etc.), calling `failBlindAudit()` and permanently sealing a resumable, preregistered audit on a transient failure.

Read scripts/nfl-2022-2025-rebuild.mjs lines 190-257 (through EOF) and `failBlindAudit` in `server/services/nfl-blind-audit.js:917-924`. Confirmed the regex is exactly as quoted, unanchored, case-insensitive, with `chain` as a bare alternative — matches anywhere in the message string. Confirmed `failBlindAudit()` sets `status='failed'` in `nfl_blind_audit_runs` and its own guard (`if (record.status==='complete') throw ...`) implies this is meant to be a terminal, hard-to-reverse state — no code path resurrects a `'failed'` run back to `'running'`. Crucially, the comment immediately above (L232-236, read verbatim) says this exact class of mistake has ALREADY happened: "the audit is week-chained and resumes at next_ordinal ... runs 9 and 10 lost 23 opened weeks to sealing here" — i.e., this is not a hypothetical, it's a documented prior incident of the same shape.

**Verdict**: refuted=false, severity confirmed P2 (arguably understates a proven-to-recur, data-integrity-destroying regex bug, but I will not override the given severity upward without a request to do so).

---

## #142 .gitignore:53 — pre-migration .bak-journal file tracked in git
**Claim**: `*.pre-migration-*.bak` doesn't match the trailing `-journal` suffix, so a rollback-journal sibling of a pre-migration backup is tracked.

Read the whole 53-line .gitignore. Confirmed: `git ls-files | grep -iE 'sqlite|server/data|\.env'` returns `server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` as tracked. Confirmed the glob `*.pre-migration-*.bak` requires the string to literally end in `.bak`; `...bak-journal` does not end in `.bak`, so it doesn't match; no other pattern in the file covers a `-journal` suffix for pre-migration backups (the two existing `-shm`/`-wal` sibling patterns at L26-27 are specific to the unrelated `pre-reset-*` naming scheme, not `pre-migration-*`).

**Verdict**: refuted=true, corrected_severity=P3, matching the claim's own concession ("the data exposure itself is negligible" — confirmed the file is a 1024-byte SQLite journal stub, not meaningful data). True defect, no observable current impact.

---

## #143 scripts/package-release.mjs:178 — two EXCLUDE entries are no-ops in the git-ls-files path
**Claim**: `'data'` and `'client/dist'` never match anything `git ls-files` emits.

Read the copy loop (L176-187) again: `const top = rel.split('/')[0]; if (EXCLUDE.has(top) || EXCLUDE.has(rel)) continue;`. Confirmed via `ls -la` at repo root: there is no top-level directory literally named `data` (only `server/data/`), so `top` is never `'data'` for any git-tracked path (e.g. `server/data/analyst-notes-2026.json` → `top==='server'`); confirmed via `git ls-files | grep '^data'` → empty. Confirmed `client/dist` is untracked (`git ls-files | grep '^client/dist'` → empty, and `client/dist/` is itself in `.gitignore`), so `rel === 'client/dist'` can never occur from `git ls-files` output (which lists files, not directories, and this one isn't tracked anyway).

**Verdict**: refuted=true, corrected_severity=P3. Both true as stated, but this is a redundant-with-#130 observation about a fallback/dead-code list; the actually-executed path's real protection is `.gitignore` (confirmed to correctly exclude the database), so this changes nothing about what actually ships today.

---

## #144 server/services/football-context.js:498 — rosterContinuity ignores season on "current roster" query
**Claim**: `rosterContinuity(team, season)`'s "current" roster query has no season filter, always reflecting today's live roster, so a historical replay of a past season's weeks 1-4 compares old usage against today's (future, from that season's perspective) roster.

Read football-context.js:470-529 in full. Confirmed exactly: `current = new Set(rows("SELECT p.id FROM players p JOIN nfl_teams t ON t.id=p.team_id WHERE t.abbr=?", team).map(...))` — no `season` predicate, while the sibling `prior` query does filter `u.season = ? ` (`season-1`). `players.team_id` reflects whatever the live roster table currently holds. This is a genuine bug in the function as written.

**Reachability trace** (this is the important part — the claim names three specific callers as exercising it):
- `fitResidualModel` filters `week >= 5` always → `earlySeason` never true during training → `contOf`/`rosterContinuity` never invoked by the fit itself. (Claim concedes this.)
- `scripts/audit-football-first.mjs` (read in full for this purpose, lines with `week`/`season`): explicitly filters `week >= 5` (L81) for every held-out season it scores — never reaches the week≤4 carryover branch. **Does not currently exercise this bug.**
- `server/services/weekly-walkforward.js` (read lines 95-135): `walkForward({ startWeek = 5, ... })` — default is 5, and BOTH call sites in the repo (`server/routes/nfl-betting.js:1821` and the `football_first_fit`/`walk_forward` entry in `server/services/report-cache.js`) call it with no `startWeek` override, i.e. always at the default of 5. **Does not currently exercise this bug under its actual invocations.**
- `server/services/forward-ledger.js`'s `recordThisWeek` (reachable via `POST /forward/record`, `nfl-betting.js:1858-1868`, arbitrary `season`/`week` from the request body): its query requires `team_score IS NULL` (unplayed games) — for a genuinely historical/completed season this returns zero rows, so `footballFirstLean` is never reached for a past, finished season through this path either.
- HOWEVER: `GET /football-first/:season/:week/:home/:away` (`nfl-betting.js:1747`) takes an arbitrary `season`/`week` from the URL with no "must be current/unplayed" gate, and `footballFeatures`'s underlying `game_lines` lookup (football-first.js) doesn't require the game to be unplayed — so calling this route directly for a past season's week ≤4 game (e.g. `/football-first/2023/2/KC/DEN`) WOULD hit the carryover branch and WOULD call `rosterContinuity(team, 2023)` with today's (2026) roster as "current." This is a live, externally-reachable path, even though it isn't one of the three scripts the claim names.

**Verdict**: refuted=false, severity P2 (kept as given). The underlying bug and its live reachability are real, but I could not confirm the claim's specific citation that `audit-football-first.mjs`, `weekly-walkforward.js`, and `forward-ledger.js` "all score arbitrary weeks" reaching this defect — under their actual current configuration/call sites, none of the three do; the real live exposure is via the direct single-game GET route with a historical season parameter, which the claim doesn't name.

---

## #145 server/services/compute-cache.js:88 — cachedAsync has no in-flight dedup
**Claim**: concurrent misses on the same key each run `compute()` independently (thundering herd against a rate-limited/paid endpoint).

Read compute-cache.js in full (119 lines). Confirmed the code fact precisely: `cachedAsync` (L88-96) has an await boundary between the `store.get` miss check and `store.set`, with no in-flight promise memoization — this is correct as described.

**Reach check**: `grep -rln "cachedAsync" server/` (whole codebase) returns only `compute-cache.js` itself — the file that defines and exports it. **Zero callers anywhere in the repo.** This is exported, unused, dead code.

**Verdict**: refuted=true, corrected_severity=P3. Real code property, but with literally no current caller, it cannot presently cause a thundering herd against anything — changes nothing today.

---

## #146 scripts/lint.mjs:15 — lint is syntax-check only
**Claim**: `node --check` per file; no semantic linting (no unused-var, no undefined-var, etc.); this is what CI calls "Lint."

Read the whole 16-line file and confirmed `.github/workflows/ci.yml`'s "Lint" step runs `npm run lint` → `node scripts/lint.mjs`. The technical claim (`node --check` is parse-only) is accurate and well-known Node behavior; no dependency (eslint etc.) is invoked anywhere in this script.

**Verdict**: refuted=true, corrected_severity=P3. True as a statement about tooling coverage, but this is a process/meta observation about what CI *would* catch, not a live defect that currently changes a number, decision, or dataset — and the specific example it cites (#127's OUTCOME_COLUMNS) was itself found to have zero current consumers (see #127). Doesn't meet the impact bar on its own.

---

## #147 scripts/install.mjs:80 — Anthropic API key prompt echoes to screen
**Claim**: `readline/promises`' `rl.question()` echoes input, so a pasted `sk-ant-...` key is visible on screen and left in scrollback.

Read scripts/install.mjs lines 1-100. Confirmed: plain `readline.createInterface({input:process.stdin, output:process.stdout})` + `rl.question(...)` with no raw-mode/mute handling anywhere nearby — this does echo by default. Accurate as a Node API fact.

**Verdict**: refuted=true, corrected_severity=P3. Real, but scoped to a one-time, single-user, local-terminal install step (Nick's own machine, own scrollback, no third party involved) — it doesn't touch money staked, a recorded decision, data integrity, or a number on a page; a one-time onboarding UX/security nit for a self-hosted single-user app.

---

## #148 scripts/install.mjs:89 — 0600 .env mode ignored on re-run against an existing file
**Claim**: `fs.writeFileSync(ENV, next, {mode:0o600})` doesn't change permissions on an existing file (POSIX open() mode-on-create-only semantics), so a previously-644 `.env` stays world-readable after a re-run that claims "never leaves this machine."

Confirmed the Node/POSIX semantics as described (mode only applies at file creation, not to an existing file re-opened for write). Confirmed live state: `ls -la .env` → `-rw-------@ ... .env` (currently 0600) — matching the claim's own admission ("this is latent rather than active on this machine").

**Verdict**: refuted=true, corrected_severity=P3. Real Node behavior; explicitly non-manifesting on the current install per both the claim's own text and my direct check.

---

## #149 scripts/install.mjs:64 — npm ls --depth=0 as a hard gate
**Claim**: `npm ls --depth=0` can exit non-zero for extraneous/unmet-peer issues, not just missing packages, so it can wrongly abort a working install with a misleading message.

Read install.mjs lines 53-65. Confirmed the code: `res = spawnSync(npm, ['ls','--depth=0'], ...); if (res.status !== 0) die('One or more required packages are missing...')`. `npm ls`'s documented exit-code behavior (non-zero on extraneous/invalid trees, not solely on missing packages) is accurate.

**Live check**: ran `npm ls --depth=0` in this repo (read-only) → exit code 0, clean dependency tree (`@anthropic-ai/sdk`, react stack, vite, etc., no extraneous/UNMET entries).

**Verdict**: refuted=true, corrected_severity=P3. Real risk in general, but this repo's actual dependency tree is currently clean, so the false-abort scenario is not presently occurring.

---

## #150 scripts/tunnel.mjs:84 — URL-clearing POST aborted on unexpected cloudflared exit
**Claim**: `child.on('exit', code => { ...; register(''); process.exit(code ?? 0); })` doesn't await `register('')` before `process.exit()`, so the app keeps advertising a dead tunnel URL after a cloudflared crash.

Read the whole 84-line file. Confirmed: `register()` (L45-53) is `async` and does `await fetch(...)`; the `child.on('exit', ...)` handler (L84) calls `register('')` without awaiting it, then calls `process.exit(code ?? 0)` on the very next synchronous statement — this terminates the event loop before the pending fetch promise can resolve, so the clearing POST is aborted mid-flight. Confirmed the deliberate-shutdown path (`shutdown`, L77-81) does it correctly with `await register('')` before `child.kill`. This is a genuine asymmetry between the two exit paths.

**Verdict**: refuted=false, severity confirmed P2. Real; matters specifically on an *unexpected* cloudflared crash (not the common clean-shutdown Ctrl-C path), which is a real though less-frequent scenario — directly affects what Settings → Phone access would show a user trying to reconnect.

---

# Summary table

| key | refuted | corrected severity | one-line reason |
|---|---|---|---|
| #127 | true | P3 | real bug, zero current consumers of the table |
| #128 | true | P3 | live system contradicts the claim's own cited evidence — nothing is orphaned |
| #129 | false | P1 | confirmed, live, matches the module's own explicit warning |
| #130 | true | P3 | fallback path is dead code — this is a git checkout |
| #131 | false | P2 | confirmed, currently affecting live Week 1 2026 output |
| #132 | false | P2 | confirmed backwards label, user-facing text |
| #133 | false | P2 | confirmed, live-facing during any OT game |
| #134 | false | P2 | confirmed sign inversion; narrative-only impact |
| #135 | false | P2 | confirmed unstandardized ridge penalty |
| #136 | true | P3 | scan-scope gap real but produces zero false orphans empirically |
| #137 | true | P3 | real portability gap, doesn't manifest on Nick's Mac deployment |
| #138 | false | P2 | confirmed live CI enforcement gap |
| #139 | false | P2 | confirmed via Node signal/exit semantics, real user-facing script |
| #140 | true | P3 | field is genuinely always-true but consumed nowhere in the codebase |
| #141 | false | P2 | confirmed, and already caused documented prior data loss |
| #142 | true | P3 | real gitignore gap, negligible tracked artifact |
| #143 | true | P3 | real dead entries, but real protection (.gitignore) already covers it |
| #144 | false | P2 | bug real and reachable via direct GET route; claim's named callers don't actually reach it though |
| #145 | true | P3 | cachedAsync has zero callers anywhere in the repo |
| #146 | true | P3 | true but tooling-meta, no current concrete impact |
| #147 | true | P3 | real but single-user/local/one-time install nit |
| #148 | true | P3 | real Node semantics, current .env already 0600 |
| #149 | true | P3 | real risk, current dependency tree installs clean |
| #150 | false | P2 | confirmed async/exit race, real edge-case reliability bug |
