---
name: gridiron-author-is-the-worst-reviewer
description: On 2026-09-19 every correction to the Gridiron HQ wiring checker came from another thread running it against their own tree — none from the author reviewing their own output.
metadata:
  type: feedback
  modified: 2026-09-19T22:20:00.000Z
---

**A thread is the least reliable reviewer of its own tool.** Five defects were
found in `scripts/wiring-map.mjs` on 2026-09-19. Not one was found by the thread
that wrote it re-reading its own output:

- **Opportunity thread** — the "never baseline this rule" block sat *inside*
  `annotations.json`, the file the check reads, so the edit that wants a rule
  quiet could delete the guard. Moving it into source then revealed the rule was
  **already baselined** by the author, twenty lines from the guard.
- **UI-rebuild thread** — four unrouted page components. The map had found all
  four and buried them among throwaway scripts: present and useless.
- **Feature-audit thread** — the "ESPN limit 800" note in an annotation
  conflated two unrelated fetches, and a reader list the author had copied from
  another thread without opening the line (`draft-assist.js:590` is a provenance
  label string, not a query).
- **Fantasy-plan thread's #42** — running the checker against *unlanded* work
  exposed a false `table-never-written` on three tables whose writer was sitting
  in the repository. A module wrapping its foreign DB handle in a local helper
  defeated handle attribution.
- **Nick, asking the plain question** "has it been run against a deliberately
  broken tree" — which found that a new module imported by a TEST failed the
  build while one imported by NOTHING AT ALL passed. The worse case was the one
  getting through, for hours, in a tool built to catch exactly that.

**Why:** the author's mental model built the tool and the review. Both share the
same blind spot, so re-reading confirms rather than tests. This is the same
defect as [[gridiron-cite-the-ref-with-the-line]]'s checker-derives-its-own-
expectation case, one level up: the reviewer derives their expectation from the
thing being reviewed.

**How to apply:**
1. **Run a new check against another thread's unlanded branch before landing it.**
   Cheapest single step here; it found two defects in one run. A throwaway
   `git worktree add --detach` plus a merge does it in a minute.
2. **Break it on purpose, in the specific ways a sceptic would name.** Reading it
   never finds the case built on the same assumption as the check. Of three
   cases named on 2026-09-19, one was caught, one had no rule, one reported the
   problem three ways and gated on none.
3. **Announce a new unwired surface before it lands**, so the check meets it
   live rather than retrospectively.
4. **A printed limit is not a fix.** The handle-attribution limit printed on
   every run all evening and still did not stop the wrong answer. Prefer an
   inference that cannot produce the wrong answer over a warning that asks the
   reader to be careful.
5. **Ask for the check-in question in plain words.** "Did you test it broken?"
   found more than any amount of re-reading.

6. **A real measurement does not license the conclusion attached to it.** Two
   errors on 2026-09-19 had one shape. I measured a genuine main-thread block
   and attributed it to the cause recorded for the previous build, without
   checking that the cause was reachable — my own timeline refuted it and I
   had written both numbers down. Then I reported the gaps between the restarts
   I happened to observe as the restart cadence; sampling at a quarter of the
   rate, I was describing the spacing of my own probes. Both times the
   observation was sound and the sentence built on it was not. Say what was
   measured and what was inferred in separate sentences, and a reader can catch
   the second without doubting the first.

See [[gridiron-wiring-map]], [[gridiron-availability-constant-0-92]],
[[gridiron-checker-template-literal-blindness]] and
[[gridiron-league-history-name-collision]].
