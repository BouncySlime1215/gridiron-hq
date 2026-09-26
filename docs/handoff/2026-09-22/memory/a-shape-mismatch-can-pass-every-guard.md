---
name: a-shape-mismatch-can-pass-every-guard
description: Two modules agreed a rule existed and disagreed on its shape; the consumer's arity guard passed on 0 === 0 and fell through to a fallback that read as success, so every table reported fresh — check what a guard does when BOTH sides are empty.
metadata:
  type: feedback
---

When a producer and a consumer disagree about the **shape** of a value rather than its
presence, the failure usually does not throw. It reads the missing keys as undefined,
normalises them to empty, satisfies every check written for the shape it expected, and
lands on whatever the code does when there is nothing to do. If that default is a
fallback that reads as success, the surface now lies with full confidence.

**Why.** 2026-09-22, `data-freshness.js`. `servedTables()` emits each rule as
`{ sql, params, text }`; the consumer was written against `{ predicate, bind,
description }`. Five lines, no error:

```
rule.predicate -> undefined -> predicate = ''
rule.bind      -> undefined -> bind = []
placeholders (0) === bind.length (0)   <- the arity guard PASSES
predicate falsy -> currentCount = row_count
row_count > 0   -> status = 'fresh'
```

Every table holding a row reported current, whatever season those rows were from, and
`stale` became unreachable. The sharp part: with the FALLBACK registry the same data
read `stale`, correctly — so merging the real registry first would have made the light
**less** truthful than having none, at the moment the feature looked finished.

**How to apply.**

1. **Ask what each guard does when both sides are empty.** An arity, length or
   equality check between two derived values passes trivially when both derive to
   nothing. That is the state a shape mismatch produces, so the guard written to catch
   malformed input is exactly the one that waves it through.
2. **Never let "nothing to check" share an outcome with "checked, fine".** Give the
   unaskable case its own value — here a fourth status, `unknown`, with a note naming
   the reason. Then verify the aggregate fails closed: `all_fresh` was
   `every(t => t.status === 'fresh')`, which already excluded it, but that has to be
   read, not assumed.
3. **Test the shape the producer actually emits**, copied from the producer, not the
   one the consumer's own fixtures use. The consumer's fallback registry had made
   every existing test pass for two commits.
4. **Say the merge order out loud on the PR.** A consumer fix and a producer that
   needs it are one change split across two branches; the producer landing first is
   the silent-total-failure case. See [[gridiron-merge-order-86-before-96]].

Same family as [[a-guard-undone-by-a-later-line]] and
[[assertion-must-name-the-thing-it-guards]]: the check ran and proved nothing.
