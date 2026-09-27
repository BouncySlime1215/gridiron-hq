---
name: gridiron-sharp-football-source-refused
description: "Sharp Football's advanced box-score JSON (rmsummerlin.github.io/SFAStatsPages) is REFUSED on licence: no LICENSE file, upstream is a restricted Google Sheet, endpoint serves their own widgets. Do not re-survey it."
metadata:
  type: reference
---
**REFUSED 2026-09-22 by Explorer. Do not re-survey, do not propose, do not scrape.**

The endpoint is real and tempting, which is why this is written down: 43 team-game
metrics for 2021-2026 including man coverage faced, blitz rate, pressure rate,
play-action rate and EPA, time to throw, 11/12 personnel, shotgun, no-huddle,
yards before/after contact. Complete (2024: 272/272 games, 544 team-games, 59 raw
keys, zero missing values), live (rebuilt every 30 minutes), keyed on canonical
nflverse game ids (`2024_01_BAL_KC`), and reachable with no key at
`https://rmsummerlin.github.io/SFAStatsPages/data/boxscore_<season>.json`.

**It is still not ours to use:**
1. No `LICENSE` or `LICENSE.md` in the repo — both 404. Public on GitHub is not
   a licence to reuse; the default is all rights reserved.
2. The repo's own README: *"Data is pulled from a restricted Google Sheet"* and
   *"the season sheets are Restricted."*
3. The Pages index: *"There is no site here — the tools live on
   sharpfootballanalysis.com and fetch these files."* Plus `robots: noindex`.
4. sharpfootballanalysis.com is a paid subscription product (jwt-auth, appp login).

**Rule it illustrates:** unauthenticated and free to fetch is NOT permitted to
use. Licence is a gate that comes BEFORE measuring whether the data is any good,
not after. Nothing paid, and nothing unlicensed either.

2025 was never fetched (protected holdout). What survived the refusal is a
finding about our own data: [[gridiron-charting-never-reaches-team-week]].
Package: `/mnt/project-files/PACKAGE-CHARTING-TEAM-WEEK-GAP-2026-09-22.md`.
