# Opener CLV — every forecaster, pooled 2022-2023-2024-2025

Generated from docs/evidence/2026-09-16/opener-clv. 2021 is excluded from pooling (untrustworthy openers) and reported per-season in summary.json.

Holm family = EDGE-ELIGIBLE tier only (input_timing = prior_week; see INPUT_TIMING in the script): 28 forecasters. Raw p<0.05: 24. Holm p<0.05: 11. Positive mean AND Holm p<0.05: ["component:drive_eff","component:dynamic_state","component:early_down_eff","component:epa_net","component:melo","component:opp_adjusted","component:rush_eff_matchup","component:second_half_eff","component:series_sustain","component:success_rate","python_football"].

Break-even ATS at -110 is 0.5238. Sorted by week-clustered z on mean CLV points.

Only prior_week rows may be read as edge at the opener. in_week = line-move prediction (opener could not know it). third_party_bulk = single-timestamp backfill, clock unverifiable. Struck-through = contaminated by the close.

Home drift (mean open->close move toward home) = 0.185 pts. "adj CLV" nets out what always-backing-that-side would have earned. "away CLV" is the acid test: positive means the model beats a drift that runs against it.

| forecaster | input timing | n | raw CLV | adj CLV | SE | z (adj) | p Holm (adj) | home share | away CLV | ATS vs open |
|---|---|---|---|---|---|---|---|---|---|---|
| component:pass_eff_matchup | prior_week | 1094 | 0.261 | 0.254 | 0.101 | 2.51 | 0.1573 | 0.518 | 0.079 | 0.5066 |
| component:drive_eff | prior_week | 1093 | 0.354 | 0.353 | 0.098 | 3.61 | 0.0069 | 0.502 | 0.17 | 0.4892 |
| ensemble_raw_blend | mixed | 1085 | 0.345 | 0.347 | 0.096 | 3.62 | — | 0.496 | 0.159 | 0.5128 |
| component:epa_net | prior_week | 1094 | 0.335 | 0.328 | 0.094 | 3.49 | 0.0105 | 0.518 | 0.156 | 0.5038 |
| component:epa_neutral | prior_week | 1094 | 0.268 | 0.263 | 0.093 | 2.81 | 0.0833 | 0.515 | 0.086 | 0.5094 |
| component:dynamic_state | prior_week | 1094 | 0.38 | 0.367 | 0.092 | 4 | 0.0027 | 0.535 | 0.209 | 0.4972 |
| component:nfelo_rating | third_party_bulk | 1094 | 0.427 | 0.399 | 0.092 | 4.34 | — | 0.577 | 0.286 | 0.516 |
| component:opp_adjusted | prior_week | 1094 | 0.379 | 0.366 | 0.091 | 4.01 | 0.0027 | 0.536 | 0.209 | 0.4981 |
| component:series_sustain | prior_week | 1094 | 0.352 | 0.346 | 0.091 | 3.81 | 0.0027 | 0.516 | 0.173 | 0.5151 |
| component:second_half_eff | prior_week | 1094 | 0.391 | 0.39 | 0.09 | 4.35 | 0 | 0.501 | 0.206 | 0.5047 |
| ~~component:market_correction_research~~ | contaminated | 1094 | 1.119 | 1.065 | 0.089 | 11.98 | — | 0.645 | 1.317 | 0.5217 |
| ~~python_correction~~ | contaminated | 1090 | 1.125 | 1.071 | 0.089 | 12.06 | — | 0.645 | 1.319 | 0.5227 |
| python_unified | prior_week | 1092 | 0.245 | 0.228 | 0.089 | 2.57 | 0.1428 | 0.547 | 0.068 | 0.5066 |
| component:melo | prior_week | 1094 | 0.296 | 0.288 | 0.087 | 3.32 | 0.018 | 0.521 | 0.115 | 0.4878 |
| component:success_rate | prior_week | 1094 | 0.312 | 0.306 | 0.087 | 3.53 | 0.0088 | 0.516 | 0.131 | 0.5169 |
| component:early_down_eff | prior_week | 1094 | 0.327 | 0.322 | 0.086 | 3.73 | 0.0048 | 0.513 | 0.145 | 0.5169 |
| component:explosive_pass | prior_week | 1094 | 0.229 | 0.223 | 0.083 | 2.7 | 0.112 | 0.516 | 0.045 | 0.5085 |
| drive_sim | prior_week | 1093 | 0.156 | 0.161 | 0.083 | 1.93 | 0.2128 | 0.487 | -0.028 | 0.475 |
| python_football | prior_week | 1094 | 0.279 | 0.266 | 0.082 | 3.22 | 0.0247 | 0.537 | 0.102 | 0.5217 |
| component:rest_travel | prior_week | 1094 | 0.093 | 0.1 | 0.079 | 1.26 | 0.4128 | 0.482 | -0.089 | 0.5104 |
| component:pythagorean | prior_week | 1094 | 0.198 | 0.188 | 0.077 | 2.43 | 0.1573 | 0.526 | 0.013 | 0.5094 |
| component:point_diff | prior_week | 1094 | 0.195 | 0.183 | 0.076 | 2.42 | 0.1573 | 0.532 | 0.011 | 0.516 |
| component:situational | prior_week | 1094 | 0.185 | 0.189 | 0.076 | 2.49 | 0.1573 | 0.488 | 0 | 0.5132 |
| component:colley | prior_week | 1094 | 0.164 | 0.161 | 0.074 | 2.17 | 0.1818 | 0.508 | -0.021 | 0.4906 |
| component:massey | prior_week | 1094 | 0.182 | 0.172 | 0.074 | 2.34 | 0.1573 | 0.527 | -0.003 | 0.5169 |
| component:trenches | prior_week | 1094 | 0.183 | 0.18 | 0.073 | 2.47 | 0.1573 | 0.508 | -0.002 | 0.5188 |
| component:availability | in_week | 1062 | 0.275 | 0.283 | 0.072 | 3.94 | — | 0.478 | 0.092 | 0.5184 |
| component:nfelo_qb_adjustment | third_party_bulk | 1094 | 0.182 | 0.23 | 0.071 | 3.22 | — | 0.371 | -0.002 | 0.5028 |
| component:turnover_regressed | prior_week | 1094 | 0.164 | 0.152 | 0.071 | 2.13 | 0.1818 | 0.534 | -0.023 | 0.5226 |
| component:field_position | prior_week | 1094 | 0.066 | 0.072 | 0.07 | 1.02 | 0.4128 | 0.484 | -0.115 | 0.5038 |
| component:roster_strength | in_week | 1094 | 0.064 | 0.067 | 0.07 | 0.97 | — | 0.492 | -0.119 | 0.5038 |
| component:explosive | prior_week | 1094 | 0.193 | 0.185 | 0.069 | 2.66 | 0.1155 | 0.523 | 0.009 | 0.5019 |
| component:rush_eff_matchup | prior_week | 1094 | 0.211 | 0.213 | 0.067 | 3.16 | 0.0288 | 0.493 | 0.025 | 0.5122 |
| component:market_regression | opener | 1094 | 0.002 | 0.127 | 0.066 | 1.94 | — | 0.162 | -0.109 | 0.4868 |
| baseline:back_away | baseline | 1094 | -0.185 | 0 | 0.064 | 0 | — | 0 | -0.185 | 0.4868 |
| baseline:back_home | baseline | 1094 | 0.185 | 0 | 0.064 | 0 | — | 1 |  | 0.5132 |
| component:pressure_response | prior_week | 1094 | 0.112 | 0.108 | 0.064 | 1.68 | 0.2766 | 0.512 | -0.075 | 0.4906 |
| baseline:back_opener_favorite | baseline | 1064 | -0.009 | -0.059 | 0.063 | -0.94 | — | 0.633 | -0.269 | 0.5019 |
| baseline:back_opener_underdog | baseline | 1064 | 0.009 | 0.059 | 0.063 | 0.94 | — | 0.367 | -0.141 | 0.4981 |
| component:recent_form | prior_week | 1094 | 0.138 | 0.148 | 0.062 | 2.38 | 0.1573 | 0.472 | -0.045 | 0.5028 |
