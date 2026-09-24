# Trade Brain — what is tested on history, what is hand-set, and where the signals should feed

Asked 2026-09-20 01:21Z: "is this based on stats, is this just made up, how do we
know this, audit the structure, should this data be pointed anywhere else."

Read-only. Every line number is `origin/main` at `791b131`. No server file is
edited by this document; the two defects it names belong to other owners and are
routed, not patched here.

**The one-line answer.** The Trade Brain's *measurements* are real counts off
ESPN and the chat corpus. Everything that turns them into a number is hand-set
and says so in the data (`fitted: false` on all eight sources). The one part of
it that was tested against history — draft behaviour, twelve league-seasons —
**failed**, and the code disables it rather than noting it. And the layer as a
whole has been measured against real decisions: it adds **nothing detectable**
over our own value number. It ships as a read, not as a price.

---

## 1. Three layers, three different provenances

### Layer A — the stored signals (what the page shows per manager)

`server/services/manager-signals.js:66-78` declares every source a row may
name, and it is the contract, not a comment:

| source | what it is | class | priceable |
|---|---|---|---|
| `roster` | ESPN roster | D (a count) | yes |
| `standings` | ESPN record and last matchup | D | yes |
| `tx` | ESPN transactions (`league_transactions_raw`) | D | yes |
| `outcome` | all-play and luck, via the archetype build | D | yes |
| `draft` | this season's draft, via the archetype build | **tested and failed** | **no** |
| `chat` | league chat (private corpus) | D | yes |
| `nick` | Nick's own read, prior, n=3 | **H** | yes |

Classes follow `docs/NUMBER-PROVENANCE.md`: D = definitional, H = hand-set.

So of seven declared sources, six are measurements. **`nick` is the one hand-set
input that is allowed to price**, and it enters receptiveness as three nudges of
−0.10 / −0.05 / +0.08 (`counterparty-pricing.js:185-187`), never as a verdict.

### Layer B — the one thing tested on history, and it failed

`study/features/archetypes.md`, built 2026-09-17 on 12 league-seasons / 108
manager-seasons / 6,575 archetype rows. Every draft-behaviour metric failed a
year-over-year repeatability test. The apparent survivor, auto-draft rate at
Pearson r = 0.70, collapses to Spearman 0.16 and a worst leave-one-manager-out
of 0.26: it is one man who auto-drafted every pick of four seasons.

What matters is that the result is **wired, not filed**. `draft` is the single
source carrying `priceable: false` (`manager-signals.js:72-75`), and `signalOf`
(`routes/trades.js:445-453`) joins that flag onto every row it serves, with the
reason in the row's own `why` string. Tested → failed → disabled in code.

### Layer C — everything that turns a signal into a number: all hand-set

`VALUATION_SOURCES` (`counterparty-pricing.js:62-93`). Eight sources, each
carrying `fitted: false` **in the data**, its own `cap`, and a `min_n` below
which it is reported inert with a reason rather than dropped:

| source | cap | min_n |
|---|---|---|
| `chat_sentiment` | 0.12 | 1 |
| `talk_vs_model` | 0.10 | 3 |
| `profile_roster_read` | 0.10 | 1 |
| `untouchable_credibility` | 0.10 | 1 |
| `hype_vs_usage` | 0.08 | 2 |
| `positional_need` | 0.08 | 1 |
| `luck_self_view` | 0.05 | 4 |
| `recency_post_loss` | 0.05 | 1 |

Plus the wrappers, all H: `PLAYER_VALUATION_CAP` 0.20 (:98), `PERCEPTION_CAP`
0.15 (:28), `RECEPTIVENESS_RANGE` [0.7, 1.3] (:30), chat weight `msgs / 300`
(:172), the 0.65 / 0.35 open-to-trade / trade-talk blend (:175), accept-rate
weight `n / 15` (:181), `PROFILE_CONFIDENCE` 1 / 0.7 / 0.4 (:112),
`POST_LOSS_FULL_MARGIN` 30, `POST_LOSS_CHAT_FULL` 0.10, `LUCK_FULL_WINS` 2
(:101-105).

Why none of it is fitted is stated in the code (:41-45): 30 proposals decided in
2026, 6 accepted. Nothing can be fitted on 6 accepts.

**What IS tested is the shape, not the sizes** — every factor names a source and
its sample, no factor exceeds its cap, no player moves more than
`PLAYER_VALUATION_CAP` however many sources agree, the same evidence is never
charged twice, and a source below `min_n` is reported inert with a reason.
Evidence: `docs/tdd/valuation-map.tdd.md`, `test/manager-data-pipeline.test.js`.

## 2. How do we know it works? It was measured, and it does not

`docs/tdd/valuation-map.tdd.md` section 6, on all 30 decided 2026 proposals
(6 accepts, 24 declines, 13 distinct deciders, 130 of 130 trade items resolved):

| arm | prices on | AUC |
|---|---|---|
| A | our own value gain for the decider | **0.813** |
| B | the map, cutoff-safe | 0.806 |
| C | the map, today's data (contaminated) | 0.833 |

Decider-clustered bootstrap, 2,000 resamples: **B − A median 0.000**
(−0.017 … 0.000). On the 16 decisions made by someone other than Nick — the ones
the layer exists for — B − A is exactly 0.000 with a zero-width interval. Arm C's
lift is exactly the part that can see the future, so it is not evidence.

Section 7's ablation agrees from the other side: zeroing each source in turn on
league 4, **no source changes which ideas surface**; three change their order.
The binding constraint is `perceptionFactorFor` in `trade-engine.js`, which
bounds the whole counterparty read to ±10% of a deal's score.

This is the honest headline and it should be said in Nick's words, not softened:
**with 6 accepts, people decide on value, and the chat layer's contribution is
smaller than 30 decisions can detect.** The layer is worth having because it is
what he is *told* about a manager, which the tactics step and the Coach consume.
It is not yet worth pricing on, and the code does not pretend otherwise.

## 3. Where the signals feed today — three call sites, all inside the trade path

`counterpartyLayer` is called at `trade-engine.js:1522`, `trade-engine.js:2052`
and `routes/trades.js:493`. `archetypesFor` is called once, at
`routes/trades.js:502`. Nothing else on the platform reads any of it.

### Where it should go, and where it must not

Nav is eight pages. Judged one at a time against whether a *priceable* source
bears on that page's question:

1. **Waivers — yes, and it is the clearest gap.** `tx` is a measured, priceable
   count of how a manager transacts. The waiver board prices a claim with no
   notion of who else is likely to claim it. "Who competes for this add" is a
   real use of a measured signal. (`waiver-wire.js` / `waiver-brain.js` are
   feature-audit's files.)
2. **League Hub — yes, one line.** `recency_post_loss` is ESPN standings,
   priceable, and already computed per manager for the trade path. Who is in a
   post-loss window is a "talk to him this week" fact the Hub has no way to say.
3. **Draft — no, and this is the sharp one.** The archetypes are built *from*
   draft day, so the Draft page is the obvious place to point them, and it is
   the one place the repeatability test says they must not go. `priceable:
   false` exists for exactly this.
4. **Start/Sit — no.** No manager signal bears on your own lineup.
5. **News, X's & O's, Settings — no** manager-signal content.

## 4. Structural findings (routed, not patched)

1. **The `priceable` join lives in the route, not under it — and the second
   consumer already exists.** The `manager_signals` table has no such column
   (`manager-signals.js:42`), and the flag is attached at
   `routes/trades.js:446`, in the HTTP layer. But `managerSignalsFor`
   (`manager-signals.js:502`), whose own comment reads "everything the trade
   engine needs about one league's managers, in one read", returns
   `metrics` / `samples` / `sources` with **no `priceable` flag at all**, and it
   is what `counterpartyLayer` reads (`counterparty-pricing.js:132`).

   Checked, so this is stated exactly: the risk is latent, not live. The four
   draft-sourced metrics are `draft_auto_rate`, `draft_reach_rate`,
   `draft_pick_vs_consensus` and `draft_name_brand_excess`
   (`manager-signals.js:266-267`), and a repository-wide grep across `server/`
   and `client/` finds **no consumer reading any of the four by name**. So
   nothing prices on a failed metric today. What is missing is the thing that
   would stop it: the pricing path reads through an accessor that cannot tell
   it, and the only place the flag is enforced is the one layer that does not
   price. A reach for `m.metrics.draft_reach_rate` inside
   `counterpartyLayer` would compile, run, and be wrong, with nothing to catch
   it.

   So before the signals are pointed anywhere else, that join moves below the
   route. This is the answer to "how can we unify everything": one accessor that
   cannot hand out an unpriceable row unlabelled, rather than a rule written in
   the one consumer that happens to obey it.
2. **`docs/NUMBER-PROVENANCE.md` is stale on this layer.** It is dated
   2026-09-18 and predates both the valuation map and the archetype study: it
   contains no occurrence of "valuation", "priceable", "archetype" or
   "repeatability", and its counterparty row cites
   `counterparty-pricing.js:49, 120` where the constants now sit at :28, :30,
   :98, :101-105, :112, :172-187. Its item (c)-14 is also now closed on both
   halves — `counterpartyDataKey` is called at `trade-engine.js:1447` inside the
   cache key, and `negotiationProfilesFor` has two live callers
   (`counterparty-pricing.js:147`, `:858`). That document has one owner; this
   addendum is written to be folded into it rather than editing it in place.
3. **`waiver-brain.js:269` hardcodes `accept_probability: 0.9`** and serves it as
   `confidence` at `:309`. `NUMBER-PROVENANCE.md` states "there is no acceptance
   probability anywhere in live code", which is true of the trade path — the
   `acceptProbability` referenced at `trade-engine.js:31` and
   `league-brain.js:185` is gone — but not of waivers. A constant 0.9 presented
   as confidence is the failure shape CLAUDE.md names: a number that looks
   measured and is not. Feature-audit's file.

## 5. What would change the answer

Only decided proposals. The population is 30 with 6 accepts; the measurement is
pre-registered and re-runnable, and the master plan (E1) already commits to
re-testing as they accrue. Until then the honest statement on the Trade Brain
page is the one the code already makes: these are reads, with their samples and
their caps shown, and they are not priced on.
