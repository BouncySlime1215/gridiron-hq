# REASON-02: reasoning claims as checkable predictions, graded (C8 / M10)

Depends on #234 (REASON-01, branch `claude/cloud-reason-01`, head `4f59d2d`); this branch starts from that head.

## What changed

- **`server/migrations/085_reasoning_claims.js`**: new table `reasoning_claims`, one row per claim a panel showed. The contract is written as SQL CHECKs. A claim is `uncheckable` if and only if it has no rule. A checkable claim has a deadline. A settled claim (`true`/`false`/`void`) records when it settled and the evidence. The UNIQUE key includes the panel fingerprint, so a panel reused across refreshes is never counted twice.
- **`server/services/reasoning/claims.js`**: `claimsFromPanel` and `recordClaims`. Each prediction comes from the fact ids the claim cites. Its words are never parsed.
  - `counter.likely` citing `reply.<i>.*` becomes `counter_with`.
  - A claim citing `his.hole.<i>.*` becomes `wants_position`.
  - Each `check_first` quote id that touches a player on the card becomes `check_first`.
  - Everything else is stored as `uncheckable`, with the reason (`own_action`, `conditional`, `no_checkable_cite`, `no_card_player`), so coverage can be measured.
- **`server/services/reasoning/resolve.js`**: `resolveOpenClaims`, with three versioned rules:
  - `offer_reply_v1`: `trade_outcomes`, 7 days.
  - `acquires_position_v1`: `league_roster_snapshots`, 14 days.
  - `news_material_v1`: final roster rows. Material means OUT/IR/SUSPENSION/DOUBTFUL, or under 50% of projection. 10 days.
  - If the test never happened, the claim becomes `void` once the deadline plus 14 days has passed. It never becomes `false`.
- **`server/services/reasoning/grade.js`**: the C8 grader, in EVAL-01's brain-report row shape (#235 `common.js#result`). The metric is the share of settled claims that came true. The CI is Wilson 95%. It passes when the CI is wholly above 0.5 and fails when it is wholly below. With fewer than 20 settled claims it reports `not_enough_data` and says how many more it needs. `detail.by_team` is M10's per-manager number.
- **`server/services/reasoning/grading.js`** and **`scripts/reasoning/grade-claims.mjs`** (`npm run reasoning:grade`): record, resolve and grade in one offline pass. They sit behind `previewUnconfirmed()`. When the flag is off they write nothing, and the grader row says why.

## RED

`e5a56bb test: RED for REASON-02 reasoning claim ledger, resolver and C8 grader`

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/reasoning/claims.js' imported from .../test/reasoning-claims.test.js
```

The RED only shows the modules are missing. Section "Liveness" below is the per-behaviour proof.

## GREEN

`2a477dc feat: REASON-02 store reasoning claims as predictions, settle them, grade C8`: 21 tests in `test/reasoning-claims.test.js` and `test/reasoning-grade-claims-script.test.js`.

**Test corrected after RED, because the test was wrong.** The first `check_first` fixture inserted a `live` row and a `final` row for the same (period, team, player). The primary key of `league_roster_snapshots` (058) excludes `source`, so the real writer turns a live row final in place: `first_seen_at` stays the same and `changed_at` moves. The fixture now matches the schema, and the rule dates a final row by `changed_at`. Mutant M5 pins this.

## Liveness (mutation sweep)

Measured on the tree just before GREEN was committed (the code below is identical at `2a477dc`). Each mutant runs both test files. Script: a python replace-run-restore loop kept in the session scratchpad.

| id | mutant | result |
|---|---|---|
| M1 | counter: position check dropped | killed |
| M2 | offers from before the claim count | killed |
| M3 | a player already on his roster counts as added | killed |
| M4 | no roster data settles false instead of waiting | killed |
| M5 | final row dated by first_seen_at | killed |
| M6 | check_first rows dropped | killed |
| M7 | our pre-planned answer treated as a prediction | killed |
| M8 | a failed section's field read in place of its value | **survived: equivalent** (a failed field has no `claims`/`likely`/`answer` keys, so it yields no claims either way; the guard this replaced was removed as redundant after an earlier sweep) |
| M9 | pass bar lowered to 0.3 | killed |
| M10 | void claims counted in the share | killed |
| M11 | flag ignored | killed |
| M12 | call site: grading.js drops leagueId to the grader | killed (test added after it first survived) |
| M13 | call site: script drops `--league` to recordClaims | killed |
| M14 | call site: script drops the flag check | killed (test added after it first survived) |
| C1 | designed surviving control: drop the Wilson clamp at 0 | survived (as designed) |
| C2 | designed not-applied control: target string absent | not applied (as designed) |

## Guard

`npm ci` exit 0, then `npm run check` exit 0 on write-tree `2ff4d522` (the merge of origin/main into this branch): 4,852 tests, 4,810 pass, 0 fail, 42 skipped. write-tree was the same before and after. This evidence file is the only change since then.

## Nick's five questions

1. **Well built?** Yes, within scope:
   - The contract is in SQL CHECKs.
   - The rules are versioned.
   - Recording is idempotent on the fingerprint.
   - An unreadable ledger cell is counted in the evidence (`unreadable_cells`). It is never silently treated as empty.
   - An unknown rule throws.
2. **Stats or made up?** The grade is a statistic: a Wilson 95% CI over settled claims. The windows are guesses, hand-set: 7, 14 and 10 days, plus 14 days of grace. So are the material bar (0.5 of projection and the status list), MIN_N 20, and the 0.5 pass bar.
3. **How we know:** from tests only. No claim has settled on real data. No panel has been produced against the live database, because the campaign producer is not on main.
4. **Pointed anywhere else?** Not yet. For grade.js to feed the brain report it must be added as one line to #235's `GRADERS` once both PRs land. The War Room does not show C8.
5. **How it unifies:** its rows have the same shape as EVAL-01's. It reads the existing outcome ledgers, `trade_outcomes` (067) and `league_roster_snapshots` (058), and adds no new data source. It extends REASON-01's grounding: a cite already gives each claim its meaning.

- **Gap fixed:** REASON-01's panels made claims that nothing stored or scored (#234 `produce.js`, whose output has no reader).
- **Incumbent:** none. `git grep -n reasoning_claims origin/main` finds nothing.
- **Not covered:**
  - The case for, devil's advocate claims that cite only card numbers, and our own answers stay `uncheckable`.
  - P(yes) is E1's job, not C8's.
  - `counter_json` has no writer on main, so the position part of `counter_with` is never checked until one records `get_positions`. Until then the claim is judged on the reply kind alone, and the evidence says `pos_checked: false`.
- **What would make it wrong:**
  - Card ids that change between refreshes (audit R2: `undefined:0` on acq-shape plans) break the `idea_id` join. The rule then falls back to matching on the card's players.
  - Roster snapshots are collected by hand. If they stop, `wants_position` and `check_first` claims void instead of settling.
