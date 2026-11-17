import pytest

from house.grid import Grid, to_units as u
from house.persist import NO, YES, newcomer

G = Grid()
DEEP = [(u("0.70"), 5000.0)]


def test_entry_yield_is_half_the_pool_times_the_share_over_the_dollars():
    # $50 at 25c = 200 contracts joining 1,800 -> a tenth of the YES side, which is half of $40 a day
    y, price, contracts = newcomer([(u("0.25"), 1800.0)], DEEP, YES, 50.0, 40.0, 1000, 0.5, G)
    assert (price, contracts) == (u("0.25"), 200)
    assert y == pytest.approx(0.5 * 40.0 * 0.1 / 50.0) == pytest.approx(0.04)


def test_no_side_orders_are_priced_in_no_cents():
    y, price, contracts = newcomer(DEEP, [(u("0.20"), 1750.0)], NO, 50.0, 40.0, 1000, 0.5, G)
    assert price == u("0.20") and contracts == 250 and y == pytest.approx(0.5 * 40.0 * (250 / 2000) / 50.0)


def test_nothing_is_earned_when_the_other_side_is_too_thin_for_the_snapshot_to_count():
    y, _, _ = newcomer([(u("0.25"), 1800.0)], [(u("0.70"), 999.0)], YES, 50.0, 40.0, 1000, 0.5, G)
    assert y == 0.0


def test_an_order_left_behind_when_others_bid_higher_is_halved_per_tick():
    then = [(u("0.25"), 1800.0)]
    now = [(u("0.26"), 400.0), (u("0.25"), 1800.0)]            # 400 at 26c is the new reference
    y0, price, _ = newcomer(then, DEEP, YES, 50.0, 40.0, 1000, 0.5, G)
    y1, _, _ = newcomer(now, DEEP, YES, 50.0, 40.0, 1000, 0.5, G, price=price)
    assert y1 == pytest.approx(0.5 * 40.0 * (200 * 0.5) / (400 + 2000 * 0.5) / 50.0)
    assert y1 < y0


def test_an_order_left_below_the_qualifying_levels_earns_nothing():
    now = [(u("0.30"), 1500.0), (u("0.25"), 1800.0)]            # the target is met at 30c; 25c is no longer counted
    assert newcomer(now, DEEP, YES, 50.0, 40.0, 1000, 0.5, G, price=u("0.25"))[0] == 0.0


def test_the_newcomers_own_order_can_complete_their_side():
    y, _, contracts = newcomer([(u("0.25"), 850.0)], DEEP, YES, 50.0, 40.0, 1000, 0.5, G, price=u("0.25"))
    assert contracts == 200 and y == pytest.approx(0.5 * 40.0 * (200 / 1050) / 50.0)


def test_with_no_reference_price_there_is_nowhere_to_start():
    assert newcomer([(u("0.25"), 10.0)], DEEP, YES, 50.0, 40.0, 1000, 0.5, G) == (0.0, None, 0.0)
