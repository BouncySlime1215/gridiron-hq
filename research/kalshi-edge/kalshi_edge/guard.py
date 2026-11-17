"""The holdout guard.

Outcomes for games starting on or after HOLDOUT_START live in their own directory.
Reading them takes a token, a token takes a frozen model file, and issuing one writes
a numbered row to the ledger first. A refused attempt writes nothing.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass
from pathlib import Path

UTC = dt.timezone.utc
VALIDATION_START = dt.datetime(2026, 9, 1, tzinfo=UTC)
HOLDOUT_START = dt.datetime(2026, 10, 1, tzinfo=UTC)
FORWARD_START = dt.datetime(2026, 11, 16, tzinfo=UTC)


class HoldoutRefused(RuntimeError):
    pass


@dataclass(frozen=True)
class HoldoutToken:
    model_sha256: str
    row_number: int


def split_of(t_start: dt.datetime) -> str:
    """train / validation / holdout / forward for a scheduled start (must be timezone-aware)."""
    if t_start.tzinfo is None:
        raise ValueError("t_start must be timezone-aware")
    if t_start < VALIDATION_START:
        return "train"
    if t_start < HOLDOUT_START:
        return "validation"
    if t_start < FORWARD_START:
        return "holdout"
    return "forward"


def open_holdout(frozen_model: Path, ledger: Path, script: str, what: str, result_file: str = "") -> HoldoutToken:
    """Record a look at the holdout and return the token that lets the data be read."""
    frozen_model = Path(frozen_model)
    if not frozen_model.is_file():
        raise HoldoutRefused(f"no frozen model at {frozen_model}: freeze the model before opening the holdout")
    sha = hashlib.sha256(frozen_model.read_bytes()).hexdigest()
    ledger = Path(ledger)
    lines = ledger.read_text().splitlines()
    n = 0
    for ln in lines:
        cells = [c.strip() for c in ln.split("|")]
        if len(cells) > 2 and cells[1].isdigit():
            n = max(n, int(cells[1]))
    n += 1
    now = dt.datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
    with ledger.open("a") as f:
        f.write(f"| {n} | {now} | {sha} | {script} | {what} | {result_file} |\n")
    return HoldoutToken(sha, n)


def holdout_path(data_dir: Path, h_minutes: int, token: HoldoutToken | None) -> Path:
    if not isinstance(token, HoldoutToken):
        raise HoldoutRefused("the holdout is read only with a token from open_holdout()")
    return Path(data_dir) / "holdout" / f"h{h_minutes}.parquet"
