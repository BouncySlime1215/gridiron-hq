---
name: client-surfaces-after-nine-tabs-removed
description: Nick had nine tabs and all four betting page trees deleted from the UI on 2026-09-16, so any plan naming Home, Data Health, Players, Trends or a betting page is planning against a tree that no longer exists.
metadata:
  type: project
---

Commit **1694694** in the 2026-09-19 train: "UI: nine tabs removed, every
backend kept, and the league chat pull added". It quotes Nick, 2026-09-16:

> get rid of the players, Command center, the League brain, and trends,
> matchups, the model, accuracy and experiments, data health, and the UI for
> all 4 betting tabs - keep the actual models of course.

**Deleted pages** (do not plan work against these): `Home.tsx` (the Command
Center; `/` now redirects to `/league`), `DataHealth.tsx`, `Players.tsx`,
`LeagueBrain.tsx`, `Trends.tsx`, `TheModel.tsx`, `NflMarketBoard.tsx`,
`FantasyLab.tsx`, and every file under `pages/betting/` and `pages/props/`.
`PlayerDetail.tsx` is **kept** — other pages link to individual players.

**Nothing under `server/` was touched.** Every model, service, scheduler job
and route survives and is reachable. `GET /dev/sources`, the freshness registry,
is one of them: it has **no page in front of it**. The commit states that a
route with no page is the intended end state, not an oversight.

**The surviving nav, eight destinations** (`client/src/navigation.ts`):
My team — League Hub, Start/Sit, Trade Lab, Trade Brain, Draft.
Intelligence — News, X's & O's. Setup — Settings.
League Hub is a tab shell over `MyTeam.tsx` and `Leagues.tsx`.

## Why this is worth a memory file

The UI-rebuild thread's whole plan was written against ffe4e72 and named
`Home.tsx`'s freshness card and `DataHealth.tsx` as two of its five pieces.
Both had been deleted, on Nick's own instruction, three days before the plan
was written. Re-taking the inventory after the merges is what caught it.

**The rule:** before planning UI work, list `client/src/pages/` on the tree you
will actually branch from. A deleted page and a page you have not read look
identical from a summary.

**And the judgement that goes with it:** a goal can survive the deletion of the
screen that served it. Freshness still matters with Data Health gone; the answer
is to re-home it (Settings is the natural place) or drop it — never to quietly
rebuild the page the user asked to remove. That is a question for the user, not
a default to pick.
