# A destructured parameter with a default was not counted as a read

RED `848bda2` and `cb614e2` · GREEN this commit · `scripts/wiring-map.mjs`, `test/wiring-map.test.js`

## What was wrong

`keyReads` decides whether a key is read anywhere. Its destructuring branch
read each part of `{ … }` like this:

```js
const name = part.trim().split(':')[0].trim();
if (/^[A-Za-z_$][\w$]*$/.test(name)) reads.add(name);
```

Two shapes fell through it, and both are the ordinary way this repository
writes an options bag:

1. **A default value.** `calibrationPassed = false` splits on `:` to itself,
   fails the bare-identifier test, and is dropped.
2. **A bag that is not the first parameter.** The pattern required `const`,
   `let`, `var` or `(` immediately before the brace, so
   `horizonWeights(week, { regularSeasonEnd = END })` matched nothing at all.

Every optional field of every options object in the repository therefore read
as unread.

## How it was found

Not by inspection. `composedKeysNeverRead`, added in the same branch, reported
`calibrationPassed` (`server/routes/nfl-betting.js:983`) and `regularSeasonEnd`
(`server/services/trade-horizon.js:62`) as keys nothing reads. Both are read,
at `server/services/staking.js:321` and `server/services/trade-horizon.js:81`
respectively — as destructured parameters with defaults.

That is the shape this project keeps hitting: a true-sounding finding with a
false mechanism, where the checker's blind spot is doing the talking. The new
rule's first two false positives came from an old helper, not from the rule.

## The fix, and what it deliberately costs

```js
const name = part.trim().split(':')[0].split('=')[0].trim();
const RE_DESTRUCT = /(?:const|let|var|[(,])\s*\{([^{}]*)\}\s*(?:=|\))/g;
```

Allowing `,` also counts the keys of an object **argument** — `f(a, { k: 1 })`
— as reads. That is not new: `(` already did it for a first-position argument.
It is accepted on purpose. This helper is generous in one direction only, and
the direction matters: an over-counted read silences a finding, an
under-counted one calls live code dead. This repository has made the second
mistake three times in one day at three different granularities, and none of
the first.

## Effect on the map

Nothing else moved. `field-attached-never-read`, the only other rule built on
`keyReads`, is unchanged at its previous count; the whole measured effect is
that `composed-key-never-read` went from 24 findings to 22, removing exactly
the two false positives above. Measured on `--out` runs, which apply no
annotations; see the note in `docs/tdd/composed-key-never-read.tdd.md` on why
a scratch run and the committed artifact are not comparable.

## Defect injection

Tree sha256 is the first 16 hex of `sha256sum scripts/wiring-map.mjs`.
Baseline green `3905215b60391a89`, 88 pass / 0 fail on `test/wiring-map.test.js`.

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| K1 | restore the old split, so a default value swallows the key | `ade1fbadd4bbfad8` | KILLED 86/2 | *keyReads sees a destructured parameter that has a default value*; *…that is not the first parameter* |
| K2 | restore the old prefix, so a bag must be the first parameter | `6cfa799dc5a63d2c` | KILLED 87/1 | *keyReads sees a destructured parameter that is not the first parameter* |
| K3 | take the LOCAL binding instead of the source key (`a: b` reads `b`) | `2a0fdbe797775d92` | KILLED 87/1 | *keyReads sees a destructured parameter that has a default value* |
| K4 | control, one word of the comment above the pattern | `e8877ef9df9f7d2c` | SURVIVED 88/0 | — |

K3 is the injection worth keeping. `{ alias: bound = 3 }` reads `alias` from
the object and binds it locally as `bound`; a rule that recorded `bound` would
add a key the object does not have and lose the one it does. The test asserts
both halves.

## The five questions

**Well built?** A three-line fix to one helper, with the two shapes it missed
pinned as behaviour, and the third shape it must not confuse (source key vs
local binding) pinned alongside them.

**Stats or made up?** Measured. 24 findings before, 22 after; two false
positives removed; every other rule's count identical across a full
`node scripts/wiring-map.mjs` run before and after.

**How do we know?** `node --test test/wiring-map.test.js` — 87/1 at RED
`848bda2`, 87/1 at RED `cb614e2`, 88/0 at GREEN. Whole tree: `npm run check`
exit 0, `npm test` 3104 / 3063 / 0 fail / 41 skipped on tree `df1ca9cf`, pinned
either side. Three injections killed with
the killing test named, one control survived.

**Pointed anywhere else on the platform?** Yes. `keyReads` also feeds
`field-attached-never-read`. That rule's count did not move here, which says
its findings never depended on an options bag — but any future rule built on
`keyReads` inherits the fix.

**How does it unify?** The map's worth rests on nobody switching it off. A
helper that quietly drops a whole syntactic form is how a checker earns a
reputation for crying wolf, and it was found only because a new rule leaned on
it hard enough to expose the gap.
