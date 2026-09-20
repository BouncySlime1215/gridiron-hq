# A row's own availability basis — RED/GREEN evidence

`server/services/lineup-brain.js#playerAvailabilityBasis`,
`client/src/components/ui/BasisChip.tsx`,
`test/lineup-reads-its-own-league.test.js`, `test/glossary-and-basis.test.js`.

RED commit, GREEN commit, this file. The RED is real, not retroactive: the
three tests were written and committed failing before the implementation moved.

## Two wrong answers, one worse than the other

**On main**, `lineup-brain.js` stamped the **process** basis onto every row. The
process basis says whether the fit's tables are loaded. So a row read `role`
whenever they were — for a kicker the fit does not cover, for a player who fell
through to a durability number, for everybody. Six surfaces adopted the basis
chip in this stack, which means six surfaces were about to show a per-player
claim the server never made.

**On this branch before this commit**, that was replaced with prefix matching on
`availability_source`, the display sentence:

```js
if (text.startsWith('fitted availability by role')) return 'role';
```

Better, and still wrong. The sentence is copy. Rewording `'fitted availability
by role (…)'` in `contingency.js` — a display string, the sort of thing anyone
may improve — would have reclassified every fitted number on Start/Sit as a
hand-set one, with nothing failing anywhere.

## The order, which is the whole fix

1. **`availability_basis` on the row.** The server states it; nothing here
   second-guesses it. A value outside the served set is `unrecognised`.
2. **`availability_source`, the sentence, only when the row carried no basis
   field.** It survives as a fallback because `assetUniverse` is
   fingerprint-cached on the row counts and timestamps of the tables it reads,
   not on the code that built it — so a deploy does not invalidate a universe
   built before the field existed. A sentence this function has not been taught
   is `unrecognised`, not a guess.
3. **The process basis, last**, for a row carrying neither. That is what this
   page served before any of this and is never worse than it.

Written defensively on purpose: correct whether or not the row carries the
field, so it does not have to land in step with the service that serves it, and
this branch is not stacked on that one.

## `constants` leaves the vocabulary, and where it goes

The agreed set is `role`, `pooled`, `durability_prior`, `default_durability`
served, plus two arms the server never sends: `unfitted_position` (no
availability row at all — `weeklyAvailability` selects QB, RB, WR and TE only,
so every kicker and defence lands there) and `unrecognised`.

Both sentences that used to produce `constants` start from the player's own
durability number: `contingency.js:639` sets one of them **before any branch
runs**, and the hand-set chain never replaces it. So both map to
`durability_prior`. Nothing in this path can produce `default_durability`,
which is the blanket-constant case on a different path entirely — and saying so
is more useful than picking one.

## Amendment: the sentence alone does not buy "measured"

The first version of this mapped both durability sentences straight to
`durability_prior`. That is too strong. `durability_prior` claims a number
worked out from **this player's own record of turning up**, and the deployed
producer has a blanket-constant case on the same path that writes the same
sentence. A number that says "his own record" when it is one constant applied
to everybody is the overstatement this whole field exists to remove.

So the sentence alone now buys `unrecognised` — Unverified — and only an
explicit `durability_prior_measured === true` on the row buys the stronger
claim. Read strictly: `!== false` would make every row from the deployed
server, which carries no flag at all, into a measured one. Three mutations,
all red:

| Mutation | Result |
|---|---|
| an unflagged durability sentence claims a measured record | 8 pass / **1 fail** |
| a falsy flag is treated as present | 8 pass / **1 fail** |
| the flag is read loosely (`!== false`), so absent becomes measured | 8 pass / **1 fail** |

## Two absences, still not the same absence

`availability_source: null` means the player had no availability row:
`unfitted_position`. The **key** being missing means an old asset universe, per
(2) above. Reading the second as the first would label every player on the page,
quarterbacks included, as one the fit does not cover. The mutation that removes
that distinction goes red.

## The chip gains a seventh tier

`unrecognised` maps to a new tier, `unknown`, labelled **"Unverified"**. It is
not folded into `missing`, because `missing` says "there is no number" and here
there is one. Folding an unknown basis into its nearest neighbour is a wrong
claim that ships looking healthy — the same failure as the display sentence
outranking the served field, one layer out.

`--basis-unknown` (`#6b5f52`) is **warm** where `--basis-missing` (`#5c6461`) is
cool, and they are deliberately in the same family: both mean "we cannot source
this for you" and neither is a verdict about the team. The label carries the
difference a reader actually uses.

## `constants` is still mapped, on purpose

The old key stays in `AVAILABILITY_BASIS`. The server that emits it is what is
deployed; the one that emits the durability pair is not. Dropping the old key
would make every Start/Sit row lose its chip the moment this shipped ahead of
the service, and **a chip that vanishes is indistinguishable from a page that
forgot to check** — which is the state this whole redesign exists to end. It
goes when the new vocabulary is live. The test accepts either server
vocabulary and requires the chip to map both, and a mutation removing the old
key goes red.

## Mutation runs

Baseline across the three files: 28 tests, 28 pass, 0 fail. All eleven red.

| Mutation | Result | Caught by |
|---|---|---|
| the process basis is stamped on every row again | 26/**2** | served field wins; unknown is unrecognised |
| the display sentence outranks the served field | 27/**1** | served field wins |
| an unknown served value is folded into a durability number | 27/**1** | unrecognised, never a guess |
| an unknown sentence is folded into a durability number | 27/**1** | every source string maps to a basis |
| the durability sentences go back to `constants` | 27/**1** | every source string maps to a basis |
| `unfitted_position` and a missing key are conflated | 27/**1** | two absences are not the same |
| `unrecognised` is folded into the `missing` tier | 27/**1** | unrecognised is its own state |
| the old `constants` key is dropped before the new server ships | 27/**1** | every basis maps to a tier |
| `default_durability` is dropped from the map | 27/**1** | every basis maps to a tier |
| the `unknown` tier loses its distinguishing label | 27/**1** | unrecognised is its own state |
| `--basis-unknown` is removed | 24/**4** | four separate token guards |

The last one is the design system's own tests catching a missing token four
different ways, which is what they were written for: a `var()` naming a token
nobody defined resolves to nothing and the stripe silently disappears.
