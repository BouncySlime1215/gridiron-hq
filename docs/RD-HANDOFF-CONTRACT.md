# R&D → build handoff contract

Two threads, one circle. **Data & techniques R&D** moves fast: it explores free
data sources, ML/statistical techniques, and charting ideas without stopping,
and adds what it finds to the plan. **This thread** is the other half: it takes
what R&D hands over and makes it production-correct, under the discipline in
`CLAUDE.md`. R&D never ships to production files itself; this thread never
decides what is worth building.

The circle: R&D explores → packages a finding → coordinator routes it → this
thread builds it to the gate below → the built thing (and what it taught us)
goes back into the plan → R&D keeps exploring.

Nothing in this file authorises a push, a PR, a merge or a deploy. Those need
Nick's own word, brought by the coordinator, every time.

---

## 1. Intake gate — what a handoff must contain

A package that is missing any of these five gets one question back to the
coordinator, not a build. This is a gate on *the package*, not on the idea.

1. **The claim, in one sentence** — what the platform can do after this that it
   cannot do now.
2. **The data, already pulled** — a real file or table on disk with row counts
   and its season/week coverage, plus where it came from and that it is free.
   A URL alone is not data. Coverage gaps are stated, not implied.
   **And: what we already download that carries this, and why the new source
   beats it.** Added 2026-09-22 after `nfl_route_splits` was built against a
   third-party site and then found to be a strict subset of an nflverse feed
   this repo already fetches — 106 receivers against 500, and the sparse-data
   weakness written into its evidence file turned out to be an artifact of the
   worse source. Nobody asked that question, so nobody answered it.
3. **The technique, named** — the method and the parameters it needs, with the
   reason this method and not the simpler one.
4. **Where it lands** — the concrete surface that consumes it (route, page,
   engine function). A number with no consumer is not a handoff; per the
   standing rule we verify the consumer, not the producer.
5. **How we will know it works** — the metric, the held-out split, and the
   baseline the metric has to beat. "It looks right" is not a number.

If R&D hunted for data and came up empty, the gap is reported up to the
coordinator, who keeps the one running log. (There is no
`docs/data/missing-data-register.md` on `main` at 654ff93 — checked. If that
register is wanted in the repo, it is its own change, not a side effect of a
handoff.)

## 2. Build pipeline — what this thread does with an accepted package

Run in order. No step is skipped for a small change.

1. **Audit first.** Read what already exists for this surface and decide
   extend-or-build, in writing, before the first test. Three copies of the same
   number is the failure mode this step exists to prevent.
2. **Confirm file ownership** with the coordinator before editing any server
   file another thread owns. One editor per file.
3. **RED commit.** Tests that encode the claim and fail for the right reason.
   Reason recorded, not just the count.
4. **GREEN commit.** Implementation, tests passing. Fix the implementation, not
   the test, unless the test is wrong.
5. **Mutation-test the tests.** Break the implementation deliberately; a
   mutation the suite survives means the test is wrong, and the test gets
   fixed before anything else.
6. **Evidence file** at `docs/tdd/<slug>.tdd.md`, matching the house shape of
   the 24 already there: audit, RED→GREEN commits, what it does, the numbers,
   the known defects.
7. **Full `npm run check`** — typecheck, lint, test, build, start:smoke — exit
   status read, and the real numbers stated. Run `npm ci` first in a fresh
   clone; without it the offline-guard tests fail with
   `ERR_MODULE_NOT_FOUND` and it looks exactly like a regression.
8. **Report up** with the numbers. The coordinator takes anything needing
   Nick's word.

## 3. The five questions

Every evidence file and PR body this thread writes answers these, in these
words, and says "guess" in plain words where the answer is a guess.

1. Is this well built?
2. Is it based on stats, or made up?
3. How do we know — a backtest on held-out seasons with the metric and the
   number, a hand-set constant, or nothing?
4. Should this data be pointed anywhere else on the platform?
5. How does it unify with the rest?

## 4. What gets handed back instead of built

- A finding whose data does not exist yet — goes back as a gap, not a build.
- An estimate presented as a measurement. A labelled, validated estimate is
  fine; an unlabelled one is not.
- A feature on the never-build list: multi-platform league import, offseason
  product, monetization, banning narrative features. Betting is out of scope.
- A rebuild of a deleted page. Nav is eight tabs; a deleted page stays deleted.
- Anything paid. A free API key is fine. A paid API, dataset or subscription is
  logged as Nick's own call and never proposed as a path.
