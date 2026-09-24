# WAR ROOM UI: the north star's screen, inside Trade Brain (design, 2026-09-23 night; local, not committed)

**Next action for Nick:** open `war-room-mock.html` (same folder) in a browser. Top-right buttons switch light/dark, phone/desktop, and "show broken states". About 3 minutes.

- **What it is:** the War Room is a new first tab inside Trade Brain (`/trade-brain?view=war-room`). Nav stays 8 tabs. No App.tsx route is added. The two existing tabs ("Who trades with you", "Sendable proposals") stay unchanged. Retired routes (`/brain/plan`, `/brain/sell-high`, trades.js:185/:201) are **not** revived; the War Room reads one new view.
- **One screen = one decision.** The decision is always "send this message to this manager, yes or no". Everything else on the page supports that decision or is folded away.
- **Sources read:** ENGINE-SPECS.md ACQ-01 + FLIP-01, CAMPAIGN-01a-g, EVAL-01, BROKEN-01, HEALTH-01, ENGINE-SPECS-UI (UI-RED rules), ARCHITECTURE UNITS EA-00..EA-12; PLAN v11/v11.1; UI-STANDARD.md; UI-REVAMP.md; ui/UX-02-ia.md. Client on **origin/main `a6a77824`**: `pages/TradeBrain.tsx` (134 lines, `TABS` at :35), `components/brain/{ManagerBoard,CopyLine,ProposalSlate,types}.tsx`, `components/trade/ManagerRead.tsx` (`Band` :81), `components/TradeCard.tsx`, `components/ui/DesignSystem.tsx` (`Provenance` :57, `Confidence` :48, `Sheet` :89, `Skeleton` :85), `navigation.ts:38-49` (8 items), `App.tsx:131-160`, `index.css` (`:root` tokens, **no dark tokens yet**), `server/services/preview-mode.js` (#214).
- **Prototype:** `scripts/study/acq-flip-proto.mjs` (worktree `wt/ACQ-FLIP-proto`, at `a6a77824`). Its report `~/gridiron-local/rnd/meta/acq-flip-proto.md` had **not landed** when this was written (the run was still going, started 8:13 PM). The contracts below map to the script's `--json` output shape, read from the code (`res.baseline`, `res.flip`, `res.acq`, `res.names`), not from a finished run.

---

## 1. Screen hierarchy

```
Trade Brain  (existing page, existing league switcher)
└─ tabs: [War Room]* | Who trades with you | Sendable proposals      * only when the view says enabled
   └─ War Room (one league at a time; league = the active league from useLeague)
      0. Top strip ........ goal · risk mode · title odds now vs plan · brain dot · number-health dot
      1. NEXT MOVE ........ the decision (big): message + copy, who, why, P(yes), odds effect, walk-away
      1b. IF HE SAYS ...... reply table: accept / decline / counter / no reply -> what to do (message ready)
      2. DESTINATION ...... odds now vs planned path (small chart), ground lost, cheapest catch-up
      3. ITINERARY ........ stops in order (get X, sell Y, cover bye) + "Add a stop" -> Coach trade-off sheet
      4. TARGETS .......... suggested targets (approve) or choose your own; speed curve (arrive by week N)
      5. FLIP MAP ......... biggest buy-from-A / sell-to-B gaps
      6. IS THE BRAIN WORKING? E1-E7 statuses + what that blocks
```

Order rule: 0 and 1 are always above the fold on a phone. 1b is open by default only after a message is marked sent. 2-6 are collapsed cards on phone (one line each, tap to open); open on desktop.

### Desktop (>= 1024 px, max width 1100 px like the page Shell)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 0 TOP STRIP  Goal: win the title · Balanced ▾ · 11.8% now, plan 13.4% · ●brain ●health │
├───────────────────────────────────────────────┬──────────────────────────────┤
│ 1 NEXT MOVE (8 cols)                          │ 2 DESTINATION (4 cols)        │
│   Send this to Team 7            [Copy]       │   odds path chart, ground lost│
│   message block                               │ 6 IS THE BRAIN WORKING?       │
│   P(yes) · odds effect · walk-away · why ▸    │   E1..E7 rows                 │
│   [I sent it]                                 │                              │
│ 1b IF HE SAYS (table, 4 rows)                 │ 4 TARGETS + SPEED CURVE       │
│ 3 ITINERARY (stops) [+ Add a stop]            │                              │
├───────────────────────────────────────────────┴──────────────────────────────┤
│ 5 FLIP MAP (full width table, top 5, "show all" opens a Sheet)               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Phone (375 px, no horizontal scroll, thumb-reachable actions)

```
┌─────────────────────────────┐
│ 0 strip (2 lines, wraps)    │
│ 1 NEXT MOVE (full)          │
│   message + Copy (big)      │
│   P(yes) | odds | walk-away │  3 tiles in a row, 1 line each
│   Why ▸  (opens Sheet)      │
│ 1b If he says ▸ (collapsed) │
│ 2 Destination ▸ one line    │
│ 3 Itinerary ▸ "3 stops"     │
│ 4 Targets ▸                 │
│ 5 Flip map ▸                │
│ 6 Brain check ▸             │
├─────────────────────────────┤
│ sticky bottom bar:          │
│ [Copy message] [I sent it]  │  the two actions, always under the thumb
└─────────────────────────────┘
```

Desktop adds columns, never content (UI-STANDARD 7). Tables become stacked rows under 640 px.

---

## 2. One read, one contract

### 2.1 Transport

- **One fetcher:** `client/src/components/warroom/useWarRoom.ts` is the only code that fetches for this tab. Today it calls `GET /api/trades/:leagueId/war-room`; once EA-03 lands it becomes `useEngineView('war_room', leagueId)` (one-file switch). No component calls `api(`/`useApi(` (UI-RED 1, grep test).
- **No arithmetic on engine values** in the client beyond formatting (UI-RED 1). Every gap, delta, spread, "ground lost" and "net" is a producer field.
- **One snapshot:** the response carries `snapshot {id, as_of}`; every section reads that snapshot, so the next move, itinerary and destination can never disagree (EA-03 "two views at one snapshot agree").

### 2.2 The typed field (every section is one)

```ts
type FieldStatus = 'ok' | 'zero' | 'thin' | 'stale' | 'fallback' | 'unknown' | 'failed';

interface Field<T> {
  status: FieldStatus;
  value?: T;                 // present only for ok | zero | thin | stale | fallback. NEVER for failed or unknown (server strips it; test)
  reason?: string;           // plain words: why unknown / what it fell back to / what failed
  as_of?: string;            // ISO
  age_sec?: number;          // for stale
  n?: number;                // for thin: "thin (n=3)"
  producer: string;          // e.g. 'acq-planner' | 'acq-flip-proto'
  producer_version: string;
  source: SourceId;          // key into SOURCES (2.3)
  preview?: boolean;         // on only because of preview mode -> "Preview, unconfirmed" tag
  preview_reason?: string;
  health?: 'ok' | 'stale' | 'degraded' | 'failed';   // HEALTH-01, when the spine exists
}

interface Num { value: number; se?: number; clears_2se?: boolean; source: SourceId; preview?: boolean; guess?: boolean; }
```

Rules (from UI-RED 2-3 and HEALTH-01b): a `failed` field renders "This number failed its check, so it is hidden. <reason>. <what to trust meanwhile>", in red text, **with no digits**. `unknown` renders "Not computed yet: <reason>" in grey. A missing field is never 0 and never "—". A `Num` whose source is not calibrated carries the amber guess label.

### 2.3 Source labels (every number shows one)

`SourceTag` renders `SOURCES[id].label` as a small pill; tap opens `Provenance` (DesignSystem.tsx:57) with version and as-of. `calibrated:false` adds the amber "guess" pill; `preview:true` adds the grey-outlined "Preview, unconfirmed" pill.

| SourceId | label on screen | calibrated today? | producer (engine) | tonight (prototype) |
|---|---|---|---|---|
| `sim.title` | "Season sim, 1,200 runs" | no (E3 pending) | `title.odds`, `action_price` (EA-06 / CE-09) | `tradeImpactWorld` deltas in `acq.best.steps[i].delta/se/clears` |
| `clone.accept` | "Trade model: chance he says yes" | no (E1 pending) | `blend.p_accept` (CLONE-01b, EA-11c) | `steps[i].p` = acceptanceBand midpoint; **always preview + guess** |
| `clone.price` | "His price (from his moves)" | no | CLONE-01a clone price | `flip.top[i].price_a/price_b`, `mult_a/mult_b` (counterparty-pricing multiplier x FantasyCalc) |
| `market.fc` | "FantasyCalc market value" | yes (TM-09 test) | `market.player_value` (EA-04) | `screenFair()` inputs (not persisted) |
| `plan.path` | "Planner, N paths searched" | no (E4 pending) | ACQ-01 / CAMPAIGN-01b path | `acq.best`, `acq.fallback`, `acq.candidates_scored` |
| `coach.text` | "Written by Coach, facts checked" | n/a (verify.js) | CAMPAIGN-01b playbook | not produced |
| `eval.check` | "Brain check E1-E7" | n/a | EVAL-01 grader (EA-04) | not produced |
| `audit.numbers` | "Number check" | n/a | BROKEN-01a `number_audit`, HEALTH-01 | not produced (BROKEN-01 not on main) |

Design stance: **nothing on the War Room is green tonight.** UI-STANDARD 5 reserves green for a verified gain; until E1/E3/E5 pass, a title-odds rise that clears 2 SE renders in ink with an up arrow, and one inside 2 SE renders grey ("inside the noise"). Amber = guess, red = risk. Green switches on per source when its EVAL check passes (the `calibrated` flag in `SOURCES` comes from the brain-check field, not a constant).

### 2.4 The view (`war_room`)

```ts
interface WarRoomView {
  enabled: boolean;                 // false -> the tab is not rendered at all
  preview?: boolean; preview_reason?: string;
  league_id: number; me: string;    // team ids only in fixtures and logs
  snapshot: { id: string; as_of: string };
  names: Record<string, string>;    // player id -> "Name (POS)"; managers are "Team <id>" unless the in-app name map is present
  destination: Field<Destination>;
  next_move:   Field<NextMove>;
  itinerary:   Field<Itinerary>;
  suggestions: Field<Target[]>;
  speed_curve: Field<SpeedPoint[]>;
  flips:       Field<Flip[]>;
  brain_check: Field<BrainCheck>;
  number_health: Field<NumberHealth>;
}
```

---

## 3. Components and their data contracts

Files live in `client/src/components/warroom/`. Shared pieces reused, not copied: `CopyLine` (brain/CopyLine.tsx), `Sheet`, `Skeleton`, `Provenance`, `EmptyState`/`PageError` (PageState.tsx). If EA-03 has merged by build time, `EngineValue.tsx` / `ReasonChain.tsx` replace `FieldState.tsx` / `WhyChain.tsx` (same props).

### 3.0 `TopStrip.tsx`: goal, mode, odds now vs plan, two dots

Reads `destination.value.{goal, risk_mode, title_now, title_planned_now}`, `brain_check.value.overall`, `number_health.value.status`.

```ts
interface Destination {
  goal: { kind: 'title' | 'playoffs' | 'points'; points_per_week?: number; label: string };   // campaign.objective (CAMPAIGN-01a)
  risk_mode: 'safe' | 'balanced' | 'all_in';  // shown as Safe / Balanced / "Fuck it, let's go" (CAMPAIGN-01d)
  arrive_by?: number;                          // week (CAMPAIGN-01g)
  title_now: Num;                              // title.odds (EA-06)
  title_planned_now: Num;                      // where the plan said we'd be this week (campaign.trajectory)
  path: { week: number; planned: number; actual?: number }[];   // producer-written; client only draws
  ground_lost: Num | null;                     // producer field: planned_now - now, signed (CAMPAIGN-01g)
  catch_up: { text: string; gain: Num; steps: number } | null;  // "cheapest way back"
}
```

| field | engine producer | prototype (tonight) |
|---|---|---|
| goal, risk_mode, arrive_by | `campaign.objective` (CAMPAIGN-01a/d/g) | **not produced**; adapter writes `unknown` "No goal set yet" |
| title_now | `title.odds` | **not persisted**: `tradeImpact` returns `me.title_before`, the script drops it. One-line fix: store `res.acq.title_now = rescore(new Map()).me.title_before` |
| title_planned_now, path, ground_lost, catch_up | `campaign.trajectory` (CAMPAIGN-01c/g) | **not produced** |

Line text: `Goal: win the title · Balanced · 11.8% now → plan 13.4% by wk 7 · ● Brain: not proven · ● Numbers: 1 warning`. Dots: brain dot = grey (not enough data) / amber (some failing, fell back to Balanced) / red (a check failing that blocks this plan) / green (all passing). Health dot = BROKEN-01b's nav dot, read from the same `number_health` field (grey "not checked yet" until BROKEN-01a exists; never green by default).

### 3.1 `NextMoveCard.tsx`: the decision

Three-line rule (UI-STANDARD 3): **what** (send this to Team 7), **why** (one line, cited), **what to do** (Copy, then I sent it). Everything else is behind "Why" (Sheet) or in the tiles.

```ts
interface NextMove {
  step_index: number; of_steps: number;          // "Step 1 of 2"
  partner: string;                               // team id
  give: string[]; get: string[];                 // player ids
  message: { text: string; source: 'coach.text'; checked: boolean } | null;   // CAMPAIGN-01b; null -> typed unknown
  p_yes: Num & { band?: { low: number; high: number } };   // clone.accept
  odds_effect: { before: Num; after: Num; delta: Num };    // action_price for this step
  path_effect: { delta_final: Num; p_complete: number; expected: Num } | null;  // plan.path
  walk_away: { text: string; max_give: string[] } | null;  // CAMPAIGN-01b concession schedule
  send_when: string | null;                      // "tonight, before Thu kickoff"
  why: { text: string; delta?: Num; source: SourceId }[];  // reason chain v2 contributions
  vs_finder: { finder_expected: Num; this_expected: Num } | null;  // "beats the finder's best single offer by X"
  sent: { at: string } | null;                   // offer.sent event exists
}
```

| field | engine producer | prototype `--json` |
|---|---|---|
| partner, give, get | ACQ-01 path step | `acq.best.steps[0].team / give[] / get[]`, names from `names[id]` |
| p_yes | `blend.p_accept` | `acq.best.steps[0].p` (band not persisted; show point + "guess") |
| odds_effect.delta | `action_price` | `acq.best.steps[0].delta`, `.se`, `.clears` |
| odds_effect.before/after | `title.odds` + `action_price` | **gap**: needs `title_now` (above) |
| path_effect | ACQ-01 | `acq.best.delta_final`, `p_complete`, `expected`, `expected_se` |
| vs_finder | ACQ-01 vs TM-01 | `baseline.best_expected.expected` (+ `expected_se`) vs `acq.best.expected` |
| message, walk_away, send_when | CAMPAIGN-01b + COACH-01 | **not produced** |
| why (reason chain) | reason_chain v2 on each field | **not produced** (priceStep's `basis` is computed and dropped) |
| sent | `offer.sent` event (EA-04) | not produced |

When `message` is unknown, the card still shows the deal ("Offer Team 7: M. Oduya + T. Kline for C. Ruiz") and the line "Message not written yet: Coach's playbook is not live." The Copy button copies the deal line instead, labelled "Copy the deal".

### 3.2 `ReplyTable.tsx`: "If he says ..."

```ts
interface Reply {
  kind: 'accept' | 'decline' | 'counter' | 'silence';
  when?: string;                     // silence: "no reply in 24 h"
  do: string;                        // plain: "Send step 2 to Team 2"
  message?: string;                  // ready-to-copy text for that branch
  odds_after?: Num;                  // the branch's title odds (producer field)
  counter_rules?: { accept_if: string; counter_with: string; walk_away_if: string };
}
```

Producer: CAMPAIGN-01b `campaign.playbook[step].replies`. Prototype: only the **decline** branch has data, as `acq.fallback` (the best other plan sharing the prefix); accept = `acq.best.steps[1]` if depth > 1; counter and silence **not produced**. Rows with no data render "Not planned yet" (unknown), never hidden, so Nick sees the table is incomplete.

### 3.3 `DestinationCard.tsx`

Reads `destination` (3.0). A small SVG line chart: planned path (dashed) vs actual (solid) by week, deadline week as a hard vertical wall. Below: "Ground lost: 1.1 pts since Tue (Team 7 declined)" and "Cheapest way back: <catch_up.text> (+0.9, 1 step)". All values producer-written; the chart draws points, it computes nothing.

### 3.4 `Itinerary.tsx` + `AddStopSheet.tsx`

```ts
interface Itinerary {
  version: number;                              // campaign.itinerary is versioned; nothing silently dropped
  stops: Stop[];
  untouchables: string[];
  conflicts: { text: string }[];                // "getting Y means selling Z, which is untouchable"
}
interface Stop {
  id: string; order: number;
  kind: 'get' | 'sell' | 'flip' | 'claim' | 'cover_bye' | 'custom';
  label: string;                                 // "Get C. Ruiz (RB) from Team 7"
  status: 'next' | 'waiting' | 'done' | 'dropped' | 'blocked';
  added_by: 'plan' | 'nick' | 'coach';
  p_yes?: Num; odds_after?: Num;
}
interface StopPreview {                          // Coach trade-off (CAMPAIGN-01f), same dice
  stop_label: string;
  cost: Num; extra_steps: number;
  gain: Num; gain_text: string;
  net: Num; verdict: 'worth_it' | 'not_worth_it' | 'close';
  because: string;
  new_next_move_changes: boolean;
}
```

| field | engine | prototype |
|---|---|---|
| stops from the plan | `campaign.itinerary` | `acq.best.steps[]` mapped to `get` stops; `chained` true -> the middle stop is a `flip` |
| p_yes / odds_after per stop | ACQ-01 | `steps[i].p`, `steps[i].delta` |
| Nick-added stops, untouchables, conflicts, version | CAMPAIGN-01f | **not produced** |
| StopPreview | CAMPAIGN-01f (`campaign.preview` request) | **not produced** |

### 3.5 `TargetPicker.tsx` + `SpeedCurve.tsx`

```ts
interface Target {
  player: string; owner: string;
  gain_if_landed: Num;           // title-odds gain if acquired
  p_reach: Num;                  // P(end holding him) from the ACQ search
  mode_fit: 'fits' | 'needs_all_in' | 'too_risky_for_safe';
  why: string;                   // one line
  approved: boolean;
}
interface SpeedPoint { arrive_by: number; cost: Num; net: Num; variance_note: string; offers_used: number; before_deadline: boolean; }
```

| field | engine | prototype |
|---|---|---|
| player, owner | `campaign.suggestions` (CAMPAIGN-01a) | `acq.targets[]` (top 3 ids), owner from `acq.best.owner` only for the chosen one |
| gain_if_landed | same | **not persisted**: `addN.get(target)` exists in memory; store it |
| p_reach | same | only for the target of `acq.best` (`p_complete`); others **not persisted** (per-target best plan is sorted away) |
| mode_fit, why | CAMPAIGN-01a/d | **not produced** |
| speed curve | CAMPAIGN-01g | **not produced** |

"Choose your own": a search box over the league's rostered players (existing player search), which writes an objective request; until the planner answers, the target shows "Planning, usually a few minutes" (loading), never a made-up path.

### 3.6 `FlipMap.tsx`

```ts
interface Flip {
  player: string; buy_from: string; sell_to: string;
  spread: Num;                                  // title-odds spread (dB + dA), producer-written
  price_a: Num; price_b: Num;                   // clone prices
  legs: { give_a: string; get_b: string; p1: Num; p2: Num; p_both: number; nick_after: Num } | null;
  legs_why_not?: string;                        // "no fair one-player leg"
}
```

| field | engine | prototype |
|---|---|---|
| player, buy_from, sell_to, spread (+se, clears) | FLIP-01 `flip.pairs` | `flip.top[i].player / a / b / spread / se / clears` |
| price_a, price_b | CLONE-01 clone price | `flip.top[i].price_a / price_b` (+ `mult_*`) |
| legs | FLIP-01 realised | `flip.realised[i].legs.{give_a, get_b, p1, p2, p_complete, d2, se2, clears2}`; `why` when null |

Ranked by the producer's order (FLIP-01 ranks by spread x P(A) x P(B) x days left; the prototype sorts by spread). Top 5 shown; "Show all" opens a Sheet. Row text: "Buy K. Bell from Team 5, sell to Team 8. Gap 2.4 pts (both fair on their screens). Both say yes: 14%."

### 3.7 `BrainCheckCard.tsx`

```ts
interface BrainCheck {
  overall: 'passing' | 'not_enough_data' | 'failing';
  checks: { id: 'E1'|'E2'|'E3'|'E4'|'E5'|'E6'|'E7'; name: string; status: 'passing'|'not_enough_data'|'failing'|'running'|'not_run';
            result?: string; bar: string; n?: number; as_of?: string }[];
  blocks: string[];               // "All-in mode's test-tier signals are off because E1 has not passed"
  fell_back_to?: 'balanced';
}
```

Producer: EVAL-01 grader rows (EA-04 `grade.*`). Prototype: **not produced**. Tonight the adapter writes E1-E7 as `not_run` except where the overnight E1/E3 historical validation writes a result file (OPS-LOG 00:21Z); it reads that file only if it names its pass bar and n. Plain names on screen: E1 "Does 40% mean 40%? (chance he says yes)", E2 "Are our offers priced right?", E3 "Does 20% title odds mean 20%?", E4 "Does the planner beat simple moves?", E5 "Did each step really help?", E6 "Following the brain vs ignoring it", E7 "Luck vs decisions (Mondays)".

### 3.8 `HealthDot.tsx` (Number health)

```ts
interface NumberHealth { status: 'ok' | 'warn' | 'broken'; open: { check_id: string; text: string; pages: string[]; trust_meanwhile: string; as_of: string }[] }
```

Producer: BROKEN-01a `number_audit` (GET `/api/number-audit`, BROKEN-01b) and later HEALTH-01 rows (BROKEN-01c). Not on main tonight: the field is `unknown` ("Number check not built yet"), shown as a grey dot, never green. Tap opens a Sheet with the open problems, filtered to the numbers this page shows.

### 3.9 `FieldState.tsx`, `SourceTag.tsx`, `WhyChain.tsx`

Shared by every card above. `FieldState` switches on `status` and renders the typed state; children render only for `ok|zero|thin|stale|fallback`. `SourceTag` per 2.3. `WhyChain` renders `why[]` as signed rows (DriverBars style), each with its source.

---

## 4. States (designed, not defaulted)

| state | what the card shows | example copy |
|---|---|---|
| loading | Skeleton with the card's shape (3 lines for NextMove) | none |
| empty (no objective) | NextMove is replaced by the target picker: "No goal set. Pick a target, or approve one of these 3." | "Pick who we go get" |
| empty (plan found nothing) | "No path to D. Harlow clears the noise this week. Nearest: +0.4 ± 0.6. Try another target or All-in mode." | producer-written reason |
| unknown | grey, "Not computed yet: <reason>" | "Speed curve not computed yet: the planner does not price deadlines yet." |
| thin | amber, "thin (n=3)" beside the number | "P(yes) 38% · guess · thin (n=2 offers to him)" |
| stale | number shown with age; amber when past max age | "11.8% · 9 h old" |
| fallback | number shown with "fell back to X" | "P(yes) from activity only: the trade model failed its check" |
| failed | red line, **no digits**, reason + what to trust | "Title odds failed a check (odds sum to 3.4, should be 4). Hidden. Trust the Title tab from Tuesday." |
| preview | grey-outlined "Preview, unconfirmed" pill on the value, plus the page banner | banner: "Preview (unconfirmed forward): these plans come from a study run, not the live engine." |
| flag off | tab not rendered at all; Trade Brain looks as it does today | none |
| error (request failed) | PageError inside the tab, with Retry; other tabs keep working | "Could not load the War Room: server returned 500. Retry." |

Page-level: if `next_move` is failed or unknown, the top of the page says so in one line and the rest still renders. One failed card never blanks the page (error boundary per card, UX-06).

---

## 5. Interaction flows

Writes go through **daemon requests** (EA-02/EA-03 request queue: `POST /api/engine/request {kind, league_id, payload}` -> `GET /request/:id`), so the UI never computes a plan. Until that queue exists, every write button is disabled with a typed reason ("Setting goals turns on with the engine queue"); **Copy works from day one.**

1. **Set objective** (goal + optional arrive-by week). Tap the goal in the top strip -> Sheet: Title / Playoffs / "X points a week" (number input) + "Arrive by week" select (only weeks before the deadline). Save -> request `campaign.objective.set` -> card shows "Replanning, usually a few minutes" -> new snapshot renders. Reversible; no confirm. Versioned (old goal in history).
2. **Approve a target.** In Targets, each row has "Go get him". Tap -> one confirm line ("This replaces your current target, D. Harlow. The plan restarts.") only if a target already exists -> request `campaign.objective.set {target}`. "Choose your own" = search -> same request.
3. **Send the message.** Nick copies (CopyLine, falls back to select-all over plain HTTP) and sends it himself in ESPN/Sleeper/group chat; the app never sends. Then "I sent it" -> logs `offer.sent` (confirm not needed: it is a log, with Undo for 10 minutes) -> the reply table opens and the step shows "Waiting on Team 7 since 9:40 PM".
4. **Log a reply.** In the reply table, four buttons: He accepted / He declined / He countered / No reply yet. Counter opens a small form (what he asked for, pick players). Each writes `offer.reply` -> the pre-computed branch shows instantly (from the playbook already in the snapshot), and the daemon replans; if the best move changed, the banner says "New next move: <why it changed>".
5. **Change risk mode.** Tap the mode in the top strip -> Sheet with 3 options, each with its plain meaning and, from the producer, the same-dice comparison ("Balanced: 13.4% expected, All-in: 11.9% expected but 6.1% chance of a title run vs 4.8%"). All-in shows a red line when a brain check blocks its test-tier signals. Apply -> confirm ("Your plan and messages will change") -> request `campaign.mode.set`.
6. **Add a stop** (CAMPAIGN-01f). "+ Add a stop" -> Sheet: plain text box ("I'm scared of the week-9 TE bye") or quick picks (get a player / sell a player / cover a bye / make someone untouchable). Submit -> request `campaign.stop.preview` -> the Coach trade-off panel: "Adding this costs 0.4 title pts and 1 extra step. It gains 0.7 in week 9. Net +0.3: worth it, because <reason>." Buttons: Add it / Don't. Add -> `campaign.stop.add`. Conflicts render in red above the buttons ("This sells J. Pike, who is untouchable").

---

## 6. Flag and preview

- **Flag:** `GRIDIRON_WARROOM_ENABLED`, default off. Read in one place, `server/services/warroom-flag.js`: `warRoomEnabled() = env === '1' || previewUnconfirmed()`; when on only because of preview, the view carries `previewFields('War Room plans come from a study run, not the live engine')` and every sentence is prefixed with `PREVIEW_PREFIX`. `preview-mode.js`'s header list of converted sites gains the War Room line. `test/preview-mode.test.js` keeps passing (only preview-mode.js reads `GRIDIRON_PREVIEW_UNCONFIRMED`).
- **Off** = the route answers `{ enabled: false }` (200) and the client does not render the tab; Trade Brain is byte-for-byte today's page.
- **Pre-spine data source (tonight to EA-03):** the adapter reads one local JSON file named by `GRIDIRON_WARROOM_SOURCE` (the prototype's `--json` output). If unset, every field is `unknown` "No plan has been run for this league yet". This source is **preview only**: when the flag is on without preview, the adapter refuses the study file and serves `unknown`. fly.toml sets neither variable.

---

## 7. BUILD PLAN (3 units; lean, Sonnet builder, UI skeptic screenshots every state)

### WR-1: the read path and the decision card (about 1 day)
- **Server:** `server/services/warroom-flag.js` (new), `server/services/war-room-view.js` (new: builds `WarRoomView` from the prototype JSON or returns typed unknowns; strips `value` from failed/unknown; maps `acq.best`, `acq.fallback`, `baseline.best_expected`), `server/routes/trades.js` (one `r.get('/:leagueId/war-room')`, read-only, no producer import, no computation in the request), `preview-mode.js` (header comment only).
- **Client:** `client/src/components/warroom/{types.ts, useWarRoom.ts, WarRoom.tsx, FieldState.tsx, SourceTag.tsx, WhyChain.tsx, TopStrip.tsx, NextMoveCard.tsx, ReplyTable.tsx, BrainCheckCard.tsx, HealthDot.tsx}`; `pages/TradeBrain.tsx` (a third `TABS` entry shown only when `enabled`; `?view=war-room` via `useSearchParams`; default tab when enabled).
- **Tests:** `test/war-room-view.test.js` (flag off -> `enabled:false`; preview -> `preview:true` + prefix; failed and unknown fields carry no `value`; missing JSON -> all unknown; fixture from a trimmed prototype output maps step 0 byte-for-byte: team, give, get, p, delta); `test/war-room-surface.test.js` (house source-level style: only `useWarRoom.ts` fetches; no arithmetic on `.value` outside formatters; `navigation.ts` still 8 items; no new `<Route` in App.tsx; every state string present; no manager names in fixtures).
- **Acceptance:** UI-RED 1-6; screenshots: normal, unknown-heavy (tonight's real state), failed, phone 375, dark (see WR-2 note).

### WR-2: the map (itinerary, destination, targets, speed curve, flip map) + phone layout (about 1 day)
- **Client:** `Itinerary.tsx`, `DestinationCard.tsx` (SVG path chart, draws only), `TargetPicker.tsx` (read-only list + disabled approve), `SpeedCurve.tsx`, `FlipMap.tsx` (+ "show all" Sheet), phone sticky action bar, per-card error boundaries.
- **Server:** extend `war-room-view.js` to map `flip.top`, `flip.realised`, `acq.targets`, `acq.best.steps[]` to stops.
- **Dark mode:** `index.css` has only `:root` tokens today. WR-2 uses tokens only (`var(--ink)`, `--surface`, ...) and, if UX-03 has not added dark tokens yet, adds the `prefers-color-scheme: dark` + `[data-theme="dark"]` token block to `index.css` in its own small commit (a design-system change, not page-local).
- **Tests:** flip rows render in producer order (no client sort); a flip with `legs:null` shows its reason; a target without `p_reach` shows unknown, not 0; chart has no computed points (grep).

### WR-3: the controls (objective, approve, sent/reply log, risk mode, add stop) (about 1.5 days; waits on the EA-02/EA-03 request queue and CAMPAIGN-01a)
- **Client:** `ObjectiveSheet.tsx`, `RiskModeSheet.tsx`, `AddStopSheet.tsx` (Coach trade-off panel), reply buttons + counter form in `ReplyTable.tsx`, "I sent it" + Undo, optimistic "Replanning" state with request polling.
- **Server:** none new if the engine request route exists (`POST /api/engine/request`); request kinds `campaign.objective.set`, `campaign.mode.set`, `campaign.stop.preview`, `campaign.stop.add`, `offer.sent`, `offer.reply`.
- **Tests:** each control posts exactly one request of its kind (mocked fetch count); before the queue exists, each control is disabled and shows its typed reason; risk-mode apply requires confirm; add-stop never applies without the preview having rendered; Undo within 10 min emits a retract event.

Ships behind `GRIDIRON_WARROOM_ENABLED` (off), on under `GRIDIRON_PREVIEW_UNCONFIRMED=1`. None of the three units serves a new number.

---

## 8. What the prototype does not produce yet (needs a producer before the card is more than "not computed yet")

1. **Title odds now (absolute)** and the planned path, ground lost, catch-up: prototype keeps deltas only. Small fix for "now": persist `me.title_before`. The rest is CAMPAIGN-01c/g.
2. **The message, walk-away price, send-when, and the reason chain** (CAMPAIGN-01b + COACH-01). The biggest gap: the NextMove card is a deal line without them.
3. **Reply table** beyond decline (`acq.fallback`) and accept (step 2): counter rules and silence nudges are not produced.
4. **Per-target gain and reachability** for the suggestions: `addN` and per-target best plans are computed and dropped. Small fix: persist `targets: [{id, gain, se, best_expected, p_complete}]`.
5. **Risk modes, speed curve, Nick-added stops and the Coach trade-off preview** (CAMPAIGN-01d/f/g): none exist.
6. **Brain check (EVAL-01) and number health (BROKEN-01a)**: neither exists on main; both render typed unknown, never green.
7. **P(yes) is today's unvalidated acceptanceBand midpoint** (the script says so). It always carries the guess + preview tags until E1 passes.

---
## v2 (Nick 9/23 ~9:40 PM: "the mock is good, but the chat bot should have full access to change the UI on the spot / plug things in. Think and reason. Should be one dashboard, not a scroll")

### 1. One dashboard, no page scroll
- Desktop: a fixed CSS grid that fits one viewport (100vh, no page scroll). Panels: top strip (league switcher ranked by "needs you this week", destination, ETA, risk mode), NEXT MOVE (largest panel), itinerary/stops, flip map, targets, catch-up + speed curve, brain check + number health, and the Coach dock (right column, always visible).
- Panels never grow the page: each has a compact view and an in-place "expand" that temporarily swaps with the NEXT MOVE slot (Esc restores). Long lists page inside the panel ("3 of 11 >").
- Phone: the same panels as a one-screen deck (swipe between panels, Coach as a bottom sheet); still no vertical page scroll.

### 2. Coach drives the dashboard (the UI action protocol)
Coach gets UI tools. Each tool returns a typed ACTION the client applies instantly; the client never runs free-form code from the model.
| action | example ask | what happens |
|---|---|---|
| `focus_panel` | "show me the flip map for league 3" | switches league, expands the flip map into the main slot |
| `filter` / `sort` | "only RBs", "sort by chance he says yes" | applies to the panel in view |
| `pin_card` | "keep his RB1 on screen" | pins a player/offer card to the dashboard |
| `plug_in` | "add a card with my bye-week holes" / "chart my title odds by week" | builds a new card from a whitelisted ENGINE FIELD (or a field query) with a chosen view (number, list, sparkline, table); saved to the layout |
| `set_objective` / `add_stop` / `remove_stop` / `set_risk_mode` / `set_tolerance` | "forget the WR, get me a TE", "go fuck-it mode until week 6" | edits the itinerary; ALWAYS shows the engine's trade-off preview first and waits for Nick's confirm tap |
| `explain` | "why is this the next move?" | highlights the reason chain on the card in view |
| `arrange_layout` / `reset_layout` | "make the flip map bigger", "put targets top-left" | rearranges the grid; per-user layout saved; one-tap undo |
| `draft_message` | "write the offer to team 7, softer" | fills the next-move message box; Nick copies/sends |
Guardrails (reasoned, not reflexive):
1. **Numbers come only from the engine.** plug_in cards bind to engine fields; Coach picks WHICH field and HOW to show it, never the value (verify.js already enforces grounded numbers).
2. **Reversible by default.** Every UI action is one-tap undo; layout changes are versioned.
3. **Nick confirms anything that changes the plan** (objective, stops, risk, tolerances) after seeing the trade-off; **nothing is ever sent to a league-mate by Coach**: sending an offer stays a human tap in ESPN.
4. **Typed actions only.** A fixed action schema validated on the client; unknown actions are refused and Coach says so.
5. **Every action is logged** (what Nick asked, what changed) so the War Room can be replayed and Coach's usefulness graded.

### 3. Build impact
- WR-2 becomes "one-dashboard grid + panel expand/swap + phone deck" (replaces the scrolling layout).
- New unit WR-COACH: Coach UI tools + action schema + client action dispatcher + saved layouts + plug_in card renderer over whitelisted engine fields; confirm-gate for plan-changing actions; action log. Depends on WR-1 and the campaign producer's JSON; COACH-NAV (itinerary edits) folds into it.

### 4. The swipe deck (Nick 9/23 ~9:50 PM: "add next buttons on offers I don't like... it wipes to the next")
- NEXT MOVE is a deck of the planner's top alternatives (pre-computed top 5 per league per refresh, each already confirmed on fresh dice). "Next" (button, swipe left, left-arrow key, or tell Coach "next / skip this") wipes the card and shows the next-best instantly; "Do it" (swipe right) makes it the active step. "2 of 5" counter; "back" undoes a skip.
- On skip, an optional one-tap reason (don't like the player / costs too much / don't trust this manager / not now) that fades if ignored. Every skip + reason is logged and TEACHES the brain: skipped players/managers are down-weighted in Nick's plans (SELF-01 preference model; a skipped option can return only if the situation changes, labelled "back because ...").
- When the deck runs out: "Want me to look wider?" (more partners, bigger packages, or a different risk mode).
- Build: WR-1 data read includes `acq.alternatives[]`; WR-2 renders the deck; WR-COACH adds the `next` action; the campaign producer outputs top-5 alternatives + reads the skip log.
