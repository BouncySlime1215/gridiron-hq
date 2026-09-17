#!/usr/bin/env python
"""
Availability model: P(player plays | official injury report before kickoff), 2021-2025.

Walk-forward by season (fit on seasons < S, test on S; S in 2022..2025).
Models: (a) shrunk empirical rate table, (b) logistic regression, (c) LightGBM,
(d) isotonic-calibrated LightGBM (isotonic fit on train-only out-of-fold preds).

Reads the live DB READ-ONLY. Writes:
  data/line-history/availability_predictions.csv
  docs/evidence/2026-09-16/news-line/availability_model_tables.md   (all metric tables)
  docs/evidence/2026-09-16/news-line/availability_model_metrics.json

Run:  research/.venv/bin/python scripts/news-line/availability_model.py
"""
import os
from __future__ import annotations

import json
import re
import sqlite3
import sys
import unicodedata
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
import lightgbm as lgb

warnings.filterwarnings("ignore")
SEED = 20260916
np.random.seed(SEED)

REPO = Path(__file__).resolve().parents[2]
# Live DB first (read-only); the repo copy is a byte-identical 2021-2025 regular-season snapshot for the
# tables used here (verified 2026-09-16: identical nfl_injuries / nfl_snaps / nfl_depth counts by season).
DB_CANDIDATES = [
    os.environ.get("GRIDIRON_DB") or str(Path(__file__).resolve().parents[2] / "server/data.sqlite"),
    str(REPO / "server/data.sqlite"),
]
OUT_CSV = REPO / "data/line-history/availability_predictions.csv"
OUT_DIR = REPO / "docs/evidence/2026-09-16/news-line"
OUT_DIR.mkdir(parents=True, exist_ok=True)
(REPO / "data/line-history").mkdir(parents=True, exist_ok=True)

SEASONS = [2021, 2022, 2023, 2024, 2025]
TEST_SEASONS = [2022, 2023, 2024, 2025]

# ----------------------------------------------------------------------------- helpers
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm_name(n) -> str:
    if n is None or (isinstance(n, float) and np.isnan(n)):
        return ""
    n = unicodedata.normalize("NFKD", str(n)).encode("ascii", "ignore").decode()
    toks = re.sub(r"[^a-zA-Z ]", "", n).lower().split()
    return " ".join(t for t in toks if t not in SUFFIXES)


def fuzzy_key(nn: str) -> str:
    t = nn.split()
    return f"{t[0][0]} {t[-1]}" if t else ""


POS_GROUP = {
    "QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE",
    "T": "OL", "G": "OL", "C": "OL", "OL": "OL", "OT": "OL", "OG": "OL",
    "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL", "EDGE": "DL",
    "LB": "LB", "ILB": "LB", "OLB": "LB", "MLB": "LB",
    "CB": "DB", "S": "DB", "SS": "DB", "FS": "DB", "DB": "DB",
    "K": "ST", "P": "ST", "LS": "ST",
}

STATUS_MAP = {None: "None", "Questionable": "Questionable", "Doubtful": "Doubtful", "Out": "Out"}
PRACTICE_MAP = {
    "Full Participation in Practice": "FP",
    "Limited Participation in Practice": "LP",
    "Did Not Participate In Practice": "DNP",
}


def body_cat(s) -> str:
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return "unknown"
    t = str(s).lower()
    if "not injury related" in t:
        if "rest" in t:
            return "rest"
        if "personal" in t:
            return "personal"
        return "nir_other"
    if "illness" in t:
        return "illness"
    if "concussion" in t:
        return "concussion"
    for k in ["knee", "ankle", "hamstring", "shoulder", "groin", "foot", "back", "calf", "hip",
              "neck", "quad", "toe", "elbow", "hand", "wrist", "rib", "thumb", "chest", "pectoral",
              "thigh", "abdomen", "achilles", "oblique", "finger", "heel", "shin", "bicep", "tricep",
              "forearm", "fibula", "eye", "glute", "core"]:
        if k in t:
            return k
    return "other"


def metrics(y, p) -> dict:
    y = np.asarray(y, float)
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    out = {"n": int(len(y)), "base_rate": float(y.mean()) if len(y) else np.nan,
           "log_loss": float(log_loss(y, p)) if len(y) else np.nan,
           "brier": float(brier_score_loss(y, p)) if len(y) else np.nan}
    out["auc"] = float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else np.nan
    return out


def calib_table(y, p, bins=10) -> pd.DataFrame:
    y = np.asarray(y, float)
    p = np.asarray(p, float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1], right=False), 0, bins - 1)
    rows = []
    for b in range(bins):
        m = idx == b
        rows.append({"bin": f"[{edges[b]:.1f},{edges[b+1]:.1f})", "n": int(m.sum()),
                     "pred_mean": float(p[m].mean()) if m.any() else np.nan,
                     "actual": float(y[m].mean()) if m.any() else np.nan})
    return pd.DataFrame(rows)


def md_table(df: pd.DataFrame, floatfmt="{:.3f}") -> str:
    df = df.copy()
    for c in df.columns:
        if df[c].dtype.kind == "f":
            df[c] = df[c].map(lambda v: "" if pd.isna(v) else floatfmt.format(v))
    cols = list(df.columns)
    lines = ["| " + " | ".join(map(str, cols)) + " |", "|" + "|".join(["---"] * len(cols)) + "|"]
    for _, r in df.iterrows():
        lines.append("| " + " | ".join(str(r[c]) for c in cols) + " |")
    return "\n".join(lines)


# ----------------------------------------------------------------------------- load
def load() -> dict:
    db = next((c for c in DB_CANDIDATES if os.path.exists(c)), None)
    if db is None:
        sys.exit("no database found in DB_CANDIDATES")
    print(f"db: {db}", flush=True)
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    q = lambda s: pd.read_sql(s, con)
    d = {"db_path": db}
    d["inj"] = q("select season, week, gsis_id, team, full_name, position, report_status, practice_status, injury, modified_at from nfl_injuries where season between 2021 and 2025")
    d["snaps"] = q("select season, week, player, team, position, offense_snaps, defense_snaps, offense_pct, defense_pct, st_pct from nfl_snaps where season between 2021 and 2025")
    d["depth"] = q("select season, week, team, gsis_id, pos_abb, pos_rank, captured from nfl_depth where season between 2021 and 2025")
    d["games"] = q("select season, week, team, opponent, home, gameday, gametime, rest_days from game_lines where season between 2021 and 2025")
    try:
        d["events"] = q("select season, week, player_id, occurred_at, payload_json from nfl_verified_events where event_type='official_injury_report'")
    except Exception as e:  # table absent in the repo snapshot
        print(f"nfl_verified_events unavailable: {e}", flush=True)
        d["events"] = pd.DataFrame(columns=["season", "week", "player_id", "occurred_at", "payload_json"])
    con.close()
    return d


# ----------------------------------------------------------------------------- build dataset
def build(d: dict) -> tuple[pd.DataFrame, dict]:
    notes = {"db_path": d["db_path"]}
    inj = d["inj"].copy()
    inj = inj[inj.week <= 18].copy()  # nfl_snaps only covers regular season
    notes["injury_rows_2021_2025"] = int(len(d["inj"]))
    notes["injury_rows_regular_season"] = int(len(inj))
    inj["nn"] = inj.full_name.map(norm_name)
    inj["fk"] = inj.nn.map(fuzzy_key)

    # --- verified events: check whether they add any daily sequence information
    ev = d["events"].copy()
    ev["payload_json"] = ev.payload_json.fillna("")
    notes["events_rows"] = int(len(ev))
    g = ev.groupby(["season", "week", "player_id"]).agg(n=("occurred_at", "size"),
                                                         n_ts=("occurred_at", "nunique"),
                                                         n_payload=("payload_json", "nunique"))
    notes["events_player_weeks"] = int(len(g))
    notes["events_player_weeks_with_multiple_distinct_timestamps"] = int((g.n_ts > 1).sum())
    notes["events_player_weeks_with_multiple_distinct_payloads"] = int((g.n_payload > 1).sum())
    notes["events_rows_per_player_week"] = g.n.value_counts().to_dict()

    # --- snaps labels
    sn = d["snaps"].copy()
    sn["nn"] = sn.player.map(norm_name)
    sn["fk"] = sn.nn.map(fuzzy_key)
    sn["played"] = ((sn.offense_snaps.fillna(0) > 0) | (sn.defense_snaps.fillna(0) > 0)).astype(int)
    sn["played_any"] = ((sn.played == 1) | (sn.st_pct.fillna(0) > 0)).astype(int)
    sn["snap_pct"] = np.maximum(sn.offense_pct.fillna(0), sn.defense_pct.fillna(0))
    snk = sn.groupby(["season", "week", "team", "nn"], as_index=False).agg(
        played=("played", "max"), played_any=("played_any", "max"), snap_pct=("snap_pct", "max"))

    # name resolution: exact normalized; else unique (first-initial, last-name) inside team-season
    season_names = sn[["season", "team", "nn", "fk"]].drop_duplicates()
    exact_keys = set(map(tuple, season_names[["season", "team", "nn"]].values))
    fk_counts = season_names.groupby(["season", "team", "fk"]).nn.agg(["nunique", "first"]).reset_index()
    fk_unique = {(r.season, r.team, r.fk): r["first"] for _, r in fk_counts[fk_counts["nunique"] == 1].iterrows()}

    def resolve(r):
        k = (r.season, r.team, r.nn)
        if k in exact_keys:
            return r.nn, "exact"
        v = fk_unique.get((r.season, r.team, r.fk))
        if v is not None:
            return v, "fuzzy"
        return None, "unmatched"

    res = inj.apply(resolve, axis=1, result_type="expand")
    inj["snap_name"], inj["match_kind"] = res[0], res[1]
    notes["match_kind_counts"] = inj.match_kind.value_counts().to_dict()
    notes["match_rate_by_season"] = inj.groupby("season").match_kind.apply(lambda s: float((s != "unmatched").mean())).round(4).to_dict()
    notes["match_kind_by_status"] = (inj.groupby(inj.report_status.fillna("None")).match_kind
                                     .value_counts(normalize=True).unstack(fill_value=0).round(4).to_dict("index"))

    inj = inj.merge(snk.rename(columns={"nn": "snap_name"}), on=["season", "week", "team", "snap_name"], how="left")
    inj["in_snaps_this_week"] = inj.played.notna()
    inj["played"] = inj.played.fillna(0).astype(int)
    inj["played_any"] = inj.played_any.fillna(0).astype(int)
    inj["snap_pct_this_week"] = inj.snap_pct.fillna(0.0)
    inj = inj.drop(columns=["snap_pct"])

    # --- prior-week snap features (same team-season, weeks < current), via resolved snap_name
    hist = snk.rename(columns={"nn": "snap_name"})[["season", "week", "team", "snap_name", "played", "snap_pct"]]
    hist = hist.sort_values(["season", "team", "snap_name", "week"])
    rows = []
    for (season, team, name), grp in hist.groupby(["season", "team", "snap_name"]):
        wk = grp.week.values
        pl = grp.played.values
        sp = grp.snap_pct.values
        rows.append((season, team, name, wk, pl, sp))
    hist_idx = {(s, t, n): (wk, pl, sp) for s, t, n, wk, pl, sp in rows}

    def prior_feats(r):
        h = hist_idx.get((r.season, r.team, r.snap_name))
        if h is None:
            return np.nan, 0, 0, np.nan
        wk, pl, sp = h
        m = wk < r.week
        if not m.any():
            return np.nan, 0, 0, np.nan
        played_prev = int(pl[m][-1] == 1 and wk[m][-1] == r.week - 1)
        games_played = int(pl[m].sum())
        last_played_wk = wk[m][pl[m] == 1]
        weeks_since = float(r.week - last_played_wk[-1]) if len(last_played_wk) else np.nan
        # snap pct at the most recent prior week the player appeared
        return float(sp[m][-1]), played_prev, games_played, weeks_since

    pf = inj.apply(prior_feats, axis=1, result_type="expand")
    inj["prior_snap_pct"], inj["played_last_week"], inj["games_played_prior"], inj["weeks_since_played"] = pf[0], pf[1], pf[2], pf[3]

    # --- prior-week report
    prev = inj[["season", "week", "gsis_id", "report_status", "practice_status"]].copy()
    prev["week"] = prev.week + 1
    prev = prev.rename(columns={"report_status": "prev_report_status", "practice_status": "prev_practice_status"})
    inj = inj.merge(prev, on=["season", "week", "gsis_id"], how="left", indicator="prev_m")
    inj["on_report_last_week"] = (inj.prev_m == "both").astype(int)
    inj = inj.drop(columns=["prev_m"])
    # consecutive weeks on report
    inj = inj.sort_values(["season", "gsis_id", "week"])
    streak = np.zeros(len(inj), dtype=int)
    last = {}
    for i, (s, g, w) in enumerate(zip(inj.season.values, inj.gsis_id.values, inj.week.values)):
        p = last.get((s, g))
        streak[i] = (p[1] + 1) if (p is not None and p[0] == w - 1) else 1
        last[(s, g)] = (w, streak[i])
    inj["report_streak"] = streak

    # --- games / kickoff
    gm = d["games"].copy()
    gm["kickoff_et"] = pd.to_datetime(gm.gameday + " " + gm.gametime.fillna("13:00"), errors="coerce")
    gm["kickoff_utc"] = gm.kickoff_et.dt.tz_localize("US/Eastern", ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
    gm["dow"] = gm.kickoff_et.dt.dayofweek  # Mon=0
    gm = gm[["season", "week", "team", "opponent", "home", "gameday", "kickoff_utc", "dow", "rest_days"]]
    inj = inj.merge(gm, on=["season", "week", "team"], how="left")
    notes["injury_rows_without_game"] = int(inj.kickoff_utc.isna().sum())
    inj = inj[inj.kickoff_utc.notna()].copy()
    inj["mod_utc"] = pd.to_datetime(inj.modified_at, errors="coerce", utc=True)
    inj["lead_h"] = (inj.kickoff_utc - inj.mod_utc).dt.total_seconds() / 3600
    inj["lead_missing"] = inj.lead_h.isna().astype(int)
    inj["is_thu"] = (inj.dow == 3).astype(int)
    inj["is_mon"] = (inj.dow == 0).astype(int)
    inj["is_sun"] = (inj.dow == 6).astype(int)

    # --- depth chart: latest capture strictly before the team's gameday
    dp = d["depth"].copy()
    dp["cap_date"] = pd.to_datetime(dp.captured, errors="coerce", utc=True).dt.tz_convert(None).dt.normalize()
    dp = dp.dropna(subset=["gsis_id", "cap_date"])
    dp_min = dp.groupby(["season", "team", "gsis_id", "cap_date"], as_index=False).pos_rank.min()
    dp_min = dp_min.sort_values(["season", "team", "gsis_id", "cap_date"])
    dp_groups = {k: (g.cap_date.values.astype("datetime64[D]"), g.pos_rank.values) for k, g in dp_min.groupby(["season", "team", "gsis_id"])}
    gameday = pd.to_datetime(inj.gameday).values.astype("datetime64[D]")

    def depth_rank(i, r):
        h = dp_groups.get((r.season, r.team, r.gsis_id))
        if h is None:
            return np.nan
        cd, pr = h
        m = cd < gameday[i]
        return float(pr[m][-1]) if m.any() else np.nan

    inj = inj.reset_index(drop=True)
    inj["pos_rank"] = [depth_rank(i, r) for i, r in enumerate(inj.itertuples(index=False))]
    notes["depth_rank_coverage_by_season"] = inj.groupby("season").pos_rank.apply(lambda s: float(s.notna().mean())).round(4).to_dict()

    # --- categorical cleanups
    inj["status"] = inj.report_status.map(lambda s: STATUS_MAP.get(s, "Unknown") if s in STATUS_MAP or s is None else "Unknown")
    inj.loc[inj.report_status.isna(), "status"] = "None"
    inj["practice"] = inj.practice_status.map(lambda s: PRACTICE_MAP.get(s, "Unknown"))
    inj["practice_seq"] = inj.practice  # NOTE: single final value; DB has no Wed/Thu/Fri sequence
    inj["body"] = inj.injury.map(body_cat)
    inj["pos_group"] = inj.position.map(lambda p: POS_GROUP.get(str(p).strip(), "OTHER"))
    inj["prev_status"] = inj.prev_report_status.map(lambda s: "None" if s is None else STATUS_MAP.get(s, "Unknown"))
    inj.loc[inj.on_report_last_week == 0, "prev_status"] = "NotOnReport"
    inj["prev_practice"] = inj.prev_practice_status.map(lambda s: PRACTICE_MAP.get(s, "Unknown"))
    inj.loc[inj.on_report_last_week == 0, "prev_practice"] = "NotOnReport"
    inj["is_starter"] = (inj.pos_rank == 1).astype(float)
    inj.loc[inj.pos_rank.isna(), "is_starter"] = np.nan
    inj["pos_rank_c"] = inj.pos_rank.clip(upper=3)

    # --- modeling set: label-defined rows only
    inj["in_model"] = (inj.match_kind != "unmatched") & (inj.pos_group != "ST")
    notes["rows_excluded_ST"] = int((inj.pos_group == "ST").sum())
    notes["rows_excluded_unmatched"] = int(((inj.match_kind == "unmatched") & (inj.pos_group != "ST")).sum())
    notes["rows_in_model"] = int(inj.in_model.sum())
    return inj, notes


# ----------------------------------------------------------------------------- models
class RateTable:
    """Hierarchical shrunk empirical rate: (status,practice,pos_group) -> (status,practice) -> status -> global."""

    def __init__(self, m=20.0):
        self.m = m

    def fit(self, df: pd.DataFrame):
        y = df.played
        self.g = float(y.mean())
        self.l1 = df.groupby("status").played.agg(["sum", "count"])
        self.l2 = df.groupby(["status", "practice"]).played.agg(["sum", "count"])
        self.l3 = df.groupby(["status", "practice", "pos_group"]).played.agg(["sum", "count"])
        return self

    def _shrink(self, table, key, prior):
        if key in table.index:
            s, n = table.loc[key, "sum"], table.loc[key, "count"]
            return (s + self.m * prior) / (n + self.m)
        return prior

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        out = np.empty(len(df))
        for i, r in enumerate(df[["status", "practice", "pos_group"]].itertuples(index=False)):
            p1 = self._shrink(self.l1, r.status, self.g)
            p2 = self._shrink(self.l2, (r.status, r.practice), p1)
            p3 = self._shrink(self.l3, (r.status, r.practice, r.pos_group), p2)
            out[i] = p3
        return np.clip(out, 1e-4, 1 - 1e-4)


CAT = ["status", "practice", "body", "pos_group", "prev_status", "prev_practice", "team"]
NUM = ["pos_rank_c", "is_starter", "prior_snap_pct", "played_last_week", "games_played_prior",
       "weeks_since_played", "on_report_last_week", "report_streak", "lead_h", "lead_missing",
       "is_thu", "is_mon", "rest_days", "week", "home"]
LR_CAT = [c for c in CAT if c != "team"]


def make_lr():
    pre = ColumnTransformer([
        ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=20), LR_CAT),
        ("num", Pipeline([("imp", SimpleImputer(strategy="median", add_indicator=True)), ("sc", StandardScaler())]), NUM),
    ])
    return Pipeline([("pre", pre), ("lr", LogisticRegression(C=0.5, max_iter=2000, random_state=SEED))])


LGB_PARAMS = dict(objective="binary", learning_rate=0.03, num_leaves=15, max_depth=4, min_child_samples=50,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=5.0,
                  n_estimators=400, random_state=SEED, verbose=-1)


def lgb_frame(df: pd.DataFrame, cats: dict | None = None):
    X = df[CAT + NUM].copy()
    for c in CAT:
        if cats is None:
            X[c] = X[c].astype("category")
        else:
            X[c] = pd.Categorical(X[c], categories=cats[c])
    return X


def fit_lgb(tr: pd.DataFrame):
    X = lgb_frame(tr)
    cats = {c: X[c].cat.categories for c in CAT}
    m = lgb.LGBMClassifier(**LGB_PARAMS)
    m.fit(X, tr.played)
    return m, cats


def oof_predict(tr: pd.DataFrame, kind: str, n_splits=5) -> np.ndarray:
    """Out-of-fold predictions inside the training set (grouped by season-week) for calibrator fitting."""
    groups = (tr.season * 100 + tr.week).values
    oof = np.zeros(len(tr))
    for a, b in GroupKFold(n_splits=n_splits).split(tr, tr.played, groups):
        t, v = tr.iloc[a], tr.iloc[b]
        if kind == "lgb":
            m, cats = fit_lgb(t)
            oof[b] = m.predict_proba(lgb_frame(v, cats))[:, 1]
        else:
            m = make_lr().fit(t, t.played)
            oof[b] = m.predict_proba(v)[:, 1]
    return oof


# ----------------------------------------------------------------------------- run
def main():
    print("loading...", flush=True)
    d = load()
    df, notes = build(d)
    md = df[df.in_model].copy().reset_index(drop=True)
    print(f"modeling rows: {len(md)}  by season: {md.season.value_counts().sort_index().to_dict()}", flush=True)

    preds = []
    fold_metrics = {}
    for S in TEST_SEASONS:
        tr = md[md.season < S].reset_index(drop=True)
        te = md[md.season == S].reset_index(drop=True)
        print(f"fold {S}: train {len(tr)} test {len(te)}", flush=True)
        # (a) rate table
        rt = RateTable().fit(tr)
        p_rt = rt.predict(te)
        # (b) LR
        lr = make_lr().fit(tr, tr.played)
        p_lr = lr.predict_proba(te)[:, 1]
        # (c) LGBM
        gbm, cats = fit_lgb(tr)
        p_gb = gbm.predict_proba(lgb_frame(te, cats))[:, 1]
        # (d) isotonic on train OOF
        oof_gb = oof_predict(tr, "lgb")
        iso_gb = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4).fit(oof_gb, tr.played)
        p_gb_iso = iso_gb.predict(p_gb)
        oof_lr = oof_predict(tr, "lr")
        iso_lr = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4).fit(oof_lr, tr.played)
        p_lr_iso = iso_lr.predict(p_lr)
        te = te.assign(p_rate=p_rt, p_lr=p_lr, p_lgb=p_gb, p_lgb_iso=p_gb_iso, p_lr_iso=p_lr_iso)
        preds.append(te)

    P = pd.concat(preds, ignore_index=True)
    MODELS = ["p_rate", "p_lr", "p_lgb", "p_lgb_iso", "p_lr_iso"]
    SUBGROUPS = {
        "all": lambda x: np.ones(len(x), bool),
        "QB": lambda x: (x.pos_group == "QB").values,
        "Questionable": lambda x: (x.status == "Questionable").values,
        "pos_rank_1": lambda x: (x.pos_rank == 1).values,
        "Questionable_pos_rank_1": lambda x: ((x.status == "Questionable") & (x.pos_rank == 1)).values,
        "Questionable_QB": lambda x: ((x.status == "Questionable") & (x.pos_group == "QB")).values,
    }

    # --- metric tables
    out_md = []
    out_md.append("# Availability model: generated tables\n")
    out_md.append(f"Generated by `scripts/news-line/availability_model.py` (seed {SEED}). All metrics are walk-forward: model fit on seasons < S, scored on S.\n")
    out_md.append("## Data notes (machine-generated)\n")
    out_md.append("```json\n" + json.dumps(notes, indent=2, default=str) + "\n```\n")

    metric_rows = []
    for sg, fn in SUBGROUPS.items():
        for S in TEST_SEASONS + ["pooled"]:
            sub = P if S == "pooled" else P[P.season == S]
            mask = fn(sub)
            sub = sub[mask]
            for m in MODELS:
                r = metrics(sub.played, sub[m])
                r.update({"subgroup": sg, "season": S, "model": m})
                metric_rows.append(r)
    M = pd.DataFrame(metric_rows)[["subgroup", "season", "model", "n", "base_rate", "log_loss", "brier", "auc"]]
    for sg in SUBGROUPS:
        out_md.append(f"## Metrics: {sg}\n")
        out_md.append(md_table(M[M.subgroup == sg].drop(columns="subgroup"), "{:.4f}") + "\n")

    # --- calibration tables (pooled and per season) for the main models
    for sg in ["all", "QB", "Questionable", "pos_rank_1"]:
        for m in ["p_rate", "p_lgb", "p_lgb_iso"]:
            out_md.append(f"## Calibration ({sg}, {m}, pooled 2022-2025)\n")
            sub = P[SUBGROUPS[sg](P)]
            out_md.append(md_table(calib_table(sub.played, sub[m])) + "\n")
    for S in TEST_SEASONS:
        for m in ["p_lgb_iso"]:
            out_md.append(f"## Calibration (all, {m}, season {S})\n")
            sub = P[P.season == S]
            out_md.append(md_table(calib_table(sub.played, sub[m])) + "\n")

    # --- plain-words rate tables (descriptive, all five seasons pooled + by season)
    def rate_tbl(x, keys):
        g = x.groupby(keys).played.agg(n="size", plays="sum")
        g["play_rate"] = g.plays / g.n
        return g.reset_index().sort_values(keys)

    out_md.append("## Plain-words rate table: designation x final practice status (2021-2025, modeling set)\n")
    out_md.append(md_table(rate_tbl(md, ["status", "practice"]), "{:.3f}") + "\n")
    out_md.append("## Rate table: designation x practice x position group (n >= 30)\n")
    t = rate_tbl(md, ["status", "practice", "pos_group"])
    out_md.append(md_table(t[t.n >= 30], "{:.3f}") + "\n")
    out_md.append("## Rate table: designation x practice x is_starter (depth rank 1 before gameday)\n")
    t = rate_tbl(md.assign(starter=md.is_starter.map({1.0: "starter", 0.0: "backup"}).fillna("no_depth")), ["status", "practice", "starter"])
    out_md.append(md_table(t[t.n >= 30], "{:.3f}") + "\n")
    out_md.append("## Rate table: Questionable by body-part category (n >= 30)\n")
    t = rate_tbl(md[md.status == "Questionable"], ["practice", "body"])
    out_md.append(md_table(t[t.n >= 30], "{:.3f}") + "\n")
    out_md.append("## Rate table: designation x practice by season (drift check)\n")
    t = rate_tbl(md, ["season", "status", "practice"])
    out_md.append(md_table(t[t.n >= 30], "{:.3f}") + "\n")
    out_md.append("## Rate table: Questionable x practice x played-last-week\n")
    t = rate_tbl(md[md.status == "Questionable"], ["practice", "played_last_week"])
    out_md.append(md_table(t, "{:.3f}") + "\n")
    out_md.append("## Rate table: Questionable x practice x game day (Thu/Sun/Mon)\n")
    t = rate_tbl(md[md.status == "Questionable"].assign(gameday_type=np.where(md[md.status == "Questionable"].is_thu == 1, "Thu", np.where(md[md.status == "Questionable"].is_mon == 1, "Mon", "Sun/other"))), ["practice", "gameday_type"])
    out_md.append(md_table(t, "{:.3f}") + "\n")

    # --- sensitivity: unmatched treated as not played
    full = df[df.pos_group != "ST"]
    s1 = rate_tbl(md, ["status"]).rename(columns={"play_rate": "play_rate_matched_only"})
    s2 = rate_tbl(full, ["status"]).rename(columns={"play_rate": "play_rate_unmatched_as_DNP"})
    out_md.append("## Sensitivity: play rate by designation, unmatched names excluded vs counted as did-not-play\n")
    out_md.append(md_table(s1.merge(s2, on="status", suffixes=("", "_all")), "{:.4f}") + "\n")

    # --- label alternative: played_any (incl. special teams only)
    out_md.append("## Label sensitivity: offense/defense snap > 0 (used) vs any snap incl. special teams\n")
    t = md.groupby(["status", "practice"]).agg(n=("played", "size"), play_rate=("played", "mean"), play_any_rate=("played_any", "mean")).reset_index()
    out_md.append(md_table(t, "{:.3f}") + "\n")

    # --- ST (K/P/LS) descriptive with ST label
    st = df[df.pos_group == "ST"]
    out_md.append("## K/P/LS (excluded from model): play rate using any-snap label\n")
    t = st.groupby(["status"]).agg(n=("played_any", "size"), play_any_rate=("played_any", "mean")).reset_index()
    out_md.append(md_table(t, "{:.3f}") + "\n")

    # --- LightGBM feature importance from the final (2025) fold
    imp = pd.DataFrame({"feature": CAT + NUM, "gain": gbm.booster_.feature_importance("gain")}).sort_values("gain", ascending=False)
    imp["gain_share"] = imp.gain / imp.gain.sum()
    out_md.append("## LightGBM gain importance (fold trained on 2021-2024)\n")
    out_md.append(md_table(imp[["feature", "gain_share"]], "{:.3f}") + "\n")

    # --- LR coefficients (fold trained on 2021-2024) for the main categorical levels
    try:
        pre = lr.named_steps["pre"]
        names = list(pre.named_transformers_["cat"].get_feature_names_out(LR_CAT)) + list(pre.named_transformers_["num"].get_feature_names_out(NUM))
        coef = pd.DataFrame({"feature": names, "coef": lr.named_steps["lr"].coef_[0]})
        coef = coef.reindex(coef.coef.abs().sort_values(ascending=False).index).head(30)
        out_md.append("## Logistic regression: 30 largest |coef| (fold trained on 2021-2024, standardized numerics)\n")
        out_md.append(md_table(coef, "{:.3f}") + "\n")
    except Exception as e:  # pragma: no cover
        out_md.append(f"(LR coefficient extraction failed: {e})\n")

    (OUT_DIR / "availability_model_tables.md").write_text("\n".join(out_md))
    M.to_json(OUT_DIR / "availability_model_metrics.json", orient="records", indent=1)

    # --- prediction file (all injury rows incl. 2021 and excluded rows; model columns NaN where no walk-forward pred)
    keep = ["season", "week", "team", "gsis_id", "full_name", "position", "pos_rank", "report_status", "practice_status",
            "practice_seq", "played", "played_any", "in_model", "match_kind", "in_snaps_this_week"]
    outp = df[keep].rename(columns={"full_name": "player_name"}).copy()
    outp = outp.merge(P[["season", "week", "gsis_id", "p_rate", "p_lgb_iso", "p_lr", "p_lgb"]], on=["season", "week", "gsis_id"], how="left")
    outp = outp.rename(columns={"p_rate": "p_play_baseline", "p_lgb_iso": "p_play_model", "p_lr": "p_play_lr", "p_lgb": "p_play_lgb_raw"})
    outp["practice_status"] = outp.practice_status.map(lambda s: PRACTICE_MAP.get(s, "Unknown"))
    cols = ["season", "week", "team", "gsis_id", "player_name", "position", "pos_rank", "report_status", "practice_status",
            "practice_seq", "p_play_baseline", "p_play_model", "played", "p_play_lr", "p_play_lgb_raw", "played_any", "in_model", "match_kind", "in_snaps_this_week"]
    outp = outp[cols].sort_values(["season", "week", "team", "player_name"])
    outp.to_csv(OUT_CSV, index=False)
    print(f"wrote {OUT_CSV} ({len(outp)} rows), tables -> {OUT_DIR}")
    print(md_table(M[(M.subgroup == "all")], "{:.4f}"))


if __name__ == "__main__":
    main()
