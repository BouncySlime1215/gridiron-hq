import pytest

from house.grid import Grid, to_units as u
from house.stub import NO, YES, best, can_rest

G = Grid()
TAPER = Grid.from_market([{"start": "0.0000", "end": "0.1000", "step": "0.0010"}, {"start": "0.1000", "end": "0.9000", "step": "0.0100"},
                          {"start": "0.9000", "end": "1.0000", "step": "0.0010"}])
DEEP_NO = [(u("0.90"), 5000.0)]


def test_on_an_empty_side_one_full_size_bid_at_the_lowest_price_takes_the_whole_side():
    s = best([], DEEP_NO, YES, 20.0, 1000, 0.5, G)
    assert (s.price, s.contracts, s.cost) == (u("0.01"), 1000, 10.0)
    assert s.per_day == pytest.approx(10.0)          # half of the pool, all of it ours


def test_the_lowest_price_follows_the_markets_own_grid():
    s = best([], DEEP_NO, YES, 20.0, 1000, 0.5, TAPER)
    assert s.price == u("0.001") and s.cost == pytest.approx(1.0)


def test_an_order_that_would_meet_the_other_sides_best_bid_cannot_rest():
    assert not can_rest(u("0.01"), [(u("0.99"), 500.0)])
    assert can_rest(u("0.01"), [(u("0.98"), 500.0)])
    assert best([], [(u("0.99"), 5000.0)], YES, 20.0, 1000, 0.5, G) is None


def test_nothing_is_earned_unless_the_other_side_reaches_the_target():
    assert best([], [(u("0.90"), 999.0)], YES, 20.0, 1000, 0.5, G) is None


def test_small_bids_above_do_not_take_the_reference_away_until_they_reach_a_fifth_of_the_target():
    # 150 contracts at 5c: the reference is still our level, so they and we score in full
    s = best([(u("0.05"), 150.0)], DEEP_NO, YES, 20.0, 1000, 0.5, G)
    assert s.price == u("0.01") and s.per_day == pytest.approx(10.0 * 1000 / 1150)


def test_when_real_bids_sit_above_the_floor_is_worthless_and_the_order_joins_them_if_cheap_enough():
    book = [(u("0.02"), 3000.0)]
    s = best(book, DEEP_NO, YES, 20.0, 1000, 0.5, G)
    assert s.price == u("0.02") and s.cost == 20.0 and s.per_day == pytest.approx(10.0 * 1000 / 4000)
    # one tick below a full level earns nothing at all: the level above already meets the target
    assert best(book, DEEP_NO, YES, 20.0, 1000, 0.5, G, max_price=u("0.01")) is None


def test_levels_dearer_than_the_cap_are_not_joined():
    assert best([(u("0.30"), 3000.0)], DEEP_NO, YES, 20.0, 1000, 0.5, G) is None


def test_it_picks_the_price_with_the_most_reward_per_dollar_not_the_most_reward():
    # 300 at 2c hold the reference; a bid at 1c is halved but costs half: 1000*0.5/(300+500) per $10
    # against joining at 2c: 1000/1300 per $20
    s = best([(u("0.02"), 300.0)], DEEP_NO, YES, 20.0, 1000, 0.5, G)
    at_one = 10.0 * 500 / 800 / 10.0
    at_two = 10.0 * 1000 / 1300 / 20.0
    assert at_one > at_two and s.price == u("0.01") and s.per_day == pytest.approx(10.0 * 500 / 800)


def test_a_no_side_order_is_priced_in_no_cents_and_checked_against_the_yes_bid():
    s = best([(u("0.90"), 5000.0)], [], NO, 20.0, 1000, 0.5, G)
    assert s.side == NO and s.price == u("0.01") and s.per_day == pytest.approx(10.0)
    assert best([(u("0.99"), 5000.0)], [], NO, 20.0, 1000, 0.5, G) is None
