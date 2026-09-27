# UX-02 INFORMATION ARCHITECTURE (2026-09-23, follows UX-01-audit.md)

Ground truth from code: `navigation.ts` currently ships 8 nav items — League Hub, Start/Sit, Trade Lab, Trade Brain, Draft, News, X's & O's, Settings — grouped as "My team" (a *group label*, not a tab), "Intelligence", "Setup". TRADE-MACHINE-MASTER.md section 4 and UI-STANDARD's "Surfaces" line both describe **My team** as its own tab (ladder, doomsday, report card, luck ledger, risk) sitting beside Trade Brain, Trade Lab, Start/Sit, League Hub, News, Draft, Settings. Today that content lives one click inside League Hub (`MyTeam.tsx`, confirmed in the UX-01 screenshot: title odds, post-draft plan and best lineup all render under League Hub's "My team" inner tab). This doc re-cuts the 8 to match the master plan while keeping the nav at exactly 8, per both docs' "nav stays 8" rule.

## The 8 tabs, re-cut around decisions

1. **My team** — promoted out of League Hub to its own top-level route (`/my-team` already exists as a path, currently a redirect into `League Hub?view=team`; UX-05 rewires it to render `MyTeam.tsx` directly). Ladder, doomsday cards, luck ledger, portfolio risk. This is the "what should I do across all 5 leagues right now" screen.
2. **Trade Brain** — unchanged route (`/trade-brain`), becomes the war room: target board, offers out, counters in, roadmap tree, regression radar, receipts. Already the best-reasoned page in the audit (documented independent-fetch rationale, honest-gap copy) — mostly an addition of the missing panels (target board, offers/counters, receipts), not a rebuild.
3. **Trade Lab** — unchanged route (`/trade-lab`), narrows to *evaluate any deal*: the audit found this page already carries 6 sub-tools and the app's deepest state coverage, but its identity is blurred by carrying both "find deals for me" (arguably Trade Brain's target-board job) and "evaluate a specific deal." Split candidate for UX-04: keep discovery-adjacent tools (Find deals, Target a player, Go get them) here only as entry points into a single deal, move anything about *who* to trade with into Trade Brain.
4. **Start/Sit** — unchanged route (`/lineup`). Guard, availability chips, floor/ceiling, late-swap windows, live tracker. Today's page already has the matchup-win% and waiver-claim callout; needs the internal error string fixed (UX-01 problem #5) before anything else.
5. **League Hub** — keeps roster/connections/sync-health/standings (today's "Connections & league-wide analysis" inner tab) once My Team moves out; becomes manager reads, streaming board, injury alerts, the weekly command center per TRADE-MACHINE-MASTER.md section 4.
6. **News** — unchanged route (`/news`), already close to spec: research feed + as-of stamps + a claims/outcomes tracker (screenshot showed "152 typed claims · 131 stories covered · 70 players tracked" with modeled/settled/confirmed/missed counts) — this is already close to "briefs," just needs the card format applied (three lines, one tap).
7. **Draft** — unchanged route (`/draft`), seasonal, seen in nav already with a `live` flag (`navigation.ts:33`).
8. **Settings** — unchanged route (`/settings`), needs the states work from UX-01 problem #7 before anything else lands on it.

Net nav change: **rename nothing, move one route's default target** (`/my-team` stops redirecting into League Hub and becomes its own page), and reclassify "X's & O's" — it isn't named in either master doc's 8-tab list. Recommend folding X's & O's research into News's "research feed" (it's already research, just organized by team instead of by story) rather than carrying a 9th concept under an 8-tab nav; a decision for Nick before UX-04, not made here.

## Three user flows

### Flow A — Tuesday trade run
Goal: find and send a trade that raises title odds, across up to 5 leagues, in one sitting.

1. **My team** (start here, not Trade Brain) — the ladder shows all 5 leagues' current odds in one glance; a card per league below the ladder flags "best trade available" if the sim found one worth sending.
2. Tap a league's "best trade" card → lands in **Trade Brain**'s target board, pre-filtered to that league, sorted by counterparty tradeability × odds gain.
3. Tap a target manager → **Trade Lab**'s evaluate-any-deal view opens pre-populated with the suggested package (Trade Lab is reached *from* a target, never browsed cold).
4. One-tap "send" writes the offer (confirm required — irreversible per rule 4); the sent offer now shows in Trade Brain's "offers out" with its ladder (accept/counter/decline odds).
5. Repeat 2-4 for the next league; My team's ladder updates as each offer is sent (grey "pending" chip, not yet a number change).

### Flow B — Sunday lock run
Goal: confirm every lineup is right before kickoff, across 5 leagues, fast.

1. **My team** — a single "lock status" strip across the top: 5 leagues, each a colored dot (green = locked correct, amber = a guess/thin call still open, red = a dead starter or bye-week starter still in).
2. Tap a red or amber league dot → **Start/Sit** for that league, scrolled to the flagged slot (guard/dead-starter card first, then availability chips).
3. Each flagged slot is a three-line card: what (bench X, start Y), why (cited: X out per source, Y's matchup win-rate delta), what to do (one-tap swap, confirm not required — reversible until kickoff per rule 4).
4. After swapping, the card collapses to a green receipt ("swapped, +N pts") and My team's dot flips green.
5. Repeat across the 5 leagues; total time budget is "before kickoff," so the whole flow should be a single scroll per league with zero back-navigation.

### Flow C — Counter received
Goal: react to an incoming counter-offer fast enough that Nick can actually reply on trade-window time.

1. Trigger: an in-app alert (event bus per TRADE-MACHINE-MASTER.md section 3) — "counter received in [league]" — lands wherever Nick is; tapping it jumps straight to **Trade Brain**'s "counters in", skipping My team and the target board entirely (this is the one flow that doesn't start at My team, because the counterparty already made the first move).
2. The counter renders as a ReceiptCard-style comparison: original ask vs. counter, with the odds delta of each, side by side (two numbers, one arrow between them).
3. One-tap evaluate re-runs the sim on the countered package inline — no navigation to Trade Lab required for a like-for-like swap; only a materially different package (added/dropped player) sends Nick into Trade Lab to rebuild it.
4. Accept/decline/re-counter are the three actions on the card; accept is irreversible (confirm required, rule 4), decline and re-counter are not.
5. Whatever Nick does, the manager-signals layer records the response time and terms (feeds LS-01/AI-05 per TRADE-MACHINE-MASTER.md section 2), invisibly — no extra step for Nick.

## Wireframes (text) — one representative screen per flow

### My team (Flow A/B entry)
```
┌─ HEADER ───────────────────────────────────────────────┐
│ My team                              [league picker ▾] │
├─ LOCK STATUS STRIP (Flow B) ────────────────────────────┤
│ ● League 1   ● League 2   ○ League 3   ● League 4  ●L5  │
├─ ODDS LADDER CARD (one per league, this one expanded) ──┤
│ Championship 2.4%  ↑0.3   Make playoffs 35%             │
│ why: 1,500 sims, correlated outcomes, real bracket       │
│ [ one tap → best trade available in Trade Brain ]        │
├─ DOOMSDAY CARD ──────────────────────────────────────────┤
│ what: starting RB out 3+ weeks (18% odds this month)     │
│ why: injury model, position depth thin (n=1 backup)      │
│ [ one tap → pre-approved recovery trade ]                │
├─ LUCK LEDGER CARD ───────────────────────────────────────┤
│ what: 2-1 actual vs 1.4-1.6 all-play                     │
│ why: schedule luck, not squad strength                   │
│ [ tap → evidence drawer ]                                │
└───────────────────────────────────────────────────────┘
(repeat odds-ladder/doomsday/luck cards per league below, collapsed)
```

### Trade Brain — counters in (Flow C)
```
┌─ HEADER ───────────────────────────────────────────────┐
│ Trade Brain              [ managers | offers | counters ]│
├─ COUNTER CARD ───────────────────────────────────────────┤
│ what: counter from [manager tier: reliable trader]       │
│   your ask: +4.2% title odds   their counter: +1.1%      │
│ why: they added a WR3 to the return, odds gain nearly    │
│   halved (cited: sim re-run on countered package)        │
│ what to do: decline — gain too thin to accept             │
│ [ Accept ]  [ Decline ]  [ Re-counter ]                   │
└───────────────────────────────────────────────────────┘
```

### Start/Sit — flagged slot (Flow B)
```
┌─ HEADER ───────────────────────────────────────────────┐
│ Start/Sit                    Week 3 · vs [opponent]      │
├─ GUARD CARD (red) ───────────────────────────────────────┤
│ what: dead starter in FLEX (bye week)                    │
│ why: 0 projected pts, cited bye-week table                │
│ what to do: swap in bench RB (+9.4 pts)                   │
│ [ Swap ]                                                  │
├─ THIN CALL CARD (amber) ─────────────────────────────────┤
│ what: WR2 questionable, guess label                       │
│ why: 60% expected active, thin (n=1 practice report)      │
│ what to do: start anyway — floor still clears bench        │
│ [ Confirm start ]                                         │
└───────────────────────────────────────────────────────┘
```

Each card above is exactly the "three lines: what / why / what to do" required by UI-STANDARD rule 3, with color meaning exactly one thing per rule 5 (green = verified gain, amber = guess/thin, red = risk/dead starter) and a single primary tap per card per rule 4. Building these as the shared `ScenarioCard`/`ReceiptCard`/`GuessLabel` components is UX-03's job; this doc only fixes where they sit and what they say.
