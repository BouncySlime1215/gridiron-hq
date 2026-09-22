# TDD evidence: an unreadable career layer is not "no NFL record"

**What this is.** `playerEvidence()` (`server/services/trade-engine.js`) wraps
each of its three evidence sources in a bare `catch` and leaves the field
absent on a throw. That degradation is deliberate and documented on the
function ("Every layer is optional... so the engine behaves exactly as before
on a database that has no play-by-play history or no fitted model"), and for
*pricing* it is correct — `value`, `adj_ppg` and every lineup number are
untouched either way.

The defect is what the **text** does with that absence. `playerRiskProfile()`
reads an absent career as `seasons = 0` and assigns `profile: 'unproven'`;
`describeProfile()` renders that as **"a player with no NFL record"** and
`packageNumbers()` as **"0 seasons on record"**. Both are positive factual
claims about the player, and they are reached whenever the career source
*throws* — a broken query, an unmigrated table, a fault in
`player-career.js` — not only when the player genuinely has no record. The
user reads that sentence inside a trade verdict, where the whole point of the
line is "you are trading a 5-year top-12 floor for a 1-season spike".

This is CLAUDE.md's named failure shape exactly: *"No bare `catch {}` that
swallows a fault — this project has shipped two real bugs of exactly that
shape, where a silent catch deleted a whole data layer and the page kept
printing numbers as if nothing had happened. If a layer goes inert, the
surface must say so."*

**Measured before fixing**, against this session's offline rig, through the
public API only:

| player | career source | `headline_read` |
|---|---|---|
| Real Veteran | returns a 5-season record | `a 5-of-5 top-24 floor` |
| Genuine Rookie | returns `null` (correctly, no record) | `a player with no NFL record` |
| Real Veteran | **throws** | `a player with no NFL record` |

The third row is the bug: byte-identical to the second, with
`profile: 'unproven'`, `seasons: 0`, `top24: 0` on a five-year starter.

**RED**, commit `1c0b93f`: `test/trade-engine-evidence-fault.test.js`, six
cases through `_setEvidenceSources` (the file's own hook for simulating a
missing layer). Three fail against the pre-fix function — the three that
require the fault to be distinguishable — and three pass, pinning the honest
cases so the fix cannot buy the distinction by breaking them.

**GREEN**, commit `bcd6fb2`:
- `playerEvidence()` records `evidence_unreadable: ['career' | 'preseason' |
  'offseason']` for the layers that threw. The fields stay absent, so pricing
  degrades exactly as before; only the lost distinction is restored.
- `playerRiskProfile()` returns `profile: 'unknown'` when the career layer is
  unreadable, checked before the `!seasons` branch.
- `describeProfile()` → "a player whose record could not be read";
  `packageNumbers()` → "record could not be read".

6/6 pass. The five existing test files that touch these symbols
(`trade-evidence`, `model-integrity`, `betting-fantasy-link`,
`lineup-evidence`, `nfl-execution-edge`) run 155/155 green with the new file.

**One existing test was changed, deliberately.**
`test/trade-evidence.test.js` asserted `playerEvidence(1)` deep-equals `{}`
with a throwing source, under the name "a throwing source is **swallowed**".
That assertion pinned the swallow itself — the behaviour CLAUDE.md forbids and
the behaviour measured above to state a falsehood — so per CLAUDE.md's "fix
the implementation, not the test, **unless the test is wrong**", it was wrong.
The property that test exists to protect is untouched and still asserted: a
failed layer never moves ppg, value, score or verdict, and never adds its own
field. Only the "and nobody is told" half changed.

**Five questions**
1. Well built? Yes — the fault is recorded at the one place it is currently
   destroyed, and every consumer of the distinction reads it from there. No
   new data, no new query, no pricing change.
2. Stats or made up? Not a model change. `evidence_unreadable` is a fact about
   whether a call threw.
3. How we know: the three-row table above, measured through the public API
   before any code changed; then RED 3/6 failing, GREEN 6/6, and 155/155 on
   every existing test file that touches these symbols.
4. Pointed anywhere else? `playerEvidence` feeds `slim()`, so every outgoing
   player object carries the flag and any future consumer can read it. This
   unit changes only the two strings named above; other readers of
   `profile === 'unproven'` (if any are added later) now have a distinct state
   available rather than a conflated one. The `preseason` and `offseason`
   layers record their faults too, but no surface currently conflates those
   with a claim, so nothing downstream of them changed.
5. How it unifies: third instance this session of the same discipline — state
   the absence rather than guess through it (`offense_pct` measured and left
   alone, `football-context.js:93` traced and found inert, `availabilityPicture`
   fixed in #115). This is the same fix as #115 one layer deeper: there an
   empty table read as "healthy", here a thrown query reads as "never played".
