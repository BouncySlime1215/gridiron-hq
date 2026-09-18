# Manager archetypes — what twelve league-seasons of drafts actually reveal

Built 2026-09-17. Code: `server/services/manager-archetypes.js`, `scripts/build-manager-archetypes.mjs`.
Tables: `manager_archetypes` (6,575 rows), `manager_archetype_jev` (45 managers).

    node scripts/build-manager-archetypes.mjs                              # measure
    node --env-file-if-exists=.env.local scripts/build-manager-archetypes.mjs --jev   # + Jev

This is the counterparty half of the trade engine. `manager-signals.js` already carries what a
manager SAYS (chat) and what he has DONE this season (transactions). This file carries the only
thing we have years of: what he DID on draft day, and how the season then treated him.

## The headline, stated plainly

**Nothing in the fantasy-writing vocabulary survives a repeatability test, and neither does the one
metric that first appeared to.** Reaches for his guys, drafts off a list, RB-heavy, homer,
risk-seeker, pays for last year's name: all null. Auto-draft rate — whether he shows up — looked like
the one survivor at Pearson r = 0.70, and it is not one either. It is one man.

| metric | yoy r | 90% interval | Spearman | worst leave-one-manager-out | within-draft reliability |
|---|---|---|---|---|---|
| auto_draft_rate | 0.70 | [0.42, 0.89] | **0.16** | **0.26** | 0.98 |
| pos_lean_rb | 0.34 | [0.09, 0.53] | 0.34 | 0.26 | 0.00 |
| pos_lean_wr | 0.33 | [0.10, 0.51] | 0.28 | 0.25 | 0.00 |
| capital_hhi | 0.22 | [-0.09, 0.47] | 0.22 | 0.14 | 0.00 |
| risk_store_yard_cv (feature-store volatility of his picks) | 0.17 | [0.09, 0.25] | 0.16 | 0.11 | 0.03 |
| name_brand_premium | 0.17 | [0.06, 0.36] | 0.19 | 0.08 | 0.42 |
| risk_prior_fp_cv (weekly PPR volatility of his picks) | 0.16 | [0.03, 0.28] | 0.15 | 0.08 | 0.00 |
| reach_rate | 0.16 | [0.04, 0.28] | 0.11 | 0.08 | 0.00 |
| pick_minus_consensus_mean (reach/value) | 0.13 | [-0.15, 0.33] | 0.10 | 0.05 | 0.00 |
| pick_minus_consensus_sd (drafts off a list) | 0.04 | [-0.18, 0.35] | -0.00 | -0.02 | 0.00 |
| homer_top_team_share | -0.14 | [-0.42, 0.13] | -0.08 | -0.18 | 0.00 |

### Why auto-draft rate is not a finding

Will Greene has auto-drafted **every pick of every one of his four seasons** in league 2. Across 108
manager-seasons, 65 are exactly 0.00 and 7 are exactly 1.00; all 7 of the ones are his. He therefore
contributes four seasons of a perfectly repeated extreme value to a variable whose remaining mass sits
in a flat cloud near zero. Drop his three pairs and:

- Pearson falls from **0.704 to 0.205** (58 pairs → 55).
- The rank correlation is **0.164 with him and 0.044 without** — Spearman was never above noise even
  with him in, which is the tell: the 0.70 is one leverage point, not a monotone relationship.
- League 2's three season-transitions flip from r = +0.87 / +0.90 / +0.98 to **-0.41 / -0.47 / -0.16**.
- League 1, which does not contain him, was never positive to begin with: -0.09, +0.06, +0.64.
- Leave-one-cluster-out without him spans -0.07 to +0.33.

`docs/TARGET-SPEC.md` asks for a sign that holds in at least 4 of 5 seasons. There are seven
league-season transitions here. With Will Greene the signs are −,+,+,+,+,+ (5 of 6 positive). Without
him they are −,+,+,−,−,− (2 of 6). **The gate is failed by one person's removal, so it was never
passed.**

The clustered bootstrap did not catch this and structurally could not. It resamples the 7
league-season clusters, and a manager with four seasons in one league sits in three of them, so he is
resampled into nearly every draw. Cluster bootstrapping protects against one DRAFT carrying a
correlation; it does nothing about one PERSON carrying it. `metricRepeatability()` now reports
`yoy_spearman` and `yoy_r_min_loo` (worst leave-one-manager-out r) beside every correlation, and the
build script prints both, so this cannot be reported as a trait again without the refutation printed
one column over.

### What still stands

Read the reliability column first. **Within-draft reliability is the gate**, and it splits each draft
into two balanced halves (rounds 1,4,5,8… against 2,3,6,7…) and correlates the manager's value on one
half against his value on the other, Spearman-Brown corrected back to full length. A reliability of
0.00 means the same person, in the same afternoon, from the same board, produces two unrelated
numbers. 24 of 29 metrics score 0.00, so their year-over-year zeros are uninformative rather than
findings. Auto-draft rate is the exception: it reproduces itself at 0.98 within a draft, and at 0.95
with Will Greene removed, so it is a **well-measured quantity that nonetheless does not repeat across
years between people.** That is a cleaner null than "we could not measure it."

`pos_lean_rb` and `pos_lean_wr` keep their Spearman (0.34, 0.28) but have 0.00 within-draft
reliability, are mechanically coupled, and sit inside the ~3 false positives that 29 metrics at 90%
intervals are expected to produce. **Do not price a trade off a positional lean.**

Two halves of one draft were originally split odd-pick/even-pick. That was wrong: this draft snakes,
so odd rounds pick from the manager's slot and even rounds from its mirror, and any slot-driven
quantity is anti-correlated between the halves by construction. The balanced round-pair split
replaced it. The reliabilities did not move, so the conclusion stands on its own rather than on that
bug.

## What is measurable now

`manager_archetypes` stores, for every manager, every league-season, with the sample size behind each
number, and again as a career roll-up:

- **Information set** — auto-draft rate and ESPN's own auto-draft subtype shares; board slot minus
  consensus rank in rounds, and its spread; reach rate; consensus coverage.
- **Utility** — positional lean in consensus-round units rather than round counts; roster shape
  through round 6; Herfindahl concentration of draft capital across positions; name-brand premium;
  top-NFL-team share with the team named. The NFL team behind that last one is now taken **only**
  from the season's own consensus feed. It used to fall back to `players.team_id`, which is a
  *current* roster: for 13-14% of 2023-2025 picks a manager's 2023 "homer team" was being decided by
  where that player plays in 2026. Those picks are now excluded (the metric's `n` drops accordingly)
  and the fallback fires only for the current season. The correction moved
  `homer_top_team_share` from -0.04 to -0.14; it was null before and it is null now.
- **Risk** — the prior season's weekly PPR coefficient of variation of the players he drafted
  (`scoring.js`'s `scoreLine` over `player_week_usage`), and the same question asked of the weekly
  feature store (`base_total_yards__sd_6 / __mean_6`, frozen at week 1).
- **Outcomes** — points per week, all-play win rate, actual H2H, luck in wins, beat-median rate,
  final rank. These come from running `scripts/luck-panel.mjs --json`, which owns that measurement;
  nothing here recomputes all-play.

Every draft-side number is centred on its own league-season before it is compared to anything. An
8-team draft reaches more than a 10-team one and a 2026 board differs from a 2023 one; without
centring, a metric that merely differs between leagues correlates with itself year over year while
saying nothing about any manager. Centring changed the reach/value year-over-year figure from 0.10 to
0.13 and pushed `homer_top_team_share` from +0.02 to -0.04 — small, but in the direction of honesty.

### Leak guarantee

- Consensus rank is the preseason FantasyPros consensus in `nfl_historical_adp`. **Corrected:** an
  earlier version of this section said the scrapes are "early August". They are not. The table keeps
  one row per (season, player) — the *last* preseason scrape — and the operative date is
  2025-08-08 for 2025 (clean, before the draft) but **2024-08-30 for 2024 and 2023-09-01 for 2023**,
  which are at or after the late-August drafts they are used to score. A 2023 or 2024 consensus rank
  can therefore reflect final-cut and preseason-injury news the manager did not have. It is a small
  forward peek, it adds noise rather than flattery (a pick who got hurt after the draft reads as a
  reach), and every consensus-derived metric is null anyway — but the claim of cleanliness was false
  and is withdrawn. It is not fixable from this table, whose primary key is
  (season, source, player_key); `nfl_historical_adp_scrape` is the dated series that would fix it and
  it currently holds **0 rows**.
- Name brand uses the **prior** season's consensus, a year older still, and is computed only when
  both years come from the same source — an ESPN rank minus a FantasyPros rank is a difference of two
  universes, not of two years.
- Player volatility is read at (season, week 1): the prior season's `player_week_usage`, and the
  feature store, whose history filter is `season < S OR (season = S AND week < 1)`.
- Outcome metrics are outcomes by construction and are tagged `source='outcome'` so nothing mistakes
  them for draft-day knowledge.

### Coverage and its one soft spot

1,738 picks, 12 league-seasons, 45 managers, **every pick attributed to a manager** (ESPN omits
`memberId` on about a fifth of picks; those are recovered through `team_id`). Consensus joins 389/416
of 2025's picks and 0 of its 27 defences — D/ST has no rank in the offense-only feed, so every
value metric is computed over QB/RB/WR/TE only.

2026 is the soft spot. `nfl_historical_adp` stops at 2025, so 2026's consensus comes from
`espn_player_market.adp`, fetched during the season rather than frozen before the draft. ESPN's ADP is
formed by drafts that finish in August, so it is preseason in substance, but it is not a dated
preseason artefact. **Corrected:** an earlier version of this section claimed 2026 was excluded from
anything graded. It is not — `metricRepeatability()` pairs every consecutive season on file, and 23 of
its 58 pairs take their second value from 2026, i.e. from this ESPN board against a 2025 FantasyPros
one. Measured: dropping 2026 moves `pos_lean_rb` from 0.34 to 0.49 and `pos_lean_wr` from 0.33 to
0.40, so its presence is depressing those rather than manufacturing them, and it leaves
`risk_store_yard_cv` at 0.17-0.18. The direction is harmless; the claim was still false. It also arrives over a much larger
player universe, which is why deltas are measured in rounds and clipped at ±3: before clipping, a
last-round flyer in the 2026 league scored as a 45-round reach and swamped two managers' career means.

## The one number worth acting on

`luck_wins` — wins the record gained over the all-play rate. A manager whose record flatters his
scoring prices his roster as if the record were real. 2025, the last completed season:

| league | flattered | punished |
|---|---|---|
| 1 | Michael Kodsi +2.2, Gabe Matta +1.6 | Sophia Matta -2.0, G B -1.4 |
| 2 | Will Greene +1.8, Matthew Holt +0.9 | Christian Lopez -2.1, Tom Schumann -1.9 |
| 3 | Zachary Kaller +1.3, J R +1.2 | Aiden Smith -1.9 |

Career, over four seasons, Gabe Matta is +1.72 wins a season on a 0.59 all-play — genuinely good and
consistently flattered on top of it. Aiden Smith is -1.73 on a 0.41 all-play — genuinely poor and
punished as well, which is the profile most likely to sell cheaply.

Two cautions. Luck is by definition not predictive of next year's luck; it is a read on what a
manager currently believes about his roster. And the 2026 all-play figures in `manager_archetypes`
rest on two scored weeks — the `n` column says so, and anything that consumes them must respect it.

## Auto-drafters — well measured, still not a trait

Career auto-pick rate, every manager above 0.30, with the picks behind each:

- Will Greene 1.00 (64 picks, 4 seasons in league 2) — has never made a live pick in this dataset,
  and is single-handedly responsible for the year-over-year correlation this metric appeared to have.
- Gabe Matta 0.38 (64), Aiden Smith 0.35 (49), Christina K 0.54 (48, last seen 2025).
- Single-season reads, 16-17 picks each, all in the 2026 leagues: Sam Dipietro 1.00, Sam Edmunds
  0.88, Zach Tuoti 0.81 (league 5), Rami Fakih 0.59 (league 4). One draft is enough to say what he
  did and not enough to say what he does.
- Of the other 37 managers, 19 are at exactly 0.00 and the rest sit under 0.20.

What this table *is* good for: it is a reliable read on **what a manager did in a draft we have**
(within-draft reliability 0.98, and 0.95 with Will Greene removed). What it is not good for is
predicting what he will do in a draft we do not have. "Will Greene auto-drafts" is a fact about
Will Greene with four observations behind it; "auto-drafting is a stable managerial trait" is a claim
this dataset does not support once he is removed from it.

**Identity caution, 2026-09-17.** This build takes names from ESPN's member records. ESPN lists the
owner of league 4 roster 7 as "Aiden Smith"; Nick identified roster 7 as Haiden Bonczek, and separately
said his roommate Aidan is not in the league chat. Which person the "Aiden Smith" account is has not
been confirmed. What the data does say about that account: in the 2026 league-4 draft all 17 of its
picks carry ESPN auto-draft type 3 — one mode for the whole draft, unlike the scattered type 1/2 picks
elsewhere — and it auto-picked 35% across 49 picks in four seasons. Nick's read was that Haiden did NOT
auto-draft "unless league data supports that"; for the 2026 draft it does. That is a statement about a
draft, not about how the roster is managed in season.

## Jev

45 managers, one call each, 132,141 input tokens, **$0.0055** (estimate printed before spending was
$0.0041; budget $1). State is pseudonymised — Jev gets M01…M45, their picks in order with each pick's
consensus delta, roster shape, risk and name-brand lines, and the season outcome. Real names never
leave the machine.

Answers are stored with a `basis` column: `draft` where the state contains evidence bearing on the
question, `inference_only` where it does not. The script then measures whether each answer
discriminates between managers at all:

| question | modal answer | share of managers | max sd across managers | basis |
|---|---|---|---|---|
| risk_appetite | 3 | 0.80 | 0.151 | draft |
| recency_bias | 1 | 0.49 | 0.144 | draft |
| endowment_effect | 0 | 0.82 | 0.171 | inference_only |
| information_speed | set_and_forget | **1.00** | **0.022** | inference_only |
| position_bias | wr_heavy | 0.62 | 0.326 | draft |
| trade_style | never | 0.87 | 0.075 | inference_only |
| sells_low_after_bad_week | true | **1.00** | **0.009** | inference_only |
| buys_high | true | **1.00** | 0.076 | inference_only |

**Three of the eight questions are degenerate.** Every one of the 45 managers is 93-100%
`set_and_forget` and >50% `sells_low_after_bad_week`, with probabilities that barely move between
people. Those are answers to the prompt, not readings of a manager, exactly as the absence of
transaction evidence should produce. They are stored because the diagnostic is worth keeping, and
they are labelled so the trade finder cannot read them as measurement.

Does Jev track the numbers it was handed?

- `information_speed: set_and_forget` vs measured auto-draft rate: **r = 0.62** (n=45). The argmax is
  constant but the ordering is real — it is reading the engagement evidence.
- `risk_appetite` score vs measured risk excess: r = 0.30 (n=45). Some tracking, but the underlying
  measurement has a within-draft reliability of 0.00, so this is agreement about noise.
- `recency_bias` score vs measured name-brand premium: **r = -0.06** (n=26). The one question with a
  direct measured counterpart in the state, and Jev's read does not follow it. Treat the recency
  score as unsupported.

The usable output of the Jev pass is therefore narrow: it ranks engagement, consistent with a number
we already had. It did not add a dimension the drafts do not contain.

## What cannot be measured yet — and one correction

The task assumed ESPN serves roughly three days of transactions. As of today `league_transactions_raw`
holds **1,341 rows spanning 2026-07-30 to 2026-09-18** — the whole 2026 season so far, not three days:
127 trade proposals, 44 declines, 21 accepts, 7 vetoes, 47 waivers, 214 roster moves. League 4 alone
has 128 trade rows. All of it is season 2026; **no prior season is retrievable**, which is the part of
the original claim that holds.

So the honest split is:

**Available now, not used here.** Proposal / decline / accept counts per manager. `manager-signals.js`
already computes `tx_accept_rate` from them behind a five-decision floor, and league 4 clears it.
This file deliberately does not duplicate that.

**Timing — CORRECTED 2026-09-17: available for trades, not for waivers.** `processed_at` is
populated on only 37 of 1,341 rows, which is what the first version of this paragraph read as "timing
is unavailable". It missed that ESPN records every trade decision as its OWN transaction — a
TRADE_ACCEPT, TRADE_DECLINE, TRADE_VETO or TRADE_UPHOLD — with its own `proposed_at` (the moment of the
decision) and `related_tx_id` pointing back at the proposal. Joining the two gives proposal-to-response
latency directly, with no negative intervals:

| decision | linked to a stored proposal | median | p10 | p90 |
|---|---|---|---|---|
| decline | 24 of 44 | 7 min | 0.8 min | 36 h |
| accept | 12 of 20 | 2.0 h | 1.5 min | 20 h |
| veto | 5 of 7 | 16 min | 6 min | 62 h |
| uphold | 4 of 9 | 19 h | 3 min | 20 h |

The unlinked decisions answer proposals made before collection began; from here on every proposal is
captured, so the linked share only rises. Waiver reaction latency and lineup-set timing genuinely are
not recoverable from this view.

**Needs more season.** Counter-offer behaviour — whether a decline is followed by a counter from the
same manager — is derivable from what is already captured but needs the proposals to accumulate:
league 4 would support it now, the other four leagues have 2 to 50 trade rows each and will not. A
first pass is worth running around week 10 of 2026; a repeatability test on it needs 2027.

**Needs years.** Anything that must clear the same bar as auto-draft rate — a within-season
reliability and a year-over-year correlation — needs at least three seasons of forward capture, so
2028 at the earliest. That is the honest horizon for "who is this person" built on transactions.

A profile built on 12 league-seasons of drafts is real. One that claims to know his waiver latency
today is not, and this file does not claim it.

## Consuming it

`archetypesFor(leagueId, season)` returns a map keyed by `roster_id` — the address the trade finder
uses — carrying each manager's career profile, his current season, and his Jev answers with their
basis. `managerProfile(memberId)` is the same by person. Every number arrives with the `n` behind it;
the repeatability table above says which of them deserve weight, and today that is: **the outcome
block, and nothing else.**

No draft-side metric has earned weight in a price. Auto-draft rate is a reliable description of a
manager's past drafts and may be worth surfacing to a human as context, but it must not be fed to
counterparty pricing as a predicted trait: its apparent repeatability is one manager, and its
Spearman is 0.16.