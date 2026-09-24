# MIGRATION NUMBER REGISTRY: the only place numbers are assigned (coordinator-owned; 9/24 12:15 AM after the PR sweep found 082/085/087 each claimed twice)
main tops at 073 + merged since. Numbers below are RESERVED; any PR using a different number for these units gets a FIX to renumber.
| no. | unit / PR | table(s) |
|---|---|---|
| 071 | #174 GR-01 rec_ledger | rec_ledger |
| 074 | #218 | |
| 075 | #216 | |
| 076 | #230 WR-3 warroom_requests | warroom_requests |
| 077 | #237 BROKEN-01 number audit | |
| 078 | #235 EVAL brain_report | brain_report |
| 079 | SERVE-LOG | serve log |
| 080 | #239 offer loop | trade_outcomes sent cols |
| 081 | #244 league waiver runs | |
| 082 | #255 FIX-01 follow ledger (replaces #245) | follow_ledger |
| 083 | FIX-09 eval seams | price_band, move_id, campaign_steps, title_odds_snapshots view |
| 084 | #247 OFFER-SNAPSHOT | trade_proposal_snapshots |
| 085 | PEOPLE-02 + SHOT-01 (local) | screenshot_proposals, people_profile_refresh |
| 086 | LIVING-01c activity mean (if a table is needed) | |
| 087 | #286 BROKEN-Q news stamps | |
| 088 | #265 FLIP-01 | |
| 089 | #271 REASON-02 | |
| 090 | #263 | |
| 091 | #293 | |
| 092 | #251 | |
| 093 | #184 RL-3-2 live inactives | |
| 094 | #284 SELF-01b | |
| 095+ | next free: take the lowest unlisted number and ADD A ROW HERE in the same PR | |
Rule: a test in main (FIX-255-1) fails on duplicate numbers once merged.
