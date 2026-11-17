"""Series ticker -> market family. Pre-specified in PREREGISTRATION.md section 8 (families)."""
import pytest

from kalshi_edge import taxonomy as tx


@pytest.mark.parametrize("series,family", [
    ("KXNBAGAME", "winner"), ("KXNFLGAME", "winner"), ("KXATPMATCH", "winner"), ("KXATPCHALLENGERMATCH", "winner"),
    ("KXUFCFIGHT", "winner"), ("KXEPLGAME", "winner"), ("KXT20MATCH", "winner"), ("KXCS2GAME", "winner"),
    ("KXNFLSPREAD", "spread"), ("KXNCAAFSPREAD", "spread"), ("KXNFL1HSPREAD", "spread"),
    ("KXNBATOTAL", "total"), ("KXNCAAF1HTOTAL", "total"), ("KXUCLTOTAL", "total"),
    ("KXNCAAFTEAMTOTAL", "team_total"), ("KXITASUPERCUPTEAMTOTAL", "team_total"),
    ("KXNBAPTS", "prop"), ("KXNFLTD", "prop"), ("KXNFLRECYDS", "prop"), ("KXUFCMOV", "prop"),
    ("KXATPSETWINNER", "prop"), ("KXCS2MAP", "prop"), ("KXNHLFIRSTGOAL", "prop"), ("KXNCAAF1H", "prop"),
])
def test_family(series, family):
    assert tx.family_of(series) == family


def test_team_total_is_not_a_game_total_and_totalmaps_is_not_a_points_total():
    assert tx.family_of("KXNCAAFTEAMTOTAL") == "team_total"
    assert tx.family_of("KXCS2TOTALMAPS") == "prop"


@pytest.mark.parametrize("series,period", [
    ("KXNFL1HSPREAD", True), ("KXNCAAF2QTOTAL", True), ("KXNBA1HTOTAL", True), ("KXNCAAF1H", True),
    ("KXNFLSPREAD", False), ("KXNBAGAME", False), ("KXNHLGAME", False), ("KXNBA3PT", False),
])
def test_period_markets_are_flagged(series, period):
    assert tx.is_period(series) is period


def test_sport_comes_from_the_milestone_type():
    assert tx.sport_of("football_game") == "football"
    assert tx.sport_of("basketball_game") == "basketball"
    assert tx.sport_of("tennis_tournament_singles") == "tennis"
    assert tx.sport_of("tennis_tournament_doubles") == "tennis"
    assert tx.sport_of("soccer_tournament_multi_leg") == "soccer"
    assert tx.sport_of("hockey_tournament") == "hockey"
    assert tx.sport_of("hockey_match") == "hockey"
    assert tx.sport_of("baseball_game") == "baseball"
    assert tx.sport_of("mma_match") == "mma"
    assert tx.sport_of("ufc_fight") == "mma"
    assert tx.sport_of("esports_match") == "esports"
    assert tx.sport_of("something_new") == "other"
    assert tx.sport_of(None) == "other"
