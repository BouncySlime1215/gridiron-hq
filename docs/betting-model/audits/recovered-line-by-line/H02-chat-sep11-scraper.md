# Adversarial verification — H02-chat-sep11-scraper (7 claims)

Files read in full:
- /Users/nick_matta/Claude/Artifacts/live_odds.py — 1503 lines, read in chunks (1-300, 300-600, 600-800, 829-999, 1190-1290, 1295-1335, 1390-1420). lines_read covers all cited regions plus surrounding context and every callee/caller referenced by the claims (`_try_page`, `_fd_alts_parallel_goto`, `_build_alt_ladder`, `merge`, `_parse_fd_comp`, `_parse_dk_nash`, `_parse_mgm_fixture`, `scrape_dk`, `_current_week`, kickoff formatting). Did not need the remaining ~150 lines (BetMGM parse internals, `main()` loop body, table-render tail) since no claim cites them and they don't bear on any claim's mechanism.
- /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/services/alt-spread-import.js — 1242 lines; read 1-400 and 1190-1242 in full (the two regions the claims cite plus the surrounding contract/doc block). Confirmed via grep that `alt_a_p6`-style fields appear only in this doc/snippet block, nowhere in a currently-executed code path.
- Confirmed via grep/`find` that nothing in the repo (only `test/`, `migrations/035_alt_spread_capture.js`, `scripts/import-alt-spreads.mjs`, and the file itself reference `alt-spread-import.js`) currently invokes `importAltSpreadCapture` against real data, and that `scripts/import-alt-spreads.mjs` requires `live_odds.py --json`, a flag that (per claim #270's own text, confirmed by absence of `--json` in the file) has never been added to `live_odds.py`. This whole subsystem is dormant.

## #269 — `_try_page`'s `browser` param never passed → ctx=None on cold start (live_odds.py:701-782)

Verified with `grep -n "_try_page("`: the function is defined `async def _try_page(page, label: str, browser=None)` (line 701) and called at lines 721, 746, 762 — **none of the three call sites pass a third argument**. So `browser` is always `None` inside `_try_page`, and `ctx = browser or _fd_browser` (line 714) always falls through to the module-global `_fd_browser`.

Traced state of `_fd_browser` at each call site:
- Line 721 (in-memory session reuse): only reached when `_fd_page is not None`, which per module init (line 253-255) only becomes true after a previous successful full launch set `_fd_browser`/`_fd_page` (lines 748-750/764-766). So at this call site `_fd_browser` is legitimately non-None — not the buggy path.
- Line 746 / 762 (fresh Camoufox launch): reached either on the very first run of the process (`_fd_page` starts `None` at line 255, so `_fd_browser` is still its initial `None`), or after the session-reuse branch failed and explicitly reset `_fd_browser = _fd_ctx = _fd_page = None` (line 730). In both cases `_fd_browser` is `None` at the moment `_try_page` runs, so `ctx = None or None = None`.

`ctx` (None) is passed into `_fd_alts_parallel_goto(ctx, parsed)` (line 715), which does `pg = await ctx.new_page()` at line 638 — `NoneType.new_page` → `AttributeError`, uncaught inside `_fd_alts_parallel_goto`, propagating out of `_try_page` and caught by the broad `except Exception as e` at line 752 (and again at 768 for the "direct" retry inside the same attempt), presenting only as a logged `FD {label}: {e}` line, then retried for all 3 attempts (line 733 `for attempt in range(3)`), ending in "FD: all retries failed" (line 781).

This is exactly the claimed mechanism and it is **the only path that runs after a process restart** (cold start) or whenever the in-memory session throws once. I cannot verify the literal transcript string ("Please use browser.new_context()") — that's outside anything in the repo — but the underlying code defect is real and reproduces on inspection alone.

Impact: FanDuel alt-spread lines are structurally unable to populate after a restart; this is the actual board Nick would read/bet from, so this changes a number he sees. Cold start is not a rare edge case — it's the state after every scraper restart (including whatever happened around the "session that died in the middle of a fix").

**Verdict: CONFIRMED, P1.** High-confidence, reproducible from code alone.

## #270 — PYTHON_EMITTER_SNIPPET reads `Side.alt_a_p6` etc., fields deleted in the current `Side` (alt-spread-import.js:320-364, live_odds.py:227-236)

Current `Side` dataclass (live_odds.py:227-236):
```
spread, spread_price, ml, total, total_price, alts (list[AltLine])
```
No `alt_a_p6` / `alt_a_p6_price` / `alt_h_p6` / `alt_a_m6` / `alt_h_m6` fields exist anywhere in the current file (confirmed by grep — those tokens appear only inside alt-spread-import.js's doc/snippet text, never in live_odds.py).

`PYTHON_EMITTER_SNIPPET`'s `_book_game()` (alt-spread-import.js:328-345) does `s.alt_a_p6, s.alt_a_p6_price` etc. (line 335, 338) — against a real dataclass instance without those fields this raises `AttributeError` on the very first game with a valid `spread`/`spread_price` (i.e., immediately, not a corner case). Confirmed: pasting this snippet verbatim into the current `live_odds.py` would not run.

Impact check (this is the key adversarial question): **is this snippet, or anything derived from it, on any path that currently executes?** No. Grep across the repo shows only `test/alt-spread-import.test.js`, the migration, `scripts/import-alt-spreads.mjs`, and the file itself reference this module; `scripts/import-alt-spreads.mjs` requires a `--json` file produced by `live_odds.py --json`, and that flag has never been added to `live_odds.py` (no `--json` anywhere in live_odds.py). The header comment at alt-spread-import.js:313-316 says as much itself ("NOT applied to the Python file by this work"). `nfl_alt_spread_captures`/`nfl_alt_spread_quotes` therefore cannot currently hold anything from this path regardless of this bug — the feature is simply not wired up yet, snippet bug or not. When (if) someone does paste it, the failure is a loud, immediate `AttributeError` on the first game, not silent data corruption — self-detecting, not a stealth defect.

Per the impact lens: this changes no number Nick currently reads, no money staked, no decision recorded, no backtest — the whole capture pipeline is inert today independent of this bug. It is accurate as a documentation/dead-snippet defect but has zero live impact.

**Verdict: adjust severity down. Real bug, but refuted under the impact lens — corrected_severity P3.** (Confirmed as literally true; not confirmed as consequential.)

## #271 — `_fd_alts_parallel_goto` `v[0]` indexing crashes on an empty-list hit (live_odds.py:619-685)

Worker returns either `(None,)*8` on a miss (line 671) or `k, _parse_fd_event_alts(_hit[0], side.spread)` on a hit (line 670). `_parse_fd_event_alts` → `_build_alt_ladder(pool, main_spread)` returns `[]` immediately if `main_spread_away is None` (live_odds.py:308-309), and can also return `[]` if nothing in the pool snaps within the window — both are real, reachable code paths, not hypothetical.

Line 677: `misses = [(k, parsed[k]) for k, v in results.items() if v[0] is None]` — when any `v` is `[]` (a genuine hit with no ladder), `v[0]` is `[][0]`, raising `IndexError` inside the list comprehension, uncaught locally. This propagates out of `_fd_alts_parallel_goto`, out of `_try_page` (line 715, no try/except around this call), and is caught only by the broad excepts at 725/752/768 in `scrape_fd`, which is exactly the same swallow-and-relabel behavior described in #269 ("FD: all retries failed").

Confirmed mechanism: any single FD game whose main-odds parse missed `spread` (Side() default `None`) but whose event page nonetheless has an `ALTERNATE_HANDICAP` market (`_hit` truthy) kills the *entire* batch for that attempt, not just that one game — because the exception is raised inside a comprehension iterating over `results.items()` for the whole cycle.

Impact: this is live-executing code on every scrape cycle; a crash here means zero FD alt lines for that cycle (a number the board would otherwise show), and it's plausible day-to-day (any game FD hasn't posted a main line for yet, or a spread market miss).

**Verdict: CONFIRMED, P2.** Real, reachable, live-facing; not P1 because it's a crash/no-data outcome (self-limiting to the next cycle) rather than a silently wrong price.

## #272 — `merge()` swapped-key fallback doesn't negate the `Side` (live_odds.py:1210-1252)

Lines 1232-1241:
```python
alt_k = f"{sg.home_abbr}@{sg.away_abbr}"
fd_d  = fd.get(k)  or fd.get(alt_k)
dk_d  = dk.get(k)  or dk.get(alt_k)
mgm_d = mgm.get(k) or mgm.get(alt_k)
...
if fd_d:  g.fd  = fd_d[3]
if dk_d:  g.dk  = dk_d[3]
if mgm_d: g.mgm = mgm_d[3]
```
Confirmed each book's `Side.spread`/`ml`/etc. is always built from the AWAY perspective as claimed:
- FD: `_parse_fd_comp`, `r.get("result", {}).get("type") == "AWAY"` (live_odds.py:410, also 416).
- DK: `_parse_dk_nash`, `ot == "Away"` (live_odds.py:880, 882).
- MGM: `_parse_mgm_fixture`, `side.spread = -hc` with comment "DecimalHandicap is home's; away = -hc" (live_odds.py:1111).

So a `Side` object is *always* keyed to "the away team named in that same dict entry." When `fd.get(k)` misses and `fd.get(alt_k)` hits, the `Side` object attached is the away-perspective data for the *book's* away team, which — because `alt_k` swaps home/away relative to the schedule key `k` — is the *schedule's home team's* number, assigned unmodified to `g.fd`/`g.dk`/`g.mgm`, which the rest of the code (table rendering, `fmt_spread`, etc.) treats as if it were the schedule's away team's number. No negation happens anywhere in `merge()`. Confirmed exactly as claimed.

This only fires when the ESPN-schedule key and a book's own key disagree on home/away (neutral-site games, an unusual `_team_abbr` collision, or a book's own reporting quirk) — not the common case — but when it fires the board shows an inverted line as if it were correct, with no error, warning, or difference in formatting to flag it. This is exactly a case of "a number Nick reads on a page" being silently wrong, on a board explicitly meant to be bet from.

**Verdict: CONFIRMED, P2** (as claimed — real and consequential, but conditioned on a genuine key mismatch, so not a routine occurrence; I did not find grounds to move it to P1 or down to P3).

## #273 — DraftKings fans out unfiltered per-game alt-spread requests (live_odds.py:950-994, 798-801, 1411)

Confirmed: `scrape_dk`'s league query (line 960) is `"eventsQuery": f"$filter=leagueId eq '{DK_NFL_LEAGUE_ID}'"` with `DK_NFL_LEAGUE_ID = "88808"` (line 801) — no date/week filter. `_parse_dk_nash` returns every event in that response regardless of week (lines 829-897, no week field even in `ScheduledGame`/`Side` for DK), and `scrape_dk` then does `await asyncio.gather(*[_fetch_one(k, v) for k, v in parsed.items()])` (line 989) — one `_dk_fetch_alt_spreads` HTTP request per parsed game, unconditionally. `interval = 300` (line 1411, main loop, 5-minute cadence) is confirmed.

I cannot verify the literal "100 games" / "14/100" transcript figures from inside the repo — those are runtime observations, not something in the file — but the code mechanism (no week filter before the per-game fan-out) is exactly as described, and the arithmetic in the claim (86 wasted × 12 cycles/hour = 1,032) is internally consistent with those reported figures.

Impact: this is a resource/detection-risk issue rather than a wrong-number-on-the-board issue — it doesn't itself misinform Nick, but it directly stresses the exact evasion architecture (`DataDome`/Tor/residential-IP avoidance) the rest of the file exists to protect, and a resulting rate-limit/ban would take down real data Nick relies on. That's a live operational risk, not merely theoretical.

**Verdict: CONFIRMED, P2** (as claimed).

## #274 — Kickoff times rendered as raw UTC, no conversion (live_odds.py:1317-1322, 158-167)

Confirmed: `dt = datetime.fromisoformat(g.start.replace("Z", "+00:00"))` (line 1319) parses to a UTC-aware datetime, then `dt.strftime("%-m/%-d  %-I:%M%p")` (line 1320) formats that same UTC instant with no conversion. Grepped the whole file for `astimezone`, `ZoneInfo`, `America/New_York` used as a conversion (not just the Playwright context locale at line 269) — there is none. So every displayed kickoff time is off from actual Eastern local time by the UTC offset (4-5 hours depending on DST), which for any evening/night kickoff pushes the displayed date to the next calendar day.

I can't verify the exact reproduced example string in the claim ("NE @ SEA 9/10 12:20am") since that's a specific runtime observation, but the underlying mechanism — UTC wall-clock time displayed unconverted, with no timezone label to disambiguate — is exactly as described and reproduces for any evening game.

Separately confirmed `_current_week()`'s hardcoded `season_start = datetime(2026, 9, 3, ...)` (live_odds.py:161) — real and as cited, though I did not independently verify the actual 2026 Week 1 kickoff date range claimed in the write-up (that's an external fact, not something the repo states).

Impact: this is a live, always-on display bug on the actual board Nick reads to judge which games are still open to bet — a wrong date/time is a legitimate operational hazard on that specific use case.

**Verdict: CONFIRMED, P2** (as claimed).

## #275 — Importer's closing caveats invert current book coverage (alt-spread-import.js:1224-1227)

Text at lines 1224-1227 states: *"`live_odds.py` parses alt spreads for FanDuel only. DraftKings and BetMGM get main lines, moneyline and total, and no alts at all."*

Checked against the current live_odds.py:
- DK: `_dk_fetch_alt_spreads` (live_odds.py:900-947) + `scrape_dk`'s `side.alts = _build_alt_ladder(pool, side.spread)` (line 987) — DK *does* build an alt ladder.
- MGM: `_mgm_build_alt_pool` (live_odds.py:1118) + `side.alts = _build_alt_ladder(pool, side.spread)` (line 1199) — MGM *does* build an alt ladder.
- FD: per claim #269/#271 above, FD's alt fetch is the one that's currently broken (crashes on cold start, and can crash mid-cycle on an empty ladder).

So the doc's coverage claim is indeed backwards relative to the current code: DK and MGM are the ones with a live, functioning alt-ladder path; FD is the one currently failing to produce alts. The doc's caveat 2 (about `find_pair` walking `[0, 0.5, -0.5, 1, -1]`) is also stale — the current code uses `_build_alt_ladder` (live_odds.py:295-366) with a fixed ±6.0-point / 0.5-step scan, a materially different shape (dedup-by-offset, snap-within-0.5, no `find_pair`/`observed_move` construct anywhere in live_odds.py — confirmed by grep, those symbols don't exist in the current file).

Impact check: this is prose inside a source-code comment block. Nothing in the repo currently executes or is gated by this text — as established under #270, the whole capture pipeline (this file's exports, `scripts/import-alt-spreads.mjs`, migration 035's tables) is dormant; nothing has ever run end-to-end since `live_odds.py --json` doesn't exist. This paragraph would only cause harm if a future developer used it to scope work (e.g., "just fix FD's alt parsing, DK/MGM don't have it") — a real but purely prospective misdirection, not a currently wrong number, decision, or bit of data anywhere live.

**Verdict: adjust severity down. Real and accurately-diagnosed inaccuracy, but refuted under the impact lens — corrected_severity P3.** (Same reasoning as #270 — a stale comment on a not-yet-active pipeline changes nothing a user or model currently sees.)

## Summary table

| key | my verdict | refuted | severity |
|---|---|---|---|
| #269 | confirmed, high-impact, live cold-start crash | false | P1 |
| #270 | literally true, zero current impact (dormant pipeline, loud self-detecting failure) | true | P3 |
| #271 | confirmed, live-crash on reachable input | false | P2 |
| #272 | confirmed, silent wrong number on live board | false | P2 |
| #273 | confirmed, real operational/rate-limit risk | false | P2 |
| #274 | confirmed, live display bug on real decision surface | false | P2 |
| #275 | literally true, zero current impact (dormant pipeline, stale comment only) | true | P3 |
