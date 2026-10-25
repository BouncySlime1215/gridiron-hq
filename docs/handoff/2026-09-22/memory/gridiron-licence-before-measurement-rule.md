---
name: gridiron-licence-before-measurement-rule
description: Fleet rule (coordinator 17:41Z, from the Sharp Football refusal) — the licence/terms check on any external data source is a gate that runs BEFORE any measurement of whether the data is good
metadata:
  type: feedback
  modified: 2026-09-22T17:43:00.000Z
---
**Why:** Explorer found Sharp Football advanced box scores as public GitHub Pages JSON, measured coverage and keying first, and only then checked the terms: no LICENSE, data sourced from a restricted Google Sheet, the site exists to serve a paid product's widgets, robots noindex → REFUSED, files deleted ([[gridiron-sharp-football-source-refused]], [[gridiron-state-1260-2026-09-22]]). The measurement was wasted effort and, had the numbers been good, would have created pressure to keep a source we cannot use.

**How to apply, for every external data source (free or not):**
1. Before any fetch beyond what is needed to read the terms: quote the licence / terms of use verbatim (site AND upstream provider) into the pre-registration, with the URL and date read.
2. Redistribution or derived-use restrictions, a "for personal use" clause, a paywalled upstream, or no licence at all → REFUSE; record it as a refused-source memory file so nobody re-finds it.
3. Only after the licence gate passes: holdout rules, column reconciliation against what is already wired, then measurement in the Auditor's format.
4. Nothing paid, ever — that rule stands alongside this one. A free source with an unusable licence is not free.
Pairs with [[gridiron-free-data-first-rule]] and [[gridiron-sharp-football-source]] (status REFUSED).

**Probe rule (Explorer, 18:56Z):** before concluding "no licence", check BOTH filenames (`LICENSE`, `LICENSE.md`) on each of `master`, `main` and `gh-pages`; nflverse-data's licence lives at `master/LICENSE.md` (CC BY 4.0) and a `main/LICENSE` probe alone returns 404. A refusal must name which leg it stands on — Sharp's stands on the restricted-sheet and paid-endpoint legs, not on the missing file. Attribution is part of the gate: a permissive licence with an attribution clause (CC BY) is usable only once the attribution is wired ([[gridiron-nflverse-cc-by-attribution]], [[gridiron-state-1276-2026-09-22]]).

**Second probe result (Release, 17:55Z):** `nflverse/nfldata` (fetched by gamescript, coaches, officials, opening-lines, profitability; coaches + officials are fantasy-side) has NO licence on any leg — LICENSE and LICENSE.md 404 on master, main and gh-pages; README.md 200 on master only (1,017 B) with no licence text. Per step 2 this is "no licence at all": no descriptor added, nothing measured, a Nick line in the next 30-min update, not a code change. nflverse-data (CC BY 4.0) and nflverse/nfldata are different repositories with different licence states; name which one a claim is about ([[gridiron-state-1278-2026-09-22]]).

**Third probe result (refs/coaches thread, 18:50Z):** `nflverse/nfldata` DROPPED — four filenames (LICENSE, LICENSE.md, LICENSE.txt, COPYING) × three branches all 404, README none; nothing was ever pulled from it. Licensed replacements found in nflverse-data (CC BY 4.0): `officials/officials.csv` and `schedules/games.csv` (head coaches + referee). Pro Football Reference refused on its terms. Detail + keying caveat [[gridiron-nflverse-cc-by-attribution]]. Probe rule extended: check `LICENSE.txt` and `COPYING` too, and never assume a sibling repo inherits a licence.
