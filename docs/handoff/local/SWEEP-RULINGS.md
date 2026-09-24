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
