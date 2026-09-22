# The unresolved-receiver ratchet, and a report that invited a mistake

**Unit:** Wiring map. **Pre-registered in PR #129's body** as non-blocking
follow-up work; this is that follow-up.

## The problem, stated so it can be disagreed with

`unresolvedReceivers` reports every query run on a handle a file was **handed**
rather than one it opened. It exists because #129 changed the resolver to name
an unrecognised receiver instead of assuming the app — and that change trades a
visible false positive for an invisible false negative. Naming the receiver
reclassifies its tables to `table-in-another-database`, which the map grades as
`context`, and the gate prints grandfathered entries, refused entries, stale
entries and blocking findings but **never context**.

So the printed census was the entire safeguard. A census with nothing behind it
drifts: 19 today, 25 next week, and nobody can say which six are new. That is
the same argument `accepted_missing_feeds` was built on, so it gets the same
mechanism.

## Design decisions, and what each one refuses

**Keyed by file and receiver, never by line.** A line number moves on every edit
above it. A line-keyed baseline would fail builds for changes that touch nothing
it cares about, and that noise is how a ratchet gets deleted — and a deleted
ratchet is worse than no ratchet, because the list it leaves behind still reads
as a decision.

**A count per pair, not a bare pair name.** Otherwise a second unidentified
query in a file that already has one lands silently, which is most of the ways
this actually grows.

**Fails on new and on growth; reports shrinkage.** A pair that shrinks means
somebody resolved a handle, and now the baseline line is the thing that is out
of date. Failing there would punish the fix.

**Baselined at 19, not failed at 19.** A gate that is red the day it arrives
gets switched off. The specific bad outcome here is worse than that: the cheap
way to make a red build pass is to rename the parameter to `db`, which the
resolver maps to the app database by convention. That turns a reported unknown
into a **wrong answer**, which is the exact silence the rule exists to catch, so
the gate's own error message says not to do it.

**Not a "report, never gate" rule, unlike the stale-entry report.** The
difference is who the message is for. A stale accept-list entry is a note to a
human about a list humans maintain, and failing on it teaches people to delete
the entry. A new unresolved receiver is a new hole in the map's coverage that
arrived with somebody's code, in that same change, where it is cheapest to fix.

## RED

Commit `d05e3b1` — *test: RED — pin the unresolved-receiver ratchet and the
pre-registered entry*. **13 tests, 13 failing.** `receiverRatchet` and
`receiverKey` did not exist; `staleOrphanEntries` took no `preRegistered`
predicate and returned no `kind`.

The assertion that names the point, inline:

```js
test('a new site in a file that already has a baselined receiver still blocks', () => {
  const r = receiverRatchet({
    found: [site('a/b.js', 1, 'rdb'), site('a/b.js', 77, 'rdb')],
    baseline: { 'a/b.js rdb': 1 },
  });
  assert.deepEqual(keysOf(r.blocking), ['a/b.js rdb']);
});
```

and its opposite, which is what keeps the thing usable:

```js
test('a line number moving does not block', () => {
  const r = receiverRatchet({ found: [site('a/b.js', 4000, 'rdb')], baseline: { 'a/b.js rdb': 1 } });
  assert.deepEqual(r.blocking, []);
});
```

## GREEN

`receiverKey`, `receiverRatchet` and the `preRegistered`/`kind` extension to
`staleOrphanEntries` in `scripts/wiring-map.mjs`, wired into `--check`, with the
baseline in `docs/wiring/annotations.json`. **13/13 pass. 33/33 across the three
wiring-map test files that touch these functions.**

## The contradiction test (R32-R33)

A zero or a success out of a bespoke check proves nothing until that check has
been seen to produce a non-zero on a case that should produce one. Both halves
were observed on this tree, in this order:

1. **Known-nonzero first.** With the ratchet wired and `annotations.json` not
   yet carrying a baseline, `node scripts/wiring-map.mjs --check` **exited 1**
   and printed exactly the four pairs it should:

   ```
   4 NEW quer(ies) on a receiver this resolver cannot identify.
     "scripts/run-historical-leaderboard.mjs rdb": 8   (baselined 0)
     "server/services/td-features.js appDb": 5   (baselined 0)
     "server/services/td-features.js nflDb": 2   (baselined 0)
     "test/model-registry-persistence.test.js upgradeDb": 4   (baselined 0)
   ```

   8 + 5 + 2 + 4 = 19, which is the census count, so nothing was dropped
   between the two.

2. **Then the zero.** With those four lines in `accepted_unresolved_receivers`,
   the same command **exits 0** and still prints all 19 sites in the census.

The exit 0 is therefore a measurement and not an absence of wiring.

## The second half: a report that invited a mistake

`staleOrphanEntries` reports an accept-list entry naming a file that is not in
the tree. One of those entries is **deliberate**: `server/services/cascade-grade.js`
is pre-registered for PR #72, and `_PERMANENT_ORPHAN_REASONS` carries its
reason, its owner and its retirement condition in full.

The report printed the same sentence for it as for a genuinely rotted entry, and
the obvious reading of that sentence is "delete this line" — which would undo a
correct decision. **This is not hypothetical: I wrote exactly that instruction
into this thread's handoff document, as a ten-minute task for whoever picked the
thread up cold, and only caught it when I opened the file to do it.** Deleting a
correct entry looks exactly like tidying up.

So the report now reads `PRE-REGISTERED` out of the reason text and labels the
two cases apart, with a count of each in the header:

```
2 accept-list entr(ies) name a file this run cannot square with the tree
(1 to look at, 1 pre-registered and correct).
  [pre-registered] server/services/cascade-grade.js — names a file that is not in this tree yet …
```

## Known limit, recorded rather than fixed here

`DB_RECEIVERS` maps a receiver literally named `db` to the app database by
convention. A file that opens a **second** database into a local named `db` and
also imports the app's database module resolves to `app`, and every table it
touches is then reported as an app table nothing writes. The Coach thread hit
this on 2026-09-22 — a private chat corpus in a local `db`, ten false findings —
and worked around it by renaming the local to `chatDb`, which is the codebase
bending to the tool.

`foreign.has(name)` is meant to catch that case and did not, so the defect is in
how foreign handles are collected, not in `DB_RECEIVERS`. It is noted at the
declaration and is the next unit for this thread. It is deliberately **not** in
this change: it needs the collector investigated, and this ratchet should not
wait on it.

## Five questions

1. **Well built?** Yes, with one caveat stated above. The mechanism is pure,
   exported and tested against deliberate breakage rather than only against its
   happy path, and it was observed failing before it was observed passing.
2. **Stats or made up?** Neither — this is a count, not an estimate. 19 sites
   across 4 pairs, printed by the tool, summing to the census it was derived
   from.
3. **How we know.** The contradiction test above: exit 1 with the four pairs
   named before the baseline, exit 0 with it, on the same tree. 13/13 unit
   tests, 33/33 across the affected files.
4. **Pointed anywhere else?** Yes. Every table in the map that is read only
   through an unidentified handle is filed under another database and is
   invisible to the missing-feed rules. That is the class of silence that took
   `play_by_play` and `pbp_participation` through two different wrong answers in
   one week. The census is what makes it visible; this is what keeps it honest.
5. **How it unifies.** It puts the resolver's ignorance under the same
   discipline as the repository's other debt: an owner, a retirement condition
   that is a result rather than a date, and a build that fails on the next one
   rather than on all of them.
