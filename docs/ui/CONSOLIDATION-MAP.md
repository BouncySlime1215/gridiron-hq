# UI consolidation map

Nick's direction: merge the UI across the platform and consolidate things that do the
same job. This map is the plan. It lists every route and major panel, its job, its data
source and its overlaps. It then proposes seven top-level areas, a feature-preservation
table per area, the redirects, the duplicate components with one pick each, and the
duplicate numbers that belong to a server unit.

It is read from the code on `main` at `22931762`; 16 of the routes were also opened in the running app during the design-system scan. Nothing is
built yet. Execution is one area per PR (section 8).

Rules for execution:
- **Nothing disappears silently.** Anything cut has a reason: a duplicate of X, dead, or broken.
- **Server producers and API contracts stay unchanged.** The only allowed exception is a read-only aggregation endpoint where truly needed, and the PR must say so.

---

## 1. Today's routes

| Route | Renders | Job | Main API |
|---|---|---|---|
| `/` | redirect to `/league` | | |
| `/league` | LeagueHub = CommandCenter + Leagues | This week across every league; connect, sync and disconnect leagues; roster strength by position | `/command-center`, `/leagues`, `/leagues/:id/analysis`, `/leagues/:id/sync`, `/leagues/:id/removal-impact` |
| `/my-team` | MyTeam + TeamScout + PostDraftPlan | Title odds; lineup-vs-best swaps; scouting report; roster and lineup; ceiling lineup; weekly points | `/model/:id/simulate`, `/trades/:id/scout`, `/trades/:id/lineup-diff`, `/trades/:id/ceiling-lineup`, `/trades/:id/post-draft-plan`, `/leagues/:id/data` |
| `/lineup` | Lineup | Start/sit with confidence; matchup posture; waivers; defence streaming; start/sit gate | `/trades/:id/lineup`, `/trades/:id/posture`, `/trades/:id/waivers`, `/trades/:id/streams`, `/gates/start-sit` |
| `/trade-lab` | TradeLab, 7 tabs | News edge, find deals, title impact, target a player, go get them, mock a trade, matchups | `/trades/:id/find`, `find/sequences`, `title-trades`, `offer`, `offer-many`, `player/:pid`, `evaluate`, `news-edge`, `dvp`; each card also calls `sense-check`, `/model/:id/trade-impact`, `explain`, `his-screen`, `offers/sent` |
| `/trade-brain` | TradeBrain: War Room (default), Who trades with you, Sendable proposals | Next move; go get; market flips; league-mates; Coach; manager board; written proposals | `/trades/:id/war-room`, `/warroom/*`, `/coach/*`, `/trades/:id/managers/signals`, `brain/managers`, `proposals`, `people/pulse`, `/players` |
| `/draft` | DraftHub: Mock &amp; boards, Who survives, Live, Recaps | Draft tools | `/drafts`, `/rankings`, `/edge/draft-survival` |
| `/drafts/:id` | DraftRoom | Local mock or tracked draft with CPU picks and a recommendation | `/drafts/:id/*`, `/edge/vor` |
| `/live-draft/:id` | LiveDraft | ESPN live draft mirror with Claude advice, lookahead and targets | `/drafts/:id/sync`, `assist`, `advice`, `lookahead`, `ingest-status` |
| `/teams`, `/teams/:abbr` | Teams, TeamDetail | NFL teams (X's &amp; O's): depth chart, scheme, tendencies, schedule, offseason, team news | `/teams`, `/teams/:abbr`, `tendencies`, `/nfl/:abbr/schedule`, `/nfl/offseason/:abbr`, `/news?team=` |
| `/players/:id` | PlayerDetail | Player page: scheme context, advanced stats, news | `/players/:id`, `advanced-stats` |
| `/news` | News: Model Tracker, Intelligence Desk, Archive &amp; Tools | Injury and news signals priced into projections; news desk; archive and pulls | `/news/*`, `/espn/sync-news` |
| `/settings` | Settings | Local auth, number health, phone pairing, league chat pull, ESPN connect, ESPN pulls | `/number-audit`, `/auth/pairing-*`, `/league-chat/*`, `/espn-connect/*`, `/espn/sync-*` |
| `/pair` | Pair | A phone signs in with an 8-digit code | `POST /api/auth/pair` |
| `/sign-in`, `/sign-in/complete` | SignIn, SignInComplete | Google sign-in, outside the app shell | `/api/auth/*` |
| `/leagues`, `/live-draft`, `/drafts`, `/rankings`, `/projections` | redirects | `/league?view=connections`, `/draft?view=live`, `/draft`, `/league`, `/league` | |
| `*` | NotFound | Bad path with recovery links | |

**Pages with no route.** Nothing imports these, so they cannot be reached today:

| Page | What it was | Note |
|---|---|---|
| `Rankings.tsx` | The editor for ranking sets | The ranking sets it edits are still used by the draft room, SidePanel and the player card, so this is a **broken** loop, not dead code. |
| `Projections.tsx` | Consensus market board | |
| `Model.tsx` | Accuracy, championship odds, correlation, game script, availability, handcuffs | |
| `Edge.tsx` | Value board, breakouts, boom/bust, efficiency, playoff schedule, season simulator | |

**Always in the shell:** QuickJump (Cmd+K), RefreshAll, DevHub, the page explainer, EspnConnectGate, DataFreshnessBanner, the number-health nav dot, and the data-credit footer.

## 2. What overlaps today (measured in the code)

- **Title odds** are shown in 7 places, from two producers. `/model/:id/simulate` (My team) is seeded separately from `tradeImpact`, which everything else uses. Details in section 7.
- **The change in title odds for a deal** is shown in 4 places: the Title impact tab, TradeCard, War Room Go get, and the War Room deck.
- **Chance he says yes** is shown in 6 places: TradeCard's P(accept) band, the War Room hero, the deck, Go get steps, Negotiate, and Market's "both say yes". The War Room's League screen and the People board also show "% respond".
- **The optimal or this-week lineup** is shown 4 times: the My team roster tab, PostDraftPlan's best lineup, the My team ceiling lineup, and Lineup's slot list. Swap suggestions also appear 3 times: LineupDiffCard, MatchupPosture swaps, and Lineup warnings.
- **Suggested trades** come from 4 surfaces: PostDraftPlan, Trade Lab find deals, Sendable proposals, and the War Room next move.
- **"Go get a player"** is in 3 places: Trade Lab "Target a player", Trade Lab "Go get them", and War Room Go get.
- **The manager read** (tier, receptiveness) is in 4 places: ManagerBoard, TradeCard's ManagerRead, the War Room League screen, and the People board.
- **Copy a message** has 3 implementations: CopyLine, the War Room CopyButton/CopyBlock, and TradeCard's pitch copy.
- **Self-scout fixes** are in 2 places: TeamScout and PostDraftPlan.
- **Weekly range** is on My team twice, from the same producer: the header and TeamScout.
- **The player evidence strip** has 3 renderers: EvidenceStrip, PlayerEvidence, and Trade Lab's PlayerOutlook inline.
- **Player chips and rows** have 5 renderers: PlayerPill, hand-built Headshot rows (3 places), PlayerRow, the War Room Avatar/Faces/player chips, and Lineup's Slot.
- **News lists** appear in 3 places: the News archive, TeamDetail news, and PlayerDetail news. "Pull ESPN news" appears in 3 places: News, TeamDetail, and Settings.
- **ESPN connect** has 3 flows: EspnConnect (Settings), EspnConnectGate (app-wide modal), and the Leagues ESPN form.
- **Health** appears on 4 surfaces: the NumberHealth card and nav dot, the DataFreshnessBanner detail table, DevHub "Live data", and the War Room health sheet.
- **Draft duplicates:**
  - Three "will he still be there" numbers.
  - Two value-over-replacement numbers.
  - Two projected-points sources.
  - Two recommenders.
  - Two ways to track an ESPN draft live.
  - Hub, Drafts and LiveDraft each draw their own `h1`.
  - The hub's Recaps tab shows the Mock list, which is a bug.
- **Stale links:**
  - NotFound links to `/` (labelled "Command Center", but it is League Hub), `/players`, and `/betting`. Neither `/players` nor `/betting` is a route.
  - PlayerDetail's "rankings" link goes to `/rankings`, which redirects to `/league`.
  - Projections' text points to Rankings, which cannot be reached.
  - `?view=connections` is linked from five places, but nothing reads it.
- **The page explainer** posts to a betting-branded endpoint, `/betting/explain/page`, even though the betting routes are gone. Only 4 pages register a summary.

## 3. The seven areas

The sidebar goes from 8 items to 7. `test/war-room-layout.test.js` pins "nav stays 8 items", so the first execute PR changes that pin to the new number and says so. The War Room stops being a separate full-screen app: its screens become parts of Today and Trades, and Coach becomes app-wide.

| Area | Route | Holds | Replaces |
|---|---|---|---|
| **Today** | `/` | The next move (War Room hero), this week's actions across every league (CommandCenter), lineup alerts (dead starters, swaps worth making), Watching, and season progress | League Hub's Command Center, War Room Today, MyTeam's LineupDiffCard summary |
| **Trades** | `/trades` | One trade surface. Go get (targets → paths → offer), Market (flips and catch-up), Find deals (finder, sequences, title impact), Build (mock a trade), People (manager board plus written proposals), and News edge | TradeLab (7 tabs), TradeBrain (War Room Go get / Market / League, ManagerBoard, ProposalSlate), PostDraftPlan's suggested trades |
| **My Team** | `/my-team` | Title odds; lineup (start/sit slots with confidence, matchup posture, the mean/ceiling/floor objective with the ceiling detail); scouting report; waivers and streaming; roster and weekly points | MyTeam, Lineup, PostDraftPlan's self-scout and best lineup |
| **League** | `/league` | Your leagues (connect, sync, disconnect, sync health), roster strength by position for every team, and standings | Leagues, League Hub's page frame |
| **Players** | `/players` | Search and board (consensus market, value, 30-day trend, ADP); rankings and tiers editor; player pages; NFL teams (X's &amp; O's); News (signals, desk, archive) | Projections (revived), Rankings (revived), PlayerDetail, Teams, TeamDetail, News |
| **Draft** | `/draft` | Boards (saved drafts), draft room, live draft, who survives, recaps | DraftHub, Drafts, DraftRoom, LiveDraft |
| **Settings** | `/settings` | Connections (one ESPN flow, phone pairing, league chat pull); Health (number audit plus data freshness plus live row counts); AI and developer (key, usage, identity audit); Model diagnostics (accuracy, correlation, game script, availability, handcuffs) | Settings, DevHub popover, DataFreshness detail table, Model (revived, read-only) |

**App-wide:**
- **Coach** becomes a drawer on every area, opened from the header, using the `/coach/ask` it uses today.
- **The page explainer:** its button stays in the header.
- **The header** carries the league picker, title odds and the health chip. These are the War Room top bar's pieces, promoted to the app.
- **Sign-in and pairing stay outside the areas.** `/sign-in`, `/sign-in/complete` and `/pair` are auth flows.

## 4. Feature preservation, per area

Every feature and number on today's pages, and where it lives after the merge. **Cut** means it is not carried over, and the reason is given.

### Today

| Old place → feature or number | New place |
|---|---|
| War Room Today → "Do this now" hero: partner, give/get with photos, status badge, chance he says yes (guess pill), title odds now → after, value edge, Copy message, Ask Coach, plan switcher, skip reasons, I sent it | Today, hero (the same component) |
| War Room Today → no-move hero with the closest misses | Today, hero |
| War Room Today → Watching (open threads, number-health breaks, brain blocks, send-when waits, deadline) | Today, Watching |
| War Room Today → season progress: goal, title odds plan, stops done/left | Today, progress strip |
| War Room top bar → league picker, title odds, risk mode, health chip | App header |
| CommandCenter → this-week cards (dead starter, injury alert, stream, no move) with deadline, "guess" chip, action; the clear sentence; the "not checked" list; checked-ago | Today, "This week" |
| MyTeam → LineupDiffCard (this week's lineup vs the best one, swaps with "right about N%", flagged starters, empty slots, activate from IR) | A one-line alert on Today linking to My Team → Lineup, where the full card lives |
| Classic War Room dashboard (Classic layout toggle) | Kept behind the toggle until the Trades area lands; cut then, as a duplicate of Today plus Trades |

### Trades

Execute last. RULES-EVERYWHERE is changing the server path for suggestions, and Trades must read its filtered output.

| Old place → feature or number | New place |
|---|---|
| War Room Go get → target cards (if landed, reachable, fit, approve), paths as timelines, offer composer (message, when to send, walk-away, If he says…, why) | Trades → Go get |
| Trade Lab → Target a player (price bar, N ways to land him, % of market, player outlook) | Trades → Go get: a picked target shows these packages alongside the planner's paths |
| Trade Lab → Go get them (several targets, packages per owner) | Trades → Go get with multi-select |
| War Room Market → flip cards (buy from → sell to, gap, both say yes, prices, why now) and catch-up | Trades → Market |
| Trade Lab → Find deals (partners grid, mutual toggle, package size, "both title odds up, points say no", browse all with dismiss / hide seen, "do this, then this opens up" sequences) | Trades → Find deals |
| Trade Lab → Title impact (title-odds change ±2 SE, ppg change, their title change, both gain) | Trades → Find deals, sorted by title impact (the same producer, `title-trades`) |
| Trade Lab → Mock a trade (build and evaluate any deal) | Trades → Build |
| Trade Lab → Matchups (defence vs position) | Players → NFL teams (it is a team stat, not a trade) |
| Trade Lab → News edge (claim / buy-low cards with age, source, confidence) | Trades → News edge |
| TradeCard → grade, badges, give/get, evidence, risk strip, ppg / bad-week / good-week changes, ManagerRead (tier, receptiveness, P(accept) band), title-odds sim, write the pitch plus copy, AI sense check, his screen, I sent this, dismiss | The one trade card (section 6), in every Trades list |
| War Room League / People board / ManagerBoard → per-manager tier (settable), archetype, receptiveness plus factors, % respond, budget, in market, his word, mood, approach, last contact, moves with him, measured signals | Trades → People, as one manager card; tapping asks Coach |
| Sendable proposals (ProposalSlate) → paid write button with cost and cache note, per proposal timing, give/get, why they say yes, opener / ask / both copy lines, ask / fair / floor, rejected list | Trades → People → "Write proposals" (same button, same cost note) |
| PulseTicker (chat pulse, 72 h) | Trades → People header |
| PostDraftPlan → suggested trades (up to 3) | **Cut, duplicate:** the same finder output as Find deals. My Team links to Trades. |
| War Room Coach drawer (fixed questions, free text, sources, morning brief, context) | App-wide Coach drawer |
| Negotiation threads (countdown, counter builder) | Inside the trade card once "I sent it" is tapped (as today in the War Room) |

### My Team

| Old place → feature or number | New place |
|---|---|
| MyTeam → team picker, Sync | My Team header |
| MyTeam → title odds right now (championship ±95%, playoffs, expected wins, weekly range, runs, median-game notice) | My Team → Overview. The weekly range is shown once there; section 7 covers the producer. |
| TeamScout → lineup strength and rank, league bars, position-by-position cards, what to fix, playoff weeks 15–17 swing | My Team → Scouting |
| TeamScout → weekly range (second copy) | **Cut, duplicate:** the same producer is shown in Overview |
| PostDraftPlan → self-scout fixes | **Cut, duplicate:** a subset of TeamScout's "what to fix" |
| PostDraftPlan → best lineup | **Cut, duplicate:** the same optimal lineup as the Lineup tab |
| MyTeam roster tab → optimal lineup with formation, starters, bench, weekly points | My Team → Lineup (formation view kept) and Overview → weekly points |
| Lineup → dead-starter alert, week total, coin-flip count, objective toggle (mean / ceiling / floor), per-slot confidence with margin, week points, why, EvidenceStrip, football factors, market line, not-considered list, bench | My Team → Lineup |
| MyTeam → Ceiling lineup tab (target, trials, lineup, stacks, outcome shape p10/p50/p90/p99, hit %, vs highest mean) | My Team → Lineup, as the "ceiling" objective's detail panel. The duplicate objective list goes; each number stays. |
| MyTeam → LineupDiffCard | My Team → Lineup, top of the tab |
| Lineup → MatchupPosture (win chance, stance, you vs them, edge, swaps that fit) | My Team → Lineup |
| Lineup → WaiverWire and teaser, StreamingBoard | My Team → Waivers |
| Lineup → StartSitGate (does our projection beat ESPN's) | My Team → Lineup footer |

### League

| Old place → feature or number | New place |
|---|---|
| Leagues → connect form (Sleeper/ESPN, id, season, cookies), sync message with scoring notes, league cards (platform, teams, season, format, synced time, connection warning, Sync, Disconnect), disconnect modal with retained counts | League → Your leagues. The ESPN part uses the one ESPN flow (section 6). |
| Leagues → payload-season warning, coverage line, roster strength by position for every team (NEED / SURPLUS / OK with %, top starters, needs and has) | League → Roster strength |
| League Hub → active league and "roster updated" meta | App header (league picker) |
| MyTeam weekly points / schedule (ESPN) | League → Standings shows every team's record and points; My Team → Overview shows yours |

### Players

| Old place → feature or number | New place |
|---|---|
| Projections (no route) → consensus board: FantasyCalc value, 30-day trend, ADP, injury flag, pull latest, create board | Players → Board (**revived**) |
| Rankings (no route) → ranking sets: new / copy, position filter, projected vs last season, add player, tiers, notes, reorder, save | Players → Rankings (**revived**: the draft room and player card read these sets, and nothing can edit them today) |
| PlayerDetail → header, ranks, formation, advanced stats, scheme use, unit analysis, outlook, news | `/players/:id` |
| PlayerCard pop-out → proj pts and rank, last season, 30-day trend, ADP, verdict, game log, scout report | Stays the one quick view. "Full page" goes to `/players/:id`. |
| Teams / TeamDetail → divisions grid; formation, scheme, unit grades, measured tendencies, schedule, offseason, team news | Players → NFL teams, `/players/teams/:abbr` |
| News → Model Tracker (signals priced into projections), Intelligence Desk, Archive and tools (pull ESPN / RSS, roundup, AI paste, manual entry, explain, delete) | Players → News. My players' headlines also surface in Today → Watching. |
| TeamDetail news block, Settings "Pull ESPN news" | **Cut, duplicates:** one news list with its filters, and one pull action (in News) |
| Trade Lab Matchups (defence vs position) | Players → NFL teams → Matchups |
| Edge (no route) → value board (VOR, ADP edge) | Players → Board adds a VOR column from `/edge/vor` (the draft room already uses it) |
| Edge → boom/bust, efficiency, breakouts and regression, playoff schedule, season simulator | **Cut, proposed:** unreachable since before this plan, and each duplicates a live view. Boom/bust and floor/ceiling duplicate the evidence strip; efficiency duplicates PlayerDetail advanced stats; the playoff schedule duplicates the Scouting playoff swing; the season simulator duplicates the evidence strip. **Needs Nick's yes.** |

### Draft

| Old place → feature or number | New place |
|---|---|
| DraftHub → tabs; who survives (league size, seat, take now vs can wait %) | Draft → Survival |
| Drafts → create (name, type, teams, rounds, slot, clock, board), list, delete | Draft → Boards |
| DraftRoom → pick counter, pause, sim to end, undo, clock with auto-pick, recommendation with alternatives, last CPU pick, best available (VOR, value/reach, queue), board grid, my team, queue, recap and grade | `/draft/:id` |
| LiveDraft → link an ESPN draft, sniped toasts, source pill, clock, Claude's call with evidence, other options, lookahead, targets (gone %, vs replacement), my team, cost of waiting, run alerts | `/draft/live/:id` |
| DraftHub → Recaps tab (shows the Mock list) | **Fixed:** Recaps lists graded drafts and opens DraftRecap |
| Drafts → "Live draft tracker" type (a manual tracked board) | Kept as a board type, but relabelled "Manual tracker" so it is not confused with the ESPN live link |
| Duplicate `h1`s | One page title per area |

### Settings

| Old place → feature or number | New place |
|---|---|
| Settings → local sign-in card, ESPN connect card, manual steps, phone pairing (code, tunnel, devices), league chat pull, player / news pulls | Settings → Connections |
| EspnConnectGate (app-wide modal) | Kept as the first-run prompt, rendering the same one ESPN flow |
| NumberHealth card and nav dot, DataFreshness detail table, DevHub "Live data" | Settings → Health, one view. The header health chip opens it. |
| DevHub → API key, workspace id, usage (today / 30 days, per feature), identity audit | Settings → AI &amp; developer |
| Model (no route) → accuracy (MAE, RMSE, bias, R², Spearman, top-36, CRPS, coverage, calibration, weekly decisions), correlation, game script, availability, handcuffs | Settings → Model diagnostics (**revived**, read-only) |
| Model → championship odds tab | **Cut, duplicate:** the same endpoint as My Team (1,500 vs 2,000 runs) |

## 5. Redirects: no old link breaks

| Old URL | New URL |
|---|---|
| `/league?view=team` | `/my-team` (unchanged) |
| `/league?view=connections`, `/leagues` | `/league` (Your leagues is the default tab) |
| `/lineup` | `/my-team?view=lineup` |
| `/trade-lab` | `/trades?view=find` |
| `/trade-lab?tab=…` | the matching Trades view: `news` → `news`, `find` → `find`, `title` → `find&sort=title`, `target` or `goget` → `goget`, `mock` → `build`, `dvp` → `/players/teams?view=matchups` |
| `/trade-brain` | `/trades?view=goget` (the War Room hero lives on Today; `/trade-brain?view=war-room` goes to `/`) |
| `/trade-brain?view=managers`, `?view=proposals` | `/trades?view=people` |
| `/teams`, `/teams/:abbr` | `/players/teams`, `/players/teams/:abbr` |
| `/news` | `/players?view=news` |
| `/rankings` | `/players?view=rankings` (was `/league`) |
| `/projections` | `/players?view=board` (was `/league`) |
| `/drafts`, `/live-draft` | `/draft`, `/draft?view=live` (unchanged) |
| `/drafts/:id` | `/draft/:id` |
| `/live-draft/:id` | `/draft/live/:id` |
| NotFound links | Fixed to the seven areas |

**Tests for the redirects.** `test/route-deletion-impact.test.js` covers server API routes with no caller, not client URLs. It stays green, because no API route loses its last caller: every page's API calls move with its features. The first execute PR adds `test/ui-redirects.test.js`. It reads `App.tsx` and asserts one `Navigate` per old URL above to its target. It also asserts that `/draft/:id`, `/draft/live/:id` and `/players/:id` still render pages and do not redirect. It follows the same source-reading pattern as `test/ux-11-my-team-tab.test.js`.

## 6. Duplicate components: one pick each

| Renders the same thing | Today | Keep, as a design-system primitive |
|---|---|---|
| Player chip | `PlayerPill` (TradeCard), War Room player chip and `Faces`, hand-built `Headshot` rows (MyTeam ×2, PostDraftPlan) | `PlayerChip`: avatar, name, position, team, optional number |
| Player list row | `PlayerRow`, Lineup `Slot`, Rankings / Projections rows, DraftRoom rows | `PlayerRow` (extended with slot and confidence) |
| Player picture | `Headshot`, War Room `Avatar`, DS `Avatar` | DS `Avatar` (ESPN only, initials fallback, no layout shift) |
| Trade card | `TradeCard`, PostDraftPlan trades (text), TradeLab title-trades card, `ProposalCard`, War Room `HeroCard` / deck card, flip card | `TradeCard` with a `hero` variant and a `flip` variant: one give/get block, one number row, one action row |
| Chance he says yes | ManagerRead band, HeroCard, deck, Go get steps, Negotiate, Market both-yes | `ChanceStat`: value, band when served, guess pill |
| Title odds and change | 7 displays | `OddsStat`: now → after, change, ±SE, noise pill |
| Copy a message | `CopyLine`, War Room `CopyButton` / `CopyBlock`, TradeCard pitch copy | `CopyText` (blocked-clipboard fallback, one look) |
| Manager card | ManagerBoard row, ManagerRead, War Room League card, People tile | `ManagerCard` |
| Evidence strip | `EvidenceStrip`, `PlayerEvidence`, TradeLab PlayerOutlook inline | `PlayerEvidence` |
| Lineup table | MyTeam starters / bench, PostDraftPlan best lineup, CeilingLineup rows, Lineup slots | `LineupTable` |
| Self-scout fixes | TeamScout, PostDraftPlan | TeamScout's list |
| News list | News archive, TeamDetail news, PlayerDetail news | `NewsList` with filters |
| ESPN connect | `EspnConnect`, `EspnConnectGate`, Leagues ESPN form | One `EspnConnect` flow; the gate and the form render it |
| Health | NumberHealth card and dot, DataFreshness table, DevHub live data, War Room HealthSheet | One Health view plus the header chip |
| Page title | per-page `h1` + `PageHeader` + nested `h1`s | DS `PageHeader` once per area |

Replaced components are deleted in the PR that replaces them. No dead duplicates are left behind.

## 7. Duplicate numbers: for a server unit

The UI shows each number once, from the canonical producer below. Changing producers is not in this plan; these rows are handed to a server unit.
The number audit (`server/services/number-audit.js`) already flags A to D.

| # | Number | Producers today | Canonical (proposed) | UI rule until fixed |
|---|---|---|---|---|
| A | Title odds / playoff odds | `/model/:id/simulate` → `simulateSeason` (My team, and the unrouted Model page at 1,500 vs 2,000 runs), unseeded; `tradeImpact` / `tradeImpactWorld` / `leagueWorld` (TradeCard, title-trades, War Room plans, his screen, Negotiate) | `tradeImpact` world, which every trade number already uses | Shown once in the header (from the war-room plan's `title_now` where present). My Team labels its own odds with their source until A is fixed. |
| B | Weekly range / floor–ceiling | `lineupSpread` (trade card, My team), season-sim pools, `ceilingLineup`, `lineupPosture`, `lineupCall` objectives. Percentiles differ: 10/90, 20/80, p20–p80 preseason, p10–p90 lookahead. | One sampler and one percentile pair | One weekly range on My Team → Overview, labelled with its percentiles; the second copy is removed |
| C | Current week | `tradeWeekContext`, `leagueCurrentWeek`, `simStartWeek` | One week producer | The header shows the week from the league. Pages do not print their own. |
| D | Chance he says yes | `acceptanceBand` live (TradeCard); the same model from an offline snapshot (War Room plans, `clone.accept`); `negotiate-engine` | One read of `acceptanceBand` for a given offer | `ChanceStat` shows the served value with its source; the same offer never shows two chances on one screen |
| E | Receptiveness | `checkedOutFactor` and `activity.manager` both adjust it (the audit's checked_out check) | Apply one | Shown once, on the manager card |
| F | "Will he still be there" (draft) | `draftSurvival` (hub), `goneBy` in draft-assist (live), lookahead `sniped_pct` | One | Each page shows its own until fixed, labelled |
| G | Value over replacement | `vorBoard` (DraftRoom, Edge), `rankTargets` vorp (LiveDraft) | One | Labelled per page |
| H | Projected points (draft) | DraftRoom `statsMap`, LiveDraft ESPN+model blend | One | Labelled per page |
| I | Player value / rankings | FantasyCalc, blended consensus, internal model value, dynasty age-adjusted value | FantasyCalc for market value; the model for our value; labelled | Every value says which it is |
| J | FantasyPros | Never shown, but `fp_ros_rank`, `fp_rank`, `fp_pos_rank` and `fp_prev_rank` reach the client in the blue-chip payload, and LiveDraft's Claude prompt includes FantasyPros takes | Server should stop sending the rank fields to the client | The UI never renders them; a test asserts no FantasyPros text on any area |

## 8. Execution order (one area per PR, each from the latest `main`)

1. **Shell and Today.**
   - Seven-item navigation and every redirect in section 5, plus `test/ui-redirects.test.js`.
   - The header takes the league picker, title odds and health chip; Coach becomes an app-wide drawer.
   - Today is built from the War Room hero and deck, CommandCenter, Watching and the lineup alert.
   - NotFound's links are fixed.
2. **My Team** (merges Lineup; the parked presentation work from this week comes with it).
3. **League.**
4. **Players** (revives Rankings and Projections; moves Teams and News in; one `NewsList`).
5. **Draft** (URL moves; recaps fix; one title).
6. **Settings** (one Health view, one ESPN flow, AI &amp; developer, model diagnostics).
7. **Trades, last.**
   - Waits for RULES-EVERYWHERE, and reads its filtered suggestions only.
   - Retires TradeLab, TradeBrain's tabs and the classic War Room dashboard.
   - Moves in the one `TradeCard`, `ManagerCard` and `ChanceStat`.

Each PR must:
- delete what it replaces;
- use only the design-system primitives;
- pass the overflow / clip / overlap scan at 375, 768, 1024, 1440 and 1920 in light and dark, with 0 long tasks and a click audit;
- pass the full gates;
- carry before/after shots;
- include a Measured section with a "before → after" line and the tree sha.

## 9. Decisions for Nick

1. **Cut Edge's unreachable boards** (boom/bust, efficiency, breakouts, playoff schedule, season simulator)? They duplicate live views (section 4, Players). The VOR column is kept.
2. **Seven sidebar items instead of eight:** the eight-item test pin changes with it.
3. **The classic War Room dashboard is retired** when Trades lands.
4. **News lives under Players**, with my players' headlines on Today, rather than as its own area.
