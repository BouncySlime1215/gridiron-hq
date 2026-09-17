#!/usr/bin/env python3
"""
PLAYER VALUE MODEL -- per-player, per-week EPA contribution, lineup-summable.

WHY THIS EXISTS (2026-09-17)
----------------------------
Every feature this repo has ever tested is a TEAM-WEEK AGGREGATE. Thirty-five of
them have an effective rank of ~2.5: they are one number ("is this team good")
wearing thirty-five hats, and a ridge stacker over them hands 35-52% of its weight
straight back to the market line. The untried axis is PERSONNEL. A team is not a
fixed entity; swap the quarterback and it is a different team.

This script builds the personnel primitive: a value per (season, week, player_id)
that is (i) knowable strictly before kickoff, (ii) opponent- and
situation-adjusted, (iii) empirical-Bayes shrunk with a FITTED shrinkage weight,
and (iv) additive over a lineup so a downstream model can sum it.

It does NOT bet anything. It is graded on one question only: does a player's value
computed from seasons 1..t-1 predict his EPA in season t better than the positional
mean, and does it do so BEYOND what his team's prior-season EPA already says?

AS-OF CUTOFF
------------
nflverse.sqlite as of its own last write (reported at runtime). play_by_play runs
2016-2026; pbp_participation (who was on the field) runs 2016-2025 and has NOT
been published for 2026. All fitting therefore uses 2016-2025 plays; 2026 weekly
rows carry values frozen at the end of 2025 and are flagged as such.

METHOD, in order
----------------
1. ATTRIBUTION. One row per pass/run play. Offensive credit goes to the passer,
   the rusher and the targeted receiver as SEPARATE regression columns (so a
   completed pass is passer_effect + receiver_effect, not a split guessed by
   hand). Defensive credit goes to all 11 defenders pbp_participation says were
   on the field, each with weight -1. What this costs is measured in
   `report_attribution_cost` and stated in the output: offensive linemen get no
   column at all, so their contribution is absorbed into the skill players who
   play behind them, and a sack with no listed receiver charges the whole
   negative EPA to the passer.

2. SITUATION + OPPONENT, JOINTLY. down/distance/field position/score
   differential/time/home/pass-or-run enter the SAME least-squares problem as
   unpenalized dense columns, so the player effects are read off net of them.
   Opponent adjustment is not a second stage: the 11 defenders are in the design
   matrix, so an offensive effect is already conditioned on who was defending.

3. SHRINKAGE. Ridge penalty per role group = sigma2_within / sigma2_between from
   a one-way random-effects ANOVA (method of moments, unbalanced groups --
   docs/betting-model/research/advanced-methods-and-github/F15-team-strength-shrinkage.md,
   which grades this estimator family as the second-best tested in Brown 2008 and
   the MLE/normal-normal class as the worst). A multiplier on that MoM value is
   then chosen out of sample on seasons 2018-2021 ONLY and locked before the
   2022-2025 report.

4. WALK-FORWARD. Every weekly value is fit on plays strictly earlier than that
   week, with exponential recency decay (half-life also chosen on 2018-2021).
   Nothing from week w or later touches the value stamped on week w.

5. PLACEBO. The whole validation is re-run with player identity permuted within
   role and play-count stratum.

Usage:
  python3 scripts/player-value-model.py extract      # cache plays -> npz
  python3 scripts/player-value-model.py tune         # pick lambda mult + half-life on 2018-2021
  python3 scripts/player-value-model.py validate     # locked OOS report 2022-2025 + placebo
  python3 scripts/player-value-model.py emit         # write weekly table
  python3 scripts/player-value-model.py all
"""
import os, sys, json, math, sqlite3, time
import numpy as np

NFLVERSE = "/Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/nflverse.sqlite"
OUT_DB   = "/Users/nick_matta/Documents/GitHub/gridiron-hq/data/derived/player_value.sqlite"
CACHE    = os.environ.get("PV_CACHE", "/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/pv_cache.npz")
TUNED    = os.path.splitext(CACHE)[0] + "_tuned.json"

ROLES = ["pass", "rush", "rec", "def"]
POSMAP = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE",
          "T": "OL", "OT": "OL", "G": "OL", "OG": "OL", "C": "OL", "OL": "OL",
          "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL",
          "LB": "LB", "OLB": "LB", "ILB": "LB", "MLB": "LB",
          "CB": "DB", "S": "DB", "SAF": "DB", "FS": "DB", "SS": "DB", "DB": "DB",
          "K": "SPEC", "P": "SPEC", "LS": "SPEC"}
POSGROUPS = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "SPEC", "UNK"]
R_PASS, R_RUSH, R_REC, R_DEF = 0, 1, 2, 3

# tuning is done on these seasons and NOWHERE ELSE; the report is the rest
TUNE_SEASONS   = [2018, 2019, 2020, 2021]
REPORT_SEASONS = [2022, 2023, 2024, 2025]

# Chosen on TUNE_SEASONS only (see scripts output of `tune`), then frozen before
# any 2022-2025 number was computed. Per-role because the roles disagree sharply:
# passers and rushers want LESS shrinkage than the method-of-moments value,
# receivers and defenders want much more.
LOCKED_HALFLIFE = 26
LOCKED_MULT = {R_PASS: 0.5, R_RUSH: 0.5, R_REC: 64.0, R_DEF: 64.0}
LOCKED_MULT_GLOBAL_ALT = 16.0    # the single-multiplier alternative, reported as a sensitivity


DENSE_RIDGE = 1e-3


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


# ---------------------------------------------------------------- extract ----
def extract():
    t0 = time.time()
    con = ro(NFLVERSE)
    con.text_factory = str
    print(f"[extract] nflverse.sqlite mtime = {time.ctime(os.path.getmtime(NFLVERSE))}")

    q = """
    select p.season, p.week, p.season_type, p.game_id, p.play_id, p.game_date,
           p.posteam, p.defteam, p.home_team, p.epa, p.play_type,
           p.down, p.ydstogo, p.yardline_100, p.goal_to_go, p.shotgun, p.no_huddle,
           p.qtr, p.score_differential, p.game_seconds_remaining, p.half_seconds_remaining,
           p.sack, p.qb_scramble,
           p.passer_player_id, p.rusher_player_id, p.receiver_player_id,
           q.defense_players
      from play_by_play p
      left join pbp_participation q
        on p.game_id = q.nflverse_game_id and p.play_id = q.play_id
     where p.play_type in ('pass','run')
       and p.epa is not null
       and p.season between 2016 and 2025
     order by p.season, p.week, p.game_date, p.game_id, p.play_id
    """
    rows = con.execute(q).fetchall()
    print(f"[extract] {len(rows):,} pass/run plays 2016-2025 in {time.time()-t0:.1f}s")

    # player positions
    pos = {}
    for gsis, position, pgroup in con.execute(
            "select gsis_id, position, position_group from players where gsis_id is not null"):
        pos[gsis] = (position or "UNK", pgroup or "UNK")
    con.close()

    n = len(rows)
    season = np.empty(n, np.int16); week = np.empty(n, np.int16)
    epa = np.empty(n, np.float64)
    is_pass = np.zeros(n, np.int8); down = np.zeros(n, np.int8)
    ydstogo = np.zeros(n, np.float64); yl100 = np.zeros(n, np.float64)
    g2g = np.zeros(n, np.int8); shot = np.zeros(n, np.int8); nohud = np.zeros(n, np.int8)
    qtr = np.zeros(n, np.int8); sdiff = np.zeros(n, np.float64)
    gsec = np.zeros(n, np.float64); hsec = np.zeros(n, np.float64)
    home_off = np.zeros(n, np.int8); sack = np.zeros(n, np.int8)
    game_idx = np.zeros(n, np.int32)
    off_team = np.zeros(n, np.int16); def_team = np.zeros(n, np.int16)
    teams = {}
    no_part = np.zeros(n, np.int8)

    col_of = {}          # (role, player_id) -> column
    col_role = []        # column -> role
    col_pid  = []        # column -> player id
    rows_i, cols_i, vals_i = [], [], []
    game_ids = {}

    def colid(role, pid):
        k = (role, pid)
        c = col_of.get(k)
        if c is None:
            c = len(col_role)
            col_of[k] = c
            col_role.append(role)
            col_pid.append(pid)
        return c

    n_no_recv = 0
    for i, r in enumerate(rows):
        (se, wk, stype, gid, pid_, gdate, posteam, defteam, home, e, ptype,
         dn, ytg, yl, gg, sg, nh, qt, sd, gs, hs, sk, scr,
         passer, rusher, receiver, defstr) = r
        season[i] = se; week[i] = wk
        epa[i] = e
        is_pass[i] = 1 if ptype == 'pass' else 0
        down[i] = dn if dn is not None else 1
        ydstogo[i] = ytg if ytg is not None else 10
        yl100[i] = yl if yl is not None else 50
        g2g[i] = gg or 0; shot[i] = sg or 0; nohud[i] = nh or 0
        qtr[i] = qt if qt is not None else 1
        sdiff[i] = sd if sd is not None else 0
        gsec[i] = gs if gs is not None else 1800
        hsec[i] = hs if hs is not None else 900
        home_off[i] = 1 if posteam == home else 0
        sack[i] = sk or 0
        for tname, arr in ((posteam, off_team), (defteam, def_team)):
            ti = teams.get(tname)
            if ti is None:
                ti = len(teams); teams[tname] = ti
            arr[i] = ti
        gi = game_ids.get(gid)
        if gi is None:
            gi = len(game_ids); game_ids[gid] = gi
        game_idx[i] = gi

        if passer:
            rows_i.append(i); cols_i.append(colid(R_PASS, passer)); vals_i.append(1.0)
        if rusher:
            rows_i.append(i); cols_i.append(colid(R_RUSH, rusher)); vals_i.append(1.0)
        if receiver:
            rows_i.append(i); cols_i.append(colid(R_REC, receiver)); vals_i.append(1.0)
        elif ptype == 'pass':
            n_no_recv += 1
        if defstr:
            for d in defstr.split(';'):
                if d:
                    rows_i.append(i); cols_i.append(colid(R_DEF, d)); vals_i.append(-1.0)
        else:
            no_part[i] = 1

    print(f"[extract] {len(col_role):,} player-role columns; "
          f"{n_no_recv:,} pass plays with no listed receiver ({100*n_no_recv/max(1,is_pass.sum()):.1f}% of passes); "
          f"{int(no_part.sum()):,} plays with no participation row")

    positions = np.array([pos.get(p, ("UNK", "UNK"))[0] for p in col_pid])
    np.savez_compressed(
        CACHE,
        season=season, week=week, epa=epa, is_pass=is_pass, down=down,
        ydstogo=ydstogo, yl100=yl100, g2g=g2g, shot=shot, nohud=nohud, qtr=qtr,
        sdiff=sdiff, gsec=gsec, hsec=hsec, home_off=home_off, sack=sack,
        game_idx=game_idx, no_part=no_part,
        off_team=off_team, def_team=def_team,
        team_names=np.array([t if t else '' for t,_ in sorted(teams.items(), key=lambda kv: kv[1])]),
        rows_i=np.array(rows_i, np.int32), cols_i=np.array(cols_i, np.int32),
        vals_i=np.array(vals_i, np.float32),
        col_role=np.array(col_role, np.int8),
        col_pid=np.array(col_pid), col_pos=positions,
    )
    print(f"[extract] cached -> {CACHE}  ({time.time()-t0:.1f}s total)")


# ----------------------------------------------------------------- design ----
class Data:
    def __init__(self):
        z = np.load(CACHE, allow_pickle=True)
        for k in z.files:
            setattr(self, k, z[k])
        self.n = len(self.epa)
        self.p = len(self.col_role)
        # chronological index: plays were pulled ordered, so (season,week) is a prefix key
        self.sw = self.season.astype(np.int32) * 100 + self.week.astype(np.int32)
        self.uniq_sw = np.unique(self.sw)
        # start offset of each (season,week) block
        self.sw_start = {int(v): int(np.searchsorted(self.sw, v, 'left')) for v in self.uniq_sw}
        self.sw_end = {int(v): int(np.searchsorted(self.sw, v, 'right')) for v in self.uniq_sw}
        self.col_grp = np.array([ROLES.index(ROLES[r]) * len(POSGROUPS) +
                                 POSGROUPS.index(POSMAP.get(str(self.col_pos[i]), "UNK"))
                                 for i, r in enumerate(self.col_role)], np.int64)
        self.n_grp = 4 * len(POSGROUPS)
        self.Z, self.znames = self._situation()
        # nnz entry -> play row (already sorted by row because built in row order)
        self.ri, self.ci, self.vi = self.rows_i, self.cols_i, self.vals_i.astype(np.float64)

    def _situation(self):
        n = self.n
        cols, names = [], []
        def add(v, nm):
            cols.append(np.asarray(v, np.float64)); names.append(nm)
        add(np.ones(n), "intercept")
        ip = self.is_pass.astype(np.float64)
        add(ip, "is_pass")
        for d in (2, 3, 4):
            add((self.down == d).astype(float), f"down{d}")
            add(((self.down == d) * ip), f"down{d}_x_pass")
        add(np.log1p(np.clip(self.ydstogo, 0, 40)), "log_ydstogo")
        add(np.log1p(np.clip(self.ydstogo, 0, 40)) * ip, "log_ydstogo_x_pass")
        add(self.g2g.astype(float), "goal_to_go")
        yl = self.yl100 / 100.0
        add(yl, "yardline"); add(yl * yl, "yardline2"); add(yl * ip, "yardline_x_pass")
        add(self.shot.astype(float), "shotgun")
        add(self.nohud.astype(float), "no_huddle")
        sd = np.clip(self.sdiff, -28, 28) / 14.0
        add(sd, "score_diff"); add(sd * sd, "score_diff2")
        tf = self.gsec / 3600.0
        add(tf, "time_frac"); add(sd * (1.0 - tf), "score_diff_x_elapsed")   # game script
        add(self.hsec / 1800.0, "half_time_frac")
        for q in (2, 3, 4, 5):
            add((self.qtr == q).astype(float), f"qtr{q}")
        add(self.home_off.astype(float), "home_offense")
        seasons = np.unique(self.season)
        for s in seasons[1:]:
            add((self.season == s).astype(float), f"season_{int(s)}")
        Zs = np.vstack(cols).T.copy()
        # ---- role x position-group columns, UNPENALISED.
        # Their presence is what makes the ridge shrink each player toward HIS
        # POSITION's mean rather than toward zero: a 12-carry quarterback is
        # pulled toward the quarterback-rushing mean, not toward the running-back
        # mean that the role pool is dominated by. For the defence they double as
        # a personnel-group control (nickel vs base).
        flat = np.bincount(self.rows_i.astype(np.int64) * self.n_grp + self.col_grp[self.cols_i],
                           weights=self.vals_i.astype(np.float64),
                           minlength=n * self.n_grp)
        G = flat.reshape(n, self.n_grp)
        keep = np.abs(G).sum(0) > 0
        G = G[:, keep]
        names = names + [f"grp_{ROLES[i // len(POSGROUPS)]}_{POSGROUPS[i % len(POSGROUPS)]}"
                         for i in np.where(keep)[0]]
        Z = np.hstack([Zs, G])
        # The group columns are exactly collinear with the intercept (the defensive
        # groups sum to -11 on every participation play), which leaves the dense
        # block rank-deficient and makes conjugate gradient crawl. Rotate the dense
        # block into an orthonormal basis and drop the null directions: identical
        # column space, identical fit, well-conditioned normal equations.
        C = (Z.T @ Z) / n
        ev, V = np.linalg.eigh(C)
        keepd = ev > 1e-8 * ev.max()
        U = V[:, keepd] / np.sqrt(ev[keepd])
        self._Zraw_names = names
        return (Z @ U), [f"dense{i}" for i in range(int(keepd.sum()))]


# ------------------------------------------------------------- CG solver -----
def solve(D, lo, hi, lam_by_role, halflife_weeks, cut_sw, warm=None, tol=1e-6, maxit=300):
    """Weighted ridge on plays [lo:hi). Dense situation block unpenalized,
    player-role columns penalized by lam_by_role. Returns (g, b, resid_var, w_sum_per_col)."""
    y = D.epa[lo:hi]
    Z = D.Z[lo:hi]
    n, m, p = hi - lo, Z.shape[1], D.p

    # exponential recency decay measured in weeks before the cutoff week
    if halflife_weeks is None or halflife_weeks <= 0:
        w = np.ones(n)
    else:
        sw = D.sw[lo:hi]
        # convert season*100+week to a monotone week counter
        wk_ct = (sw // 100 - 2016) * 22 + (sw % 100)
        cut_ct = (cut_sw // 100 - 2016) * 22 + (cut_sw % 100)
        w = np.power(0.5, (cut_ct - wk_ct) / float(halflife_weeks))

    # slice of the sparse block
    e0 = int(np.searchsorted(D.ri, lo, 'left')); e1 = int(np.searchsorted(D.ri, hi, 'left'))
    ri = D.ri[e0:e1] - lo; ci = D.ci[e0:e1]; vi = D.vi[e0:e1]
    lam = np.array([lam_by_role[r] for r in D.col_role], np.float64)

    wy = w * y
    rhs_g = Z.T @ wy
    rhs_b = np.bincount(ci, weights=vi * wy[ri], minlength=p)
    rhs = np.concatenate([rhs_g, rhs_b])

    # Jacobi preconditioner
    dg = (Z * Z * w[:, None]).sum(0) + DENSE_RIDGE
    db = np.bincount(ci, weights=vi * vi * w[ri], minlength=p) + lam
    dinv = 1.0 / np.concatenate([np.maximum(dg, 1e-9), np.maximum(db, 1e-9)])

    def A(x):
        g, b = x[:m], x[m:]
        pred = Z @ g + np.bincount(ri, weights=vi * b[ci], minlength=n)
        wp = w * pred
        return np.concatenate([Z.T @ wp + DENSE_RIDGE * g,
                               np.bincount(ci, weights=vi * wp[ri], minlength=p) + lam * b])

    x = np.zeros(m + p) if warm is None else warm.copy()
    r = rhs - A(x)
    z = dinv * r; pdir = z.copy()
    rz = r @ z
    nrhs = max(np.linalg.norm(rhs), 1e-12)
    it = 0
    for it in range(maxit):
        Ap = A(pdir)
        alpha = rz / max(pdir @ Ap, 1e-30)
        x += alpha * pdir
        r -= alpha * Ap
        if np.linalg.norm(r) / nrhs < tol:
            break
        z = dinv * r
        rz_new = r @ z
        pdir = z + (rz_new / rz) * pdir
        rz = rz_new
    g, b = x[:m], x[m:]
    pred = Z @ g + np.bincount(ri, weights=vi * b[ci], minlength=n)
    resid = y - pred
    dof = max(n - m, 1)
    rvar = float((w * resid * resid).sum() / (w.sum() * dof / n))
    neff = np.bincount(ci, weights=vi * vi * w[ri], minlength=p)
    return g, b, rvar, neff, x, it + 1


# --------------------------------------------- empirical-Bayes MoM lambda ----
def mom_lambda(D, lo, hi, g_sit):
    """One-way random-effects ANOVA, method of moments, unbalanced groups
    (Searle 1992 ch.3), on situation-residual EPA grouped by player within role.
    lambda = sigma2_within / sigma2_between, which is exactly the ridge penalty
    that reproduces the normal-normal posterior mean n/(n+lambda)."""
    y = D.epa[lo:hi]
    resid = y - D.Z[lo:hi] @ g_sit
    e0 = int(np.searchsorted(D.ri, lo, 'left')); e1 = int(np.searchsorted(D.ri, hi, 'left'))
    ri = D.ri[e0:e1] - lo; ci = D.ci[e0:e1]
    out = {}
    for role in range(4):
        sel = D.col_role[ci] == role
        cc = ci[sel]; rr = ri[sel]
        if len(cc) == 0:
            out[role] = 1e6; continue
        uc, inv = np.unique(cc, return_inverse=True)
        v = resid[rr]
        ni = np.bincount(inv).astype(float)
        si = np.bincount(inv, weights=v)
        keep = ni >= 2
        if keep.sum() < 4:      # Stein needs N>=4 units
            out[role] = 1e6; continue
        mi = si / ni
        grand = si.sum() / ni.sum()
        ss_tot = float((v * v).sum()) - (si.sum() ** 2) / ni.sum()
        ss_between = float((ni * (mi - grand) ** 2).sum())
        ss_within = ss_tot - ss_between
        k = len(ni)
        N = ni.sum()
        msw = ss_within / max(N - k, 1)
        msb = ss_between / max(k - 1, 1)
        n0 = (N - (ni * ni).sum() / N) / max(k - 1, 1)     # unbalanced correction
        s2_between = max((msb - msw) / max(n0, 1e-9), 1e-9)
        out[role] = float(msw / s2_between)
    return out


# -------------------------------------------------------------- validation ---
MIN_PLAYS = {R_PASS: 150, R_RUSH: 50, R_REC: 30, R_DEF: 200}
SIGN = {R_PASS: 1.0, R_RUSH: 1.0, R_REC: 1.0, R_DEF: -1.0}


def _role_aggregates(D, lo, hi, resid):
    """per (role,player) count and mean situation-residual EPA over plays [lo:hi)."""
    e0 = int(np.searchsorted(D.ri, lo, 'left')); e1 = int(np.searchsorted(D.ri, hi, 'left'))
    ri = D.ri[e0:e1] - lo; ci = D.ci[e0:e1]
    cnt = np.bincount(ci, minlength=D.p).astype(float)
    ssum = np.bincount(ci, weights=resid[ri], minlength=D.p)
    with np.errstate(invalid='ignore', divide='ignore'):
        mean = np.where(cnt > 0, ssum / np.maximum(cnt, 1), np.nan)
    sgn = np.array([SIGN[r] for r in D.col_role])
    return cnt, mean * sgn


def _player_team(D, lo, hi):
    """modal team for each player-role column over plays [lo:hi) (offense team for
    offensive roles, defensive team for defenders)."""
    e0 = int(np.searchsorted(D.ri, lo, 'left')); e1 = int(np.searchsorted(D.ri, hi, 'left'))
    ri = D.ri[e0:e1] - lo; ci = D.ci[e0:e1]
    isdef = D.col_role[ci] == R_DEF
    tm = np.where(isdef, D.def_team[lo:hi][ri], D.off_team[lo:hi][ri]).astype(np.int64)
    nt = int(D.off_team.max()) + 1
    flat = np.bincount(ci.astype(np.int64) * nt + tm, minlength=D.p * nt)
    tab = flat.reshape(D.p, nt)
    return tab.argmax(1), tab.max(1)


def _team_prior(D, lo, hi, resid):
    nt = int(D.off_team.max()) + 1
    ot = D.off_team[lo:hi].astype(np.int64); dt = D.def_team[lo:hi].astype(np.int64)
    on = np.bincount(ot, minlength=nt).astype(float); os_ = np.bincount(ot, weights=resid, minlength=nt)
    dn = np.bincount(dt, minlength=nt).astype(float); ds = np.bincount(dt, weights=resid, minlength=nt)
    return (np.where(on > 0, os_ / np.maximum(on, 1), 0.0),
            -np.where(dn > 0, ds / np.maximum(dn, 1), 0.0))


def wcorr(x, y, w):
    w = w / w.sum()
    mx, my = (w * x).sum(), (w * y).sum()
    cx, cy = x - mx, y - my
    vx, vy = (w * cx * cx).sum(), (w * cy * cy).sum()
    if vx <= 0 or vy <= 0:
        return 0.0
    return float((w * cx * cy).sum() / math.sqrt(vx * vy))


def wols(X, y, w):
    """weighted least squares, returns coefficients and weighted R^2."""
    W = w / w.sum()
    A = X * W[:, None]
    beta = np.linalg.solve(X.T @ A + 1e-10 * np.eye(X.shape[1]), X.T @ (W * y))
    pred = X @ beta
    sse = float((W * (y - pred) ** 2).sum())
    sst = float((W * (y - (W * y).sum()) ** 2).sum())
    return beta, 1.0 - sse / max(sst, 1e-12)


_CTX = {}


def season_context(D, t, halflife):
    """Everything about season t that does NOT depend on the shrinkage knob.
    The outcome and all baselines are built from the SITUATION-ONLY fit on prior
    seasons, so changing lambda cannot move the target or the baselines."""
    k = (t, halflife)
    if k in _CTX:
        return _CTX[k]
    cut = t * 100 + 1
    hi = D.sw_start[cut]
    g0, lam0 = _sit(D, hi, halflife, cut)
    resid_prior = D.epa[:hi] - D.Z[:hi] @ g0
    cnt_p, mean_p = _role_aggregates(D, 0, hi, resid_prior)
    off_tp, def_tp = _team_prior(D, 0, hi, resid_prior)
    team_prior_modal, _ = _player_team(D, 0, hi)
    lo_t = D.sw_start[cut]
    hi_t = D.sw_end[max(v for v in D.sw_start if v // 100 == t)]
    resid_t = D.epa[lo_t:hi_t] - D.Z[lo_t:hi_t] @ g0
    cnt_t, mean_t = _role_aggregates(D, lo_t, hi_t, resid_t)
    team_t, _ = _player_team(D, lo_t, hi_t)
    ctx = dict(cut=cut, hi=hi, g0=g0, lam0=lam0, cnt_p=cnt_p, mean_p=mean_p,
               off_tp=off_tp, def_tp=def_tp, team_prior_modal=team_prior_modal,
               cnt_t=cnt_t, mean_t=mean_t, team_t=team_t, t=t, halflife=halflife)
    _CTX[k] = ctx
    return ctx


_WARM = {}


def season_eval(D, t, lam_mult, halflife, placebo_rng=None):
    """Fit on everything strictly before season t week 1; evaluate on season t."""
    ctx = season_context(D, t, halflife)
    mm = lam_mult if isinstance(lam_mult, dict) else {r: lam_mult for r in range(4)}
    lam = {r: ctx['lam0'][r] * mm[r] for r in range(4)}
    warm = _WARM.get((t, halflife))
    gg, bb, rvar, neff, x, _ = solve(D, 0, ctx['hi'], lam, halflife, ctx['cut'], warm=warm)
    _WARM[(t, halflife)] = x

    if placebo_rng is not None:
        bb = bb.copy()
        for r in range(4):
            idx = np.where(D.col_role == r)[0]
            order = idx[np.argsort(neff[idx])]
            for chunk in np.array_split(order, 10):          # stratify on play count
                bb[chunk] = bb[chunk][placebo_rng.permutation(len(chunk))]

    cnt_t, mean_t, cnt_p, mean_p = ctx['cnt_t'], ctx['mean_t'], ctx['cnt_p'], ctx['mean_p']
    out = {}
    for r in range(4):
        sel = np.where((D.col_role == r) & (cnt_t >= MIN_PLAYS[r]) & (cnt_p >= 1))[0]
        if len(sel) < 10:
            continue
        tprior = (ctx['off_tp'] if r != R_DEF else ctx['def_tp'])[ctx['team_t'][sel]]
        out[r] = dict(
            n_players=int(len(sel)), value=bb[sel], raw_prior=mean_p[sel],
            team_prior=tprior, y=mean_t[sel], w=cnt_t[sel], n_prior=cnt_p[sel],
            season=t, cols=sel,
            moved=(ctx['team_t'][sel] != ctx['team_prior_modal'][sel]).astype(float),
        )
    return out, lam, rvar, neff, bb, gg


_SITCACHE = {}


def _sit(D, hi, halflife, cut):
    k = (hi, halflife, cut)
    if k not in _SITCACHE:
        g0, _, _, _, _, _ = solve(D, 0, hi, {r: 1e9 for r in range(4)}, halflife, cut)
        _SITCACHE[k] = (g0, mom_lambda(D, 0, hi, g0))
    return _SITCACHE[k]


def tune():
    """Choose lambda multiplier and recency half-life on 2018-2021 ONLY.
    Selection criterion, fixed before any number was seen: the unweighted mean of
    the four role-level play-weighted correlations between value and next-season
    situation-residual EPA."""
    D = Data()
    grid_mult = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0]
    grid_hl = [None, 104, 52, 26, 13, 8, 5]
    results = []
    print(f"[tune] start {time.strftime('%H:%M:%S')}", flush=True)
    for hl in grid_hl:
        for mult in grid_mult:
            rs = {r: [] for r in range(4)}
            for t in TUNE_SEASONS:
                ev, _, _, _, _, _ = season_eval(D, t, mult, hl)
                for r, d in ev.items():
                    rs[r].append((wcorr(d['value'], d['y'], d['w']), d['w'].sum()))
            per_role = {}
            for r in range(4):
                if rs[r]:
                    num = sum(a * b for a, b in rs[r]); den = sum(b for _, b in rs[r])
                    per_role[r] = num / den
            score = float(np.mean([per_role[r] for r in sorted(per_role)]))
            results.append(dict(halflife=hl, mult=mult, score=score,
                                per_role={ROLES[r]: round(per_role[r], 4) for r in per_role}))
            print(f"  [{time.strftime('%H:%M:%S')}] hl={str(hl):>4} mult={mult:>4} "
                  f"score={score:.4f}  {results[-1]['per_role']}", flush=True)
    best = max(results, key=lambda d: d['score'])
    per_role_best = {}
    for hl in grid_hl:
        rows = [g for g in results if g['halflife'] == hl]
        if rows:
            per_role_best[str(hl)] = {rn: max(rows, key=lambda g: g['per_role'].get(rn, -9))['mult']
                                      for rn in ROLES}
    print("\n[tune] BEST single multiplier (locked):", best)
    print("[tune] BEST per-role multipliers by half-life:", per_role_best)
    json.dump(dict(best=best, per_role_best=per_role_best, grid=results), open(TUNED, 'w'), indent=1)
    return best


def _cluster_t(X, y, w, groups, j):
    """weighted OLS coefficient j with cluster-robust SE (clustered on `groups`)."""
    W = w / w.sum()
    A = X * W[:, None]
    XtX = X.T @ A + 1e-12 * np.eye(X.shape[1])
    Xi = np.linalg.inv(XtX)
    beta = Xi @ (X.T @ (W * y))
    u = (y - X @ beta) * W
    meat = np.zeros_like(XtX)
    for gmask in np.unique(groups):
        idx = np.where(groups == gmask)[0]
        s = (X[idx] * u[idx, None]).sum(0)
        meat += np.outer(s, s)
    V = Xi @ meat @ Xi
    se = math.sqrt(max(V[j, j], 1e-30))
    return float(beta[j]), float(beta[j] / se)


def _wmean_by(key, y, w, keys_all):
    """weighted mean of y within each key, returned aligned to keys_all."""
    out = {}
    for k in np.unique(key):
        m = key == k
        out[k] = float((w[m] * y[m]).sum() / max(w[m].sum(), 1e-9))
    g = float((w * y).sum() / w.sum())
    return np.array([out.get(k, g) for k in keys_all]), out, g


def validate():
    """The locked out-of-sample report. Hyper-parameters come from TUNE_SEASONS and
    are not touched here. Every baseline is the POSITIONAL mean, per the brief."""
    tuned = json.load(open(TUNED))
    hl = LOCKED_HALFLIFE
    mult = LOCKED_MULT
    D = Data()
    npg = len(POSGROUPS)
    print(f"\n[validate] LOCKED from {TUNE_SEASONS}: lambda_mult={mult} halflife={hl}", flush=True)

    def pool(seasons, placebo=False, rng=None):
        acc = {r: [] for r in range(4)}
        for t in seasons:
            ev, lam, rvar, neff, bb, gg = season_eval(D, t, mult, hl,
                                                      placebo_rng=rng if placebo else None)
            for r, d in ev.items():
                acc[r].append(d)
            if not placebo:
                print(f"  fit<{t}: n_train={D.sw_start[t*100+1]:,} "
                      f"lambda={ {ROLES[k]: round(v,1) for k,v in lam.items()} } "
                      f"resid_var={rvar:.4f}", flush=True)
        return acc

    tune_pool = pool(TUNE_SEASONS)
    rep_pool = pool(REPORT_SEASONS)
    rng = np.random.default_rng(20260917)
    plac_pool = pool(REPORT_SEASONS, placebo=True, rng=rng)

    lines = []
    for r in range(4):
        if not rep_pool[r]:
            continue
        cat = lambda k, src: np.concatenate([d[k] for d in src[r]])
        # ---- training-season pool: calibration maps + positional means, LOCKED
        vT, yT, wT = cat('value', tune_pool), cat('y', tune_pool), cat('w', tune_pool)
        rpT, tpT = cat('raw_prior', tune_pool), cat('team_prior', tune_pool)
        posT = D.col_grp[cat('cols', tune_pool)] % npg
        _, posmap, grand = _wmean_by(posT, yT, wT, posT)
        cal = lambda x: wols(np.column_stack([np.ones_like(x), x]), yT, wT)[0]
        c_val, c_raw, c_team = cal(vT), cal(rpT), cal(tpT)

        # ---- report pool
        v, y, w = cat('value', rep_pool), cat('y', rep_pool), cat('w', rep_pool)
        rp, tp = cat('raw_prior', rep_pool), cat('team_prior', rep_pool)
        cols = cat('cols', rep_pool); pos = D.col_grp[cols] % npg
        moved = cat('moved', rep_pool)
        vp = cat('value', plac_pool)
        posmean = np.array([posmap.get(k, grand) for k in pos])

        mse = lambda pred: float((w * (y - pred) ** 2).sum() / w.sum())
        m_pos = mse(posmean)
        m_val = mse(c_val[0] + c_val[1] * v)
        m_raw = mse(c_raw[0] + c_raw[1] * rp)
        m_team = mse(c_team[0] + c_team[1] * tp)

        # within-position (partial) correlations: remove the positional mean from both sides
        dem = lambda x: x - _wmean_by(pos, x, w, pos)[0]
        yd, vd, rpd, tpd, vpd = dem(y), dem(v), dem(rp), dem(tp), dem(vp)
        rr = lambda a: wcorr(a, yd, w)

        # does the player value survive the team aggregate?
        z = lambda a: (a - (w * a).sum() / w.sum()) / max(
            math.sqrt((w * (a - (w * a).sum() / w.sum()) ** 2).sum() / w.sum()), 1e-9)
        X2 = np.column_stack([np.ones_like(yd), z(tpd)])
        X3 = np.column_stack([np.ones_like(yd), z(tpd), z(vd)])
        _, r2_team = wols(X2, yd, w)
        _, r2_both = wols(X3, yd, w)
        coef, tstat = _cluster_t(X3, yd, w, cols, 2)

        # movers only: a player who changed team between the fit window and season t
        mv = moved > 0
        r_mov = wcorr(vd[mv], yd[mv], w[mv]) if mv.sum() >= 30 else None
        r_stay = wcorr(vd[~mv], yd[~mv], w[~mv]) if (~mv).sum() >= 30 else None

        # train/test gap: the same correlation measured IN SAMPLE on the fit window
        n_prior = cat('n_prior', rep_pool)
        rp_in = dem(rp)
        r_in = wcorr(dem(v), rp_in, w)

        lines.append(dict(
            role=ROLES[r], n_player_seasons=int(len(y)),
            r_value_within_position=round(rr(vd), 4),
            r_raw_unshrunk_within_position=round(rr(rpd), 4),
            r_team_prior_within_position=round(rr(tpd), 4),
            r_placebo_within_position=round(rr(vpd), 4),
            r_movers=None if r_mov is None else round(r_mov, 4),
            n_movers=int(mv.sum()),
            r_stayers=None if r_stay is None else round(r_stay, 4),
            mse_vs_positional_mean_pct=round(100 * (1 - m_val / m_pos), 2),
            mse_raw_unshrunk_pct=round(100 * (1 - m_raw / m_pos), 2),
            mse_team_prior_pct=round(100 * (1 - m_team / m_pos), 2),
            r2_team_only=round(r2_team, 4), r2_team_plus_player=round(r2_both, 4),
            incremental_r2_of_player=round(r2_both - r2_team, 4),
            t_player_given_team_clustered=round(tstat, 2),
            in_sample_r_train_window=round(r_in, 4),
        ))
        print(json.dumps(lines[-1]), flush=True)
    json.dump(dict(locked=dict(halflife=hl, mult={ROLES[k]: v for k, v in mult.items()}),
                   results=lines),
              open(os.path.splitext(CACHE)[0] + "_validation.json", 'w'), indent=1)
    return lines


# ------------------------------------------------ SE calibration + costs -----
def calibrate_se(D, hi, lam, halflife, cut, n_rep=2, seed=7):
    """The analytic sampling SD of a ridge coefficient for an isolated column is
    se_i = sigma*sqrt(n_i)/(n_i+lambda). It ignores the correlation between a
    player's column and his team-mates', so it is not to be trusted as written.
    Measure the error: split GAMES at random into halves, fit both, and compare the
    realised spread of (b_A-b_B)/sqrt(2) with what the formula predicts. The
    returned per-role factor multiplies the formula in `emit`; it is fitted, not
    assumed, and a value far from 1.0 is itself the finding."""
    rng = np.random.default_rng(seed)
    gidx = D.game_idx[:hi]
    ngames = int(gidx.max()) + 1
    ratios = {r: [] for r in range(4)}
    for rep in range(n_rep):
        side = rng.integers(0, 2, ngames)
        halves = []
        for h in (0, 1):
            rows = np.where(side[gidx] == h)[0]
            halves.append(_fit_subset(D, rows, lam, halflife, cut))
        (bA, nA, vA), (bB, nB, vB) = halves
        d = (bA - bB) / math.sqrt(2.0)
        for r in range(4):
            sel = np.where((D.col_role == r) & (nA > 10) & (nB > 10))[0]
            if len(sel) < 30:
                continue
            f = 0.5 * (np.sqrt(vA * nA[sel]) / (nA[sel] + lam[r]) +
                       np.sqrt(vB * nB[sel]) / (nB[sel] + lam[r]))
            ratios[r].append(float(np.std(d[sel] / f)))
    return {r: (float(np.mean(v)) if v else 1.0) for r, v in ratios.items()}


def _fit_subset(D, rows, lam_by_role, halflife, cut):
    """ridge fit on an arbitrary subset of play rows (used only for SE calibration)."""
    y = D.epa[rows]; Z = D.Z[rows]
    n, m, p = len(rows), Z.shape[1], D.p
    sw = D.sw[rows]
    if halflife:
        wk = (sw // 100 - 2016) * 22 + (sw % 100)
        ck = (cut // 100 - 2016) * 22 + (cut % 100)
        w = np.power(0.5, (ck - wk) / float(halflife))
    else:
        w = np.ones(n)
    newpos = -np.ones(D.n, np.int64); newpos[rows] = np.arange(n)
    keep = newpos[D.ri] >= 0
    ri = newpos[D.ri[keep]]; ci = D.ci[keep]; vi = D.vi[keep]
    lam = np.array([lam_by_role[r] for r in D.col_role], np.float64)
    wy = w * y
    rhs = np.concatenate([Z.T @ wy, np.bincount(ci, weights=vi * wy[ri], minlength=p)])
    dg = (Z * Z * w[:, None]).sum(0) + DENSE_RIDGE
    db = np.bincount(ci, weights=vi * vi * w[ri], minlength=p) + lam
    dinv = 1.0 / np.concatenate([np.maximum(dg, 1e-9), np.maximum(db, 1e-9)])

    def A(x):
        g, b = x[:m], x[m:]
        pred = Z @ g + np.bincount(ri, weights=vi * b[ci], minlength=n)
        wp = w * pred
        return np.concatenate([Z.T @ wp + DENSE_RIDGE * g,
                               np.bincount(ci, weights=vi * wp[ri], minlength=p) + lam * b])
    x = np.zeros(m + p); r_ = rhs - A(x); z = dinv * r_; pd = z.copy(); rz = r_ @ z
    nr = max(np.linalg.norm(rhs), 1e-12)
    for _ in range(300):
        Ap = A(pd); al = rz / max(pd @ Ap, 1e-30)
        x += al * pd; r_ -= al * Ap
        if np.linalg.norm(r_) / nr < 1e-6:
            break
        z = dinv * r_; rz2 = r_ @ z; pd = z + (rz2 / rz) * pd; rz = rz2
    g, b = x[:m], x[m:]
    pred = Z @ g + np.bincount(ri, weights=vi * b[ci], minlength=n)
    resid = y - pred
    rvar = float((w * resid * resid).sum() / w.sum())
    neff = np.bincount(ci, weights=vi * vi * w[ri], minlength=p)
    return b, neff, rvar


def attribution_cost(D, hi, lam, halflife, cut):
    """What the attribution assumption costs, in numbers rather than adjectives."""
    g0, _ = _sit(D, hi, halflife, cut)
    gg, bb, rvar, neff, _, _ = solve(D, 0, hi, lam, halflife, cut)
    y = D.epa[:hi]
    r_sit = y - D.Z[:hi] @ g0
    e1 = int(np.searchsorted(D.ri, hi, 'left'))
    ri, ci, vi = D.ri[:e1], D.ci[:e1], D.vi[:e1]
    pred_player = np.bincount(ri, weights=vi * bb[ci], minlength=hi)
    r_full = y - (D.Z[:hi] @ gg + pred_player)
    var0 = float(((y - y.mean()) ** 2).mean())
    out = dict(
        play_var_total=round(var0, 4),
        r2_situation_only=round(1 - float((r_sit ** 2).mean()) / var0, 4),
        r2_situation_plus_players=round(1 - float((r_full ** 2).mean()) / var0, 4),
    )
    # how much team-season offence does the credited-player sum reproduce?
    nt = int(D.off_team.max()) + 1
    key = D.off_team[:hi].astype(np.int64) * 100 + (D.season[:hi] - 2016)
    uk, inv = np.unique(key, return_inverse=True)
    n_k = np.bincount(inv).astype(float)
    act = np.bincount(inv, weights=r_sit) / n_k
    prd = np.bincount(inv, weights=pred_player) / n_k
    keep = n_k >= 300
    c = np.corrcoef(act[keep], prd[keep])[0, 1]
    out['team_season_offence_r_actual_vs_playersum'] = round(float(c), 4)
    out['team_season_offence_r2'] = round(float(c * c), 4)
    out['unexplained_by_credited_players_pct'] = round(100 * (1 - c * c), 1)
    npass = int(D.is_pass[:hi].sum())
    # a pass with no listed receiver charges 100% of the play to the passer
    has_rec = np.zeros(hi, bool)
    has_rec[ri[D.col_role[ci] == R_REC]] = True
    out['pass_plays_no_receiver_pct'] = round(100 * float((D.is_pass[:hi].astype(bool) & ~has_rec).sum()) / npass, 2)
    return out


# ------------------------------------------------------------------ emit -----
def emit():
    hl, mult = LOCKED_HALFLIFE, LOCKED_MULT
    D = Data()
    cuts = sorted(int(v) for v in D.uniq_sw if v // 100 >= 2018)
    # 2026: pbp_participation is not published, so the window simply ends at 2025
    frozen_2026 = [2026 * 100 + w for w in range(1, 6)]

    # SE inflation factor, measured once at the 2022 cut and applied throughout
    hi22 = D.sw_start[202201]
    _, lam0 = _sit(D, hi22, hl, 202201)
    lam22 = {r: lam0[r] * mult[r] for r in range(4)}
    infl = calibrate_se(D, hi22, lam22, hl, 202201)
    print("[emit] SE calibration factor over sigma*sqrt(n)/(n+lambda):",
          {ROLES[r]: round(v, 2) for r, v in infl.items()})
    ac = attribution_cost(D, hi22, lam22, hl, 202201)
    print("[emit] attribution cost:", json.dumps(ac))

    os.makedirs(os.path.dirname(OUT_DB), exist_ok=True)
    out = sqlite3.connect(OUT_DB)
    out.executescript("""
    drop table if exists player_value_weekly;
    create table player_value_weekly(
      season int, week int, player_id text, position text,
      role text, value real, se real, n_plays real,
      value_pass real, se_pass real, n_pass real,
      value_rush real, se_rush real, n_rush real,
      value_rec  real, se_rec  real, n_rec  real,
      value_def  real, se_def  real, n_def  real,
      window_end_season int, window_end_week int, stale int,
      primary key(season, week, player_id));
    drop table if exists player_value_meta;
    create table player_value_meta(k text primary key, v text);
    """)
    warm = None
    total = 0
    t0 = time.time()
    for cut in cuts + frozen_2026:
        if cut // 100 == 2026:
            hi = D.n
            cut_fit = int(max(D.uniq_sw))
            stale = 1
        else:
            hi = D.sw_start[cut]
            cut_fit = cut
            stale = 0
        if hi < 5000:
            continue
        _, lam0 = _sit(D, hi, hl, cut_fit)
        lam = {r: lam0[r] * mult[r] for r in range(4)}
        gg, bb, rvar, neff, warm, iters = solve(D, 0, hi, lam, hl, cut_fit, warm=warm)
        lam_vec = np.array([lam[int(r)] for r in D.col_role])
        se = np.array([infl[int(r)] for r in D.col_role]) * \
             np.sqrt(rvar * np.maximum(neff, 0.0)) / (neff + lam_vec)
        # collapse player-role columns to one row per player
        byp = {}
        for c in range(D.p):
            if neff[c] < 5:
                continue
            pid = str(D.col_pid[c]); role = int(D.col_role[c])
            d = byp.setdefault(pid, dict(pos=str(D.col_pos[c])))
            d[role] = (float(bb[c]), float(se[c]), float(neff[c]))
        rows = []
        wend = int(max(v for v in D.uniq_sw if v < cut) if cut // 100 != 2026 else max(D.uniq_sw))
        for pid, d in byp.items():
            roles = [(r, v) for r, v in d.items() if r != 'pos']
            if not roles:
                continue
            prim = max(roles, key=lambda kv: kv[1][2])
            g = lambda r: d.get(r, (None, None, 0.0))
            rows.append((cut // 100, cut % 100, pid, d['pos'], ROLES[prim[0]],
                         prim[1][0], prim[1][1], sum(v[2] for _, v in roles),
                         *g(R_PASS), *g(R_RUSH), *g(R_REC), *g(R_DEF),
                         wend // 100, wend % 100, stale))
        out.executemany("insert or replace into player_value_weekly values (" + ",".join(["?"] * 23) + ")", rows)
        total += len(rows)
        if cut % 100 == 1:
            print(f"  {cut//100} w{cut%100}: train={hi:,} iters={iters} players={len(rows)} "
                  f"lam={ {ROLES[k]: round(v,1) for k,v in lam.items()} } ({time.time()-t0:.0f}s)")
    meta = dict(
        built_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        nflverse_mtime=time.ctime(os.path.getmtime(NFLVERSE)),
        as_of="play_by_play 2016-2025 + pbp_participation 2016-2025; participation NOT published for 2026",
        lambda_multiplier={ROLES[k]: v for k, v in mult.items()}, halflife_weeks=str(hl),
        tuned_on=str(TUNE_SEASONS), reported_on=str(REPORT_SEASONS),
        se_inflation={ROLES[r]: round(v, 3) for r, v in infl.items()},
        attribution_cost=ac,
        value_units="EPA per play attributable to this player in this role, opponent- and situation-adjusted, EB-shrunk",
        leakage="every row is fit strictly on plays before (season,week); 2026 rows are frozen at the end of 2025 and flagged stale=1",
    )
    out.executemany("insert or replace into player_value_meta values (?,?)",
                    [(k, json.dumps(v)) for k, v in meta.items()])
    out.commit()
    print(f"[emit] {total:,} rows -> {OUT_DB} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("extract", "all"):
        extract()
    if cmd in ("tune", "all"):
        tune()
    if cmd in ("validate", "all"):
        validate()
    if cmd in ("emit", "all"):
        emit()
