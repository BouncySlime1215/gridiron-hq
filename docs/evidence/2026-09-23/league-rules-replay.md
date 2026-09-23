# CE-05 replay: computed seeds vs real ESPN seeds (counts only)

Local copy, not production: `sqlite3 ~/gridiron-local/data.sqlite ".backup '.local-db/data.sqlite'"` taken
2026-09-23. Code: branch `claude/local-ce-05-league-rules` at `8b39a42d` (GREEN; `seedStandings` unchanged
since). No league, team or manager names below.

Command:

```
GRIDIRON_DB_PATH=$(mktemp -d)/scratch.sqlite SCHEDULER_DISABLED=1 \
  node docs/evidence/2026-09-23/league-rules-replay.mjs .local-db/data.sqlite
```

Source table `league_season_teams` (writer `saveTeams`, `server/services/league-history.js:143`;
`playoff_seed` is ESPN `teams[].playoffSeed`). Rules come from `leagues.payload` via `leagueRules`.
Pass rule (committed in `179c9096` before this ran): every team's computed seed equals its stored seed.

| league | season | teams | divisions | seeds equal | control: plain wins-then-points equal | playoff field equal |
|---|---|---|---|---|---|---|
| 1 | 2023 | 8 | 1 | 8/8 | 8/8 | yes |
| 1 | 2024 | 8 | 1 | 8/8 | 8/8 | yes |
| 1 | **2025** | 10 | 1 | **10/10** | 10/10 | yes |
| 2 | 2023 | 10 | 2 | 10/10 | **8/10** | yes |
| 2 | 2024 | 10 | 2 | 10/10 | **8/10** | yes |
| 2 | **2025** | 10 | 2 | **10/10** | 10/10 | yes |
| 3 | **2025** | 6 | 1 | **6/6** | 6/6 | yes |
| 1-5 | 2026 (`league_season_teams`, 2 weeks) | 46 | | 46/46 | 46/46 | yes |
| 1-5 | 2026 (`leagues.payload` `teams[].playoffSeed`, 2 weeks) | 46 | | 46/46 | | |

**Result: PASS.** 2025: 26/26 seeds across the three leagues with 2025 rows. All `league_season_teams` rows: 108/108 (62 in 2023-2025, 46 in 2026)
plus 46/46 current payload seeds.

The known-nonzero control: the same replay with the division rule switched off gets 8/10 in league 2
in 2023 and 2024, so the check can fail and the division-winner rule is what the data shows (in 2024
an 8-6 division winner is seed 2 above a 9-5 team).

Assumptions (guesses, stated plainly):
- Past seasons are replayed with each league's **2026** settings and 2026 division membership. The
  history backfill (`backfillLeagueHistory`, `league-history.js:206`) fetches past seasons' settings but
  stores none of them. League 1 had 10 teams in 2025 and 8 in 2026, so its 2025 playoff count may
  differ; seeds for all teams are compared, so the playoff count does not enter the seed check.
- "Playoff field equal" uses the 2026 playoff count for past seasons (same guess).

Holdout looks: recorded as `L154` (2025 rows) and `F001` (2026 payload) in `docs/evidence/HOLDOUT-LEDGER.md`.
This is a rule check, not a model fit; nothing was tuned on it.
