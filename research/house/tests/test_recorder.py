import json

import pandas as pd

from house import lip
from house.client import ApiError
from house.grid import Grid, to_units as u
from house.recorder import NO, YES, Program, Recorder


def program(ticker="MKT-A", reward=1_400_000, target="1000.00", pid="p1", start="2026-11-17T00:00:00Z", end="2026-11-24T00:00:00Z"):
    return {"id": pid, "market_ticker": ticker, "period_reward": reward, "start_date": start, "end_date": end,
            "target_size_fp": target, "discount_factor_bps": 5000, "incentive_type": "liquidity"}


class FakeApi:
    def __init__(self):
        self.programs = [program()]
        self.books = {"MKT-A": {"yes_dollars": [["0.4000", "600.00"], ["0.3900", "700.00"]], "no_dollars": [["0.5800", "2000.00"]]}}
        self.volume = {"MKT-A": 10.0}
        self.calls, self.fail_books = [], False

    def pages(self, path, params, key, max_pages=50):
        self.calls.append((path, dict(params)))
        if path == "/incentive_programs":
            return (list(self.programs) if params["status"] == "active" else []), True
        return [{"trade_id": "t1", "ticker": params["ticker"], "count_fp": "3.00"}], True

    def get(self, path, params=None):
        self.calls.append((path, params))
        if path == "/markets":
            return {"markets": [{"ticker": t, "volume_fp": str(self.volume[t]), "price_ranges": [], "status": "active"}
                                for t in params["tickers"].split(",")]}
        if self.fail_books:
            raise ApiError("429")
        return {"orderbooks": [{"ticker": t, "orderbook_fp": self.books.get(t, {})} for _, t in params]}


def read(root, kind):
    files = sorted((root / kind).rglob("*.parquet"))
    return pd.concat([pd.read_parquet(f) for f in files]) if files else pd.DataFrame()


def clock():
    t = [1_794_950_000.0]
    def now():
        t[0] += 1.0
        return t[0]
    return now


def test_a_program_is_dollars_per_day_from_centi_cents_and_its_dates():
    p = Program.from_row(program())
    assert p.reward == 140.0 and p.per_day == 20.0 and p.target == 1000 and p.discount == 0.5


def test_a_sweep_writes_the_formulas_verdict_for_each_side(tmp_path):
    api = FakeApi()
    r = Recorder(tmp_path, api, now=clock())
    r.step()
    s = read(tmp_path, "scores").set_index("side")
    want = lip.qualify([(u("0.40"), 600), (u("0.39"), 700)], 1000, 0.5, Grid())
    assert s.loc[YES, "score"] == want.total == 600 + 350
    assert s.loc[YES, "ref"] == u("0.40") and s.loc[YES, "best"] == u("0.40")
    assert s.loc[YES, "cap"] == 600 * 0.40 + 700 * 0.39
    assert s.loc[NO, "score"] == 2000 and bool(s.loc[NO, "valid"]) and s.loc[YES, "perday"] == 20.0


def test_one_thin_side_makes_the_whole_snapshot_invalid(tmp_path):
    api = FakeApi()
    api.books["MKT-A"]["no_dollars"] = [["0.5800", "999.00"]]
    Recorder(tmp_path, api, now=clock()).step()
    s = read(tmp_path, "scores").set_index("side")
    assert bool(s.loc[YES, "ok"]) and not bool(s.loc[NO, "ok"]) and not s["valid"].any()


def test_raw_books_are_stored_when_they_change_and_at_keyframes_only(tmp_path):
    api = FakeApi()
    r = Recorder(tmp_path, api, now=clock(), keyframe_every=3, meta_every=10**9)
    r.step()                                             # sweep 0: keyframe
    r.step()                                             # sweep 1: unchanged, nothing stored
    assert len(read(tmp_path, "books")) == 3
    api.books["MKT-A"]["yes_dollars"][0][1] = "650.00"
    r.step()                                             # sweep 2: changed
    assert len(read(tmp_path, "books")) == 6
    r.step()                                             # sweep 3: keyframe again
    assert len(read(tmp_path, "books")) == 9
    assert len(read(tmp_path, "scores")) == 8            # the verdict is written every sweep regardless


def test_a_failed_batch_is_named_in_the_sweep_log_and_the_recorder_carries_on(tmp_path):
    api = FakeApi()
    r = Recorder(tmp_path, api, now=clock(), log=lambda *_: None)
    r.step()
    api.fail_books = True
    line = r.step()
    assert line["failed"] == ["MKT-A"] and line["scored"] == 0
    api.fail_books = False
    assert r.step()["scored"] == 1
    logged = [json.loads(x) for x in (tmp_path / "sweeps.jsonl").read_text().splitlines()]
    assert [x["failed"] for x in logged] == [[], ["MKT-A"], []]


def test_trades_are_fetched_only_for_markets_whose_volume_grew(tmp_path):
    api = FakeApi()
    api.programs.append(program(ticker="MKT-B", pid="p2"))
    api.volume["MKT-B"] = 0.0
    r = Recorder(tmp_path, api, now=clock(), meta_every=0)
    r.step()
    assert not (tmp_path / "trades").exists()            # first sight sets the baseline
    api.volume["MKT-B"] = 7.0
    line = r.step()
    asked = [p["ticker"] for path, p in api.calls if path == "/markets/trades"]
    assert asked == ["MKT-B"] and line["trades"] == 1 and line["moved"] == 1


def test_each_programme_row_is_kept_once_even_across_restarts(tmp_path):
    api = FakeApi()
    Recorder(tmp_path, api, now=clock(), programs_every=0).step()
    r = Recorder(tmp_path, api, now=clock(), programs_every=0)
    r.step(); r.step()
    assert len((tmp_path / "programs.jsonl").read_text().splitlines()) == 1
