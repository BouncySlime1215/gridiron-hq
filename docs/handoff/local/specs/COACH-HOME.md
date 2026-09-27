# COACH-HOME — Coach becomes the home page; trades become pages (design only)

Fable, 2026-09-26. Read-only pass over `~/Documents/GitHub/gridiron-hq`. No code, no DB writes.

## 0. What exists (so the design stays honest)

| Need | Have today | Gap |
|---|---|---|
| Home | `pages/Today.tsx`: TodayPanel (hero deck, Watching, season), CommandCenter, headlines | Coach is a drawer beside it, not in it |
| Coach UI | `coach/CoachDrawer.tsx` v2: thinking stages (`reading → checking_league → asking_jev → comparing → rechecking`), lane-1 partial, verdict/why/risks shape, NumbersPeopleCard compact, PlanChange / Proposal / Draft action cards, follow-up chips | Everything is a bubble; nothing is a page |
| Coach server | `router.js` (7 intents), `preload.js` bundle, `answer-shape.js` (verdict, stance, basis_key), `rules-check.js` (11 named rules), `reconcile.js` (agree / differ / same_but / no_people_read), `threads.js` (one active thread per league, focus, rolling summary), `negotiator.js` (reply_table + engine rescore, flag `GRIDIRON_COACH_NEGOTIATE`) | No per-trade threads; no page contract |
| Chain | COACH-CHAIN's ChainView (step → hole → fill, Δ lineup, Δ title per step) in progress | — |
| Playoff odds | `playoff-path.js` is **shadow only** (`GRIDIRON_PLAYOFF_SEEDING`); preload says "no playoff-odds number is served" | Serve it before the odds block can show a playoff line |
| Lineup by slot | preload `my_roster` (slot, starter, health, projections); `depth_premium` gives a step's `lineup_points_delta` | No served *after* lineup by slot |
| Reply clock | `NPItem.send_when` (REPLY-CLOCK flag) from `trade-tactics.js` | — |
| Needs your OK | `AjPick.tsx` (AJ-PICK, PROTECTED-UPGRADE) on the deck | — |

Rule kept from CLAUDE.md 2b: seven areas, no new top-level pages, one number one producer, rules shown never bypassed.

## 1. The Coach home

**Nav.** The first sidebar item becomes **Coach** (`/coach`, alias `/today` redirects). Breadcrumb `Coach / Today`, `Coach / Trade`, `Coach / History`. Still seven areas: Coach, Trades, My team, League, Players, Draft, Settings. The header's "Coach" button stays but now means "ask from here" (see drawer decision).

**Above the fold at 1440 (two columns, 7 : 5).**

Left, the **conversation column**:
1. *Coach's opening line* — one served sentence, not a model call: the deck's next move as a verdict ("Send the 2-for-1 to Team 4 today: +2.1 pts title odds, clears the noise"), from `plan_summary` + `plan_moves`. Under it the goal strip (`contextParts`).
2. *The ask box* with the six FIXED_QUESTIONS as chips, plus two new ones: "Build the page for this trade" and "Fill my weakest slot after this".
3. *The thread* — the league thread as today, but every answer about a trade renders as a **Trade card** (title, verdict chip, Δ odds, one "Open page" button) instead of a bubble. Follow-ups and action cards unchanged.

Right, the **day rail** (what Today has now, made narrower): the hero deck card (NextMoveDeck `variant="hero"`, with its Needs-your-OK banner), Watching rows, season progress, then CommandCenter's week actions folded to "Show more", then three headlines. The rail is the same components; only the wrapper changes.

**Phone 375.** One column: opening line, ask box, hero card, thread, then the rail sections as collapsed Cards ("This week · 4 actions"). The ask box is sticky-bottom (it already is in the drawer's `wr-drawer-ask`).

**Drawer decision: keep it, shrink it.** On the other six areas, the header Coach button opens the existing drawer as a *quick-ask overlay*: same thread, same components. Two changes: (a) a trade answer in the drawer shows the Trade card with "Open page", which navigates to `/coach?view=trade&move=…`; (b) the drawer loses the Morning brief and Action log details (they live on the Coach home). Reason to keep: Nick asks from My team or Players while looking at a player; losing that costs more than one overlay costs. Reason to shrink: two full Coaches would be two producers of the same screen.

## 2. Trade story pages

Route: `/coach?view=trade&move=<move_id>` (or `&thread=<id>`). One PageHeader ("Trade · Team 4", eyebrow "Coach"), then a stack of blocks. Coach chooses which blocks and their order; every number in a block comes from a producer cell that already carries a cite.

### 2.1 Block library (fixed; the model cannot add one)

| id | Shows | Producer / props |
|---|---|---|
| `verdict` | Verdict line, stance chip, basis, why bullets, risks | `answer-shape` output (`shape`, `claims`, `refusals`) |
| `chain` | ChainView: each step's give/get, the hole it opens, the fill, Δ lineup pts, Δ title odds ± SE | `plan_moves[i].steps`, `depth_premium`, COACH-CHAIN's step shape |
| `lineup` | Before / after by slot; the hole slot outlined; health chips | `my_roster` (before); *after* from the new `lineup_after` producer (unit 3). Until served: shows before + the step's `lineup_points_delta`, and the hole from `partner_focus.roster_holes` |
| `odds` | Title odds now → after, ± SE, "clears the noise" mark; playoff odds line only when `playoff_path` is served, else the row reads "Playoff odds: not priced yet" | `plan_summary.title_odds_now/_se`, step `title_after`, `clears_2se`; `playoff_path` (shadow → served) |
| `lanes` | NumbersPeopleCard `variant="full"` + the disagreement sentence | `reconcile` (`laneVerdict`, `disagreementLine`), NPItem |
| `partner` | Partner card: P(responds), what they want (roster holes), offers logged, reply history, `send_when`, and the "how Nick comes across" line | `partner_focus`, NPItem.send_when, people layer (feedback_coach_models_how_nick_looks) |
| `rules` | Checklist, one row per `COACH_RULES` id in plain words, pass / fail / needs-OK; "N ideas hidden by your rules" | `rules-check.checkSuggestion` reasons; never-give.js |
| `ladder` | Counter ladder: "If they say no → …", "If they ask for X → take / counter with Y / walk", walk-away line | `reply_table` + negotiator rescore (flag on); with the flag off, the plan's `reply_table` rows only, labelled "not re-priced" |
| `timing` | Best time to send, week clock, lineup lock | `send_when`, `tradeWeekContext`, lineup-lock |
| `actions` | Buttons: Send (copy + "I sent it"), Needs your OK (AjOkBanner), Save chain, Not now | ProposalCard / AjPick / new save action |
| `note` | One short model sentence tying two blocks ("The hole this opens is what step 2 fills") | model text, verify.js-checked, cites required |

Rules line (`RULES_LINE`) prints under `actions` on every page.

### 2.2 The JSON contract Coach emits

```json
{
  "page": "trade", "move_id": "m_1834", "thread_id": 91, "as_of": "2026-09-26T14:02Z",
  "title": "Two-for-one to Team 4", "eyebrow": "Coach",
  "blocks": [
    { "id": "verdict", "ref": "answer" },
    { "id": "chain",   "ref": "plan_moves[0]" },
    { "id": "lineup",  "ref": "plan_moves[0].steps[0]", "highlight_slot": "RB2" },
    { "id": "odds",    "ref": "plan_moves[0].steps[0]" },
    { "id": "note",    "text": "Step 2 exists only because step 1 opens RB2.", "cites": ["r3#0.title_odds_change"] },
    { "id": "lanes",   "ref": "np:move:m_1834" },
    { "id": "partner", "ref": "partner_focus" },
    { "id": "rules",   "ref": "plan_moves[0]" },
    { "id": "ladder",  "ref": "plan_moves[0].steps[0]" },
    { "id": "timing",  "ref": "partner_focus" },
    { "id": "actions", "ref": "plan_moves[0]" }
  ]
}
```

The model writes only `blocks[].id`, `blocks[].ref`, the optional `highlight_slot`, and `note` text. Props are resolved server-side from the preload bundle by `ref`; the client never receives a number the model typed.

**Validation (server, `coach/page.js`, after verify.js):**
1. JSON schema: `id ∈ library`, `ref` matches a bundle path pattern, at most one of each id except `note` (max 3), `verdict` first, `actions` last.
2. Every `ref` resolves to an `ok` cell; an unresolved ref drops the block and logs `page_block_dropped` (never the page).
3. `note` runs through verify.js as a claim; a failed note is dropped.
4. `rules` and `actions` are **always appended** if missing: a trade page cannot omit the rules or the buttons.
5. A page with fewer than three surviving blocks falls back to the chat bubble (today's path), so nothing is worse than now.
Client: `TradePage.tsx` maps ids to components from a `Record<BlockId, Component>`; an unknown id renders nothing and warns.

## 3. Conversation model

- **Threads pinned per trade or partner.** `coach_threads` gains `kind` (`league` | `move` | `partner`) and `key` (move_id or roster id); one active thread per key. Asking from a trade page writes to that page's thread; `focus` is preset to the move so "him" and "that trade" resolve without a guess.
- **Follow-ups update the page live.** "What if they counter with X?" is a WHAT_IF turn on the move thread; the negotiator rescore returns new cells; Coach re-emits the contract; the client diffs by block id and re-renders only `odds`, `ladder`, `verdict` (transform/opacity fade, reduced-motion safe). The question and answer also append to the thread column beside the page (right rail at 1440, below at 375).
- **History.** `Coach / History` lists past trade pages: title, date, verdict, outcome (sent / accepted / declined / expired, from War Room records), Δ title odds predicted vs what the plan shows now. Tap reopens the page frozen at its `as_of`, with a "Rebuild with today's numbers" button.

## 4. States

| State | What Nick sees |
|---|---|
| Loading | Skeletons at final size per block in the order emitted; the thinking-stage line at the top ("Checking your league…"); lane-1 partial fills `verdict` first; "Still working, the numbers will show first" after 8 s |
| AI off / credits out | Page builds from served cells only (default block order: verdict-as-plan-line, chain, odds, rules, actions); banner "The AI is off here. This page is from your plan." |
| Budget reached | Same as above, with the existing BudgetLink to Settings › AI & developer |
| Empty | No next move served: the home shows the goal strip, "Plan not ready yet", Watching, and the ask box; trade pages 404 to the home with "That trade is no longer served" |
| Rule fail | The page still builds; `actions` shows only "Not now"; `rules` rows in red name the rule |

## 5. Layouts

- **1440:** home 7 : 5 columns; trade page 8 : 4 (blocks left, thread right, thread sticky under the header). Blocks are Cards; `lineup` is two Tables side by side; `chain` is ChainView full width.
- **375:** single column; trade page shows `verdict`, `odds`, `actions` first, then a "Full story" fold with the rest; thread below. Ask box sticky-bottom. Page height stays under ~4 screens by folding `ladder`, `partner`, `rules` (rules header shows "9 pass · 1 needs OK").
- Light and dark from tokens.css only; ChainView's Δ colours use `good` / `bad` tones, not new hues.

## 6. Build plan (each behind a flag, in order)

1. **COACH-HOME-1 · Coach page = Today + drawer, `GRIDIRON_COACH_HOME`.** Move the drawer body into a page column beside TodayPanel; sidebar item renamed Coach; `/today` redirects; drawer stays on other areas minus brief/log. Uses only existing components plus ChainView (shown inside the hero card when the move has more than one step). *Accept:* home renders at 375 / 1440 light and dark with no overflow; drawer still opens from My team; all existing coach tests pass; snapshot of `/coach` equals old `/today` content plus the thread.
2. **COACH-HOME-2 · Trade page contract, `GRIDIRON_COACH_PAGES`.** `coach/page.js` (schema, resolver, validator), `TradePage.tsx`, blocks `verdict chain odds rules actions note`. Trade answers in the thread become Trade cards with "Open page". *Accept:* a hand-written contract with a bad ref drops one block and logs; a page with two blocks falls back to a bubble; every number on the page matches the preload cell by cite.
3. **COACH-HOME-3 · Lineup and lanes blocks.** New `lineup_after` producer (the existing lineup optimizer over the post-trade roster, written to plans.json by the campaign run, never on request); `lineup`, `lanes`, `partner`, `timing` blocks. *Accept:* the hole slot highlighted equals `partner_focus.roster_holes`; NumbersPeopleCard full renders both lanes with the verdict; no client-side arithmetic (lint rule: no `-`/`+` on cell values in block files).
4. **COACH-HOME-4 · Ladder and live follow-ups (`GRIDIRON_COACH_NEGOTIATE` on).** `ladder` block; WHAT_IF turns re-emit the contract; client diff-renders by id. *Accept:* "what if they counter with X" changes `odds` and `ladder` only; reduced-motion shows no animation; a rescore timeout (8 s) leaves the old cells with "not re-priced".
5. **COACH-HOME-5 · Per-trade threads and History.** Migration for `kind` / `key`; `Coach / History` tab; frozen pages with "Rebuild". *Accept:* two trade pages keep separate threads; History outcome matches War Room records; a frozen page shows its `as_of`.
6. **COACH-HOME-6 · Playoff odds served.** `GRIDIRON_PLAYOFF_SEEDING` from shadow to served after its pre-reg pass; the `odds` block gains the playoff line and the must-win weeks. *Accept:* the line appears only when the cell is `ok`; the SE prints beside it.

Time: units 1–2 about two days each; 3–5 about a day each; 6 depends on the pre-reg.

Privacy: no league-mate names in fixtures; pages label partners "Team N" until identity rows resolve at render.
