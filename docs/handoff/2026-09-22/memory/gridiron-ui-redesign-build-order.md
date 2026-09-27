---
name: gridiron-ui-redesign-build-order
description: The Gridiron HQ UI redesign's build order, what shipped in each step, and the four findings that change what the approved model items can be.
metadata:
  type: project
  modified: 2026-09-20T02:00:35.825Z
---

The UI redesign Nick approved 2026-09-20 01:38Z. Proposal published as
`https://claude.ai/artifact/9ajVsBBoSZsKs6PbREZm4A` ("Gridiron HQ Redesign").
Owned by the UI thread (cse_012mJNcQKskfZmyq4qTmFqDe). Steps stack, each its own
branch and draft PR, head sent to the coordinator as it lands.

**Nick's words, verbatim, that the work is held against:** "I like what we have
rn but it's kinda shit. I want it to be way way way way way better." · "I also
like the ability to click into data and then see how that data was found etc.
you should add a deep dive into the stats but not new pages." · "keep the
explanations on stats explanations that make sense to someone who never deals
with stats. Detailed but not like wtf. Also normalize the names of the stats." ·
"don't make it seem like it's vibe coded... use a text that isn't normally done
by AI models etc. moving things, interactive actions etc" · "the page with the
teams is so fucked lol. No model stuff but the descriptions etc fucked."

## Steps

- **Step 0, design system. SHIPPED: PR #73, branch
  `claude/project-thread-xiezr0-design-system`, head 1fe949e off main 791b131.**
  `docs/design/design-system.md` + tokens in `client/src/index.css` + fonts in
  `client/index.html` + `test/design-system-tokens.test.js` (8 tests). Archivo
  width-axis display/body + Spline Sans Mono. Seven-step type scale. Six-tier
  basis colour ramp that never borrows `--good`/`--warn`/`--crit`. Motion
  tokens. **It EXTENDS index.css, does not replace it** — that file's existing
  token set is considered and was not re-decided.
- **Step 1, basis chip + glossary.** `client/src/lib/glossary.ts`,
  `client/src/components/ui/BasisChip.tsx`, `test/glossary-and-basis.test.js`,
  `docs/tdd/basis-chip-and-glossary.tdd.md`. Branch
  `claude/project-thread-xiezr0-basis-chip`.
- **Step 2, stat block + number roll.** `StatBlock.tsx`, `lib/useNumberRoll.ts`.
- **Step 3, deep-dive drawer.** Five layers. Built ON `Sheet` from
  DesignSystem.tsx, not beside it.

## Four findings that bound the work

1. **`client/src/components/ui/DesignSystem.tsx` is mostly orphaned.** 122 lines,
   ~16 exports, only three have a consumer: `Skeleton` (App.tsx),
   `ToastProvider` (main.tsx), `PageHeader` (DraftHub, LeagueHub). `Card`,
   `Section`, `StatTile`, `Confidence`, `Provenance`, `Distribution`,
   `DriverBars`, `Sheet`, `DataTable`, `EmptyState`, `ErrorState` have none.
   Plan: adopt or drop each as the redesign reaches its page, stated per PR.
2. **`Confidence` (:48) prints the word "Calibrated" from hard-coded thresholds**
   (coverage >= .78 "Calibrated", >= .65 "Developing", else "Low confidence")
   with no fit behind it. Unused today, which is the only reason it is not a live
   false claim. Not adopted. Routed to the model evidence audit.
3. **The teams page is hand-written editorial seed**, `server/db/seed/teams.js`,
   header says so: "Schemes/analyses are editorial seed content." 13 `TBD`
   strings, several reading "TBD (camp)" in week 2. Do NOT hand-edit 32 teams'
   prose — that is inventing facts. The fix is to label it as assumed and dated,
   and to give the page real model content (team tendencies + descriptive DvP).
4. **The nav is eight tabs and nine were deleted 2026-09-16 (commit 1694694).**
   Never rebuild a deleted page. See MEMORY.md.

See [[gridiron-model-items-what-is-buildable]] for the four approved model items.
