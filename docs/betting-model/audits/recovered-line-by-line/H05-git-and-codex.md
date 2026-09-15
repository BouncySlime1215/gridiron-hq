# Adversarial verification — H05-git-and-codex (4 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard
HEAD: 14c5e6510ddb85ae0ba11a3b00441aa4407c61dd (read-only throughout; no writes, no test/build/git-state-changing commands run)

---

## #284 — GET /api/execution-slate/opportunities unauthenticated (server/routes/execution-slate.js:123)

Files read in full: server/routes/execution-slate.js (134 lines, lines_read=134), server/index.js (mount section + full middleware list, lines 1-140), server/modeling/authz.js (25 lines, full), server/services/execution-slate-reasoning.js (targeted: lines 150-340, the shoppedLineOpportunity/teaserOpportunity/gateOpportunities block).

Verified facts:
- `server/routes/execution-slate.js:123-132` — `r.get('/opportunities', ...)` has **no** middleware argument at all: `r.get('/opportunities', (req, res) => {...})`. Confirmed by direct read.
- `server/routes/execution-slate.js:60` — `r.post('/recommend', requireModelPermission('model:execute'), async (req, res) => {...})` — the sibling route **is** gated.
- `git show 14c5e65 -- server/routes/execution-slate.js` confirms the only diff in that commit was adding `requireModelPermission('model:execute')` to the POST line; the GET route block (lines 122-132 in the diff context) is untouched by that commit.
- `server/index.js:109` — `app.use('/api/execution-slate', executionSlateRouter);` — no router-level middleware, unlike neighboring lines 78/88/91/97/98/94 which wrap other routers in `...legacyAuthenticated` / `...legacyAdmin`. Confirmed by grep of the full mount block (lines 76-109).
- `server/modeling/authz.js:16-25` — `requireModelPermission` genuinely requires a resolved bearer session (`resolveAuthenticatedUser`) plus a specific stored permission row or admin role; it 401s with no principal. So the POST route's gate is real, and its absence on GET is a real, exploitable difference in auth posture.
- `execution-slate-reasoning.js:259-327` (`gateOpportunities`) — confirmed: a `shopped_line` candidate is blocked (`ceiling_units: 0`) unless `c.qualified === true`; `shoppedLineOpportunity` (line 184-186) sets `qualified: rowIn.qualified === true`, so the shopped-line path's exposure is genuinely capped at 0 units now, matching the claim's "residual exposure is smaller." A `teaser` candidate has no such gate — it goes straight to `stakeFor(...)` (lines ~289-315) and gets a real Kelly-derived `ceiling_units` whenever `ceiling > 0`. This confirms the claim's central point: `liveOpportunities()` (called identically by both routes, `execution-slate.js:33-58`) still returns real, non-zero, quarter-Kelly-sized `ceiling_units` for teaser opportunities via the **unauthenticated** GET route.

Assessment: This is a real, narrowly-scoped, verifiable gap. It does not let an unauthenticated caller execute or record a bet (nothing writes state from this route — it's a pure `res.json`), but it does let anyone with network access to the server see the same sized-stake numbers the commit's own headline claims to have locked down. Given the project's own T-60 capture and phone-access-via-tunnel usage pattern (per user memory), "anyone with network access" is not a purely theoretical local-only actor. The claim's own severity framing (P2, explicitly smaller than the original P1-class hole) is honest about scope and matches what the code shows.

**Verdict: not refuted. Confidence high (0.9). Severity: P2 (as claimed) is reasonable — real auth gap, real sized numbers exposed, but read-only/no execution.**

---

## #285 — Node version mismatch: package.json/CI vs. developer runtime; Codex Node-22 run (package.json:7)

Files read: package.json (full, 1-40 relevant + scripts), .github/workflows/ci.yml (full, 96 lines), test/offline-guard.mjs (full, 39 lines), test/page-explain.test.js (lines 1-40 + key handling), test/nfl-news-events.test.js (lines 1-25 + key handling), server/services/claude.js (lines 90-140, the callClaude function incl. exact line 118).

Verified facts:
- `package.json:6-8` — `"engines": { "node": ">=22.5" }` exactly as quoted.
- `.github/workflows/ci.yml:45` — `node-version: '22'`, with an explicit comment (lines 41-44) acknowledging "the local development runtime is Node 25."
- This machine's own `node --version` = v25.9.0, matching "the developer's Node v25.9.0" in the claim.
- `server/services/claude.js:118` — `const msg = await anthropicClient.messages.create({...});` — this is exactly the call frame the claim cites as the stack target for `callClaude`.
- `test/page-explain.test.js:72` and `test/nfl-news-events.test.js:29` both call `moduleMock.module('node-fetch', {...})` — confirmed real usage of `node:test`'s experimental module-mock API to intercept the Anthropic SDK's underlying transport, exactly as the claim describes, and both files' own comments (page-explain.test.js:11-16, nfl-news-events.test.js:8-11) self-document that this is the interception mechanism and that it depends on `--experimental-test-module-mocks` (declared in `package.json`'s `"test"` script, line 14).
- `test/offline-guard.mjs` (full file) only patches `globalThis.fetch`; it says nothing about `node-fetch`'s own module-level export, and per its own docstring (lines 17-19) it is "Loaded via NODE_OPTIONS" — confirmed this is wired only in `.github/workflows/ci.yml:81` (`NODE_OPTIONS: '--import ./test/offline-guard.mjs'`), not in `package.json`'s plain `"test"` script. So a bare local `npm test` has **no** fetch-level backstop at all — only the `mock.module('node-fetch', ...)` calls inside the two Claude-calling test files.
- `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:218-220` (repo's own words): "**The hosted Node 22 CI job has still never been run.** Local runtime is Node 25. Current suite: 1,618 tests, 1,579 pass, 0 fail, 39 skipped." This independently corroborates the claim's central structural point — as of the day before HEAD, nobody had actually run this suite on the CI-pinned Node version, and the repo's own audit trail says so in as many words.
- Commit 14c5e65's own message states "Suite: 1,623 tests, 1,584 pass, 0 fail, 39 skipped" — confirmed via `git log -1 --format=%B 14c5e65`, matching the claim's "commit 14c5e65's claimed 0 fail."

NOT verifiable (external to repo): I searched the whole reachable filesystem (`/Users/nick_matta` to depth 6, targeted searches for `*codex*`, `ok-x20`, `node22-tests.log`) and found **no** Codex working directory, no `node22-tests.log`, anywhere on this machine. The specific counts (1,642/1,589/11 fail/3 cancelled/39 skipped) and the specific claim that all 11 failures are "Connection error" stack traces through `claude.js:118` cannot be confirmed or denied from anything in or reachable from the repo. I could not run Node 22 myself (running `npm test` is explicitly prohibited by the audit's hard rules), so this is a genuine blind spot, not a refutation — but it means the specific numbers are unverified assertions from a source I cannot inspect.

Overstatement found: the claim's *impact* framing — "a developer running plain npm test on a mock-incompatible Node with a key in the environment spends money silently" — is contradicted by the claim's own cited evidence and by the test code itself:
1. Both test files (`page-explain.test.js:34`, `nfl-news-events.test.js:21` equivalent `setTestKey()`) explicitly overwrite `process.env.ANTHROPIC_API_KEY = 'test-key-not-real'` for the duration of the test, specifically to prevent a real key from ever being used even if interception fails. So even a total mock failure cannot spend money against the developer's real account — it would fail Anthropic's auth check with a fake key.
2. The claim's own cited failure mode is "Connection error," which is what the Anthropic SDK reports on a network-level failure (e.g., no egress in a sandboxed runner), not what it reports on a completed-but-rejected (401) request. A "Connection error" means no request was ever delivered to Anthropic's servers — which is inconsistent with "spends money," since no billable request occurred either way.
So the underlying structural finding (Node version never validated, "0 fail" only means "0 fail on Node 25", a mock-based safety net that is fragile and untested on the pinned CI version) is real and well-supported directly from the repo. The specific "spends money silently" escalation is not supported by the claim's own evidence and is very likely wrong.

**Verdict: not refuted (core claim stands on repo evidence + the repo's own admission), but corrected_severity downgraded from P1 to P2** — the real, verifiable defect is "the CI-pinned/declared Node version has never actually been exercised, so every '0 fail' figure is Node-25-only," which is a genuine and undisclosed test-integrity gap (masks a real risk that Node-22-only behavior differences go uncaught) but not a demonstrated case of actual financial loss; the "spends money silently" claim is refuted by the test files' own fake-key override and by the claim's own "Connection error" evidence. Confidence 0.65 (high confidence the version-mismatch finding is real; the specific quantified Codex run is unverifiable from here; the money-loss mechanism as stated is actively contradicted).

---

## #286 — RETURN-TO-CODEX.md's own "no stored artifact" admission, and a claimed rebuttal via mktest/ and a Codex manifest (docs/evidence/2026-09-11/RETURN-TO-CODEX.md:195)

Files read: docs/evidence/2026-09-11/RETURN-TO-CODEX.md (full, 278 lines, lines_read=278 — read in two chunks, 1-150 and 150-278).

Verified facts:
- `docs/evidence/2026-09-11/RETURN-TO-CODEX.md:195` — "Of the five measurement claims in §4, **four have no stored artifact of any kind** — no script, no JSON, no database row, no clone on disk." This matches the claim's quoted text closely (claim capitalizes "NO STORED ARTIFACT"; actual text is "four have no stored artifact of any kind" — same substance, paraphrase-level match).
- Line 213 — "An analysis that cannot be rerun is a memory, not a measurement." — exact match to the claim's second quoted fragment.
- The document's §4 (lines ~120-172) does discuss a "4,060" search and a stated ceiling of "4.44" for a 95% quantile of 4,060 independent one-sided tests (line 148), and explicitly flags that figure itself as suspect and **withdrawn**: "The figure is withdrawn pending the script; the conclusion does not depend on it." (line 148, same line).
- Independent computation (research/.venv python, scipy.stats.norm): the exact 95th-percentile of the maximum of 4,060 independent standard-normal one-sided test statistics is `norm.ppf(0.95**(1/4060))` = **4.212397189854343** — this matches the claim's corrected figure to full double precision. This part of the claim's math is genuinely correct and independently reproduced.
- However, the document **already** flags "4.44" as suspect and withdraws it, stating explicitly the conclusion does not depend on it (line 148). So this correction, while numerically real, changes nothing Nick reads or acts on — the document had already discounted that number before this claim was written.

NOT verifiable / contradicted:
- The claim cites `mktest/engine.py:92` and `mktest/final.json` as the stored artifact for a specific "H5 n=2,354... bootstrap SE 1.1944009623pp, MDE 3.3462337361pp/SD" statistic. I confirmed directly that **no `mktest/` directory exists anywhere in this repository** (`ls mktest` → "No such file or directory"; `test -f mktest/engine.py` and `test -f mktest/final.json` both fail). A repo-wide grep for the specific numbers cited (`2,354`, `1.1944`, `3.3462337`) returns zero hits anywhere under `docs/`. The document's own §4 states the cross-both teaser family holds **2,894** legs total (not 2,354), and states the MDE as "3.35pp" (a rounder figure, not "3.3462337361pp"). The specific citation does not match anything in the cited document and does not exist as a file in the repo.
- The claim also cites "Codex finding R01 (Codex/2026-09-11/ok-x20/work/claude-reconciliation.md)" preserving "51 files totalling 1,916,967 bytes with SHA-256 hashes into work/recovered-claude-research/manifest.json." I searched this machine (`/Users/nick_matta` to depth 6, and the whole repo) for `*codex*`, `ok-x20`, `mktest`, `recovered-claude-research`, and `claude-reconciliation` — **zero matches anywhere**. This external evidence cannot be located, confirmed, or denied from anything reachable in or from the audited repo.

Assessment: The claim's headline framing — "the repo's most self-consciously honest document carries exactly the class of unverified claim it was written to flag" — depends entirely on the specific counter-example (a supposedly-stored artifact for one of the "no artifact" statistics) that does not exist anywhere I can find, and whose specific numbers don't even match the source document it's rebutting. The one piece of math I could independently verify (4.44 → 4.212397189854343) is real but the document had already withdrawn that number and said the conclusion doesn't depend on it — so it changes nothing Nick reads or acts on. Per the impact lens, this claim does not survive: the genuinely-checkable part is already-superseded/non-actionable, and the load-bearing "gotcha" part cites files that do not exist in the repository.

**Verdict: refuted. Confidence 0.75. Corrected severity: P3 / not-a-defect** — the document's self-admission is accurate but not a new finding (it's the document doing exactly what it says it's doing); the rebuttal evidence (mktest/engine.py, mktest/final.json, the Codex manifest) is unlocatable and internally inconsistent with the source document's own numbers, and the one verifiable correction (4.44 vs 4.212397189854343) is on a figure the document already withdrew and explicitly said didn't matter to its conclusion.

---

## #287 — 58 unpushed commits, single copy of the repo and 9.0 GB DB (docs/CLAUDE-NEXT-STEPS.md:1)

Commands run (read-only; `git for-each-ref`, `git remote -v`, `cat .git/FETCH_HEAD`, `git rev-list --count`, `git log`, `git show`, `grep .gitignore` — no state-changing git command used).

Verified facts:
- `git for-each-ref refs/heads/main refs/remotes/origin/main` → `14c5e6510ddb85ae0ba11a3b00441aa4407c61dd commit refs/heads/main` and `7dfd3f2392510effc6f5d51e9708d502ff80bdbf commit refs/remotes/origin/main` — exact match to the claim's cited refs.
- `git remote -v` → `origin https://github.com/BouncySlime1215/gridiron-hq.git` (fetch and push) — exact match.
- `.git/FETCH_HEAD` file timestamp: `Sep 11 21:47` — exact match to the claim's "2026-09-11 21:47."
- `git rev-list --count origin/main..main` = **58** — exact match to the claim's "58 commits."
- `git log --oneline origin/main..main` confirms the range spans from `721c89a` (oldest, chronologically first unpushed) through `14c5e65` (HEAD); date check: `git log -1 --format=%ci` on the oldest-side commit `7dfd3f2` (the fork point, i.e., last pushed) is 2026-09-08 22:13:22, and `14c5e65` is 2026-09-10 22:38:47 — consistent with the claim's "2026-09-08 to 09-10" span.
- `.gitignore` lines 5-7, 11, 25-27, 52-53 confirm `server/data.sqlite*`, `*.sqlite.bak`, `*.pre-migration-*.bak` etc. are all ignored — confirms "no off-machine copy of ... the data."
- `eb32787` commit (`git show eb32787`) — confirmed verbatim: "the live database is 9.0 GB, eight accumulated snapshots held 57.3 GB, and the volume was at 97% with 15 GB free," and confirmed the accidental commit of a 9.3 GB database via a shell-quoting bug, recoverable only because "Nothing had been pushed, so the commit was reset and rebuilt without it." This is an exact match to the claim's impact paragraph, word-for-word in substance.
- `docs/CLAUDE-NEXT-STEPS.md:1` exists as cited (title line of the file), used as a reasonable anchor for a document-wide/repo-state claim rather than a specific quoted line — acceptable given the claim is about the repository's overall state, not a specific sentence in that file.

Not independently verifiable (out of scope of this repo): the existence and exact "58 behind" state of an actual second local clone on another machine — this is asserted based on the user's known standing rule (present in this session's own memory context) and is a reasonable, clearly-labeled inference rather than a claim requiring repo-internal verification.

Assessment: every checkable fact in this claim is correct, exact, and independently reproduced from git plumbing and the two cited commits. The impact (single copy of 58 commits of real fixes plus the in-flight T-60 capture, no off-machine backup, and a proven near-miss with an accidental 9.3 GB commit) is real, current, and consequential.

**Verdict: not refuted. Confidence 0.95. Severity: P2 as claimed is reasonable** (arguably could be argued higher given the live in-progress capture, but P2 — a real, current, unmitigated operational/data-loss risk — is a defensible, non-overstated severity, not a code-correctness defect that changes a number on a page).
