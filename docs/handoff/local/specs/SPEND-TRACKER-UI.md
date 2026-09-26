# SPEND-TRACKER UI spec (API Spend screen and app navigation)

Source: a cloud design session handed off by Nick on 2026-09-26. Design only.
Figma: https://www.figma.com/design/GZNSQBIxKr3BwOyVMEg1jf ("Gridiron – API Spend")

What the Figma file contains:
- **API Spend page:**
  - desktop 1440: light (default, anomaly, empty) and dark (default, anomaly);
  - desktop 1024: 2 frames;
  - mobile 375: 4 frames.
  - The desktop frames were visually checked. **Desktop is the priority**; mobile is secondary.
- **App navigation page:** the map of the 7 areas, the shell with callouts, the dark rail, the ⌘K palette, the Coach drawer and the phone menu.
  - These were **NOT screenshot-checked**, because the Figma plan hit its call limit. Do one visual pass before building from them.

## 1. Placement
- The screen goes in **Settings > AI & developer**, as its first section. The section order is API spend > Daily budgets > API key.
- No new tab.
- **CLAUDE.md 2b needs a written exception** so this section can show dollars and model display names (Haiku 4.5, Sonnet 5, Opus 5.5).
- It still never shows raw model ids or feature keys.

## 2. Screen
- **Today card:**
  - "$X of $Y daily budget".
  - The meter turns amber at 80% and red at 100%.
  - "Resets at midnight ET".
  - An "Estimate" chip.
- **Last 7 days:** a bar chart with a dashed average line.
- **Breakdown by feature, source and model:**
  - 3 cards when the content area is at least 900 px wide;
  - otherwise 1 card with tabs.
- **Morning brief line:** "Yesterday: $0.42 API, 31 calls".
- **Always-on note:** "Not yet verified against Anthropic's billing."
- **Daily budgets table:** Edit and Set actions, using the existing `setDailyBudget`.
- **API key card:** shows "Connected" and a "Replace key" action. It **never shows the key**.
- **Anomaly rule:**
  - today is at least 2x the mean of the previous 7 full days, **AND**
  - today is at least $0.25.

## 3. Server gaps
These need a server unit first. The UI must not recompute any of them.
1. `ai_usage` has no `source` column. Hide the Source breakdown until the column exists.
2. `usageSummary().daily` groups by UTC date, not the local day.
3. There is no `by_model` for today.
4. The server does not serve a total budget.
5. There are no anomaly fields: `avg_7d_usd`, `ratio`, `anomaly`, `top_driver`.
6. "ET" currently means the server's local time, not an explicit timezone.

**Coordinator additions** (evidence-labelled):
- **The source column is the core of Nick's ask** ("load/offline and in session").
  - Tag every call at the single call site, `server/services/claude.js`.
  - Take the tag from the `GRIDIRON_AI_SOURCE` env var: `app` for the server, `offline` for refresh.sh and the jobs, `test` for the test harness and DB copies.
  - The default is `app`.
- **Builder test calls** made against DB copies must land in the live ledger with `source=test`. Otherwise tonight's roughly $1-2 of test spend stays invisible.
  - Options: write to a shared ledger file that the server ingests, OR point the builders at the live ledger through an append-only path.
  - Decide this at build time. **Never hand-edit the live DB.**
- **Group days explicitly** with the `America/New_York` timezone, not the server's local time.
- **Optional true-up** against Anthropic's usage and cost API.
  - Nick must create the admin key himself.
  - The note stays "Not yet verified" until he does.

## 4. Nav rules
- **Sidebar:** 7 areas. It never grows.
- **Header:** the same on every page, in this order:
  - collapse, breadcrumb, league picker, Week, Title odds, health chip;
  - Search ⌘K, Refresh, Coach, Explain, More.
  - Below 1280 px it compacts, so it fits at 1024.
- **Pages:**
  - Each area has one PageHeader and one tab row.
  - The URL is `/area?view=tab`.
  - The breadcrumb reads `Area / Tab`.
- **Overlays, not pages:** Coach and the player and trade cards.

## 5. Fixes the design implies (not built yet)
- Remove `NumberHealthNavDot`. The header health chip becomes the only health signal.
- Move DevHub out of the header into Settings > AI & developer.
- Build the ⌘K rows from each area's tab config.
- **Fix the `DEEP_DESTINATIONS` bug:** "Who trades with you" points at `/trades?view=managers`, but the tab id is `people`.
- Change the Settings view id from `dev` to `ai`, and redirect the old id.
- **Drop the eyebrow on area PageHeaders.** The spend frames still show a "SETTINGS" eyebrow. Delete it at build time.

## 6. Cross-links
- A spend anomaly adds a row to Today > Watching.
- The morning-brief spend line in the Coach drawer links to Settings > AI & developer.
- A budget-reached error links to its row in the Daily budgets table.

## Privacy
Placeholders only: no league or manager names, no trade details, no keys.

## Build order
Start after Coach v2 lands:
1. The CLAUDE.md 2b exception.
2. **SPEND-SERVER:** the source column, ET days, by_model, the total budget, anomaly fields, and ingesting test calls.
3. **SPEND-UI:** the Settings > AI & developer screen.
4. **NAV-SHELL:** the section 5 fixes in one shell PR, after one visual pass of the nav frames.
