# UI-ENG-4: War Room clone view per league-mate (TDD record)

Branch `claude/cloud-ui-eng-4`, built on #231 (`claude/cloud-war-room-ui`, head `cce5005e`)
with origin/main `12a6de93` merged in (`dd7da25c`).

## What it adds

One panel, "How each manager reads", in the War Room one-dashboard grid (WAR-ROOM-UI.md v2):
grid area `clones` (desktop: row 3 of the middle column, under Stops; Expand swaps it into
the NEXT MOVE slot), and one page of the phone deck. Per league-mate:

| part | producer | state when absent |
|---|---|---|
| profile traits (labels) | `server/services/people/profile-reader.js#normaliseProfile` (FIX-00 shape: leading-token enums, `nick_override` + `manager_notes` win, quiet = under 25 messages read) | `unknown` "quiet in chat (n messages read …)" / "no chat profile" / "chat DB is not on this machine" |
| P(accept) band | `trade-acceptance.js#acceptanceBand` (same function the finder uses), for a deal that passes the edge test; `fitted:false`, amber guess | "population, not him" when he has no decided offers; `unknown` when Nick says not reachable; `failed` when the counterparty layer throws |
| top reasons (≤3) | the band's factors (largest first), then Nick's word, then a fresh want | `unknown` "No reason moves him off the starting point yet." |
| wants player X | profile `values_talk.wants`, matched to a rostered player he does not own; strength 1 for 7 days, linear to 0 at day 21 (PEOPLE-LAB, PEOPLE-WIRING.md) | `unknown` when quiet or rosters not synced; unmatched phrases are dropped |
| credibility of his shop talk | `bluff-detector.js#declarationCredibility` record (≥3 declarations; bars 0.70 / 0.45 from `untouchableStance`), else the profile's `behaviour_vs_words` label | `unknown` when quiet or no record and no label |

Labels only: no profile sentence, note text or manager name is copied into the output
(tested with a sentinel string). Managers are "Team <roster id>".

Flag: the War Room's own flag (`warroom-flag.js#warRoomFlag`, which reads
`preview-mode.js#previewUnconfirmed`). Off: `GET /api/trades/:id/war-room/clones` answers
`{ enabled: false }` and the client never asks for it (the hook gets `null` until the War
Room view says enabled).

## RED

`e6db1376` test: War Room clone view per manager, profile reader labels, wants decay (UI-ENG-4 RED)

Both new test files fail at import on that commit (the two modules do not exist):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/people/profile-reader.js' imported from .../test/warroom-clones.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/warroom-clones.js' imported from .../test/warroom-clones-panel.test.js
# pass 0 / # fail 2
```

## GREEN

`8433c169` feat: War Room clone panel per league-mate behind the War Room flag (UI-ENG-4 GREEN)
`736f8ad6` test: pin the clone loader's call site (added after the mutation sweep found M8 surviving)

## Liveness: mutation sweep (tree after `736f8ad6`)

Each mutant applied alone; the two new test files run against it; restored after.

| id | mutant | result |
|---|---|---|
| M1 | wants never marked `fading` | killed (2 tests) |
| M2 | a player he already owns is not dropped from wants | killed (1) |
| M3 | no 21-day cutoff on wants | killed (1) |
| M4 | Nick's override ignored (chat read wins) | killed (1) |
| M5 | quiet rule off (any profile is a personal read) | killed (4) |
| M6 | unreachable manager still gets a band | killed (2) |
| M7 | credibility trusts a record under 3 declarations | killed (1) |
| M8 | call site: loader passes `me: null` | **survived** first run (no test seeded a league); killed (1) after `736f8ad6` |
| M9 | "population, not him" never used | killed (2) |
| M10 | per-want date ignored (profile as_of used) | killed (2) |
| M11 | panel drops the basis note | killed (2) |
| M12 | panel not in the grid areas | killed (1) |
| C1 | control: `CRED_MIXED` 0.45 → 0.44 (boundary deliberately not pinned) | survived, as designed |
| C2 | control: a mutation whose target text does not exist | not applied, as designed |

## Guard run

`npm ci` (fresh clone, exit 0), then `npm run check` on tree `4cf504d2` (head `736f8ad6`): **exit 0**.
tests 4859 · pass 4817 · fail 0 · skipped 42 · cancelled 0. Typecheck, lint, wiring, build and start smoke all passed.
`git write-tree` before and after: `4cf504d20825c749b3d59c881f6e79f21ddbd95b` both times. This record is a docs-only commit on top.

## Nick's five questions

1. **Well built?** Two pure builders (`normaliseProfile`, `buildCloneRows`) with one loader each; the panel formats only (the War Room surface test's "no arithmetic on .value" and "only useWarRoom.ts fetches" still pass with the new files in the directory).
2. **Stats or made up?** Mixed, and labelled. The band is the finder's existing heuristic (`fitted:false`, not calibrated: E1 pending). The 7/21-day wants decay is PEOPLE-LAB's measured window (local R&D, not re-run here). The credibility bars (0.70/0.45) are bluff-detector's hand-set bars. The quiet threshold (25 messages) is a **guess**, a hand-set constant.
3. **How we know:** nothing backtested in this PR. Unit tests on invented shapes; real-data check is the LOCAL lines in the PR body.
4. **Pointed anywhere else?** Only the War Room panel. It does not change the finder, the campaign producer, or `negotiationProfilesFor`.
5. **How it unifies:** the band comes from the same `acceptanceBand` the finder uses; credibility from the same `declarationCredibility` the counterparty layer uses; the profile reader is in FIX-00's shape and path, so FIX-00 / PEOPLE-01 can take it over (and #252's `profile-adapter.js` can switch its one import).

- **Gap fixed:** UI-ENG-4 had no surface; `negotiationProfilesFor` (counterparty-pricing.js:1456 on origin/main `12a6de93`) drops every rebuilt profile, so nothing showed a profile read at all.
- **Incumbent:** Trade Brain "Who trades with you" (`ManagerBoard.tsx`), which shows receptiveness and signals but no band, wants or credibility.
- **Does NOT cover:** CLONE-01b served clones and veto (not merged), TELLS-01b tells, RADAR-01a gap, motive state, reason-chain deltas over time ("fell 0.18 since Tue"). The band is not changed by Nick's "hard to deal with" (shown as a reason, not priced).
- **What would make it wrong:** a profile whose enum sentences start with a token the parsers do not know (it reads `unknown`, not wrong, but under-reads); a wants entry with no date falls back to the profile's `as_of`, which can make an old want look fresh.
