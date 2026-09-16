# Opener CLV — every forecaster, pooled 2022-2025

Generated from docs/evidence/2026-09-16/opener-clv. 2021 is excluded from pooling (untrustworthy openers) and reported per-season in summary.json.

Holm family = EDGE-ELIGIBLE tier only (input_timing = prior_week; see INPUT_TIMING in the script): 28 forecasters. Raw p<0.05: 24. Holm p<0.05: 11. Positive mean AND Holm p<0.05: ["component:drive_eff","component:dynamic_state","component:early_down_eff","component:epa_net","component:melo","component:opp_adjusted","component:rush_eff_matchup","component:second_half_eff","component:series_sustain","component:success_rate","python_football"].

Break-even ATS at -110 is 0.5238. Sorted by week-clustered z on mean CLV points.

Only prior_week rows may be read as edge at the opener. in_week = line-move prediction (opener could not know it). third_party_bulk = single-timestamp backfill, clock unverifiable. Struck-through = contaminated by the close.

| forecaster | input timing | n | mean CLV pts | SE (wk-clustered) | z | p | p (Holm) | CLV direction | ATS vs open |
|---|---|---|---|---|---|---|---|---|---|
| ~~python_correction~~ | contaminated | 1090 | 1.125 | 0.089 | 12.59 | 0 | — | 0.8157 | 0.5227 |
| ~~component:market_correction_research~~ | contaminated | 1094 | 1.119 | 0.089 | 12.52 | 0 | — | 0.8132 | 0.5217 |
| component:nfelo_rating | third_party_bulk | 1094 | 0.427 | 0.093 | 4.61 | 0 | — | 0.5813 | 0.516 |
| component:second_half_eff | prior_week | 1094 | 0.391 | 0.091 | 4.3 | 0 | 0 | 0.5516 | 0.5047 |
| component:opp_adjusted | prior_week | 1094 | 0.379 | 0.092 | 4.13 | 0 | 0 | 0.5582 | 0.4981 |
| component:dynamic_state | prior_week | 1094 | 0.38 | 0.092 | 4.11 | 0 | 0 | 0.5604 | 0.4972 |
| component:availability | in_week | 1062 | 0.275 | 0.072 | 3.83 | 0.0001 | — | 0.5468 | 0.5184 |
| component:series_sustain | prior_week | 1094 | 0.352 | 0.092 | 3.83 | 0.0001 | 0.0025 | 0.5495 | 0.5151 |
| component:early_down_eff | prior_week | 1094 | 0.327 | 0.087 | 3.76 | 0.0002 | 0.0048 | 0.5473 | 0.5169 |
| component:drive_eff | prior_week | 1093 | 0.354 | 0.099 | 3.59 | 0.0003 | 0.0069 | 0.5468 | 0.4892 |
| component:success_rate | prior_week | 1094 | 0.312 | 0.088 | 3.56 | 0.0004 | 0.0088 | 0.5407 | 0.5169 |
| ensemble_raw_blend | mixed | 1085 | 0.345 | 0.097 | 3.55 | 0.0004 | — | 0.5565 | 0.5128 |
| component:epa_net | prior_week | 1094 | 0.335 | 0.095 | 3.54 | 0.0004 | 0.0088 | 0.5451 | 0.5038 |
| component:melo | prior_week | 1094 | 0.296 | 0.088 | 3.36 | 0.0008 | 0.016 | 0.5505 | 0.4878 |
| python_football | prior_week | 1094 | 0.279 | 0.083 | 3.35 | 0.0008 | 0.016 | 0.5275 | 0.5217 |
| component:rush_eff_matchup | prior_week | 1094 | 0.211 | 0.069 | 3.04 | 0.0024 | 0.0432 | 0.5286 | 0.5122 |
| component:epa_neutral | prior_week | 1094 | 0.268 | 0.095 | 2.83 | 0.0046 | 0.0782 | 0.533 | 0.5094 |
| component:explosive | prior_week | 1094 | 0.193 | 0.07 | 2.76 | 0.0058 | 0.0928 | 0.5374 | 0.5019 |
| component:explosive_pass | prior_week | 1094 | 0.229 | 0.083 | 2.74 | 0.0061 | 0.0928 | 0.533 | 0.5085 |
| python_unified | prior_week | 1092 | 0.245 | 0.09 | 2.72 | 0.0065 | 0.0928 | 0.5187 | 0.5066 |
| component:pass_eff_matchup | prior_week | 1094 | 0.261 | 0.103 | 2.53 | 0.0115 | 0.1495 | 0.5209 | 0.5066 |
| component:point_diff | prior_week | 1094 | 0.195 | 0.077 | 2.52 | 0.0117 | 0.1495 | 0.5297 | 0.516 |
| component:nfelo_qb_adjustment | third_party_bulk | 1094 | 0.182 | 0.073 | 2.49 | 0.0126 | — | 0.5066 | 0.5028 |
| component:pythagorean | prior_week | 1094 | 0.198 | 0.079 | 2.49 | 0.0127 | 0.1495 | 0.5264 | 0.5094 |
| component:trenches | prior_week | 1094 | 0.183 | 0.075 | 2.45 | 0.0144 | 0.1495 | 0.5187 | 0.5188 |
| component:massey | prior_week | 1094 | 0.182 | 0.076 | 2.41 | 0.016 | 0.1495 | 0.5297 | 0.5169 |
| component:situational | prior_week | 1094 | 0.185 | 0.077 | 2.41 | 0.016 | 0.1495 | 0.5209 | 0.5132 |
| component:turnover_regressed | prior_week | 1094 | 0.164 | 0.073 | 2.24 | 0.0254 | 0.1778 | 0.522 | 0.5226 |
| component:recent_form | prior_week | 1094 | 0.138 | 0.064 | 2.16 | 0.0312 | 0.1872 | 0.5231 | 0.5028 |
| component:colley | prior_week | 1094 | 0.164 | 0.076 | 2.15 | 0.0317 | 0.1872 | 0.5121 | 0.4906 |
| drive_sim | prior_week | 1093 | 0.156 | 0.084 | 1.87 | 0.0621 | 0.2484 | 0.5171 | 0.475 |
| component:pressure_response | prior_week | 1094 | 0.112 | 0.064 | 1.74 | 0.0826 | 0.2484 | 0.5121 | 0.4906 |
| component:rest_travel | prior_week | 1094 | 0.093 | 0.08 | 1.16 | 0.2455 | 0.491 | 0.5033 | 0.5104 |
| component:field_position | prior_week | 1094 | 0.066 | 0.071 | 0.93 | 0.3529 | 0.491 | 0.5011 | 0.5038 |
| component:roster_strength | in_week | 1094 | 0.064 | 0.071 | 0.91 | 0.3631 | — | 0.5044 | 0.5038 |
| component:market_regression | opener | 1094 | 0.002 | 0.07 | 0.03 | 0.9738 | — | 0.4824 | 0.4868 |
