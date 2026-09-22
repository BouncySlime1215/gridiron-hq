---
name: gridiron-model-audit-open-findings
description: The smaller findings from the 2026-09-20 Gridiron HQ model audit — title odds, horizons, display precision, injury-proof trade value, and the advanced stats that reach no fantasy number — each with its file:line on main at 791b131.
metadata:
  type: project
  modified: 2026-09-20T01:36:13.496Z
---

Companion to [[gridiron-model-audit-2026-09-20]]. All on `origin/main` at
**791b131**; each was routed to the thread owning the file.

- **Title odds ignore the season in progress and are uncalibrated.**
  `MyTeam.tsx:62` requests `/model/{id}/simulate?runs=1500` with **no
  `from_week`**, so `simulateSeason` takes `fromWeek = 1` (`season-sim.js:173`),
  `initialRecords` returns zeros (`:122`) and the real record is discarded, while
  scoring is drawn from `buildProjections({through: SEASON-1})` (`:180`). 2026
  rookies with no prior history are dropped from the pool (`:219`, `:237`); the
  bracket is pinned to weeks 15-17 (`:195`) though `trade-horizon.js#leagueSchedule`
  derives the real ones. **No historical calibration of these odds exists
  anywhere in the repo** — no script, test or evidence file grades a week-*w*
  probability against a real finish. Only the Monte Carlo noise is measured
  (`trade-verify.js:78-90`). One-line start: pass `from_week` at `MyTeam.tsx:62`.
- **`title_delta` is printed 100× finer than its own noise.**
  `TradeLab.tsx:291` shows two decimals of a percent; the measured seed-to-seed
  sd is 0.0107 at 1,200 runs (~±1.1pp), and `trade-verify.js`'s own
  `MATERIAL_TITLE_DELTA = 0.01` floor (`:111-116`) is not applied on that card.
- **Wrong horizons.** `season_delta = ppg_delta × GAMES` with `GAMES = 17`
  (`trade-engine.js:1096`, `:119`), rendered as "over the season" at
  `TradeCard.tsx:109` — at week 2, with at most 16 NFL weeks left and a fantasy
  calendar `leagueSchedule()` already knows. Same shape at `:415` (`18 − week`).
- **Trade value survives a season-ending injury.**
  `decisionPpg = 0.25 × currentWeekPpg + 0.75 × rosPpg` (`:385`); `currentWeekPpg`
  carries availability (`:359`), `rosPpg` does not (`:365-367`). The 25/75 split
  itself has never been measured.
- **"Fair" is borrowed, not judged.** Asset `value: m?.value ?? 0` from
  `dynasty_values` (FantasyCalc) at `trade-engine.js:418`; labels are hand-set
  cuts at `:1233-1241`. **A player FantasyCalc does not list is worth zero** in
  every fairness calculation.
- **No advanced stat reaches the fantasy projection — and for VOLUME that is a
  tested negative, not a gap.** EPA, CPOE, RACR, PACR, WOPR, air-yards share, NGS
  and PFR are read by thirteen *betting* modules and by no fantasy one. Snap share
  appears once, as a sentence (`player-week-engine.js:731`). `priorFfOpportunity`
  is attached at `player-week-engine.js:358-359` and read by nothing.
  `opportunity-model.js` (425 lines, ridge over 16 features including air-yards
  share, WOPR, snap trajectory, xFP, vacated teammate share, spread, implied
  total) has **zero server consumers** — only its own test and
  `scripts/study-opportunity-volume.mjs`. **Corrected 2026-09-20: do not
  recommend bolting those stats onto the volume head.** That study
  (`docs/OPPORTUNITY-FINDINGS-2026-09-19.md` section 3) found the ridge loses to a
  four-line EWMA of the player's own recent games, and I then graded the EWMA
  against what ships: the shipped head loses to the EWMA in all four cells, the
  fitted-k head beats it on targets and ties on carries. So the ranked answer for
  opportunity is **promote the shrinkage fit, full stop**. Advanced stats remain
  genuinely unexplored for the *efficiency* half (yards per target, catch rate, TD
  rate), which is where RACR, PACR and CPOE would actually speak — that is the
  open question, not volume.

What is genuinely well built, so nobody re-litigates it:
[[gridiron-what-is-actually-tested]].
