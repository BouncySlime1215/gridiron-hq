# Coach Playbook — behavioural rules for Phase 8

**Status:** plan-ready companion to `FANTASY-ENGINE-MASTER-PLAN.md` Phase 8. Written 2026-09-17.
**Nick's rulings (2026-09-17):** (7) neutral reference = ESPN, cited only as a closing move (gap < 10 %, ≥ 2 counters) and only when it is at or above Nick's floor — never when it favours them; (8) no A/B — measure by predicted-vs-realised acceptance instead; (9) no conditional picks in any league → T16 off; (10) concession ladder is decided **live**, step by step from the counterparty's actual reply, with only the floor fixed in advance → requires the live chat monitor (plan Phase 8b).
**Scope:** the rules the Coach applies when it turns `{targetRosterId, package, draft}` into `{message, anchor, send_at, dont_say[], predicted_response, p_accept}`. It does not re-specify the profile (4b), the chat labels (4c), `their_value` (4d), or the ask/fair/floor ladder and negotiation sim (5); it consumes them. Section 7 lists what the profile must add.

## 0. Evidence key, precedence, and the standing constraint

Every rule is tagged with its school and its evidence grade:

- **[Voss]** Black Swan / *Never Split the Difference*. **[PON]** Fisher & Ury, Malhotra & Bazerman. **[Cialdini]** influence and compliance literature. **[BE]** behavioural economics of bargaining. **[E-neg]** Thompson–Nadler email/text negotiation, chronemics, receptiveness. **[FF]** fantasy practitioner columns.
- **(P)** peer-reviewed with a replicated direction. **(p)** practitioner consensus or single lab study; direction only. **(i)** our inference from adjacent evidence; treat as a hypothesis to measure (section 8).

When schools conflict, the Coach ranks (P) over (p) over (i), and within a tie prefers the rapport-preserving move. The reason is structural, not stylistic: the focus league is ten people who trade with each other every week for years. The Negotiation Journal rejoinder to Voss, the PON hardball-tactics review, Wong's door-in-the-face detection study, and every [FF] source say the same thing — in repeated play, a move that reads as manipulation costs every future trade with that manager. The Coach optimises expected value over the season, not the current thread.

Six conflicts, resolved explicitly:

1. **"Never split the difference" [Voss] vs objective criteria [PON] and neutral focal points [BE].** Resolved: the Coach never proposes a midpoint on a single-issue swap. When the gap is < 10 % of `their_value` after two counters, the Coach closes on a *named neutral reference* (ESPN value, FantasyCalc, the league's own comparable trades). That is anchoring to a criterion, not splitting; the [BE] focal-point evidence (Babcock & Loewenstein, impasse 28 % → 6 % when the self-serving gap is removed) is stronger than Voss's lore. Where a multi-issue logroll exists, it is used instead of any midpoint (Thompson & Hastie; Galinsky et al. 2008 Study 3, (P)).
2. **Ackerman 65 % opener [Voss] vs the fairness floor [BE] and impasse risk (Lee et al. 2018, (P)).** Resolved: the opener is never below the Phase-5 *ask* (P(accept) ≈ 0.25), which is by construction inside the engage zone and above the 80 %-by-neutral-score floor. The 65/85/95/100 ladder is replaced by ask → fair → floor with shrinking steps (section 4). The only surviving Voss components are the ones with (P) support: precise assets and a stated reason.
3. **Loss framing [Voss] vs gain framing [BE, Cialdini].** Resolved: gain frame by default (Neale & Bazerman 1985; Bazerman, Magliozzi & Neale 1985, (P): loss-frame negotiators concede less and impasse more). A loss statement is permitted only as one sentence about a concrete lineup hole (bye, injury, streamer at flex), never about record, playoffs, or the score, and never to `panic_seller ≥ 0.5` (already in the loss domain; de Dreu et al. 1994 show a visible loss frame invites exploitation, which is what a vulture bid looks like).
4. **Label the emotion [Voss] and schmooze [E-neg] vs perspective-take, don't empathise [BE].** Resolved: one warm, specific, third-person line is allowed as a rapport opener (Morris et al. 2002, impasse 61 % → 41 % with pre-negotiation rapport, (P)); the offer body is written from their roster outcome, not their feelings (Galinsky et al. 2008: deal rate 76 % perspective-taking vs 54 % empathy, (P)). "I understand" and "I feel for you" are on the never list.
5. **Precise anchors (Mason et al. 2013, (P)) vs too-much-precision with experts (Loschelder 2016, (P)) vs hedged openers for walkers (Lee, Mason & Malcomb 2025, (p)).** Resolved by profile: precise assets + one reason for engagers; a hedged *shape* for walkers and ghosts; no numerical precision at all for managers with high `expertise` (section 7).
6. **Door-in-the-face [Cialdini] vs "never send dummy offers" [FF] and detection retaliation (Wong/PON).** Resolved: DITF as a discrete tactic is disallowed. The ask → fair retreat in section 4 provides the reciprocal-concession effect honestly, because the ask is a package Nick would actually accept.

## 1. Opening and anchoring rules

The anchor the Coach returns is the Phase-5 ladder point chosen by the rules below, expressed as a specific package (assets, pick year and round), never as "a pick and a flier".

| Rule | Condition | Anchor | School / evidence |
|---|---|---|---|
| 1.1 Go first | No price named by the counterparty in this thread AND `expertise` (§7) < 0.7 | Nick names the full package. Never "what would you want for X?" | [BE] Galinsky & Mussweiler 2001; Orr & Guthrie 2005 meta r ≈ .50 (P) |
| 1.2 Ask first | Counterparty has named a price, OR `expertise ≥ 0.7`, OR `hoarder ≥ 0.5`, OR a logroll is available and `reply_p90 ≤ 24h` | One question about their need, then anchor on message 2 | [BE] Loschelder "anchor sinks your boat" (P); [E-neg] Sinaceur et al. 2013 late first offers → more integrative deals (P) |
| 1.3 Ladder point by engagement | `counter_rate > 50%` AND `reply_p50 < 6h` AND `ghost < 0.4` | **ask** (P ≈ 0.25) | [BE] Oesch & Galinsky review; [FF] Cummings "close to my best, not my best" (p) |
| | `counter_rate` 25–50 % | between ask and fair (P ≈ 0.35–0.40) | same |
| | `counter_rate < 25%` OR `ghost ≥ 0.6` OR first-ever proposal to this manager | **fair** (P ≈ 0.5), stated as near-best ("not a starting point") | [E-neg] Lee et al. 2018 barrier-to-entry (P); [FF] |
| | `panic_seller ≥ 0.5` AND `reacting_to_loss` within 48 h | **fair**, framed as a floor-for-ceiling swap | [FF]; [E-neg] post-loss "help, don't pounce" (p) |
| | `sharp ≥ 0.6` OR `expertise ≥ 0.7` | **fair** with the neutral reference named | [BE] Loschelder 2016 expert backfire (P) |
| | Nick has ≥ 2 declined-without-counter proposals to this manager this season | fair, tilt 0 | [FF] "boy who cried wolf" (p) |
| 1.4 Fairness floor | Neutral score gives their side < 80 % of Nick's (< 90 % if league has veto or they complained about a "lopsided" trade in 30 d) | Reposition by adding a low-cost-to-Nick asset before sending; never send | [BE] ultimatum-game rejection below ~20 %; Loewenstein et al. 1989 (P). 80 % is our translation (i) |
| 1.5 Precision by profile | `counter_rate ≥ 40%` AND `expertise < 0.7` | Exact assets + one number (PPG rank, ROS rank) + one reason | [BE] Mason et al. 2013, d ≈ .5 on adjustment size (P) |
| | `expertise ≥ 0.7` | Exact assets, no numbers, one roster-fit reason | Loschelder 2016 (P); Maaravi justification backfire (P) |
| | `counter_rate < 30%` OR `ghost ≥ 0.5` | Hedged shape: "something in the neighborhood of X for Y + Z" | [E-neg] Lee, Mason & Malcomb 2025 (p) |
| 1.6 Units | `stated_valuation_unit` (§7) exists | Express the offer in their unit (pick round / tier / straight-up), not tool value points | [E-neg] Petrowsky et al. 2023, 25 M eBay negotiations, mimicked endings → fewer impasses (P, correlational) |
| 1.7 Firm wording | Always | Warm opener line if allowed by §5, then firm offer language; no "let me know what you'd want" | [Cialdini] Jeong et al. 2019 firm > friendly first offers, no satisfaction penalty (P) |
| 1.8 MESO instead of a single anchor | `ghost ≥ 0.6` OR `reply_p90 > 24h` OR `hoarder ≥ 0.5` OR `counter_rate > 60%` OR an untouchable is stated OR last reply was "not that one" | 2–3 packages equal to Nick within 5 % on `my_ros_gain`, differing in shape; ask "which is closest" | [PON, E-neg] Leonardelli et al. 2019, six studies (P). Never > 3, never a decoy, never to `panic_seller` in window |
| 1.9 Package shape | Draft is N-for-M with N > M AND (`droppable_count` (§7) = 0 OR `hoarder ≥ 0.6` OR they declined a 2-for-1 before) | Convert to N-for-N by taking their worst roster player back, or name the drop and why it is painless | [FF] "2-for-1 is a 3-for-2" (p); [BE] roster-spot cost to hoarders |
| 1.10 Never naked | Always | Every in-app offer carries a ≤ 3-sentence note in their-roster terms | [FF] (p) |

## 2. Framing rules

Applied as rewrite passes over Nick's draft, in this order. The Coach repositions the draft; it does not replace Nick's voice.

1. **Perspective-take in the body.** [BE] (P). Every sentence about Nick's need becomes a sentence about their lineup outcome. Lint: `you/your` count ≥ `I/my` count in the body. Quote their own stated valuation verbatim when one exists ≤ 30 days old (`stated_valuations` ledger).
2. **Gain frame, reference point = their current roster.** [BE, Cialdini] (P). Lead with what stays and what arrives; the outgoing piece last and once. Never "bust", "sell low", "cut your losses", the score, their record, or their draft slot. One concrete-hole sentence permitted (conflict 3).
3. **Their words as the criterion.** [PON, Cialdini, FF] (p; consistency literature (P) in general). If `stated_valuations` contains a claim about a player in the deal ≤ 30 d old, made outside a `reacting_to_loss` window, and the offer satisfies it on its face, cite it in DM only. If the valuation has since been contradicted by news, acknowledge that first or do not cite.
4. **Reason calibrated to ask cost.** [Cialdini] Langer 1978 (P); Maaravi (P). Low-cost ask (bench-for-bench, a reply request): any reason. High-cost ask (their starter, `their_value_delta` < 0): only a reason grounded in roster data they cannot cheaply rebut (bye hole, depth ≤ 1, schedule), else no reason. Never "because I really need a WR".
5. **Constraint-first.** [PON] investigative negotiation (p). If their roster shows a structural constraint the deal would worsen (depth ≤ 1 at a slot, roster at max, bye cluster next week, IR full), name it and pre-solve it with an asset cheap to Nick.
6. **Receptiveness recipe on any counter or rejection.** [E-neg] Yeomans et al. 2020, d ≈ 0.47 on receptiveness, more persuasive to disagreers (P). Four beats: acknowledge specifically, name a point of agreement, state the disagreement positively ("I can do Z" not "I can't do that"), hedge. Lint: ≥ 2 negations or any "you should / you have to" in the draft triggers the rewrite.
7. **Tone guard.** [E-neg] Kruger et al. 2005: sarcasm decodes near chance by text (P). Strip sarcasm, jokes at their roster, ALL-CAPS, and bare one-word replies. Add one warmth token (their name or a specific acknowledgment). Emoji: at most one, only if their `emoji_rate` (§7) > 0 in the last 10 messages and this is not first contact.
8. **Register for the anchor, the final, or a "no".** [Voss] late-night DJ, translated (i). Sentences ≤ 12 words, no exclamation marks, one ask per message. Use on ≤ 20 % of messages; never on first contact with a ghost, never in banter.
9. **Fairness vocabulary.** [Voss] (p), [BE] (P on self-serving bias). Nick never says "fair", "lowball", "fleece", "you'd be crazy", "trade calculator", and never pastes a screenshot. If *they* say "fair/lowball/insult", the Coach mirrors the word, labels once ("seems like it came across like I'm trying to pull one over"), and offers to walk through the reasoning or hear their number. Never "it's a fair offer".
10. **Concede one weakness, anchor on one reference.** [BE] Babcock & Loewenstein 1997 (P). After ≥ 2 counters, or when `|stated_value − their_value| > 20 %`, or when they used "fair/lopsided": voluntarily acknowledge one real weakness in Nick's side (not the core of the pitch) and point both at one named reference. Never cite a reference Nick has not checked against their known source (`expertise` source list) — two focal points is worse than none.

## 3. Tactic table

Triggers are evaluated in the order listed; the first row whose trigger fires sets the primary tactic, and rows marked (+) may stack. Signals in `code` are 4b/4c fields or §7 additions. Thread-state fields (`thread.*`) are §7.

| # | Trigger (measurable) | Tactic | Message move | Avoid | School / grade |
|---|---|---|---|---|---|
| T1 | `thread.n_msgs = 0` AND (`days_since_last_dm > 30` OR `trust_with_nick` bottom tercile) | Schmooze, then ask permission to send | One specific warm line (their injury, a shared loss), then "want me to send something?"; package only after reply | Nothing generic; no ask in the same sentence; skip if a DM happened in 7 d | [E-neg] Morris et al. 2002 (P); [PON] process-before-substance (p) |
| T2 | `ghost ≥ 0.5` OR `reply_p90 > 24h` OR `counter_rate < 20%`, first contact | Foot-in-the-door / no-oriented opener | "Quick one, yes/no: is X someone you'd move, or off the table?" Under two lines. Nothing else | Not with `hoarder ≥ 0.6` ("are you against moving X" hands them the exit → use MESO); not in the group | [Cialdini] Burger 1999, small but real (P); [Voss] (p); PMC 2023 "words to say no" (p) |
| T3 | `stated_valuations` count < 2 OR max archetype score < 0.5 OR no completed trade with Nick | Investigate before offering | One question about *them*: "what are you actually trying to fix, RB or depth?" | One question, not several; not about the player Nick wants; not to a ghost (use MESO) | [Voss] black swan (p); [PON] investigative (p); Galinsky 2008 (P, mechanism) |
| T4 | `hoarder ≥ 0.5` OR `untouchables` non-empty | Trade *around* the untouchable; endowment flip | "Not asking about X, I know that's off the table. What about [teammate / their 2nd at that position]?" (+) "If you already had Y and I offered X for him, would you take it? Same trade." | Never chase the untouchable in the same thread; never tell them they are overvaluing; never target a player they acquired by trade < 3 weeks ago | [BE] KKT 1990 WTA ≈ 2× WTP (P); AFL pick study compounding endowment (P); [PON] ignore the ultimatum (p) |
| T5 | `last_msg_class` = ultimatum ("untouchable/final/not moving") AND `thread.ultimatum_n ≤ 2` | Ignore it, pivot to another asset | "Got it. Separate question — what are you thinking on [other player]?" | Never quote or argue the ultimatum; if `ultimatum_n ≥ 3` on the same asset, stop and pivot targets | [PON] Malhotra (p) |
| T6 | `talker ≥ 0.6` AND `last_msg_class` = valuation claim without reasoning AND `reply_p50 < 2h` AND channel = DM | Text mirror, once | Echo their last 1–3 words with a question mark; nothing else | Once per thread; never to a ghost (costs a round trip); never late in the thread; never copy slang/emoji wholesale | [Voss] (p); Swaab et al. 2011 early mimicry helps, late does not (P); too-much-mimicry 2023 (P) |
| T7 | `last_msg_class` = rejection with reason, OR `counter_rate > 60%`, OR `thread.counter_n ≥ 2` | Calibrated how/what question, no re-price | "How do I make this work without giving up [Nick untouchable]?" / "What would it take on your side?" | Never "why won't you"; one question per message; if they stated an untouchable Nick is asking for, summarise (T8) and pivot instead | [Voss] (p); [PON] "ask why before you sell" (p) |
| T8 | `stated_valuations` ≥ 2 for this manager OR `thread.their_msgs ≥ 3` | "That's right" summary before the repositioned offer | Paraphrase need, valuation, refusal; "that about right?"; send the offer only after confirmation | If the reply is "you're right / sure", re-summarise with a label; never insert Nick's counterargument in the summary; not from thin data | [Voss] (p); Galinsky 2008 perspective-taking (P, mechanism) |
| T9 | `reacting_to_loss` ≤ 48 h AND `panic_seller ≥ 0.5` AND (starter injured OR standings drop ≥ 2) AND last group message not angry | Post-loss help window | DM in the 12–36 h window: "If you want to stabilise RB this week rather than ride waivers, I can send X for Y today. It's there if it helps." Certainty for upside | No score, no "buy low", no group chat, no lowball (remembered all season); no send inside 2 h of the loss; if `hoarder ≥ 0.6` hold 3 days regardless | [FF] (p); [BE] risk-seeking in loss domain (P, individual choice); [E-neg] Moore 2004 (P, direction) |
| T10 | `reacting_to_loss` ≤ 48 h AND `panic_seller < 0.4` | Hold; send Wed–Thu after waivers, no reference to the loss | Non-panic template: "Now that waivers are done — X for Y? Helps both playoff schedules." | Nothing before 48 h; no sympathy opener; no loss language | [PON] Fisher & Ury emotion (p); [BE] loss frame → less concession (P) |
| T11 | Their `bye_cluster_next_week ≥ 2` starters AND bench cannot cover AND record .400–.600 | Pre-bye squeeze | Send Tue–Wed of the prior week: "X and Y both off next week and nothing behind them — A plays, for B. Keeps you alive without a waiver gamble." | Dead after Thursday; no lowball to a contender's bye pain | [FF] (p) |
| T12 | Week ≥ 5 AND their record ≤ .500 AND weeks to deadline ≤ 6 | Now-for-later | Offer the higher weekly floor for the slower-ramping / better playoff-schedule asset; "you need wins now, I'll take the wait" | Never "you're out of it"; if record ≤ .300 expect huge latency, consider another partner | [FF] (p) |
| T13 | `name_brand_buyer ≥ 0.6` AND Nick holds a player with ADP rank ≥ 10–15 spots better than current ROS projection rank | Name-brand lead | Lead with the name and pedigree; ask for their high-usage low-name player; no usage stats in the message | Never to `expertise ≥ 0.5` (they will see through it and it costs credibility); never attach projections (cues the counter-information that kills the anchor) | [BE] selective accessibility (P, mechanism); [FF] (p) |
| T14 | `stated_valuations` includes praise of a player Nick owns, ≤ 30 d, not in a loss window | Normative leverage / their words | "You said last week X is a league-winner once the schedule softens. Would you be opposed to him for Y + pick?" DM only | Never out of context, never > 30 d, never to pry a hoarder's untouchable, never in the group | [Voss, Cialdini, PON, FF] (p; consistency (P) generally) |
| T15 | Positional depth mismatch (they top-3 at P, Nick bottom-3, reverse at Q) OR contender/rebuilder mismatch, AND `counter_rate > 40%` | Logroll | Multi-issue package built on the mismatch; "we're not competing — you're in the race, I'm not" | No 3-for-1 dumps to hoarders/name-brand buyers; no logroll to a panic seller mid-tilt (keep 1-for-1) | [PON, BE] Thompson & Hastie; Galinsky 2008 Study 3 joint gain (P) |
| T16 | `|nick_value − stated_value| > 15 %` on one asset AND the gap is a forecast (injury, role, rookie) AND the league can log conditional picks | Contingent contract | "Let the season decide: if he finishes top-12 the 2nd becomes a 1st, else it stays a 2nd. Commish logs it." Layered on a near-done deal | Not against `expertise ≥ 0.7` on that team; not as a substitute for a real offer; skip if unenforceable | [PON] Bazerman & Gillespie (p) |
| T17 | Nick rosters the direct handcuff to one of their top-2 RBs, or a keeper-eligible piece and they are out (record ≤ .350, week ≥ 8) | Asymmetric-value pitch | "He's insurance for you, a dead roster spot for me" | Not to a hoarder already deep at RB; not for a handcuff Nick cannot start | [FF] (p) |
| T18 | `their_counters_asset_class` (§7) shows ≥ 2 counters asking for the same class (always a pick, always a throw-in RB) | Demand-as-signal | Give more of that class in exchange for keeping Nick's core piece | Do not announce the insight; discount for talkers who ask for everything | [PON] investigative principle 3 (p) |
| T19 | `last_msg_class` = rejection-no-counter AND `counter_rate < 30%` AND Nick's draft adds value vs his last offer | Don't bid against yourself | "What would get it done from your side? I'd rather hear your version than keep guessing." Then wait | No second sweetened offer the same day; if `reply_p90 > 48h` and Nick needs the player this week, pair with a MESO | [PON] hardball tactic 4 (p) |
| T20 | `rejection_latency` (§7) > their `reply_p50` ("close" branch) | Persist with one small increment | "Sounds like it was close. Would [previous + small piece] do it?" | Not if the previous offer was at floor; ignore for ghosts whose baseline is already > 24 h | [PON] Cotet, Krajbich et al. 2025, ~1 M eBay negotiations + field experiment (P, transfer is (i)) |
| T21 | `rejection_latency < 0.5 × reply_p50` ("far" branch) | No nudge; return to T3/T7 or a MESO | — | No sweetener | same |
| T22 | `batna_n ≥ 2` (roster scan finds ≥ 2 partners for the same need) | Truthful multi-shop, disclosed | "I've got a similar version out to one other team; you're my first look because you need an RB more." Send the other offer the same hour | Never fabricate; once per thread; never "take it or I go to Dave"; not to a hoarder who resents being rushed; if `batna_n = 0` the BATNA line goes on the don't-say list | [PON, BE] Pinkley et al. 1994 (P); [FF] Cummings/Cockcroft (p) |
| T23 | Real league event within 7 d (waiver run, Thursday lock on a player in the deal, trade deadline) AND (`reply_p90 > 24h` OR `counter_rate > 50%`) | Reveal the real deadline | "I need to know by Wed 8pm because waivers run at 9 and I'll pivot. No pressure either way." Stated ≥ 36 h out and ≥ 1.5 × their `reply_p90` | Never invented; never attached to first contact with a ghost (pair with T2); never an exploding clock; their deadlines on Nick are flagged as likely arbitrary and do not trigger concessions | [Voss, Cialdini, E-neg] Moore 2004; Gino & Moore 2008 (P) |
| T24 | Incoming offer: unsolicited, from `talker ≥ 0.6` or `sharp ≥ 0.6`, reply latency < 15 min, push to close; OR arrives < 6 h after news on a player in it | Winner's-curse check | Check the news feed first; "Interesting — why now? Anything on X I'm missing?" | Never accept in minutes even if good; one small kicker ask before closing | [BE] Samuelson & Bazerman; Galinsky et al. 2002 (P on satisfaction) |
| T25 | Deal verbally agreed, not yet submitted, `counter_rate > 60%`, `hoarder < 0.4`, `thread.concessions_by_them < 2` | Nibble, once | "Deal. One small thing — flip our 2027 4ths since I'm sending the better pick? Then I'll submit." Defensive: "Ha, you already got the good end. Let's keep it where we shook on it; submitting now." | Never twice; never material; never to a hoarder or someone who conceded twice | [Cialdini] Dawson (p) |
| T26 | Thread ended in rejection ≥ 24 h ago, no offer since, target still on Nick's list, `ghost < 0.5` | Keep investigating after no | "For my own calibration — what would it have taken? Not trying to reopen it." Wait ≥ 1 day before using the answer | Not with a new offer in the same message; not to ghosts | [PON] investigative principle 5 (p) |
| T27 (+) | League veto enabled AND neutral gap > 20 % either way, OR top-12 overall player for multiple pieces | Veto-proofing | After acceptance, one neutral group line before the review window: what each side needed. Nothing else | Never post the offer, the calculator verdict, or "win" language; never ask the commissioner publicly; one calm explanation, then silence | [FF] (p) |

## 4. Concession and counter ladder

Inputs from Phase 5: `ask` (P ≈ 0.25), `fair` (P ≈ 0.5), `floor` (P ≈ 0.75, `my_ros_gain ≥ 0`), all in `their_value` units; the negotiation sim's counter distribution for this manager; `thread.*` state. Let `G = ask − floor`.

**Outbound (Nick proposing).**

| Step | Precondition | Move | Wording rule | School |
|---|---|---|---|---|
| 0 Open | Section 1.3 picks the point | Open at ask / between / fair by profile. Pre-commit `floor` and `max_counters = 3` before message 1 | Precise assets, one reason (or none for experts), MESO where 1.8 fires | [BE] Oesch & Whyte 2002 (p); [FF] walk-away (p) |
| 1 | They counter (any class) | Concede ≈ 0.5 G → lands near `fair`. Name the concession and its cost; state what it buys | "I'm adding Z — that's my flex most weeks. That closes the gap on my side, so the 2nd comes off your ask." | [PON] Malhotra concession rules (p); Kwon & Weingart (P) |
| 2 | They counter again | Concede ≈ 0.3 G. Say it is the last real move | "I can swap the 3rd for the 2nd. That's my last real move." | [Cialdini] OBHDP 2021 diminishing concessions signal the floor (P) |
| 3 | Third counter AND remaining neutral gap < 10 % AND a throw-in exists (bench outside top-150 or a round-4+ pick they have not said they dislike) | Concede ≈ 0.2 G plus the non-core throw-in → `floor` | "Last one from me: [core] plus [throw-in] so you're not naked at flex. That's my ceiling; if not, no hard feelings." | [Voss] final Ackerman step (p) |
| Stop | Any of: floor reached, `thread.counter_n ≥ 3`, neutral gap stopped closing on the last round, or they re-anchor higher after Nick conceded | Walk-away close; reopen with a different package after ≥ 7 days | "That's my last version — totally fine if it's a no, I'll leave it there." | [BE] escalation of commitment (P); [FF] |

Invariants: steps strictly shrink (equal steps signal room, a larger later step signals the earlier floor was false); no concession without a counter from them (T19); no concession before a "how/what" question has been asked at least once (T7) unless `trust_with_nick` is high; "final" is said exactly once per thread; the fair waypoint is where the neutral reference is cited (rule 2.10). The Coach's `predicted_response` at each step comes from the Phase-5 counter distribution; if the sim says P(counter) < 0.2 at the next step, the Coach recommends stopping rather than conceding.

**Concession timing by trust.** `trust_with_nick` low or unknown (< 2 completed trades, or last thread ended in rejection): hold each reply for max(30 min, `reply_p50`) and at most min(24 h, `reply_p90`); reply first with a question or a "looking at my week 6–8 lineup, back tonight", then concede with a reason. `trust_with_nick` high (≥ 2 completed trades, positive tone): concede fast to close. [Cialdini] NCMR extension of Kwon & Weingart: immediate concessions cut satisfaction and perceived quality only when the partner is expected to be self-interested (P).

**Inbound (Nick receiving).**

1. Acknowledge within hours regardless ("saw this, thinking, reply tonight") — eBay data says counterparties misread slow replies as disinterest [PON] (P, direction). Decide on the paced schedule above.
2. Never accept in < 30 min. If their offer is within 15 % of Nick's reservation: flinch once ("that's more than I had in mind"), then one small ask (kicker or pick swap), then close. [Cialdini] Fassina & Whyte 2014 (P); [BE] Galinsky 2002 (P).
3. Run T24 on any suspicious fast offer.
4. Counter with one adjustment toward them and a pocket piece pre-tagged in Nick's roster; never resend the original reshuffled. [FF] (p).
5. Their deadline on Nick: flag as probably arbitrary; no concession to meet it. [Voss, PON] (p).

## 5. Channel and timing

**Channel.**
- Terms are negotiated in DM, always. [E-neg] Carnevale, Pruitt & Seilheimer 1981: audience surveillance raises threats and positional commitment and lowers joint gain (P); Malhotra on side channels (p). Triggers that force the move: Nick's draft addressed to the group; `talker ≥ 0.6`; the counterparty posted about the target in the last 14 d; ≥ 2 other managers reacted in the thread. Group line: "[Name] I'll DM you."
- The group chat has exactly two legitimate uses: a "taking offers on X" post when Nick *wants* multiple bidders (`batna_n ≥ 2`) [E-neg, FF] (p), and the one-line veto-proofing note after acceptance (T27).
- Never in the group: mirrors, labels, quoted valuations, calculator numbers, a counter to a position they stated publicly (it forces them to defend it to the audience), a dunk on a declined offer, or a request that the commissioner push a deal through.
- Public statements bind harder than private ones [Cialdini] (P), so the Coach *reads* group-chat valuations and *uses* them in DM (T14).

**Timing.**
- `send_at` = the counterparty's modal fast-reply hour (reply-latency-by-hour histogram, ≥ 20 timestamped messages) on Tue–Thu; default Tue–Wed evening after waivers. Never Sun 1 pm–midnight ET, never Mon night, never during waiver processing, never within 2 h of their loss. [E-neg, FF] (i).
- Post-loss gate: `panic_seller ≥ 0.6` → 12–36 h after the loss (after MNF, before Wednesday waivers); `panic_seller < 0.4` → ≥ 48 h, Wed–Thu. [BE, FF, PON] (p).
- Pre-bye: Tue–Wed of the week before the bye cluster (T11).
- Follow-up: exactly one, at max(`reply_p90`, 48 h): "No pressure — just want to know if it's a no so I can look elsewhere." A second follow-up only if `talker ≥ 0.5` and `reply_p50 < 12 h` (they engage but forgot). Never re-ping inside their p90 — inside their own latency it reads as pressure [E-neg] Kalman & Rafaeli (P on silence perception; (i) for hours-scale). Never fill silence with a better offer.
- Set the clock explicitly when `reply_p50 > 6h` or `ghost > 0.5`: append "no rush; if I don't hear by Thursday night I'll assume it's a pass, no hard feelings." Defuses temporal-synchrony and sinister-attribution bias [E-neg] Thompson & Nadler 2002 (p).
- Deadlines: real events only, ≥ 1.5 × `reply_p90` away, ≥ 36 h out (T23). Nick's own reply pace: ≥ their p50 for counters (never faster than 30 min), ≤ min(24 h, p90) so the delay is not read as hostility [E-neg] 2025 26 M-negotiation study: later counters → better price and fewer impasses (P, correlational).
- Deadline week: expect `week_distribution` and "goes quiet before the deadline" (4b) to shift; the Coach shortens the follow-up window to `reply_p50` and prefers MESOs.

## 6. What the Coach never does

- Sends an in-app offer without a note, or a note containing "fair", "lowball", "fleece", "you'd be crazy", "trade calculator", a score reference, or a screenshot. [Voss, FF]
- Opens below `ask`, below the 80 % neutral floor, or with a 3-for-1 of bench players. [BE, FF]
- Sends a dummy or decoy package, a fabricated competing offer, an invented deadline, or a fake favour. In a ten-person league these are checked in the group chat and the reputational cost is paid on every future trade. [PON, Cialdini, FF]
- Runs door-in-the-face as a discrete tactic, nibbles twice, says "final" twice, or re-anchors higher after conceding. [Cialdini, PON]
- Says "I understand", "I feel for you", "everyone has a price", "you said that last month", "sell low", "bust", or mentions their record or the score. [Voss, BE]
- Quotes them out of context, from > 30 d ago, from a loss window, or in the group. [Cialdini, E-neg]
- Asks for a stated untouchable, or a player they acquired by trade in the last 3 weeks. [BE, PON]
- Bids against itself: no sweetened re-offer after a rejection without a counter. [PON]
- Double-texts inside their `reply_p90`, sends during Sunday games, or within 2 h of a loss. [E-neg, FF]
- Uses the low, slow register for a whole thread, or emoji on first contact. [Voss, E-neg]
- Accepts an incoming offer in under 30 minutes, or one that arrived within 6 h of news without checking the feed. [BE]
- Continues after a third counter or a third repetition of the same ultimatum. [BE, PON]
- Lets a thread with a `sharp`/`expertise ≥ 0.7` manager carry precise numbers Nick cannot back. [BE]

## 7. New data the profile must carry

The plan's 4b/4c already carry: reply p50/p90 and hour/day histograms, counter rate and magnitude, ghost/unanswered %, post-loss trade rate, `reacting_to_loss`, the stated-valuations ledger with dates and confidence, untouchables and sell statements, tone mix, loss reactivity, responsiveness and history with Nick, name-brand/endowment/recency premiums, fairness sensitivity, archetype scores, and the seasonal price trend. The rules above additionally need the fields below. Sources: **C** chat, **T** transactions, **R** rosters, **N** Nick's draft, **L** league settings, **S** derived/thread.

*Per manager (profile additions)*
1. `expertise` (C): rate of calculator / ADP / snap-share / target-share / rankings-site citations per 100 messages, and which sources; drives rules 1.2, 1.5, T13, T16.
2. `stated_valuation_unit` (C): modal unit of their value talk — pick round, tier ("WR2"), straight-up, or points; drives 1.6.
3. Stated-valuation *channel* and *loss-window flag* (C): whether each ledger entry was made in the group or a DM, and whether inside `reacting_to_loss`; drives T14 and rule 2.3.
4. `stated_needs` / `stated_denials` (C): explicit "I need a RB" / "my RBs are fine" statements with dates; T1/T3 must not diagnose a denied need.
5. `emoji_rate` (C): share of their last 10 messages with emoji; rule 2.7.
6. `trust_with_nick` (T, C): fitted from completed trades with Nick, outcome of the last thread, and tone toward Nick; drives concession timing and T1. (Plan has the ingredients; the composite is new.)
7. `days_since_last_dm` with Nick (C).
8. `rejection_latency` conditional on outcome (T, C): time-to-decline vs time-to-accept, expressed as a ratio to `reply_p50`; drives T20/T21.
9. `instant_accept_n` (T): count of Nick's proposals accepted with no counter in < 1 h; raises the next opener one notch.
10. `their_counters_asset_class` (T): asset class requested in each of their counters (pick / throw-in RB / starter swap); drives T18.
11. `ultimatum_ledger` (C): ultimatum phrases per asset with repetition count; drives T5.
12. `lopsided_complaints` (C): "lopsided / collusion / robbery" posts in the last 30 d; raises the fairness floor to 90 %.
13. `tactic_exposure_log` (S): per manager, which Coach tactics have been used this season (deadline revealed, BATNA mentioned, nibble, "final" said, T14 quote) and their outcome; enforces the once-per-thread and once-per-season rules and feeds section 8.
14. `reply_latency_by_hour` (C): the hour-of-day histogram restricted to *replies*, not all messages; `send_at`.
15. `team_news_mention_rate` by NFL team (C): proxy for information asymmetry on a given player (they follow that beat); drives 1.2 and T16.

*Per roster / situation (from R, L, M)*
16. `droppable_count`: bench players below waiver-replacement value; `positional_depth` per slot; `roster_at_max`; `ir_slots_free`; `bye_cluster_next_week`; handcuff map (backup-of-their-RB1); keeper eligibility where the league has it. Feeds 1.9, T4, T11, T17, rule 2.5.
17. `acquisition_source_and_date` per roster asset (draft round / waiver / trade, date): endowment is highest on recent trade acquisitions; T4 and target selection.
18. `batna_n`: number of other rosters where an equivalent package is plausible (from `findTrades`); T22.
19. League calendar: lineup lock times, waiver run time, trade deadline, veto rule and review window; T23, T27, §5.
20. NFL game windows for the week (for the Sunday/Monday blackout).

*Per thread (S — a new `coach_threads` state store)*
21. `last_msg_class` ∈ {accept, counter, reject-with-reason, reject-no-counter, ultimatum, valuation-claim, "you're right"-type brush-off, "that's right"-type confirmation, silence}; keyword flags for fair/lowball/insult; sentiment.
22. `counter_n`, `their_msgs`, offer diff history (what Nick added or dropped each round), `concessions_by_them`, `ultimatum_n`, `idle_time`, `next_allowed_followup`, whether "final" has been said, agreed-but-unsubmitted state.

*Nick's draft (N — lint output the Coach reads)*
23. I/you ratio; exclamation, emoji, caps counts; negation count; obligation words ("you should/have to"); sarcasm markers; forbidden vocabulary hits; whether the draft adds value vs the last offer without naming it; whether the draft carries an implicit deadline; channel it is addressed to.

## 8. Measuring whether the Coach works

The Phase 8 acceptance ("Nick rates ≥ 8/10 as I'd send that") measures whether Nick will use it, not whether it works. The outcome test is against an uncoached baseline, with the harness discipline from section 6 of the master plan.

**Baselines.**
- *Historical:* every proposal Nick sent in 2023–25 across the five leagues (from 4a), with its outcome, reply latency, counter count, final `their_value_delta`, and the surrounding chat. This is the uncoached control and it also fits the Phase-5 P(accept) model's prior.
- *Concurrent:* alternate threads coached vs uncoached by a pre-registered rule (e.g. odd/even week × partner, blocked so each partner gets both). Nick may override, but the override is logged and the analysis is intention-to-treat.
- *Model counterfactual:* for every coached message, score both the raw draft and the coached message under the Phase-5 P(accept) model; the predicted lift is reported beside the realised one so we can see whether the Coach is doing what the model thinks it is.

**Primary outcomes (paired by partner where possible).**
1. Acceptance rate of proposals (accepted / decided).
2. Reply rate (non-silence within `reply_p90`), and time-to-first-reply as a ratio to the partner's `reply_p50`.
3. Time-to-yes on accepted deals, in rounds and in hours.
4. Counter magnitude: distance from opener to final in `their_value` units, and their first counter's distance from Nick's anchor (the Mason et al. adjustment-size measure).
5. Value captured: final `my_ros_gain` relative to the `fair` point (≥ 0 means Nick closed at or above fair), and realised end-of-season points from the deal (Phase 9 machinery).
6. Impasse and walk-away rate; veto rate.

**Relationship guardrails (must not degrade).** Per partner across the season: reply probability to Nick, `reply_p50` to Nick vs to others, tone-toward-Nick share, and whether the partner initiates with Nick. A Coach that raises acceptance this week and lowers reply probability next month has failed; report both.

**Tactic-level attribution.** `tactic_exposure_log` gives which rows of section 3 fired per message. Report the whole family; BH across tactics; placebo by shuffling coached/uncoached labels within partner; drift baseline = Nick's historical rates by partner. Timing claims (send-hour, post-loss window) need the drift baseline first, as with any CLV-style claim.

**Honesty about sample size.** Nick sends on the order of 10–30 proposals per league-season. Pooled over five leagues and two seasons the uncoached baseline is perhaps 100–300 decided proposals; the coached arm accrues at the same rate. Acceptance-rate differences below ~15 points will not be distinguishable from noise in one season, and most tactic-level effects never will be. So: report every outcome as a band with a bootstrap interval, pre-register the primary outcome (acceptance rate) and one secondary (counter magnitude), treat the rest as descriptive, and re-run each season. If after a full season the coached arm's acceptance rate is not above the historical baseline at 1 SE, the honest claim is that the Coach produces messages Nick would send, not that it changes outcomes — which is still the Phase 8 deliverable.
