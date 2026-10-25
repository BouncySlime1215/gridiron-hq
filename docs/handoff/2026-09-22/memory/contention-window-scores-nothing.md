---
name: contention-window-scores-nothing
description: Trade Lab's contention window (Win-now / Rebuild / Reset …) is copy, not a score — where it is produced, what consumes it, and the near-identical thing that DOES score.
metadata:
  type: reference
  modified: 2026-09-20T02:05:00.000Z
---

Line numbers pinned to `origin/main` at **791b131**.

**Produced** in `server/routes/tradelab.js`, inside `analyzeLeague` (`:98`), at
**`:182-190`** — `server/services/tradelab.js` does not exist, and the block is
not `:183-188`; both were miscited earlier and corrected by the Opportunity
thread. It writes `t.window = { label, stance }` from a market-capital x
core-age grid with `YOUNG = 25.5, OLD = 27.5` and seven label/stance pairs.

**It scores nothing.** All seven labels were grepped across `server/` and
`client/`: the only occurrence outside their own declaration is unrelated prose
in `db/seed/teams.js:44`. Nothing branches on the label, nothing weights a price
by it. It is copy and advice — which is why the honest fix for it is to change
what it *says*, never to gate an action on it.

**Consumed** by `trade-engine.js:1172` (`their_window: ctx.theirWindow ?? null`,
read at `:158` as `window: t.window`) and rendered at
`client/src/components/TradeCard.tsx:237`. The client type is
`client/src/components/trade/types.ts:129`.

**DO NOT CONFLATE IT** with the "post-loss window" in
`counterparty-pricing.js:87` / `:100` / `:261`. That one is a different concept
with the same word and it **does** score — it moves a counterparty's price. A
change aimed at one of these that lands in the other changes numbers while
looking like a copy edit.

**Fixed 2026-09-20 on `claude/project-thread-5f9c3y-window-honest`:** the
core-age axis is now gated on `isDynasty`, because four of the seven labels are
claims about next season and a redraft league has none — "Ascending — accumulate
youth, sell aging vets while they hold value" tells a redraft manager to trade
away the players who win him games this year. `isDynasty` is defined once, in
`format.js:62`, as `league_type === 'dynasty' || 'keeper'`; the gate reuses it
rather than inventing a second definition, and the same file already gates
`dynastyAgeAdjustment` on it (`tradelab.js:47`). `core_age` is still computed and
reported; `window.basis` now names which axes decided the label.

Still unbuilt: the window does not read O4's Team Outlook verdict (fine / watch /
act_candidate). `server/services/team-outlook.js` is **not on main** — it is on
`claude/project-thread-f921do-outlook-basis`, 8 new files, 0 modified, unmerged.

See [[feature-audit-shipped-prs-55-57]].
