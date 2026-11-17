"""The holdout guard: outcomes for games on or after the holdout date are not readable by accident."""
import datetime as dt
import json

import pytest

from kalshi_edge import guard

UTC = dt.timezone.utc


def test_split_assignment_follows_the_preregistered_dates():
    assert guard.split_of(dt.datetime(2026, 8, 31, 23, 59, tzinfo=UTC)) == "train"
    assert guard.split_of(dt.datetime(2026, 9, 1, 0, 0, tzinfo=UTC)) == "validation"
    assert guard.split_of(dt.datetime(2026, 9, 30, 23, 59, 59, tzinfo=UTC)) == "validation"
    assert guard.split_of(dt.datetime(2026, 10, 1, 0, 0, tzinfo=UTC)) == "holdout"
    assert guard.split_of(dt.datetime(2026, 11, 15, 23, 0, tzinfo=UTC)) == "holdout"
    assert guard.split_of(dt.datetime(2026, 11, 16, 0, 0, tzinfo=UTC)) == "forward"
    assert guard.split_of(dt.datetime(2025, 3, 1, tzinfo=UTC)) == "train"


def test_split_needs_an_aware_timestamp():
    with pytest.raises(ValueError):
        guard.split_of(dt.datetime(2026, 10, 1))


def test_opening_the_holdout_without_a_frozen_model_is_refused(tmp_path):
    ledger = tmp_path / "HOLDOUT-LEDGER.md"
    ledger.write_text("| # | when |\n|---|---|\n")
    with pytest.raises(guard.HoldoutRefused):
        guard.open_holdout(frozen_model=tmp_path / "missing.json", ledger=ledger, script="x.py", what="smoke")
    assert ledger.read_text().count("\n") == 2          # a refused attempt computes nothing, so it adds no row


def test_opening_the_holdout_appends_a_ledger_row_with_the_model_hash(tmp_path):
    model = tmp_path / "frozen.json"
    model.write_text(json.dumps({"tau": 0.01}))
    ledger = tmp_path / "HOLDOUT-LEDGER.md"
    ledger.write_text("| # | when (UTC) | frozen model sha256 | script | what was computed | result file |\n|---|---|---|---|---|---|\n")
    token = guard.open_holdout(frozen_model=model, ledger=ledger, script="run_holdout.py", what="primary P1-P4",
                               result_file="results/holdout.json")
    rows = [ln for ln in ledger.read_text().splitlines() if ln.startswith("| 1 |")]
    assert len(rows) == 1
    assert token.model_sha256 in rows[0] and "run_holdout.py" in rows[0] and "primary P1-P4" in rows[0]
    assert len(token.model_sha256) == 64
    # a second look is a second row, numbered
    guard.open_holdout(frozen_model=model, ledger=ledger, script="run_holdout.py", what="again")
    assert any(ln.startswith("| 2 |") for ln in ledger.read_text().splitlines())


def test_a_changed_model_file_changes_the_recorded_hash(tmp_path):
    model = tmp_path / "frozen.json"
    ledger = tmp_path / "L.md"
    ledger.write_text("|h|\n|---|\n")
    model.write_text("{\"tau\": 0.01}")
    a = guard.open_holdout(frozen_model=model, ledger=ledger, script="s", what="w").model_sha256
    model.write_text("{\"tau\": 0.02}")
    b = guard.open_holdout(frozen_model=model, ledger=ledger, script="s", what="w").model_sha256
    assert a != b


def test_holdout_path_cannot_be_read_without_a_token(tmp_path):
    with pytest.raises(guard.HoldoutRefused):
        guard.holdout_path(tmp_path, 10, token=None)
    model = tmp_path / "frozen.json"
    model.write_text("{}")
    ledger = tmp_path / "L.md"
    ledger.write_text("|h|\n|---|\n")
    token = guard.open_holdout(frozen_model=model, ledger=ledger, script="s", what="w")
    assert guard.holdout_path(tmp_path, 10, token=token) == tmp_path / "holdout" / "h10.parquet"
