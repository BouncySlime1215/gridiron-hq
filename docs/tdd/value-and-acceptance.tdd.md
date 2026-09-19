# TDD evidence: value-and-acceptance (WA Trade Brain, stage 4 of 5)

Source: `docs/FANTASY-ENGINE-MASTER-PLAN.md` D4, the **P(accept)** paragraph:

> too few decided proposals (6 accepts, 24 declines) to fit a model, so it is a
> band from the heuristic (their perceived value delta, need fit, receptiveness,
> profile) with the observed accept rate as the anchor, labelled as a band.

and D4's non-negotiable edge test.

Built in a Claude Code cloud session, 2026-09-19. **There is no database in that
box** — `server/data.sqlite` and the chat DB are both absent (fresh clone,
gitignored). Everything below is therefore fixture-verified only and must not be
promoted past `tested`. What needs the Mac is listed in `TASKS.md`.

Runner (every command below):

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      --test-concurrency=1 test/trade-acceptance.test.js

LLM spend: $0.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `counterparty-pricing.js#readDeal` | Already computes the acceptance-relevant price quantity (`perception_delta`, how the deal reads on HIS numbers) and carries `receptiveness`, `chat_msgs`, `accept_rate`. **Drops `accept_rate_n`** — the profile has it (`:210`) but `readDeal` does not pass it through, so no caller can weight the anchor by its sample. | **Extend**: pass `accept_rate_n` through. One line, no behaviour change to any existing field. |
| `playerValuation` factors 5 (`positional_need`) and 2 (`profile_roster_read`) | Both are **already priced into `perception_delta`**. D4 lists "need fit" and "profile" as P(accept) inputs, but charging them again on top of a delta that contains them is exactly the double-charge `counterparty-pricing.js` has three explicit rules against. | **Do not re-charge.** The price axis enters the band once, as `perception_delta`. Need and roster-read are visible in `perception_reasons` for explanation, never re-added as a second term. |
| `negotiation_profiles.says_no.does_his_no_hold` | Declared in `NEGOTIATION_PROFILE_SCHEMA` (`:828`) with enum yes/usually/rarely/unknown, and **read by nothing in `server/`** — confirmed by grep. It is a behavioural signal (does a stated no convert to a real no), not a price signal, so it is uncharged and independent of `perception_delta`. | **Use it.** This is the "profile" input D4 asks for, in the one form that is not already counted. |
| `trade-tactics.js#anchorLadder` | Already carries an `anchor` block with `accept_rate`, `n`, `calibrated: false`, `fitted: false`, and a `why` string, plus a comment explaining why a fitted model was deliberately not built on 6 accepts. | **Reuse the shape, not the code.** The band reports its anchor the same way so two surfaces cannot describe the same number differently. |
| `trade-tactics.js#edgeTest` | Already a hard filter in `findTrades` (`trade-engine.js`, `shaped.filter(d => d.edge.passes)`). | **Gate on it.** The band is attached after the edge filter, so a gift never carries an acceptance number at all. |

## Gates, pre-registered before any test or implementation was written

- **G1 band, never a point.** Every return carries `low`/`mid`/`high`, `fitted: false`,
  and a named basis. There is no code path that yields a bare probability.
- **G2 the anchor is real and carries its n.** The observed accept rate anchors the
  band and is reported with `accept_rate_n`. With no decided offers the band says so
  and widens, rather than inventing a prior.
- **G3 the same evidence is never charged twice.** `perception_delta` is the only
  price term. Need fit and the profile roster read, both already inside it, are never
  re-added. Proven by a fixture where a need-driven multiplier moves `perception_delta`
  and the band moves once, not twice.
- **G4 honest degradation.** A manager with no counterparty data returns a band that
  says "no information" with its reason, not a confident midpoint — the inert-source
  shape `counterparty-pricing.js` uses.
- **G5 the edge test still gates.** An idea failing `edgeTest()` is never given an
  acceptance number. A deal that only wins on his perception does not become sendable
  because he would probably say yes.
- **G6 ablation.** Zeroing a source really moves the band, through the same `zero`
  interface `valuationMap`/`readDeal` take.
- **G7 monotonicity / no sign error.** A deal that reads better on his numbers cannot
  produce a lower midpoint, all else equal. This project has shipped a sign error
  before (the Bayesian weight direction); this gate is the cheap guard against another.

## RED -> GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | `6976685` | 15 tests, 0 pass — `server/services/trade-acceptance.js` does not exist. The gates were written into this file before the tests were, and the tests before the module. |
| GREEN | `32faf5f` | 15/15. Neighbours still green, run individually against the same runner: `valuation-map` 27/27, `trade-tactics` 32/32, `trade-engine-correctness` 15/15. `npm run lint` exit 0 (833 files). |

### What each gate is proven by

| Gate | Test |
|---|---|
| G1 band, never a point | "every result is a band with a named basis, and is never presented as fitted" — asserts `low <= mid <= high`, real width, `fitted: false`. |
| G2 anchor carries its n | three tests: the anchor reports rate + n + `calibrated: false`; no decided offers widens the band vs an anchored one and says "no decided offers"; n=4 is wider than n=60. |
| G3 never charged twice | two tests add `needs: ['RB']` and a `roster_read` on top of the same `perception_delta` and assert the band is byte-identical; a third asserts every factor that DID move it names a declared source and respects its cap. |
| G4 honest degradation | no counterparty data returns `basis: 'no_information'` with a band at least 0.5 wide and its inert sources listed with reasons; a missing profile appears as inert `says_no_holds` rather than being skipped silently. |
| G5 edge test gates | a failing edge returns `band: null`, `basis: 'edge_failed'`; a MISSING edge result returns `basis: 'edge_unknown'` rather than defaulting to a pass. |
| G6 ablation | `zero: ['receptiveness']` changes the band and removes that factor. |
| G7 monotonicity | delta -10 / 0 / +20 produces non-decreasing midpoints and a real spread; a manager whose no rarely holds is never scored below one whose no is final. Plus an extremes test: the band stays inside [0,1] and never claims certainty or impossibility. |

## What this does NOT establish

The band is a **heuristic**, not a fitted model, and cannot be validated on the
sample that exists. D4 says so and this implementation agrees with it rather than
papering over it: nothing here has been shown to predict a real accept/decline.
`valuation-map`'s own pre-registered test already found that the perception layer
predicts real decisions no better than raw value (0.81 vs 0.81, ~30 decisions) —
this band inherits exactly that limitation and claims nothing beyond it.
