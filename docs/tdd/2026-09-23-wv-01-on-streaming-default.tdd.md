# WV-01-ON: turn the streaming-board suggestion on by default (NICK-WV01 exemption)

Unit WV-01-ON (plan item B5, follow-on to WV-01/#176). Branch
`claude/local-wv-01-on-streaming-board-on`, cut from `origin/main` at `47f214ff`
(which already contains #176, "Add a defense-streaming card to Start/Sit",
merged 2026-09-23T14:10:29Z).

## 1. Audit: extend or build

What exists on `47f214ff`:

| piece | where | what it does |
|---|---|---|
| `WV01_STREAMING_BOARD_ENABLED` | `server/services/streaming-board.js:55` (now `:58`) | gates the swap suggestion; was `false` by default per Auditor ruling 2026-09-23 (e) / STATS-METHOD.md rule 5 (no confirmed 2026 forward holdout) |
| pinned default-off test | `test/streaming-board.test.js:174` "Auditor 2026-09-23 (e)" | asserted the flag false and that nothing in the repo sets it true |
| card label | `client/src/components/lineup/StreamingBoard.tsx:39-43` | read "unconfirmed forward: not yet checked on 2026 games" when the suggestion was shown |
| history replay | `docs/evidence/streaming-def-history.mjs`, cited by `docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md` | replays `streamingBoard()`/`rankDefenses()` on 2022-2025, the basis for the +1.94 pts/swap-week [1.88, 2.01] figure already shipped in the header comment |
| the exemption itself | `WORK-QUEUE.md` section 12, row `NICK-WV01`, under heading "## 12. Rulings (cont.) 2026-09-23T15:43Z: Nick: 'For all of them do what you think is best'. Coordinator decisions:" | "Exemption granted for zero-parameter market rankings that pass their history test: the streaming card suggests swaps now, labelled 'history-tested (2022-25), not yet confirmed on 2026 games'. Rule 5 still applies to anything with fitted parameters." |

Decision: **extend**, not build. This unit changes one boolean default and one
label string; it reuses the existing service, route, history replay and test
file. No new table, column, migration, or number is produced — the underlying
ranking (the betting market's implied total) is unchanged and was already
shipping (unconfirmed) when the flag was explicitly turned on for a caller.
No new external data, so no licence check applies.

**Statistical discipline note:** this is a *policy* change (a Coordinator ruling
carves out an exemption to rule 5 for zero-parameter, non-fitted market
rankings), not a new statistical claim. No new number is computed here and no
new look is taken at the 2025 held-out season, so nothing is added to
`docs/evidence/HOLDOUT-LEDGER.md`. The existing history-replay figures (+1.94
pts/swap-week [1.88, 2.01], from `docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md`)
are unchanged and are exactly what the new label names ("history-tested
(2022-25)"). Because this ships a start/sit-facing suggestion by default
without a fresh forward-2026 confirmation, it remains labelled
"not yet confirmed on 2026 games" per the ruling, so nobody reads it as a
verified 2026 result — this is the ruling's own mitigation for shipping
without rule 5's forward check.

## 2. Pre-registration

Not applicable: no model, projection, trade-valuation, lineup, or inventory
number is being produced or changed. This is a default-flag flip already
adjudicated by the Coordinator ruling above; the Independent Auditor's own
prior ruling (e) is the one being carved out, not re-litigated.

## 3. RED

Commit `fce306ec` "test: RED — pin WV01_STREAMING_BOARD_ENABLED default-on
(NICK-WV01 exemption)". Failing assertions against `47f214ff` (flag still
`false`):

```
Expected values to be strictly equal:
null !== 'swap'
```
(`test/streaming-board.test.js:189`, `suggestion.action` with no explicit
`enabled` — i.e. the default path)

```
Expected values to be strictly equal:
null !== 'swap'
```
(`test/streaming-board.test.js:233`, `GET /api/trades/:leagueId/streams`
route body, same default path)

plus the flag-value assertion (`WV01_STREAMING_BOARD_ENABLED === true`)
failing since the flag was still `false`. Full run: 12 pass / 3 fail (see
command below).

Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gridiron-red-XXXX.sqlite) node --experimental-test-module-mocks --test --test-reporter=tap test/streaming-board.test.js`

## 4. GREEN

Commit `0a5f029d` "feat: WV01_STREAMING_BOARD_ENABLED on by default (NICK-WV01
exemption)":

- `server/services/streaming-board.js:58` — `WV01_STREAMING_BOARD_ENABLED`:
  `false` -> `true`; header comment (`:46-57`) and the call-site comment
  (`:209-211`) rewritten to cite the NICK-WV01 ruling instead of Auditor
  ruling (e) as the default's rationale.
- `client/src/components/lineup/StreamingBoard.tsx:39-42` — card copy changed
  from "unconfirmed forward: not yet checked on 2026 games" to "history-tested
  (2022-25), not yet confirmed on 2026 games" (the ruling's exact label text).

GREEN: `test/streaming-board.test.js` 15/15 pass.

Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gridiron-green-XXXX.sqlite) node --experimental-test-module-mocks --test --test-reporter=tap test/streaming-board.test.js` -> `# pass 15 / # fail 0`.

`git write-tree` on the clean tree after GREEN: `e53a6be638d228579c9369df38c82bbf45d09068`.

## 5. Mutation sweep

Unit mutant (the flag constant) and call-site mutant (the default parameter
binding), plus one designed survivor and the not-applied control, all run with:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u ...) node --test --test-reporter=tap test/streaming-board.test.js`

| mutant | change | result |
|---|---|---|
| 1 (unit) | `server/services/streaming-board.js:58` `WV01_STREAMING_BOARD_ENABLED = true` -> `= false` | **killed**: 12 pass / 3 fail |
| 2 (call site) | `server/services/streaming-board.js:132` default param `enabled = WV01_STREAMING_BOARD_ENABLED` -> `enabled = false` (caller path ignores the const) | **killed**: 13 pass / 2 fail |
| 3 (designed survivor) | `client/src/components/lineup/StreamingBoard.tsx:41` label text `history-tested (2022-25), not yet confirmed` -> `MUTATED-LABEL-TEXT` | **survived**: 15 pass / 0 fail — `test/streaming-board.test.js` has no test that renders `StreamingBoard.tsx` or asserts its label string; gap closed after skeptic review: see section 5b |
| control (not applied) | none; clean tree | 15 pass / 0 fail (baseline, matches GREEN) |

All mutant files were restored byte-for-byte after each run (`diff` against
a saved copy showed no difference; `git status --porcelain` empty throughout).

## 5b. Label test (added after skeptic review, commit after cc28898f)

A skeptic (TEST LIVENESS lens) showed the label had no test: mutant M3 changed
the render gate at `client/src/components/lineup/StreamingBoard.tsx:39` from
`data?.unconfirmed_forward ?` to `data?.unconfirmedForward ?` and
`test/streaming-board.test.js` still gave 15 pass / 0 fail. Fix:
`test/streaming-board-label.test.js` renders the real `StreamingBoard.tsx`
(TSX compiled with the repo's TypeScript, `PageState.tsx` compiled the same
way, `react-router-dom` Link stubbed; same harness as
`test/lineup-error-no-leak.test.js`) and asserts the exact text
"history-tested (2022-25), not yet confirmed on 2026 games" appears when
`unconfirmed_forward=true` and is absent (with the replay line) when false.

Command for every row: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u) node --experimental-test-module-mocks --test --test-reporter=tap test/streaming-board-label.test.js`

| tree | result |
|---|---|
| RED: `cc28898f` + new test, with `StreamingBoard.tsx` replaced by its `47f214ff` (pre-flip, "unconfirmed forward" wording) version | 1 pass / 1 fail — "label missing" |
| GREEN: `cc28898f` + new test | 2 pass / 0 fail |
| M3 (skeptic's mutant: gate reads `unconfirmedForward`) | **killed**: 1 pass / 1 fail — label missing |
| M4 (gate forced `true`) | **killed**: 1 pass / 1 fail — label shown when false |
| original mutant 3 (label text -> `MUTATED-LABEL-TEXT`) | **killed**: 1 pass / 1 fail |

Order note: the test is committed after the implementation (history is not
rewritten); RED is shown by running it against the pre-flip component file.
Component restored byte-for-byte after each run (`git status --short` showed
only the new test file).

## 6. What this does

`streamingBoard()`'s swap suggestion is now shown by default instead of
suppressed by default; the board's ranking data (the market's implied total)
was already shown either way. The one behavior change a user sees: the
Start/Sit page's "Stream a defense" card now proposes a specific swap out of
the box, labelled "history-tested (2022-25), not yet confirmed on 2026
games" instead of showing rankings with no suggestion and no label.

## 7. The numbers, with commands

- RED: 12 pass / 3 fail — command above, tree `47f214ff` + `fce306ec`.
- GREEN: 15 pass / 0 fail — command above, tree `e53a6be6` (write-tree).
- Mutation sweep: 2/2 designed-lethal mutants killed, 1 designed survivor
  (client label; now covered, section 5b: 2 pass GREEN, M3/M4 killed), 1 not-applied control at
  baseline. Commands and counts above.
- No new statistical figure is produced; the +1.94 pts/swap-week [1.88, 2.01]
  figure is unchanged and was already computed in `docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md`.

## 8. Known defects

- ~~No client-side test for the card label.~~ Fixed: section 5b.
- The exemption applies specifically to this zero-parameter service; if
  `streamingBoard()` ever grows a fitted parameter (e.g., a learned weight on
  the implied total), rule 5's forward-holdout gate applies again per the
  ruling's own text ("Rule 5 still applies to anything with fitted
  parameters") and this default must be re-examined.

## 9. Nick's five questions

1. **Well built?** Yes for what it is: a one-boolean default flip and one
   label string, covered by RED/GREEN tests and a mutation sweep on both the
   unit and its call site.
2. **Stats or made up?** No new stats. It re-labels and re-enables an
   existing, already-computed history-replay result (+1.94 pts/swap-week,
   2022-2025) per a Coordinator ruling that exempts zero-parameter market
   rankings from the forward-2026-holdout requirement; that exemption is the
   thing to scrutinize, not a number I produced.
3. **How do we know?** `WORK-QUEUE.md` section 12, row `NICK-WV01`, is the
   ruling; `docs/tdd/2026-09-23-wv-01-streaming-board.tdd.md` is the history
   replay it refers to. Both were read, not assumed, before this unit started.
4. **Pointed elsewhere?** No new producer created; `streamingBoard()` remains
   the one producer of this ranking/suggestion, reached by
   `GET /api/trades/:leagueId/streams` and the Start/Sit page's
   `StreamingBoard.tsx`, unchanged in this unit.
5. **How does it unify?** No conflicting second producer exists for defense
   streaming; grep for other "streaming" or "D/ST rank" producers in this
   unit's audit (section 1) found none besides this service.

## 10. Holdout looks

None taken in this unit (no new look at 2025 held-out data; see the
statistical-discipline note in section 1).
