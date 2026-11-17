"""The reward formula, pinned to the text of Kalshi's CFTC filing of 2026-10-14
(Appendix B, section 5). Each test quotes the sentence it enforces."""
import pytest

from house import lip
from house.grid import Grid, to_units as u

CENT = Grid()
TAPERED = Grid.from_market([
    {"start": "0.0000", "end": "0.1000", "step": "0.0010"},
    {"start": "0.1000", "end": "0.9000", "step": "0.0100"},
    {"start": "0.9000", "end": "1.0000", "step": "0.0010"},
])


def side(levels, target=1000, grid=CENT):
    return lip.qualify([(u(p), s) for p, s in levels], target, 0.5, grid)


def test_every_bid_at_a_qualifying_level_counts_not_just_the_first_thousand():
    # "add ALL bids at the current bid price to the Qualifying Yes Bids"
    s = side([("0.40", 5800)])
    assert s.ok and s.total == 5800
    # the mistake this replaces capped the level at the target and reported 1000


def test_walking_stops_at_the_level_that_reaches_the_target_and_takes_it_whole():
    # "If the Qualifying Yes Total Size is greater than or equal to the target size, the procedure is stopped here"
    s = side([("0.40", 600), ("0.39", 700), ("0.38", 9000)])
    assert [p for p, _, _ in s.levels] == [u("0.40"), u("0.39")]
    assert s.size == 1300


def test_reference_is_the_first_level_where_a_fifth_of_the_target_has_accumulated():
    # "greater than or equal to one fifth of the target size, then the Reference Yes Price is set to the current bid price"
    s = side([("0.45", 5), ("0.44", 150), ("0.43", 45), ("0.42", 2000)])
    assert s.reference == u("0.43")          # 5 + 150 + 45 = 200 = 1000 / 5
    s = side([("0.45", 5), ("0.44", 150), ("0.43", 44.99), ("0.42", 2000)])
    assert s.reference == u("0.42")          # 199.99 is not a fifth


def test_bids_above_the_reference_score_in_full_and_each_tick_below_halves():
    # "N is the number of ticks between the Reference Yes Price and the price of the Qualifying Yes Bid.
    #  If the price of the Qualifying Yes Bid is greater than the Reference Yes Price, N is set to zero."
    s = side([("0.45", 5), ("0.44", 300), ("0.43", 100), ("0.41", 800)])
    assert s.reference == u("0.44")
    assert [m for _, _, m in s.levels] == [1.0, 1.0, 0.5, 0.125]
    assert s.total == 5 + 300 + 100 * 0.5 + 800 * 0.125


def test_ticks_are_counted_on_the_markets_own_grid():
    # a real book, 2026-11-17: NO bids on a tapered market
    s = side([("0.902", 5), ("0.901", 591), ("0.23", 45), ("0.22", 113), ("0.21", 662)], grid=TAPERED)
    assert s.reference == u("0.901")
    assert s.total == pytest.approx(596, abs=1e-9)        # 0.5 ** 68 and smaller add nothing visible
    below = dict((p, m) for p, _, m in s.levels)
    assert below[u("0.23")] == 0.5 ** 68                   # one tenth-of-a-cent tick, then 67 cents


def test_a_side_that_cannot_reach_the_target_has_no_qualifying_bids():
    # "If no more bids exist, Kalshi will clear the Qualifying Yes Bids, as there were not enough bids to reach the Target Size."
    s = side([("0.40", 600), ("0.39", 399.99)])
    assert not s.ok and s.levels == () and s.total == 0 and s.reference is None
    assert not side([]).ok


def test_fractional_contracts_add_up_exactly():
    s = side([("0.40", 333.33), ("0.39", 333.33), ("0.38", 333.34)])
    assert s.ok and len(s.levels) == 3


def test_a_newcomer_joining_the_reference_level_is_paid_by_size_not_by_queue_place():
    book = [(u("0.40"), 3000.0)]
    assert lip.share(book, u("0.40"), 1000, 1000, 0.5, CENT) == pytest.approx(0.25)


def test_improving_the_price_with_a_fifth_of_the_target_moves_the_reference_and_halves_everyone_behind():
    book = [(u("0.40"), 3000.0)]
    assert lip.share(book, u("0.41"), 200, 1000, 0.5, CENT) == pytest.approx(200 / (200 + 1500))
    # with less than a fifth the reference stays where it was and nobody is discounted
    assert lip.share(book, u("0.41"), 199, 1000, 0.5, CENT) == pytest.approx(199 / 3199)


def test_an_order_below_the_last_qualifying_level_earns_nothing():
    book = [(u("0.40"), 600.0), (u("0.39"), 700.0)]
    assert lip.share(book, u("0.38"), 5000, 1000, 0.5, CENT) == 0.0


def test_an_order_can_be_the_thing_that_makes_a_side_qualify():
    book = [(u("0.40"), 600.0)]
    assert lip.share(book, u("0.40"), 100, 1000, 0.5, CENT) == 0.0
    assert lip.share(book, u("0.40"), 400, 1000, 0.5, CENT) == pytest.approx(0.4)


def test_a_snapshot_counts_only_when_both_sides_reach_the_target():
    # "Snapshots will be excluded ... if there is not two-sided liquidity"
    yes, thin = [(u("0.40"), 1000.0)], [(u("0.55"), 999.0)]
    assert lip.snapshot_valid(yes, [(u("0.55"), 1000.0)], 1000, 0.5, CENT)
    assert not lip.snapshot_valid(yes, thin, 1000, 0.5, CENT)


def test_owning_both_sides_for_the_whole_period_pays_the_whole_reward():
    # Payout = score share * reward * non-excluded / total, and each valid snapshot is worth 2 (one per side)
    assert lip.payout(reward=100.0, seconds=10, shares=[(1.0, 1.0, True)] * 10) == 100.0
    assert lip.payout(reward=100.0, seconds=10, shares=[(1.0, 0.0, True)] * 10) == 50.0


def test_excluded_snapshots_shrink_the_payout_in_proportion():
    half = [(1.0, 1.0, True)] * 5 + [(1.0, 1.0, False)] * 5
    assert lip.payout(reward=100.0, seconds=10, shares=half) == 50.0


def test_payouts_round_down_to_the_cent_and_under_a_dollar_pays_nothing():
    # "if the result is greater than or equal to $1.00, the result is paid out ... rounded down to the nearest cent"
    assert lip.payout(reward=100.0, seconds=3, shares=[(0.1, 0.0, True)] * 3) == 5.0
    assert lip.payout(reward=10.0, seconds=3, shares=[(0.1999, 0.0, True)] * 3) == 0.0     # 0.9995
    assert lip.payout(reward=33.335, seconds=1, shares=[(0.1, 0.0, True)]) == 1.66          # 1.66675


def test_an_order_below_the_reference_but_still_qualifying_is_paid_at_its_discount():
    # 300 at 40c sets the reference; 100 + our 700 at 39c complete the target one tick below it
    book = [(u("0.40"), 300.0), (u("0.39"), 100.0)]
    assert lip.share(book, u("0.39"), 700, 1000, 0.5, CENT) == pytest.approx(700 * 0.5 / (300 + 800 * 0.5))


def test_sizes_are_rounded_to_hundredths_not_truncated():
    # 0.29 * 100 is 28.999999999999996 as a float; truncating it would leave this side one hundredth short
    assert 0.29 * 100 < 29
    assert side([("0.40", 999.71), ("0.39", 0.29)]).ok
