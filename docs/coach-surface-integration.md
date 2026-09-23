# Where Coach opens, and what each tab hands it

For the UI thread, before the panel is built. Written 2026-09-20 against
`claude/coach-grounded-4l8hno-hold` at `f5406ee`. Every file and line below was read in
that tree.

## The one decision that shapes everything else

**Coach mounts once, at the App.tsx root layout, and pages register context. It is not
a component a page renders.**

That is how `PageExplainAssistant` already works (`client/src/App.tsx`, mounted at the
root layout), and it is right for the same reasons: the panel survives navigation, its
conversation is not torn down when the user moves from Start/Sit to News mid-question,
and a page cannot forget to include it.

**Do not build a second context provider.** `usePageExplain(section, subview, summary,
eventContext)` in `client/src/components/PageExplainContext.tsx` already carries exactly
the shape Coach's endpoint wants, and four pages already call it. Coach's
`POST /api/coach/ask` takes `{question, context, league_id}` where `context` is a free
object; pass `{route, section, subview, summary, eventContext}` straight from the
existing hook. Two registration mechanisms for the same fact would drift within a week,
the way `NAV_GROUPS` and the palette's `DESTINATIONS` did before `navigation.ts` merged
them.

Two things about `context`, both enforced server-side:

- It is **context only, never evidence**. The system prompt says so and the grounding
  check backs it: a number that appears only in `context` and in no retrieved row is an
  `ungrounded_number` violation and the claim does not ship. So a page can hand Coach
  what is on screen without that becoming a source Coach can cite.
- It is capped at **16,000 characters** (`server/routes/coach.js:34`). Register the
  small honest summary the page already has for its own rendering, not the API payload.

The launcher itself is the same affordance on all eight tabs — one control in the root
layout, `⌘K`-adjacent, opening the panel over the current page. The per-tab work is the
context below, not eight launchers.

## The eight tabs

Nav is `client/src/navigation.ts#NAV_GROUPS`. Four of the eight already register; four
do not, and today those four get the honest "this page has not told me what is on
screen" fallback.

| Tab | Route → page | Registers today | What to hand Coach |
|---|---|---|---|
| League Hub | `/league` → `pages/LeagueHub.tsx` | **no** | `section 'league hub'`, `subview` = the `view` state (`team` \| `connections`), summary `{league_name, league_id, season, week, roster_size, last_synced, leagues_connected}` |
| Start/Sit | `/lineup` → `pages/Lineup.tsx:64` | yes | already correct — week, objective, projected points, coin flips, slot count, warnings, `chance_to_play_degraded`. No change needed. |
| Trade Lab | `/trade-lab` → `pages/TradeLab.tsx:66` | yes | already correct — tab, team selected, roster size, untouchable count. Add the player ids in view when a target tab is active, as `eventContext`, not `summary`. |
| Trade Brain | `/trade-brain` → `pages/TradeBrain.tsx` | yes | already correct. |
| Draft | `/draft` → `pages/DraftHub.tsx` | partly — `LiveDraft.tsx` registers, the hub does not | register on the hub too: `section 'draft'`, `subview` = `view` (`mock` \| `survival` \| `live` \| `recap`), summary `{league_id, seat, teams, rounds}` |
| News | `/news` → `pages/News.tsx:286` | **no** | `section 'news'`, `subview` = `view` (`log` \| `feed` \| `signals`), summary `{team_filter, items_shown, date_range, verified_signals, extractor_last_run}` |
| X's & O's | `/teams` → `pages/Teams.tsx`; `/teams/:abbr` → `pages/TeamDetail.tsx` | **no** | index: `section "x's and o's"`, summary `{teams_listed}`. Detail: `subview 'team'`, summary `{team, season, is_prior_season, weeks_measured, identity_markers}` and `eventContext {team, season}` — `teamTendencies` already returns every one of those (`server/services/nfl-team-tendencies.js:171-180`) |
| Settings | `/settings` → `pages/Settings.tsx` | **no** | `section 'settings'`, summary `{leagues_connected, espn_connected, chat_pull_configured}`. Lowest value of the eight; do it last. |

`/players/:id` (`pages/PlayerDetail.tsx`) is not a nav tab but is where most player
questions will actually be asked. Give it `eventContext {player_id, name, position,
team}` — that is what lets Coach query the right rows instead of matching on a name
string.

## What Coach can answer on each tab today

This matters for the panel's empty state: suggest questions Coach can actually stand up,
not ones it will refuse. Coach has seven tools — `catalog_lookup`, `sql_select`,
`compute`, `who_plays`, `team_tendencies`, `coaching_profile`, `football_context` — over
34 catalogued tables.

- **Strong now:** X's & O's (`team_tendencies` and `coaching_profile` are exactly the
  scheme and identity questions), Start/Sit (`who_plays` answers availability with its
  sources), any player usage question anywhere (`player_week_usage` via `sql_select`).
- **Weak now:** News (the news tables are not all catalogued yet), Draft (no draft tool),
  Settings (nothing to ask).

A question Coach cannot answer comes back as a refusal naming what it does not read,
which is a correct answer rather than a failure — but an empty state that suggests one
is a bad first impression.

## The contract the panel renders

Types are already written: `client/src/components/coach/coach.types.ts` on the hold
branch. Everything else under `components/coach/` is the UI thread's.

- `POST /api/coach/ask` with `Accept: text/event-stream` streams the real trace and ends
  with a `result` event carrying the same JSON the plain POST returns. Events, in order:
  `understood`, `planning`, `query` (`running` then `done`, with row counts and tables),
  `computing`, `refused`, `drafting`, `checking`, `rejected`, `answer`.
- **The trace is the thinking animation.** Nick asked for one; this is a real account of
  what happened rather than a spinner, and it reads well — "reading player_week_usage,
  148 rows", "working out the share", "checking the answer".
- The answer is `{claims: [{text, cites}], refusals, as_of}` and the `ledger` travels
  with it. `resolveCite(ledger, cite)` turns `r1#0.target_share` into the actual cell, so
  a number in the panel can be clicked to show the row it came from. **That is the
  feature**: the panel never has to ask the reader to trust a sentence.
- Nothing with `verification.ok === false` ever ships a claim — Coach returns a refusal
  instead. The panel does not need to decide whether an answer is trustworthy.
- Limits: 12 asks a minute, 2,000-character question, both from
  `server/routes/coach.js:33-35`. A 429 is a real state the panel should render.

## Stat names

`docs/stat-lexicon.json` is generated from `server/services/coach/stat-names.js` by
`scripts/emit-stat-lexicon.mjs` and a test fails if the two drift. 38 concepts, 44
`table.column` mappings, 4 named gaps. **Read the JSON; do not transcribe it** — a second
hand-kept copy is the thing the one-name-per-stat rule exists to prevent. Of the eleven
quantities the stat-table work named, all eleven are now in it.
