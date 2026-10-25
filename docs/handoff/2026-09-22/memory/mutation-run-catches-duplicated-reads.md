---
name: mutation-run-catches-duplicated-reads
description: A surviving mutation usually means a second copy of the code answered correctly — check for a duplicated query or helper before assuming the test is weak.
metadata:
  type: feedback
  modified: 2026-09-20T03:17:27.665Z
---

On 2026-09-20 a mutation injecting `MIN` for `MAX` into an `as_of` read
**survived** a suite that looked like it guarded the rule.

**Why:** two exported functions each held their *own copy* of the same two
queries. A string replace hit the first copy; every assertion in the suite ran
through the second, which still answered correctly. The rule was guarded
against a *hand* edit and not against the real risk, which is the two copies
drifting.

**Why it matters:** the first instinct on a surviving mutation is "the test is
too weak, add an assertion". That is only half right here. The survival was
evidence of a **code** defect — a duplicated read — and adding an assertion
without deduping would have left the drift in place.

**How to apply:**
1. When a mutation survives, first ask *which copy did I mutate, and is there
   another one?* `grep` the mutated line's distinctive text and count matches.
2. Dedupe into one function, then re-run: the same mutation should now be
   caught by the tests that already existed.
3. Add a mutation that **re-introduces the duplication** (inline the helper
   back into one caller with a wrong operator). That is the regression test for
   the dedupe itself.
4. Separately, check whether the *direct* entry point has any assertions of its
   own, or whether every test reaches it through a wrapper. It was the wrapper
   that was tested; the exported function was not.

Also from the same run: assert the scope a field actually has. A per-member
assertion on a league-season-scoped count failed the code for being right. Fix
the test, and keep a second fixture (an empty league-season asserting 0) as the
discriminator so the assertion still has teeth.

Related: [[archetype-card-provenance]], [[gridiron-failure-modes]].

---

**A REGEX ALTERNATION IN AN ASSERTION IS USUALLY A TEST THAT HAS NOT DECIDED
WHAT IT IS CLAIMING (2026-09-20, adopted into the evidence standard).**

Three separate files, three separate parts, each found only by mutation and
never by reading the test:

- `/gateway|Jev/` on `WHY_UNSCHEDULED` — deleting "calls a paid gateway per
  manager" passed on the surviving word "Jev", so the claim the constant exists
  to make (the pass *costs money*, which is why a timer is wrong) was guarded
  by nothing.
- `/Mac|Apple Messages|not on this machine/` on the credibility reason —
  deleting the disambiguating clause passed on "Apple Messages" in the clause
  before it, leaving the finding that an empty credibility map otherwise reads
  as "he has never called a player untouchable".
- `/064|migration/i` on `LEAGUE_HISTORY_SOURCE` — deleting the migration half
  passed on the word "migration" surviving in the sentence about the script.

**How to apply:** each branch of an alternation becomes its own assertion with
its own message. If two phrasings are genuinely interchangeable, the test does
not care about either and should assert the fact they share instead.

**AND CHECK THE REPLACEMENT AGAINST THE WHOLE STRING, then re-run the
mutation.** A fourth case, 2026-09-20: splitting `/cloud box|laptop/` into a
"where you are" half and a "what to do" half, the second written `/laptop|Mac/`
— which still passed, because *"not the Mac"* in the first sentence matched it.
A split a neighbouring clause can satisfy is not a split. The working version
asserts the ACTION (`/pull|upload/`), the thing that actually disappears when
the actionable sentence does. Never accept a split verified only by reading;
re-run the same mutation and watch it fail.

**The neighbouring trap, from the same run.** A mutation that PRESERVES the
guarantee is not evidence of a weak test. One retarget left a sentence reading
"...and cannot be produced here", which still satisfied the strengthened
assertion — correctly. Check what the mutated text actually says before calling
a survival a finding.

**And: a row is only evidence if the suite it ran is the suite that asserts the
rule.** Three mutations were pointed at the wrong suite and read as survivors.
A runner should fail a row whose suite contains no test touching the mutated
export. See [[evidence-standard-mutation-rows]].
