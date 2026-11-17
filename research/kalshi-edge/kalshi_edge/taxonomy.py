"""Series ticker -> market family, and milestone type -> sport.

Deliberately dumb string rules, fixed before any outcome was looked at:

  winner      who wins the game / match / fight        (...GAME, ...MATCH, ...FIGHT)
  spread      margin ladder                            (...SPREAD)
  total       combined-score ladder                    (...TOTAL)
  team_total  one team's score ladder                  (...TEAMTOTAL)
  prop        everything else tied to a game: player stats, period winners,
              set / map winners, method of victory, first scorer, ...
"""
from __future__ import annotations

import re

_PERIOD = re.compile(r"\d[HQ](SPREAD|TOTAL)?$")

_SPORTS = {
    "football_game": "football",
    "basketball_game": "basketball", "basketball_series": "basketball",
    "tennis_tournament_singles": "tennis", "tennis_tournament_doubles": "tennis",
    "soccer_tournament_multi_leg": "soccer", "soccer_group": "soccer",
    "hockey_tournament": "hockey", "hockey_match": "hockey",
    "baseball_game": "baseball", "baseball_tournament": "baseball",
    "mma_match": "mma", "ufc_fight": "mma",
    "esports_match": "esports",
    "table_tennis_match": "table_tennis",
    "cricket_match": "cricket",
    "boxing_match": "boxing",
    "darts_match": "darts",
    "volleyball_match": "volleyball",
    "rugby_match": "rugby",
    "lacrosse_match": "lacrosse",
    "afl_match": "afl",
    "golf_tournament": "golf", "golf_match": "golf",
    "racing_tournament": "racing",
    "squash_match": "squash",
    "cycling_race": "cycling",
}


def _stem(series: str) -> str:
    s = series.upper()
    return s[2:] if s.startswith("KX") else s


def family_of(series: str) -> str:
    s = _stem(series)
    if s.endswith("TEAMTOTAL"):
        return "team_total"
    if s.endswith("TOTAL"):
        return "total"
    if s.endswith("SPREAD"):
        return "spread"
    if s.endswith(("GAME", "MATCH", "FIGHT")):
        return "winner"
    return "prop"


def is_period(series: str) -> bool:
    """True for half / quarter markets (1H, 2H, 1Q..4Q), with or without a SPREAD / TOTAL suffix."""
    return _PERIOD.search(_stem(series)) is not None


def sport_of(milestone_type: str | None) -> str:
    return _SPORTS.get(milestone_type or "", "other")
