# Draft ranker vs draft theory — prioritized findings (8-team PPR, slot 2, 16 rounds)

Evidence: `sim2.mjs` (7 picks) and `sim3.mjs` (full 16 rounds, others by market; scratchpad). Full-draft result with the current code: **WR Nacua, QB Allen, TE McBride, WR Flowers, RB J.Williams, WR Adams, WR Moore, WR Sutton, RB Pollard, QB Stafford, ... — DEF and K EMPTY after 16 rounds**, one RB through 7 rounds, five WRs in the first eight picks, a backup QB in round 10. All of that traces to items 1–4.

`E[best]` = expected best-available projection at a position at pick P: sort available by projection desc, `Σ proj_i · s_i · Π_{j<i}(1−s_j)` with `s = 1 − goneBy(market_rank, P)` (computed in sim3 with the real `goneBy`).

## 1. Replacement level is a static count that contradicts the survival model — TONIGHT
Flaw: `replacementLevel` (draft-assist.js:100-109) takes the Nth player in market order, N = 8×(starters+flex/3+BENCH_DEMAND 1.0) ≈ 27 → WR27 = 177, RB27 = 200, TE 175, QB11 263. The ranker's own `goneBy` says what is free at pick 63 (round 8, when 8×7 starter slots are full) is WR 225, RB 218, TE 211, QB 308. WR VORP inflated ~48 pts, RB ~18, QB ~45 — why WRs beat RBs and Allen wins pick 15. Baseline never moves during the draft.
Fix (replace 337-356):
```js
function expectedBest(list, P) {
  const l = list.filter(p => p.projected_points != null).sort((a,b) => b.projected_points - a.projected_points);
  let pNone = 1, e = 0;
  for (const p of l) { const s = 1 - goneBy(p.market_rank, P); e += pNone * s * p.projected_points; pNone *= 1 - s; if (pNone < 1e-4) break; }
  return +e.toFixed(1);
}
const starterSlots = Object.entries(slots).filter(([k]) => !['K','DEF'].includes(k)).reduce((s,[,v]) => s+v, 0); // 7
const pFill = upcoming.find(p => p >= draft.team_count * starterSlots) ?? myAfter;   // 63 for slot 2
replacement_points = expectedBest(list, Math.max(pFill, myAfter ?? 0));
```
K/DEF keep the count rule. Zero-math fallback: `BENCH_DEMAND = {QB:0, RB:0.3, WR:0.3, TE:0}` when team_count ≤ 10.
Data: none new. Validate: sim2 pick 2 flips to Bijan (367−218=149 vs Nacua 128; Gibbs 142, CMC 132); pick 15 Allen 105→60, level with Jeanty 66/McBride 61. sim3: ≥2 RBs by round 5, ≤4 WRs by round 8.

## 2. `fallback` is the first survivor in market order, not best-projected — TONIGHT
Flaw: 338-339 — `survivors` is market-ordered, `fallback = survivors[0]`. At pick 34 RB fallback = Josh Jacobs 187 while E[best RB at 47] = 239 (Stevenson 200 also survived). `cost_of_waiting` said 70; true ≈ 19 → Javonte Williams' urgency ~3.7× too big; same number feeds the prompt (drafts.js:846).
Fix: `fallback_points = expectedBest(list, myAfter)`; name = highest-projected survivor. Urgency (465-466) unchanged.
Validate: sim2 pick 34 → RB cost_of_waiting ≈ 20, WR ≈ 12.

## 3. K/DEF unreachable; candidate set = top 60 by market — TONIGHT
Flaw: consensus excludes K/DEF; they're appended with `market_rank = available.length+50+n` (303-317); `rankTargets` scores only `available.slice(0,60)` (427) and `−0.4×board_rank` (477) costs them ~−60 anyway. Never recommended (sim3: both slots empty at pick 128). Same slice hides ADP-arbitrage names (Pittman mkt 107 / WR24 by projection; P.Washington mkt 81 / WR27).
Fix in rankTargets:
```js
const pool = new Map(state.available.slice(0,60).map(p => [p.player_id,p]));
for (const pos of ['QB','RB','WR','TE']) state.available.filter(p=>p.position===pos&&p.projected_points!=null)
  .sort(byProjDesc).slice(0,12).forEach(p=>pool.set(p.player_id,p));
if (roundsLeft <= 2) for (const pos of ['K','DEF']) if ((my_team.needs.starters[pos]??0)>0)
  state.available.filter(p=>p.position===pos).sort(byProjDesc).slice(0,3).forEach(p=>pool.set(p.player_id,p));
score -= 0.4 * (['K','DEF'].includes(p.position) ? 0 : Math.min(p.board_rank, 60));
```
Also make sure the K/DEF tail survives `available.slice(0,120)` (399) — push top-5 K/DEF by projection before the tail. K VORP is small (Aubrey 171 vs 8th K 155; DEF 131 vs 107) so the −80/−60 gates are right.
Validate: sim3 final roster has DEF+K at picks 114/127.

## 4. Snake pair effect (15/18, 31/34, 47/50…) invisible — TONIGHT
Flaw: at the first pick of a pair `myAfter` is 2-3 picks away (251-253, 294, 338) so `gone_by_next` ≈ 0.1-0.5, urgency ≈ 0 and the ranker degrades to raw VORP (how Allen won 15). Theory: choose the pair against the long horizon, order the two by who's gone in the 2-3 intervening picks.
Fix: `const pairHorizon = myAfter && myAfter - nextPick <= 3 ? (upcoming[2] ?? myAfter) : myAfter;` compute gone_by_next / fallback / replacement against `pairHorizon`; add `gone_by_pair: goneBy(rank, myAfter)`; in rankTargets when paired `score += 0.3 * gap * p.gone_by_pair`.
Validate: pick 15 top-2 = two best long-horizon values, higher `gone_by_pair` first; at 18 the survivor is #1.

## 5. Shallow-league bench: backup-QB target, flat 0.5 bench weight — TONIGHT
Flaw: `BENCH_TARGET.QB = 1` (66) + `needWeight 0.5` (438) → Stafford at pick 79 as QB2 in a 1-QB 8-team league (16+ starting QBs on waivers). Bench RB/WR beyond the third is worth far less than half a starter.
Fix: `BENCH_TARGET.QB = teams >= 12 ? 1 : 0`; `benchWeight = 0.5 * Math.min(1, teams/12)` (0.33 at 8) for depth_needed>0, 0.2 beyond.
Validate: sim3 pick 79 not a QB; one QB on final roster.

## 6. Handcuffs ignored — TONIGHT
Flaw: no term. With 7 bench + deep waivers, RB1's backup is the best-EV bench RB (≈0.3×(259−200) ≈ 18 lineup pts > any round-10+ VORP×0.33).
Fix: `players.team_id` + `players.slot_code` ('RB1'/'RB2' is populated and team-unique; `depth_rank` is not — DET has three depth_rank-1 RBs). If `p.position==='RB' && p.slot_code==='RB2'` and my roster has same-team `slot_code==='RB1'` with proj ≥ 220 → `score += 0.3 * (myRB1.projected_points - pos.replacement_points)`, rounds ≥ 8. Add slot_code/team_id to the selects at 239 and 114.
Validate: after Javonte Williams at 34, Malik Davis (DAL RB2) top-3 by rounds 11-13.

## 7. Late rounds pick on median projection, no ceiling — TONIGHT (bonus) / LATER (variance model)
Flaw: rounds 11-16 in sim3 decided by +2..+7 margins on ESPN medians (R.White, Croskey-Merritt, Diggs, A.Jones). Bench picks in 8-team should maximize P(top-24), not mean.
Fix tonight: when `!startsHere && round >= 9`: +8 if `player_accolades.draft_year===2026 && draft_round<=2`, +4 rounds 3-4 (38 rookies present); +4 if `model_rel >= 0.15`. Later: p80 ceiling column, bench scored on `p80 − replacement`.
Validate: sim3 rounds 12-16 shift toward rookies/positive-model-rel; starter rounds unchanged.

## 8. Tier cliff computed in market order and unused — TONIGHT
Flaw: 368 slices the market-ordered list and diffs neighbours → noise (K cliff "after Harrison Mevis"). Score never uses tiers.
Fix: sort by projected_points desc first; add `+0.5 * cliff.drop` when p is above the cliff and expected survivors of that tier at pairHorizon < 1.
Validate: cliff names monotone in projection; last-of-tier bump at 18/31.

## 9. Bye weeks: every dossier says "bye ?" — TONIGHT (data) / LATER (score)
Flaw: `players.bye_week` NULL for all 970 rows → drafts.js:814 prints `bye ?`. `schedule_games` (2026, 544 rows = 32×17, weeks 1-18) has byes implicitly.
Fix: `bye = week in 1..18 with no schedule_games row for team_id` (cache per process); later `−3` when a pick is the 2nd same-bye starter in a position group.
Validate: dossiers show a week; sim unaffected.

## 10. Market prior and prompt/ranker contradiction — LATER
`−0.4×board_rank` (477) ignores what a rank gap is worth in points at that position; replace with market-implied shrinkage `proj' = 0.6·proj + 0.4·sortedProjAtPos[marketPosIndex]` (Stafford QB4-by-proj/QB13-by-market: 307→296). The prompt (drafts.js:853) says "never reach for a QB, TE…" while the shortlist it receives has QB/TE at #1 at picks 15/18 — after items 1/2/4 they should agree. Injury flag (491) flat −6 on 78/295 ADP players; should scale projection (×0.92) instead.

Order tonight: 1 → 2 → 3 → 4 → 5, then 6/8/9. Item 1 alone fixes the three worst sim outcomes (WR over Bijan at 2, QB at 15, one RB through round 7).
