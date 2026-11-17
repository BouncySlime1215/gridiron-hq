import pytest

from house.grid import Grid, to_units

TAPERED = Grid.from_market([
    {"start": "0.0000", "end": "0.1000", "step": "0.0010"},
    {"start": "0.1000", "end": "0.9000", "step": "0.0100"},
    {"start": "0.9000", "end": "1.0000", "step": "0.0010"},
])


def test_prices_become_exact_integers():
    assert to_units("0.9010") == 9010
    assert to_units(0.07) == 700          # 0.07 * 10000 is 700.0000000000001 as a float


def test_cent_grid_counts_cents():
    assert Grid().ticks_between(to_units("0.21"), to_units("0.91")) == 70
    assert Grid().ticks_between(4500, 4500) == 0


def test_tapered_grid_counts_tenths_in_the_tails_and_cents_in_the_middle():
    # 90.1c -> 90.0c is one tick, then a cent a tick down to 23c
    assert TAPERED.ticks_between(to_units("0.90"), to_units("0.901")) == 1
    assert TAPERED.ticks_between(to_units("0.23"), to_units("0.901")) == 67 + 1
    assert TAPERED.ticks_between(to_units("0.011"), to_units("0.012")) == 1
    assert TAPERED.ticks_between(to_units("0.09"), to_units("0.11")) == 10 + 1


def test_a_step_crosses_the_boundary_with_the_right_size_each_side():
    assert TAPERED.up(to_units("0.099")) == to_units("0.10")
    assert TAPERED.up(to_units("0.10")) == to_units("0.11")
    assert TAPERED.down(to_units("0.10")) == to_units("0.099")
    assert TAPERED.down(to_units("0.90")) == to_units("0.89")
    assert TAPERED.up(to_units("0.90")) == to_units("0.901")
    assert Grid().up(4500, 3) == 4800


def test_off_grid_prices_and_reversed_arguments_are_errors_not_guesses():
    with pytest.raises(ValueError):
        Grid().ticks_between(4550, 4700)
    with pytest.raises(ValueError):
        Grid().ticks_between(4700, 4500)
    with pytest.raises(ValueError):
        Grid().up(10_000)
