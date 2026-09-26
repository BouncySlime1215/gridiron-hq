# RELEASE NOTES: a plain-English "what changed for you" note after each merged batch, shown once in Today

2026-09-26. Batch D plan item 60. Off `main` `f2a5eb41`. Flag `GRIDIRON_RELEASE_NOTES` (off by default).

Item 60: "after each merged batch, generate a plain-English 'what changed for you' note (no names), shown
once in Today." This unit ships the server and data half:

| Piece | What it does |
| --- | --- |
| `server/services/release-notes.js` | Sorts every commit in a batch into one bucket: a line Nick will notice, built but switched off, behind the scenes, or held back (wording or a name). Writes and reads the notes file. |
| `scripts/release-notes.mjs` | Reads `git log --no-merges <from>..<to>`, builds the note, prints it. Dry run by default; `--apply` writes it and needs the flag on. `--from` defaults to the last note's `to`. |
| `GET /api/release-notes` | The newest note not yet seen, or `null`. Flag off: `{ enabled: false, reason }`, reads nothing. |
| `POST /api/release-notes/:id/seen` | Marks it seen, so Today shows it once. |

The Today card is not in this PR (Trades/Today UI is wired by the coordinator); its shape is in the PR body.

## How a commit becomes a line

1. A `Release-note:` trailer in the commit body wins: its text is the line (still held to rules 5 and 6).
   `Release-note: none` hides the commit. This is how future PRs say exactly what Nick will see.
2. Types `test`, `docs`, `chore`, `refactor`, `ci`, `build`, and untyped subjects are behind the scenes.
3. Anything that says it is shadow or off (in the subject, or a body line that is not a bulleted
   constituent commit) is "built but switched off": it changed nothing Nick sees, so it is never a line.
4. The rest (`feat`, `fix`, `perf`, `ui`): the subject with its type, unit code, TDD marker, PR number and
   parentheticals removed; "Nick's" becomes "your", "Nick" becomes "you".
5. Dev-text gate: a line with a file name, path, snake_case or camelCase identifier, env name, unit code,
   hash, PR number, dollar amount, model name or leftover "Nick" is held back, never shown half-cleaned.
6. Names gate: every line is scanned against the league-mate denylist built from the plans file
   (`check-names-leak.mjs#denylistFromPlans`). A hit holds the line back and counts it (the name is
   never stored). No denylist: the whole note is `held` and shows nothing, with the reason.

## Pre-registration (written before the GREEN commit)

- **B1 (flag off is inert).** `GRIDIRON_RELEASE_NOTES` unset: GET answers exactly `{ enabled: false, reason }`
  and the notes file is not read; POST seen answers the same and writes nothing; the script's `--apply`
  exits 2 and writes nothing. `GRIDIRON_PREVIEW_UNCONFIRMED=1` alone does not switch it on.
  **Pass bar:** all four hold. **Fails it:** any read, write or served note with the flag off.
- **B2 (real history, no dev text).** The 56 real non-merge commits on `main` in `18e9bcf1^..f2a5eb41`
  (fixture `test/fixtures/release-notes-main-history.json`). **Pass bar:** 0 dev-text hits and 0 "Nick" in
  served lines; at least 4 lines served (not vacuous); the four known-live changes named in the test
  (overpay check, finished starter, News edge gate, Rankings speed) are served. **Fails it:** any served
  line with dev text, or fewer than 4 lines.
- **B3 (shadow honesty).** Every fixture commit whose subject says shadow or names its own off flag
  (U6 IS-TITLE, calibration monitor, playoff seeding, waivers perishable, E-LATENCY, CLONE v2, JEV-01a,
  RB-DELTAS, O1C-WIRE, per-league rules) is in `off`, never in `items`. **Pass bar:** 10/10.
- **B4 (accounting).** Every commit lands in exactly one bucket: items (after dedupe, plus duplicates
  counted) + off + behind + held = commits. **Pass bar:** exact on the fixture and on the synthetic set.
- **B5 (names).** A made-up team name and manager name planted in two subjects: both held back, the note's
  JSON contains neither string, `held.names` = 2. No denylist (plans file missing or no teams map): note
  `status: 'held'`, 0 items, plain reason. **Pass bar:** both.
- **B6 (trailer).** `Release-note: <text>` serves that text for a commit whose subject would be held;
  `Release-note: none` puts a `feat` in behind the scenes; a trailer with dev text is held. **Pass bar:** 3/3.
- **B7 (shown once).** GET returns the note; POST seen; GET returns `null`; a newer note shows; POST on an
  unknown id is 404; a second POST is a no-op 200. **Pass bar:** all six.
- **B8 (visible failure, no silent catch).** A corrupt notes file: GET answers
  `{ enabled: true, status: 'unknown', note: null, reason }` and logs the error; the script's `--apply`
  over a corrupt file exits 1 and leaves the file as it was. **Pass bar:** both.

## RED

(filled in after the RED commit)

## GREEN

(filled in after the GREEN commit)
