# SWEEP RULINGS (coordinator, 9/24 12:25 AM). The sweep ingester and every fix unit follow these.
1. ONE profile reader: server/services/people/profile-reader.js from FIX-00 (#260). #253 is closed as superseded. #254 (COUNTERPART-01) and #270 (UI-ENG-4) must DELETE their own profile-reader.js and import #260's. #276's nick-block.js becomes a function inside #260's reader (nick block = profile_json.nick_override + manager_notes rows with source 'nick-chat-*'). Fix units must build on #260's branch.
2. ONE counterpart model: #254 (server/services/people/counterpart.js). #252's model becomes a consumer or is dropped. P(yes) gets NO chat lift (remove wants_player/shop_talk from P(accept), counterpart.js:198-243); wants_player feeds targets, package and partner order only (PEOPLE-03).
3. ONE fallback rule (last good number): the engine spine's (#250 state.js). #257 and #281 call it.
4. ONE fatigue counter: #275 FIX-07 sentThisWeek (trade_outcomes WHERE sent_at). #264 REP-01 reads it, excludes unsent app_proposed rows, and gets a flag.
5. ONE flip-map producer: the campaign producer's flip_map. #265 FLIP-01 becomes its nightly and news-triggered runner and must apply the nick block (unreachable -> never a leg).
6. Superseded and closed: #220 (by #280), #245 (by #255), #253 (by #260).
7. Migrations: MIGRATIONS.md only. Added: 093 #184 live inactives, 094 #284 SELF-01b. #243 keeps 079 (SERVE-LOG). #263 uses 090.
8. Flags: every new flag is read through preview-mode.js (LIVE_INACTIVE_WARNINGS, GRIDIRON_SELF_CLONE_ENABLED, GRIDIRON_JEV_CHAT_BLEND, and #263's bandit, which needs a flag).
9. Wiring check CI failures (#233, #254, #259, #279, #281): one fix in scripts/wiring-map.mjs teaches it that the refresh loop and daemon are surfaces (FIX-279-1). Do it once, on #272's branch.
10. #268 TELLS-01b: server/routes/tells.js:21 has no assertLeagueMember, so it serves any league's tells to any user. It MUST get the league check and move the refit off the request before merge (security).
11. ONE planner: the campaign producer (plans.json). #267 ACQ-01's planner (acq-plans.json) moves INSIDE the producer as its search/2-for-1 module; no second output file.
12. ONE "this week" number: #291 BROKEN-G blend.week is the producer. #166's label and no-boost choices are folded into it (FIX-166-3); #166 stops producing.
13. Activity adjustment counted once: LIVING-01c (#273, R&D-confirmed) ships. #261 LIVING-01b's activity adjustment is disabled whenever 01c's flag is on (guard + test).
14. War Room UI order: FIX-04 (#287) first, then FIX-06 (#282) rebased onto it (the rebaser does this).
15. Migration numbers come from MIGRATIONS.md ONLY, never from a sweep suggestion: #251 = 092, #277 = 095, #288 = 096, #293 = 091, #295 = 097.
16. #246 E1: fix the needs-N formula (e1.js:148-152: cap it, and derive it from the CS width) and read trade_outcomes, not offer_log (FIX-09 seam).
17. (9/24 ~2:45 AM) Nick-derived flags (unreachable/contactable, hard/difficulty, buyer/trades, active) are OWNED by the one reader's nick block (profile-reader.js). counterpart.js READS them and never recomputes; main's nick-block code folds into the reader (FIX-260-CI). The counterpart fields the planner serves (p_responds, reply_mix, yes_point, challenger p_accept) are ADDED to plans-schema.js (typed fields) in #313, not squeezed into existing keys.
