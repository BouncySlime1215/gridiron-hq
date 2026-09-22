# Missing data register

Standing rule, Nick 2026-09-22: **if we lack data, go find it online for free
first. If it genuinely cannot be found, build a workaround that holds up
statistically and label it — and write the gap down here so Nick can chase it.**

Add a row rather than burying a gap in a thread. State the search you actually
ran, not that you looked. Anything behind a paywall or an account is a
candidate for Nick's hands, so name the source.

---

## missing: per-player routes run

**What we want.** Routes run per player per week — the denominator behind
targets per route run and yards per route run, and the thing that separates a
receiver who was on the field from one who was actually in the pattern.

**Searched, 2026-09-22.** Not "looked at" — downloaded and header-read:

- Every candidate nflverse release probed, headers read, no route column
  anywhere: `advstats_week_rec` (17 cols, 8 seasons, 0 route columns),
  `advstats_season_rec` (25 cols), `stats_player_week` (no route/snap column),
  `player_stats` (targets and target_share only), `snap_counts` (total snaps,
  not pass snaps), `ftn_charting` (29 cols), `weekly_rosters` (36 cols).
- `pbp_participation` is the near miss. It has a `route` column, but it holds
  one charted route per *play* — the targeted receiver's route type — non-empty
  on 19,110 of 45,919 2024 plays. It cannot be counted per player.
- Kaggle Big Data Bowl (Nick's link): kaggle.com serves pages (200) but every
  API endpoint returns 401 and this container has no credentials. Competition
  data also requires accepting the rules on an account. **Nick's hands.**
- Open web: PFF charts every route and is paywalled. HeatRadar publishes
  weekly routes for 2026 and states plainly that *"No public play-by-play feed
  records whether a player ran a route, so this comes from a weekly charting
  export"* — proprietary, no CSV and no API. StickToTheModel publishes
  estimated YPRR and derives it from participation data, i.e. the same proxy
  this project built.

**Conclusion.** True routes run is not free. The public analytics world uses a
participation-derived proxy, which is what we built.

**Workaround built, and its verdict.** Pass-play participation: plays where the
player is in participation's `offense_players` and play-by-play calls the play a
pass. 100% join rate across 2018-2025. It reproduces football (WR median route
share 0.714, TE 0.486, RB 0.375) but **it earned nothing**: adding it on top of
snap share moved MAE by -0.0007 PPR, 95% CI [-0.0018, +0.0005]. It is
statistically indistinguishable from `offense_pct`, which `nfl_snaps` already
stores. Full proof:
`docs/evidence/2026-09-22/phase-a-routes-run-lift-proof.md`.

**What Nick could get us that would change the answer.** A true routes-run feed
that excludes blocking snaps. The proxy counts a blocking back as having run a
route, so it collapses onto snap share by construction; a real feed might
separate from snap share where the proxy cannot, most likely for RB and TE.
Candidates: PFF (paid), FantasyPoints Data (paid), SIS (paid), or Kaggle Big
Data Bowl tracking data via his account (free, but a limited slice of seasons
and no 2026, and competition terms need reading before it touches a product).

## missing: participation data for the current season

`pbp_participation_2026.csv` returns HTTP 404 while `snap_counts_2026` and
`stats_player_week_2026` are already current through 2026 week 2 (2,901 and
2,162 rows). Anything built on participation is history-only and cannot score a
current lineup. This is the constraint that killed the two-stage estimator
before it was built.

## missing: the `pbp_participation` table itself

`grep -rln pbp_participation server/db/ server/migrations/` returns nothing:
no migration or schema file creates this table. But the consequence differs by
consumer, and an earlier version of this entry got that wrong.

- `server/services/td-features.js:191` reads `pbp_participation` and
  `play_by_play` as genuine phantoms, in a module nothing else calls. This is
  the real gap.
- `server/services/nfl-weekly-feature-store-v2.js:272` is **not** a phantom
  read. Its tables live in satellite `.sqlite` files that this image does not
  ship — the same class as the chat corpus — and the module degrades honestly
  when they are absent rather than failing silently. That is a deployment gap,
  not dead code. Corrected on the wiring audit's finding, 2026-09-22; the
  original "inert path" framing here was mine and it was wrong.
- `server/services/nfl-formations.js` only names it in its header comment; it
  writes `nfl_play_formations`.

Worth noting for whoever closes the gap: `nfl-formations.js` already downloads
and parses the participation CSV but stores only play-level formation columns,
never `offense_players`, so the existing ingester cannot produce the per-player
counts `td-features.js` wants.
