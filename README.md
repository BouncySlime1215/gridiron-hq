# Gridiron HQ — 2026 Fantasy Football Command Center

A local full-stack dashboard: rankings builder, mock/live draft tracker, X's-and-O's team
deep dives for all 32 NFL teams, ESPN league sync, and AI-analyzed training camp news.
Everything runs on your Mac — no hosting, no accounts, data stays local in SQLite.

## Run it

```bash
npm run dev
```

Then open http://localhost:5178. (API runs on 5177, frontend on 5178.)

## Features

- **Rankings** — seeded with the July 2026 consensus PPR top 100. Drag to reorder,
  set tiers, add notes, create multiple boards, add any player by search.
- **Draft Room** — mock drafts or live-draft tracking. Best-available is driven by
  *your* board; snake order handled automatically; toggle an X&O view of your picks.
- **32 Teams** — offense / defense / special teams formation views (skill players named,
  O-line and D-front shown as units), coach & scheme breakdowns, unit-level analyses.
  Reflects the 2026 offseason: 10 new head coaches, free agency, and the draft.
- **My Team** — connect a private ESPN league (league ID + espn_s2/SWID cookies,
  instructions on the Settings page). Roster, starting lineup on the field, weekly points.
- **Camp News** — log day-by-day camp stories per team. Paste headlines and Claude
  (Haiku) writes scheme + fantasy analysis (requires `ANTHROPIC_API_KEY` in `.env`,
  costs fractions of a cent per batch), or write your own takes.

## Notes

- ESPN cookies are stored only in the local SQLite file (`server/data.sqlite`) and are
  sent only to ESPN's API.
- To reset all data, delete `server/data.sqlite*` and restart — the seed reloads.
- Depth charts/coaching data are a July 2026 snapshot; edit via the DB or ask Claude
  Code to refresh them as camp battles shake out.
