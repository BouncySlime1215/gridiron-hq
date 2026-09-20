# Deep-dive drawer — TDD evidence

Retroactive RED by mutation, the shape set by `docs/tdd/week2-numbers.tdd.md`
and followed by the two steps before this one.

## What is guarded, and the one rule that matters most

Nick asked for this in his own words: "I also like the ability to click into
data and then see how that data was found etc. you should add a deep dive into
the stats but not new pages. Just like flex our model when I click into
something."

Five layers, in the order a manager actually asks them:

1. What is this? — the glossary sentence
2. What went into it? — the inputs, each with its own basis
3. How was it worked out? — the method, in a sentence
4. **How well does it do?** — what it was tested on, and what it failed
5. Where does it come from? — the raw field, as a footnote

**Layer 4 is the reason this is worth building and the one that will be tempting
to drop.** A drill-down that only explains how a number is constructed is
advertising. This app has numbers that were tested and failed:
`matchups.js:28-63` records a pre-registered out-of-sample test where every
defence-vs-position multiplier came out *worse* than no adjustment (2025 MAE
+0.0007, CI [-0.0021, +0.0035]; at the old K=12, +0.0072 in-sample), which is
why every multiplier in that file is hard-coded to 1 with `signal: false`. A
panel that shows that history without the sentence saying it did not predict is
worse than a panel that shows nothing.

So layer 4 cannot be silently omitted. `undefined` means the caller forgot;
`null` means the caller is stating it was never tested. Those are different, and
only the second is allowed to be quiet — it renders "This number has never been
tested against a season it was not built on. Read it as the model's opinion, not
as a measurement."

Layer 2's rule is the second one: every input carries its own basis, because a
measured number built from three assumed ones is not a measured number and this
is the only layer that can say so.

## Adopting `Sheet` rather than writing a second overlay

`Sheet` in `DesignSystem.tsx` already had Escape, a backdrop click and
`aria-modal`, and had **no consumer at all**. Building a second overlay beside it
is how two overlays end up disagreeing, so this is built on it and its two gaps
are fixed there:

- **No focus trap.** One Tab past the last control landed on the page behind an
  `aria-modal` overlay — invisible focus, and a keyboard user is lost with no
  way back.
- **No scroll lock.** A wheel or a swipe over the backdrop scrolled the page
  underneath, so a manager closed the panel and found themselves somewhere else.
  The lock restores whatever the page had rather than assuming `visible`, so two
  overlapping overlays cannot leave the page stuck.

Focus *restore* is deliberately not in `Sheet`. It belongs to whatever opened
the panel, which is the only thing that knows where the manager was looking, so
`DeepDive` does it — and checks `document.contains` first, because focusing a
removed node drops a keyboard or screen-reader user at the top of the document.

## The mutations

Each reverts one rule in the shipped source, runs `test/deep-dive.test.js`, and
is restored. Control after restoring: **8 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| p1 | Make layer 4 skippable like the optional layers | **7 pass, 1 fail** |
| p2 | Make an input's `basis` optional | **7 pass, 1 fail** |
| p3 | Remove focus restore on close | **7 pass, 1 fail** |
| p4 | Remove the focus trap from `Sheet` | **7 pass, 1 fail** |
| p5 | Make the scroll lock assume `visible` instead of restoring | **7 pass, 1 fail** |
| p6 | Open all five layers at once | **7 pass, 1 fail** |
| p7 | Drop the reduced-motion guard on the layer reveal | **7 pass, 1 fail** |

p1 is the one that would ship. Nothing about it looks wrong in a diff: it reads
as tidying an optional prop, and the result is that every untested number in the
app silently loses the sentence saying so.

## Honest limit

`node:test`, no DOM. These read source text, so what is pinned is what the files
say. The focus trap in particular is asserted to exist, not asserted to work —
verifying that needs a browser, and there is no such harness in this repository.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/deep-dive.test.js
```
